import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { createStore } from "../storage/store.mjs";
import { createProviderAdapter } from "../core/provider-adapter.mjs";
import { OtmError } from "../core/errors.mjs";
import { loadHostEvidenceModule } from "../core/continuation.mjs";
import { verifyClaudeSessionCapability } from "../core/claude-capability.mjs";
import { tools as codexTools } from "../mcp/tools.mjs";
import { toMcpResult } from "../mcp/result.mjs";
import { VERSION } from "../core/constants.mjs";
import { assertAcyclicContext } from "../core/validation.mjs";

const CLAUDE_PHASE_ACTIONS = Object.freeze(["otm_start_task", "otm_progress", "otm_complete_task", "otm_audit_stop"]);
const MAX_CLAUDE_PHASE_OPS = 16;

const MANAGED_TOOL_METHODS = Object.freeze({
  otm_start: "startTask",
  otm_reconcile: "reconcileTask",
  otm_start_task: "markTaskActive",
  otm_progress: "recordProgress",
  otm_complete_task: "completeTask",
  otm_block_task: "blockTask",
  otm_audit_stop: "auditStop",
  otm_resume: "resumeRun",
});
const CLAUDE_TOOL_PURPOSE = Object.freeze({
  otm_start:
    "Start the canonical OTM route with a model-reviewed outcome hierarchy for this Claude session.",
  otm_reconcile:
    "Re-review accumulated source context and reconcile the shared route after steering or discoveries, preserving valid evidence and exact task IDs.",
  otm_start_task:
    "Mark one exact route gate active before work on that gate begins.",
  otm_progress:
    "Record progress or evidence on exact route gates and descendants through the canonical OTM state machine.",
  otm_complete_task:
    "Complete an exact route gate only after its required descendants and evidence pass normal OTM checks.",
  otm_block_task:
    "Record an actionable blocker on an exact route gate without changing unrelated provider work.",
  otm_audit_stop:
    "Read the canonical Stop audit; incomplete gates remain open and the tool never finalizes a route.",
  otm_resume:
    "Resume the exact blocked or paused route under this Claude session after an explicit reason.",
});
const SHARED_IDENTITY_KEYS = new Set([
  "nativeSessionId",
  "workerNativeSessionId",
  "sessionId",
  "session_id",
  "threadId",
  "thread_id",
  "conversationId",
  "conversation_id",
]);
const CAPABILITY_CONTEXT_INSTRUCTION =
  "Use the exact short-lived sessionCapability supplied by the latest OTM Claude hook context when calling OTM tools. Never copy it into task prompts, evidence, or summaries.";

export const CLAUDE_MCP_SERVER_INSTRUCTIONS =
  "Claude OTM tools use the shared canonical route, history, and summaries. Read shared history/status first; explicit cross-provider continuation is allowed only after fresh verified host evidence and an idle interval. Every tool call requires the short-lived sessionCapability supplied by OTM's official Claude hooks. Never use a native provider session ID as tool authority. For several already-reviewed independent gates use otm_phase to batch ordered start/progress/complete/audit operations with one model tool request. It is sequential, not globally atomic: if an operation fails, inspect exact canonical state before resuming; never replay an entire partially applied batch.";

export const CLAUDE_OTM_TOOLS = Object.freeze([
  ...Object.entries(MANAGED_TOOL_METHODS).map(([name]) =>
    buildManagedTool(name),
  ),
  buildSnapshotTool(),
  buildPhaseTool(),
  buildHistoryTool(),
  buildContinueTool(),
  buildCheckpointTool(),
]);

/** Run the separate Claude stdio frontend over the canonical OTM store. */
export async function runClaudeMcpServer({
  env = process.env,
  cwd = process.cwd(),
  transport = null,
} = {}) {
  const store = createStore({ env });
  let hostEvidence = null;
  if (env.OTM_HOST_EVIDENCE_MODULE) {
    hostEvidence = await loadHostEvidenceModule(env.OTM_HOST_EVIDENCE_MODULE);
  }
  const server = new Server(
    { name: "overtli_task_manager_claude", version: VERSION },
    {
      capabilities: { tools: {} },
      instructions: CLAUDE_MCP_SERVER_INSTRUCTIONS,
    },
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: CLAUDE_OTM_TOOLS,
  }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    try {
      const result = dispatchClaudeTool({
        name: request.params.name,
        arguments: request.params.arguments || {},
        env,
        cwd,
        store,
        inspectOwnerWork: hostEvidence?.inspectOwnerWork || null,
      });
      return toMcpResult(result, {
        detail:
          request.params.name === "otm_snapshot" &&
          request.params.arguments?.detail === true,
      });
    } catch (error) {
      const token = request.params.arguments?.sessionCapability;
      const message =
        typeof token === "string"
          ? String(error?.message || "Operation failed.")
              .split(token)
              .join("[session capability removed]")
          : String(error?.message || "Operation failed.");
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: `OTM ${error?.code || "INTERNAL_ERROR"}: ${message}`,
          },
        ],
        structuredContent: {
          ok: false,
          code: error?.code || "OTM_INTERNAL_ERROR",
        },
      };
    }
  });

  const activeTransport = transport || new StdioServerTransport();
  let closed = false;
  const closeStore = () => {
    if (closed) return;
    closed = true;
    store.close?.();
  };
  if (!transport) {
    process.once("SIGINT", closeStore);
    process.once("SIGTERM", closeStore);
  }
  await server.connect(activeTransport);
  const sdkOnClose = activeTransport.onclose;
  activeTransport.onclose = () => {
    try {
      sdkOnClose?.();
    } finally {
      closeStore();
    }
  };
  return {
    server,
    close: async () => {
      await server.close();
      closeStore();
    },
  };
}

/** Exposed for bounded tests and integration owners; authority is always re-verified. */
export function dispatchClaudeTool({
  name,
  arguments: rawArguments,
  env = process.env,
  cwd = process.cwd(),
  store,
  inspectOwnerWork = null,
} = {}) {
  const definition = CLAUDE_OTM_TOOLS.find((tool) => tool.name === name);
  if (!definition)
    throw new OtmError(`Unknown Claude OTM tool: ${name}`, {
      code: "MCP_TOOL_UNKNOWN",
    });
  validateClaudeArguments(definition.inputSchema, rawArguments);
  const { sessionCapability, ...rawToolArguments } = rawArguments;
  const claims = verifyClaudeSessionCapability(sessionCapability, { env });
  const cleanArguments = scrubInput(rawToolArguments, sessionCapability);
  const adapter = createProviderAdapter({
    provider: "claude",
    verifiedSessionClaims: claims,
    workspaceRoot: claims.workspaceRoot,
    cwd,
    env,
    store,
    inspectOwnerWork,
  });
  try {
    const scopedArguments = {
      ...cleanArguments,
      workspaceRoot: claims.workspaceRoot,
    };
    if (Object.hasOwn(MANAGED_TOOL_METHODS, name)) {
      const base = codexTools.find((tool) => tool.name === name);
      validateJsonSchema(scopedArguments, base.inputSchema, "arguments");
      return sanitizeResult(
        adapter[MANAGED_TOOL_METHODS[name]](scopedArguments),
        sessionCapability,
      );
    }
    if (name === "otm_phase") {
      return sanitizeResult(executeClaudePhase(adapter, cleanArguments, claims.workspaceRoot), sessionCapability);
    }
    if (name === "otm_snapshot") {
      if (cleanArguments.runId) {
        return sanitizeResult(
          adapter.readSharedTask({
            runId: cleanArguments.runId,
            workspaceRoot: claims.workspaceRoot,
          }),
          sessionCapability,
        );
      }
      return sanitizeResult(
        adapter.snapshot(scopedArguments),
        sessionCapability,
      );
    }
    if (name === "otm_history") {
      return sanitizeResult(
        adapter.readSharedHistory({
          ...cleanArguments,
          workspaceRoot: claims.workspaceRoot,
        }),
        sessionCapability,
      );
    }
    if (name === "otm_continue") {
      return sanitizeResult(
        adapter.continueTask({
          runId: cleanArguments.runId,
          expectedRevision: cleanArguments.expectedRevision,
          workspaceRoot: claims.workspaceRoot,
        }),
        sessionCapability,
      );
    }
    if (name === "otm_checkpoint") {
      return sanitizeResult(
        adapter.checkpoint({
          runId: cleanArguments.runId,
          checkpointKey: cleanArguments.checkpointKey,
          workspaceRoot: claims.workspaceRoot,
        }),
        sessionCapability,
      );
    }
    throw new OtmError(`Claude OTM tool is not implemented: ${name}`, {
      code: "MCP_TOOL_UNKNOWN",
    });
  } finally {
    adapter.close();
  }
}

function buildManagedTool(name) {
  const base = codexTools.find((tool) => tool.name === name);
  const schema = withoutSessionScopes(base.inputSchema);
  addCapabilityProperty(schema);
  schema.additionalProperties = false;
  schema.required = [
    ...new Set([...(schema.required || []), "sessionCapability"]),
  ];
  return {
    name,
    description: `${CAPABILITY_CONTEXT_INSTRUCTION} ${CLAUDE_TOOL_PURPOSE[name]}`,
    inputSchema: schema,
  };
}

/**
 * One Claude-native phase request may settle several already-verified gates.
 * Every constituent operation keeps its original canonical manager validation,
 * authorization, evidence requirements and stop/review semantics. Deliberately
 * not an atomic multi-gate transaction: failure reports an exact applied prefix
 * and never retries side effects or hides a partial settlement.
 */
function executeClaudePhase(adapter, args, workspaceRoot) {
  const operations = args.operations;
  if (!Array.isArray(operations) || !operations.length ||
      operations.length > MAX_CLAUDE_PHASE_OPS) {
    throw new OtmError("A phase requires 1..16 explicitly scoped operations.", {
      code: "CLAUDE_PHASE_INVALID_SIZE",
    });
  }
  // Validate the COMPLETE request, including every nested identity and schema,
  // before the first mutation. A late malformed item can never cause a partial
  // application of an earlier otherwise-valid item.
  const prepared = operations.map((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item) ||
        !CLAUDE_PHASE_ACTIONS.includes(item.name)) {
      throw new OtmError("Phase operation is not an authorized task/evidence action.", {
        code: "CLAUDE_PHASE_ACTION_FORBIDDEN",
      });
    }
    const payload = item.arguments || {};
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      throw new OtmError("Phase operation arguments must be an object.", {
        code: "CLAUDE_PHASE_INVALID_ARGUMENTS",
      });
    }
    const forbidden = Object.keys(payload).filter(
      (key) => key === "workspaceRoot" || key === "provider" ||
        key === "sessionCapability" || SHARED_IDENTITY_KEYS.has(key),
    );
    if (forbidden.length) {
      throw new OtmError("Nested phase operations cannot override signed session or workspace identity.", {
        code: "CLAUDE_PHASE_SCOPE_OVERRIDE",
      });
    }
    const base = codexTools.find((tool) => tool.name === item.name);
    const scoped = { ...payload, workspaceRoot };
    const safeSchema = withoutSessionScopes(base.inputSchema);
    safeSchema.additionalProperties = false;
    validateJsonSchema(payload, safeSchema, "operations[" + index + "].arguments");
    validateJsonSchema(scoped, base.inputSchema, "operations[" + index + "].arguments");
    return { name: item.name, arguments: scoped };
  });
  const applied = [];
  for (const [index, item] of prepared.entries()) {
    try {
      const response = adapter[MANAGED_TOOL_METHODS[item.name]](item.arguments);
      applied.push({
        index, name: item.name,
        runId: response?.run?.id || item.arguments.runId || null,
        taskId: item.arguments.taskId || null,
        routeRevision: Number.isInteger(response?.run?.routeRevision)
          ? response.run.routeRevision : null,
      });
    } catch (error) {
      return {
        ok: false,
        partial: applied.length > 0,
        applied,
        failed: {
          index, name: item.name,
          code: error?.code || "OTM_PHASE_OPERATION_FAILED",
          message: String(error?.message || "Operation failed").slice(0, 350),
        },
        retryPolicy: "Do not replay this batch. Inspect otm_snapshot for exact canonical gate states and send only still-required operations.",
      };
    }
  }
  return {
    ok: true, partial: false, applied,
    completed: applied.length,
    authority: "Each transition was validated by the canonical OTM adapter; phase action never releases live jobs or bypasses OTM Stop.",
  };
}

function buildPhaseTool() {
  return {
    name: "otm_phase",
    description: CAPABILITY_CONTEXT_INSTRUCTION +
      " Settle a bounded accepted-work phase in one model tool turn: ordered start_task/progress/complete_task/audit_stop operations. Validate every nested schema BEFORE mutating; the underlying OTM transitions keep their own evidence and state checks. A partial failure preserves successful earlier operations and returns their exact indices; NEVER blindly replay the entire batch. This is NOT a generic scheduler or a replacement for the canonical OTM task database.",
    inputSchema: {
      type: "object",
      properties: {
        sessionCapability: capabilitySchema(),
        operations: {
          type: "array", maxItems: MAX_CLAUDE_PHASE_OPS,
          items: {
            type: "object",
            properties: {
              name: { type: "string", enum: CLAUDE_PHASE_ACTIONS },
              arguments: { type: "object" },
            },
            required: ["name", "arguments"],
            additionalProperties: false,
          },
        },
      },
      required: ["sessionCapability", "operations"],
      additionalProperties: false,
    },
  };
}

function buildSnapshotTool() {
  const base = codexTools.find((tool) => tool.name === "otm_snapshot");
  const schema = withoutSessionScopes(base.inputSchema);
  addCapabilityProperty(schema);
  schema.additionalProperties = false;
  schema.required = ["sessionCapability"];
  return {
    name: "otm_snapshot",
    description: `${CAPABILITY_CONTEXT_INSTRUCTION} Read the current route owned by this Claude session, or read any exact runId from shared project history without mutating or claiming it.`,
    inputSchema: schema,
  };
}

function buildHistoryTool() {
  return {
    name: "otm_history",
    description: `${CAPABILITY_CONTEXT_INSTRUCTION} Discover compact canonical history across Codex, Claude and older workspaces (scope=all by default). Results are paged, at most ten runs/summaries per page; use nextOffset to continue. Use runId and summaryId to read a saved summary in bounded text chunks with offset/maxChars. Inspect the exact run with otm_snapshot. Read-only discovery never takes ownership or requires a new summary or folder.`,
    inputSchema: {
      type: "object",
      properties: {
        sessionCapability: capabilitySchema(),
        limit: { type: "integer", minimum: 1, maximum: 50 },
        scope: { type: "string", enum: ["all", "workspace"] },
        offset: { type: "integer", minimum: 0, maximum: 10000000 },
        runId: { type: "string", minLength: 1, maxLength: 128 },
        summaryId: { type: "string", minLength: 1, maxLength: 128 },
        maxChars: { type: "integer", minimum: 1, maximum: 12000 },
      },
      required: ["sessionCapability"],
      additionalProperties: false,
    },
  };
}

function buildContinueTool() {
  return {
    name: "otm_continue",
    description: `${CAPABILITY_CONTEXT_INSTRUCTION} Explicitly request exclusive ownership transfer of an exact shared run after at least 15 minutes without owner activity and only when fresh trusted native-broker and ODC-job evidence proves the previous provider has no active or unknown owner work. Task-owned resource claims must be included in native-broker evidence; global GPU availability is not a continuation requirement. A stopped chat, stale timestamp, caller-supplied settled flag, or missing inspector never authorizes transfer.`,
    inputSchema: {
      type: "object",
      properties: {
        sessionCapability: capabilitySchema(),
        runId: { type: "string", minLength: 1, maxLength: 128 },
        expectedRevision: { type: "integer", minimum: 1 },
      },
      required: ["sessionCapability", "runId", "expectedRevision"],
      additionalProperties: false,
    },
  };
}

function buildCheckpointTool() {
  return {
    name: "otm_checkpoint",
    description: `${CAPABILITY_CONTEXT_INSTRUCTION} Record a concise shared checkpoint in the canonical route history without finalizing or copying a provider-specific summary.`,
    inputSchema: {
      type: "object",
      properties: {
        sessionCapability: capabilitySchema(),
        runId: { type: "string", minLength: 1, maxLength: 128 },
        checkpointKey: { type: "string", minLength: 1, maxLength: 256 },
      },
      required: ["sessionCapability", "runId"],
      additionalProperties: false,
    },
  };
}

function withoutSessionScopes(schema) {
  const copy = structuredClone(schema);
  const remove = (value) => {
    if (!value || typeof value !== "object") return;
    if (value.properties && typeof value.properties === "object") {
      for (const key of [...Object.keys(value.properties)]) {
        if (
          key === "workspaceRoot" ||
          SHARED_IDENTITY_KEYS.has(key) ||
          key === "provider"
        ) {
          delete value.properties[key];
        } else remove(value.properties[key]);
      }
    }
    if (Array.isArray(value.required)) {
      value.required = value.required.filter(
        (key) =>
          key !== "workspaceRoot" &&
          !SHARED_IDENTITY_KEYS.has(key) &&
          key !== "provider",
      );
    }
    if (value.items) remove(value.items);
    for (const branch of ["oneOf", "anyOf", "allOf"]) {
      for (const child of value[branch] || []) remove(child);
    }
  };
  remove(copy);
  return copy;
}

function addCapabilityProperty(schema) {
  schema.properties ||= {};
  schema.properties.sessionCapability = capabilitySchema();
}

function capabilitySchema() {
  return {
    type: "string",
    minLength: 64,
    maxLength: 8192,
    description:
      "Short-lived signed session capability from the latest OTM Claude UserPromptSubmit or SessionStart hook context. Do not include it in prompt/evidence fields.",
  };
}

function validateClaudeArguments(schema, args) {
  if (!args || typeof args !== "object" || Array.isArray(args)) {
    throw new OtmError("Claude OTM tool arguments must be an object.", {
      code: "MCP_INVALID_ARGUMENTS",
    });
  }
  assertAcyclicContext(args);
  for (const [key, value] of Object.entries(args)) {
    if (typeof value === "string" && value.length > 256 * 1024) {
      throw new OtmError(`arguments.${key} exceeds the maximum size.`, {
        code: "INPUT_TOO_LARGE",
      });
    }
    if (Array.isArray(value) && value.length > 256) {
      throw new OtmError(`arguments.${key} exceeds the maximum item count.`, {
        code: "INPUT_TOO_LARGE",
      });
    }
  }
  validateJsonSchema(args, schema, "arguments");
}

function validateJsonSchema(value, schema, field) {
  if (Array.isArray(schema.oneOf)) {
    const matches = schema.oneOf.filter((candidate) => {
      try {
        validateJsonSchema(value, candidate, field);
        return true;
      } catch {
        return false;
      }
    });
    if (matches.length !== 1)
      throw new OtmError(`${field} does not match exactly one allowed shape.`, {
        code: "MCP_INVALID_ARGUMENTS",
      });
    return;
  }
  if (schema.type === "object") {
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new OtmError(`${field} must be an object.`, {
        code: "MCP_INVALID_ARGUMENTS",
      });
    for (const key of schema.required || [])
      if (value[key] === undefined)
        throw new OtmError(`${field}.${key} is required.`, {
          code: "MCP_INVALID_ARGUMENTS",
        });
    const properties = schema.properties || {};
    if (schema.additionalProperties === false) {
      const unknown = Object.keys(value).filter(
        (key) => !Object.hasOwn(properties, key),
      );
      if (unknown.length)
        throw new OtmError(
          "Claude OTM arguments include unsupported properties.",
          { code: "MCP_UNKNOWN_ARGUMENT" },
        );
    }
    for (const [key, child] of Object.entries(value))
      if (properties[key])
        validateJsonSchema(child, properties[key], `${field}.${key}`);
    return;
  }
  if (schema.type === "array") {
    if (!Array.isArray(value))
      throw new OtmError(`${field} must be an array.`, {
        code: "MCP_INVALID_ARGUMENTS",
      });
    if (schema.maxItems !== undefined && value.length > schema.maxItems)
      throw new OtmError(`${field} exceeds its item limit.`, {
        code: "MCP_INVALID_ARGUMENTS",
      });
    for (const [index, child] of value.entries())
      validateJsonSchema(child, schema.items || {}, `${field}[${index}]`);
    return;
  }
  if (schema.type === "string") {
    if (
      typeof value !== "string" ||
      (schema.minLength !== undefined && value.length < schema.minLength) ||
      (schema.maxLength !== undefined && value.length > schema.maxLength)
    )
      throw new OtmError(
        `${field} must be a string within its allowed length.`,
        { code: "MCP_INVALID_ARGUMENTS" },
      );
  } else if (schema.type === "boolean" && typeof value !== "boolean")
    throw new OtmError(`${field} must be a boolean.`, {
      code: "MCP_INVALID_ARGUMENTS",
    });
  else if (
    schema.type === "integer" &&
    (!Number.isSafeInteger(value) ||
      (schema.minimum !== undefined && value < schema.minimum) ||
      (schema.maximum !== undefined && value > schema.maximum))
  )
    throw new OtmError(
      `${field} must be an integer within its allowed range.`,
      { code: "MCP_INVALID_ARGUMENTS" },
    );
  else if (
    schema.type === "number" &&
    (!Number.isFinite(value) ||
      (schema.minimum !== undefined && value < schema.minimum) ||
      (schema.maximum !== undefined && value > schema.maximum))
  )
    throw new OtmError(`${field} must be a number within its allowed range.`, {
      code: "MCP_INVALID_ARGUMENTS",
    });
  if (Array.isArray(schema.enum) && !schema.enum.includes(value))
    throw new OtmError(`${field} has an unsupported value.`, {
      code: "MCP_INVALID_ARGUMENTS",
    });
  if (schema.properties || schema.items)
    validateJsonSchema(value, schema, field);
}

function scrubInput(value, capability) {
  if (typeof value === "string")
    return value.split(capability).join("[session capability removed]");
  if (Array.isArray(value))
    return value.map((item) => scrubInput(item, capability));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key,
      scrubInput(item, capability),
    ]),
  );
}

function sanitizeResult(value, capability) {
  if (typeof value === "string")
    return value.split(capability).join("[session capability removed]");
  if (Array.isArray(value))
    return value.map((item) => sanitizeResult(item, capability));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !SHARED_IDENTITY_KEYS.has(key))
      .map(([key, item]) => [key, sanitizeResult(item, capability)]),
  );
}

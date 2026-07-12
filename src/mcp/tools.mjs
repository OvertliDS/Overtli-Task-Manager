import {
  boundedContextSchema,
  evidenceSchema,
  internalStepInputSchema,
  reconciliationChangeSchema,
  taskListSchema,
} from "./schemas.mjs";

export const tools = [
  {
    name: "otm_start",
    description:
      "Start a new session-scoped Overtli Task Manager route for a non-trivial Codex task. Routes are isolated by workspace plus CODEX_THREAD_ID unless sessionId is explicit. Returns chat Markdown and writes canonical session current files plus the workspace session index.",
    inputSchema: {
      type: "object",
      properties: {
        goal: { type: "string" },
        prompt: { type: "string" },
        context: {
          description:
            "Supplemental prompt context text or structured context available to the model.",
          ...boundedContextSchema,
        },
        promptContext: {
          description:
            "Additional prompt parts, pasted content, attachment text, OCR, or guidance the model used while deriving tasks.",
          ...boundedContextSchema,
        },
        attachments: {
          description:
            "Attachment metadata or extracted text/OCR/description content. Binary data is stored only as metadata; model-derived tasks should carry the real inference.",
          ...boundedContextSchema,
        },
        screenshots: {
          description:
            "Screenshot guidance, OCR, captions, or model-visible descriptions. OTM does not inspect pixels; model-derived tasks should reflect what was visible.",
          ...boundedContextSchema,
        },
        images: {
          description:
            "Image guidance, OCR, captions, or model-visible descriptions. OTM does not inspect pixels; model-derived tasks should reflect what was visible.",
          ...boundedContextSchema,
        },
        workspaceRoot: { type: "string" },
        sessionId: { type: "string" },
        turnId: { type: "string" },
        replaceExisting: { type: "boolean" },
        tasks: taskListSchema,
      },
      required: ["goal"],
    },
  },
  {
    name: "otm_reconcile",
    description:
      "Update an active route after user steering, continuation, appended tasks, dropped tasks, or route replacement. Use immediately when the user changes direction.",
    inputSchema: {
      type: "object",
      properties: {
        workspaceRoot: { type: "string" },
        sessionId: {
          type: "string",
          description:
            "Optional explicit session scope. Defaults to OTM_SESSION_ID or CODEX_THREAD_ID.",
        },
        runId: { type: "string" },
        prompt: { type: "string" },
        mode: {
          type: "string",
          enum: ["append", "steer", "continue", "replace"],
        },
        changes: {
          type: "array",
          maxItems: 256,
          items: reconciliationChangeSchema,
        },
        tasks: taskListSchema,
      },
    },
  },
  {
    name: "otm_snapshot",
    description:
      "Return the current route snapshot as Markdown and structured JSON. Use for chat-visible status updates.",
    inputSchema: {
      type: "object",
      properties: {
        workspaceRoot: { type: "string" },
        sessionId: { type: "string" },
        runId: { type: "string" },
      },
    },
  },
  {
    name: "otm_start_task",
    description:
      "Mark one route segment active before doing related work. Use an exact taskId from the latest OTM snapshot or session-scoped current.json; do not copy ids from another chat or the workspace index.",
    inputSchema: {
      type: "object",
      properties: {
        workspaceRoot: { type: "string" },
        sessionId: { type: "string" },
        runId: { type: "string" },
        taskId: { type: "string" },
        note: { type: "string" },
      },
      required: ["taskId"],
    },
  },
  {
    name: "otm_progress",
    description:
      "Record a progress checkpoint and return a Markdown status update. Use exact task ids from the latest snapshot/current.json when taskId is supplied. Use this to mark one internal step done/active as work happens; route gates still require otm_complete_task evidence after internal steps are terminal.",
    inputSchema: {
      type: "object",
      properties: {
        workspaceRoot: { type: "string" },
        sessionId: { type: "string" },
        runId: { type: "string" },
        taskId: { type: "string" },
        message: { type: "string" },
        evidence: evidenceSchema,
        internalStep: {
          description:
            "Internal step title or object to update for the active/task route segment.",
          ...internalStepInputSchema,
        },
        internalStepId: { type: "string" },
        internalStepTitle: { type: "string" },
        internalStepIndex: { type: "integer", minimum: 0, maximum: 127 },
        internalStepStatus: {
          type: "string",
          enum: [
            "pending",
            "active",
            "done",
            "blocked",
            "skipped",
            "complete",
            "completed",
          ],
        },
        advanceInternalStep: { type: "boolean" },
      },
      required: ["message"],
    },
  },
  {
    name: "otm_complete_task",
    description:
      "Mark a route segment complete using an exact taskId from the latest snapshot/current.json. Requires concrete completion evidence and terminal internal steps.",
    inputSchema: {
      type: "object",
      properties: {
        workspaceRoot: { type: "string" },
        sessionId: { type: "string" },
        runId: { type: "string" },
        taskId: { type: "string" },
        evidence: evidenceSchema,
      },
      required: ["taskId", "evidence"],
    },
  },
  {
    name: "otm_block_task",
    description:
      "Mark a route segment blocked with blocker evidence. Use when completion is impossible without repair or user input.",
    inputSchema: {
      type: "object",
      properties: {
        workspaceRoot: { type: "string" },
        sessionId: { type: "string" },
        runId: { type: "string" },
        taskId: { type: "string" },
        reason: { type: "string" },
        requiresUser: { type: "boolean" },
        evidence: evidenceSchema,
      },
      required: ["taskId", "reason"],
    },
  },
  {
    name: "otm_drop_task",
    description:
      "Drop or supersede a route segment when user steering makes it unnecessary.",
    inputSchema: {
      type: "object",
      properties: {
        workspaceRoot: { type: "string" },
        sessionId: { type: "string" },
        runId: { type: "string" },
        taskId: { type: "string" },
        reason: { type: "string" },
        supersede: { type: "boolean" },
      },
      required: ["taskId", "reason"],
    },
  },
  {
    name: "otm_audit_stop",
    description:
      "Audit whether Codex may stop. If required segments remain, continue instead of finalizing.",
    inputSchema: {
      type: "object",
      properties: {
        workspaceRoot: { type: "string" },
        sessionId: { type: "string" },
        runId: { type: "string" },
      },
    },
  },
  {
    name: "otm_finalize_turn",
    description:
      "Write a turn summary and checkpoint memory. Use after otm_audit_stop passes, show the returned Markdown summary to the user, then call otm_clear_current.",
    inputSchema: {
      type: "object",
      properties: {
        workspaceRoot: { type: "string" },
        sessionId: { type: "string" },
        runId: { type: "string" },
        summaryId: { type: "string", maxLength: 128 },
        turnId: { type: "string", maxLength: 128 },
        outcome: { type: "string", maxLength: 500 },
        reason: { type: "string", maxLength: 16_000 },
        nextSteps: {
          type: "array",
          maxItems: 128,
          items: { type: "string", maxLength: 16_000 },
        },
        allowIncomplete: { type: "boolean" },
        clearCurrent: { type: "boolean" },
        clear: { type: "boolean" },
        deleteFiles: { type: "boolean" },
      },
    },
  },
  {
    name: "otm_clear_current",
    description:
      "Clear active current.json/current.md after summary is saved. Defaults to a tombstone instead of deleting files.",
    inputSchema: {
      type: "object",
      properties: {
        workspaceRoot: { type: "string" },
        sessionId: { type: "string" },
        runId: { type: "string" },
        deleteFiles: { type: "boolean" },
      },
    },
  },
  {
    name: "otm_abandon",
    description:
      "Explicitly abandon an unfinished route after review. Requires an exact run id and a recorded reason; this is the only incomplete-route clearing path.",
    inputSchema: {
      type: "object",
      properties: {
        workspaceRoot: { type: "string" },
        sessionId: { type: "string" },
        runId: { type: "string", maxLength: 128 },
        reason: { type: "string", minLength: 1, maxLength: 16_000 },
        deleteFiles: { type: "boolean" },
      },
      required: ["runId", "reason"],
    },
  },
  {
    name: "otm_resume",
    description:
      "Resume an unfinished blocked or paused route through a recorded lifecycle transition. This never reopens a finalized route.",
    inputSchema: {
      type: "object",
      properties: {
        workspaceRoot: { type: "string" },
        sessionId: { type: "string" },
        runId: { type: "string" },
        taskId: { type: "string" },
        reason: { type: "string" },
      },
      required: ["runId"],
    },
  },
  {
    name: "otm_archive",
    description:
      "Archive finalized, cleared, or explicitly abandoned route history. Requires a run id and is idempotent for an already archived route.",
    inputSchema: {
      type: "object",
      properties: {
        workspaceRoot: { type: "string" },
        sessionId: { type: "string" },
        runId: { type: "string" },
        reason: { type: "string" },
      },
      required: ["runId"],
    },
  },
  {
    name: "otm_cleanup_workspace",
    description:
      "Clean OTM-owned workspace temp and scratch artifacts immediately. Use at final completion or when stale .tmp/scratch files clutter .codex/overtli-task-manager.",
    inputSchema: {
      type: "object",
      properties: {
        workspaceRoot: { type: "string" },
        minAgeMs: { type: "integer", minimum: 0, maximum: 31_536_000_000 },
        scratchMaxAgeMs: {
          type: "integer",
          minimum: 0,
          maximum: 31_536_000_000,
        },
        allSessions: { type: "boolean" },
        confirm: { type: "boolean" },
        dryRun: { type: "boolean" },
      },
    },
  },
  {
    name: "otm_prune_history",
    description:
      "Prune durable OTM history older than the retention window. Defaults to 7 days and preserves active, blocked, and paused routes.",
    inputSchema: {
      type: "object",
      properties: {
        workspaceRoot: { type: "string" },
        retentionDays: { type: "integer", minimum: 1, maximum: 36_500 },
        dryRun: { type: "boolean" },
      },
    },
  },
  {
    name: "otm_project_review",
    description:
      "Refresh the project-specific lightweight context cache by reading overview docs, AGENTS.md, memory banks, docs, manifests, PRDs, and GDDs without full source scanning.",
    inputSchema: {
      type: "object",
      properties: {
        workspaceRoot: { type: "string" },
        maxFiles: { type: "integer", minimum: 1, maximum: 500 },
      },
    },
  },
  {
    name: "otm_memory_search",
    description:
      "Search project-specific checkpoint memory, turn summaries, and project overview cache for continuation context.",
    inputSchema: {
      type: "object",
      properties: {
        workspaceRoot: { type: "string" },
        query: { type: "string", minLength: 1, maxLength: 16_000 },
        limit: { type: "integer", minimum: 1, maximum: 500 },
      },
      required: ["query"],
    },
  },
  {
    name: "otm_memory_upsert",
    description:
      "Create or update project-specific memory. Use for durable decisions, checkpoints, and concise context that should survive later turns.",
    inputSchema: {
      type: "object",
      properties: {
        workspaceRoot: { type: "string" },
        id: { type: "string" },
        kind: { type: "string" },
        title: { type: "string" },
        body: { type: "string" },
        tags: { type: "array", items: { type: "string" } },
        source: { type: "object", additionalProperties: true },
      },
      required: ["title", "body"],
    },
  },
  {
    name: "otm_memory_delete",
    description:
      "Preview or delete stale project memory by id, kind, or tag. Workspace-wide deletion requires all:true and confirm:true.",
    inputSchema: {
      type: "object",
      properties: {
        workspaceRoot: { type: "string" },
        id: { type: "string" },
        kind: { type: "string" },
        tag: { type: "string" },
        all: { type: "boolean" },
        confirm: { type: "boolean" },
        dryRun: { type: "boolean" },
      },
    },
  },
  {
    name: "otm_memory_list",
    description:
      "List non-expired project memory entries for the selected workspace.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        workspaceRoot: { type: "string", maxLength: 16000 },
        limit: { type: "integer", minimum: 1, maximum: 500 },
      },
    },
  },
  {
    name: "otm_memory_inspect",
    description: "Inspect one exact project memory entry by id.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        workspaceRoot: { type: "string", maxLength: 16000 },
        id: { type: "string", maxLength: 128 },
      },
      required: ["id"],
    },
  },
  {
    name: "otm_memory_purge_expired",
    description:
      "Preview or purge expired memory entries in the selected workspace.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        workspaceRoot: { type: "string", maxLength: 16000 },
        dryRun: { type: "boolean" },
      },
    },
  },
  {
    name: "otm_install_workspace",
    description:
      "Idempotently install OTM into the current repository: AGENTS.md managed block, .agents/skills, .codex/hooks.json, and gitignore entries. Optionally add project MCP config.",
    inputSchema: {
      type: "object",
      properties: {
        workspaceRoot: { type: "string" },
        dryRun: { type: "boolean" },
        installMcpConfig: { type: "boolean" },
        targetAgentsFile: { type: "string" },
      },
    },
  },
  {
    name: "otm_doctor",
    description:
      "Diagnose OTM storage, active route, current.json, and install state.",
    inputSchema: {
      type: "object",
      properties: {
        workspaceRoot: { type: "string" },
        sessionId: { type: "string" },
      },
    },
  },
];

// MCP transports validate schemas before the handler, while the server also
// validates independently for hosts that bypass SDK schema validation.  Keep
// top-level request objects closed; nested prompt/evidence structures remain
// intentionally flexible and are bounded/redacted by the domain layer.
const structuredOutputSchema = {
  type: "object",
  additionalProperties: false,
  required: ["ok"],
  properties: {
    ok: { type: "boolean" },
    code: { type: "string" },
    details: {},
    result: {},
  },
};
for (const definition of tools) {
  definition.inputSchema.additionalProperties ??= false;
  applySchemaBounds(definition.inputSchema);
  definition.outputSchema = structuredOutputSchema;
  definition.annotations = toolAnnotations(definition.name);
}

function applySchemaBounds(schema, fieldName = "") {
  if (!schema || typeof schema !== "object") return;
  for (const candidate of schema.oneOf || [])
    applySchemaBounds(candidate, fieldName);
  if (schema.type === "string" && schema.maxLength === undefined) {
    schema.maxLength =
      /(?:^|_)(?:id|runId|taskId|sessionId|turnId|parentId|internalStepId)$/i.test(
        fieldName,
      )
        ? 128
        : 16_000;
  }
  if (schema.type === "array") {
    schema.maxItems ??= 256;
    applySchemaBounds(schema.items, fieldName);
  }
  if (schema.type === "object") {
    for (const [key, child] of Object.entries(schema.properties || {}))
      applySchemaBounds(child, key);
  }
}

function toolAnnotations(name) {
  const readOnly = new Set([
    "otm_snapshot",
    "otm_audit_stop",
    "otm_memory_search",
    "otm_memory_list",
    "otm_memory_inspect",
    "otm_doctor",
  ]);
  const destructive = new Set([
    "otm_clear_current",
    "otm_abandon",
    "otm_cleanup_workspace",
    "otm_prune_history",
    "otm_memory_delete",
    "otm_memory_purge_expired",
    "otm_drop_task",
    "otm_archive",
  ]);
  const idempotent = new Set([
    "otm_snapshot",
    "otm_audit_stop",
    "otm_memory_search",
    "otm_memory_list",
    "otm_memory_inspect",
    "otm_doctor",
  ]);
  return {
    readOnlyHint: readOnly.has(name),
    destructiveHint: destructive.has(name),
    idempotentHint: idempotent.has(name),
  };
}

import path from "node:path";
import fs from "node:fs";
import { createTaskManager } from "../core/manager.mjs";
import {
  findWorkspaceRoot,
  readText,
  getHomeDir,
  atomicWriteJson,
} from "../core/fs-utils.mjs";
import {
  installWorkspace,
  renderInstallResult,
} from "../install/install-workspace.mjs";
import {
  uninstallWorkspace,
  renderUninstallResult,
} from "../install/uninstall-workspace.mjs";
import {
  installGlobal,
  renderGlobalInstallResult,
} from "../install/install-global.mjs";
import {
  uninstallGlobal,
  renderGlobalUninstallResult,
} from "../install/uninstall-global.mjs";
import { reviewProjectContext } from "../context/project-review.mjs";
import { runHookScript } from "../hooks/runner.mjs";
import { resolveSessionId } from "../core/session-scope.mjs";
import {
  loadBetterSqlite3,
  SQLITE_SCHEMA_VERSION,
} from "../storage/sqlite-store.mjs";
import { inspectDoctor, renderDoctor } from "./doctor.mjs";
import { canonicalizeWorkspaceRoot } from "../core/validation.mjs";

export async function handleCli({ argv, cwd, stdin, packageRoot, env }) {
  const command = argv[0] || "help";
  if (command === "help" || command === "--help" || command === "-h") {
    console.log(helpText());
    return;
  }
  if (command === "version" || command === "--version" || command === "-v") {
    console.log(packageVersion(packageRoot));
    return;
  }
  if (command === "mcp-config") {
    console.log(renderMcpConfig(packageRoot));
    return;
  }
  const flags = parseFlags(
    command === "hook" ? argv.slice(2) : argv.slice(1),
    allowedFlagsFor(command),
    booleanFlagsFor(command),
  );
  validateNumericFlags(flags);
  if (command === "backup" || command === "restore") {
    const result =
      command === "backup"
        ? await backupStore(env, flags)
        : restoreStore(env, flags);
    printCli(
      flags,
      result,
      `OTM ${command}\nStorage: ${result.storage}\n${result.dryRun ? "Mutations: none" : `Path: ${result.path}`}`,
    );
    return;
  }
  if (command === "migrate" && flags.dryRun) {
    const result = inspectMigrationDryRun(env);
    console.log(
      flags.json
        ? JSON.stringify(result, null, 2)
        : `OTM migration dry run\nStorage: ${result.storage}\nCurrent schema: ${result.currentVersion ?? "n/a"}\nTarget schema: ${result.targetVersion ?? "n/a"}\nMutations: none`,
    );
    return;
  }
  const hookEventName = command === "hook" ? argv[1] : null;
  if (command === "hook" && (!hookEventName || hookEventName.startsWith("--")))
    throw new Error("hook requires an event name.");
  const workspaceRoot = canonicalizeWorkspaceRoot(
    flags.workspace || flags.workspaceRoot || findWorkspaceRoot(cwd),
  ).displayPath;
  const sessionId = resolveSessionId({ sessionId: flags.sessionId }, env);
  // Installer lifecycle commands intentionally run before store creation.
  // In particular, their dry-run forms must create neither state directories
  // nor database files.
  if (command === "install") {
    const result = installWorkspace({
      cwd,
      workspaceRoot,
      packageRoot,
      dryRun: Boolean(flags.dryRun),
      installMcpConfig: Boolean(flags.withProjectMcpConfig),
      targetAgentsFile: flags.agentsFile || null,
    });
    console.log(renderInstallResult(result));
    return;
  }

  if (command === "install-global") {
    const result = installGlobal({
      codexHome: flags.codexHome || env.CODEX_HOME || null,
      packageRoot,
      dryRun: Boolean(flags.dryRun),
      env,
    });
    console.log(renderGlobalInstallResult(result));
    return;
  }

  if (command === "uninstall") {
    if (flags.global === true) {
      const result = uninstallGlobal({
        codexHome: flags.codexHome || env.CODEX_HOME || null,
        packageRoot,
        dryRun: Boolean(flags.dryRun),
        confirm: Boolean(flags.confirm),
        env,
      });
      printCli(flags, result, renderGlobalUninstallResult(result));
      return { exitCode: result.ok ? 0 : 2 };
    }
    const result = uninstallWorkspace({
      cwd,
      workspaceRoot,
      packageRoot,
      dryRun: Boolean(flags.dryRun),
      confirm: Boolean(flags.confirm),
      removeState: Boolean(flags.removeState),
      targetAgentsFile: flags.agentsFile || null,
    });
    printCli(flags, result, renderUninstallResult(result));
    return { exitCode: result.ok ? 0 : 2 };
  }

  if (command === "doctor") {
    const report = inspectDoctor({
      workspaceRoot,
      packageRoot,
      sessionId,
      env,
    });
    if (flags.repair === true) {
      if (!report.ok) {
        report.repair = {
          attempted: false,
          reason:
            "Doctor found integrity errors; restore or resolve them before summary repair.",
        };
      } else {
        const manager = createTaskManager({
          cwd: workspaceRoot,
          env,
          readOnly: flags.dryRun === true,
        });
        try {
          report.repair = {
            attempted: true,
            ...manager.repairSummaries({
              workspaceRoot,
              dryRun: flags.dryRun === true,
            }),
          };
        } finally {
          manager.close?.();
        }
      }
    }
    printCli(flags, report, renderDoctor(report));
    return { exitCode: report.ok ? 0 : 2 };
  }

  // Help, version, configuration rendering, installer lifecycle, and doctor above
  // deliberately avoid store initialization, so they remain usable even when
  // durable state is corrupt.
  const readOnly =
    flags.dryRun === true &&
    new Set([
      "repair",
      "export",
      "import",
      "memory-purge-expired",
      "prune-history",
      "cleanup",
    ]).has(command);
  const manager = createTaskManager({ cwd: workspaceRoot, env, readOnly });

  if (command === "migrate") {
    const result = {
      storage: manager.store.kind,
      schemaVersion:
        manager.store.kind === "sqlite"
          ? manager.store.db.pragma("user_version", { simple: true })
          : "otm.store.v1",
      migrated: true,
    };
    printCli(
      flags,
      result,
      `OTM migration complete\nStorage: ${result.storage}\nSchema: ${result.schemaVersion}`,
    );
    return;
  }

  if (command === "repair") {
    const result = manager.repairSummaries({
      workspaceRoot,
      dryRun: flags.dryRun === true,
    });
    printCli(
      flags,
      result,
      `OTM repair\nSummary records: ${result.matched}\nFiles republished: ${result.repaired}${result.dryRun ? "\nMutations: none" : ""}`,
    );
    return;
  }

  if (command === "export") {
    if (!flags.output) throw new Error("export requires --output.");
    const document = manager.exportWorkspace({ workspaceRoot });
    const output = path.resolve(flags.output);
    const result = {
      workspaceRoot,
      output,
      dryRun: flags.dryRun === true,
      counts: exportCounts(document),
    };
    if (!result.dryRun) {
      if (fs.existsSync(output))
        throw new Error(
          "export output already exists; choose a new path to avoid overwriting a backup.",
        );
      atomicWriteJson(output, document, { tempDir: path.dirname(output) });
    }
    printCli(
      flags,
      result,
      `OTM export\nWorkspace: ${workspaceRoot}\nRuns: ${result.counts.runs}\nOutput: ${output}${result.dryRun ? "\nMutations: none" : ""}`,
    );
    return;
  }

  if (command === "import") {
    if (flags.confirm !== true)
      throw new Error(
        "import requires --confirm after reviewing the export file.",
      );
    if (!flags.input) throw new Error("import requires --input.");
    const input = path.resolve(flags.input);
    if (!fs.existsSync(input) || !fs.statSync(input).isFile())
      throw new Error("import input must be an existing export file.");
    let document;
    try {
      document = JSON.parse(fs.readFileSync(input, "utf8"));
    } catch {
      throw new Error("import input is malformed JSON.");
    }
    const result = manager.importHistorical({
      workspaceRoot,
      document,
      dryRun: flags.dryRun === true,
    });
    printCli(
      flags,
      { ...result, input },
      `OTM historical import\nWorkspace: ${workspaceRoot}\nRuns: ${result.imported.runs}${result.dryRun ? "\nMutations: none" : ""}`,
    );
    return;
  }

  if (command === "resume") {
    if (!flags.runId) throw new Error("resume requires --run-id.");
    const result = manager.resumeRun({
      workspaceRoot,
      sessionId,
      runId: flags.runId,
      taskId: flags.taskId,
      reason: flags.reason,
    });
    printCli(
      flags,
      { run: result.run, snapshot: result.snapshot },
      result.markdown,
    );
    return;
  }

  if (command === "archive") {
    if (!flags.runId) throw new Error("archive requires --run-id.");
    if (flags.confirm !== true)
      throw new Error("archive requires --confirm after reviewing the run id.");
    const result = manager.archiveRun({
      workspaceRoot,
      sessionId,
      runId: flags.runId,
      reason: flags.reason,
    });
    printCli(
      flags,
      result,
      `OTM archive\nRun: ${result.run.id}\n${result.idempotent ? "Already archived." : "Archived."}`,
    );
    return;
  }

  if (command === "abandon") {
    if (!flags.runId) throw new Error("abandon requires --run-id.");
    if (!flags.reason) throw new Error("abandon requires --reason.");
    if (flags.confirm !== true)
      throw new Error(
        "abandon requires --confirm after reviewing the run id and reason.",
      );
    const result = manager.abandonRun({
      workspaceRoot,
      sessionId,
      runId: flags.runId,
      reason: flags.reason,
      deleteFiles: flags.deleteFiles === true,
    });
    printCli(flags, result, result.markdown);
    return;
  }

  if (command === "snapshot") {
    const result = manager.snapshot({ workspaceRoot, sessionId, write: false });
    console.log(result.markdown);
    return;
  }

  if (command === "status") {
    const result = manager.snapshot({ workspaceRoot, sessionId, write: false });
    printCli(
      flags,
      { run: result.run, snapshot: result.snapshot },
      result.markdown,
    );
    return;
  }

  if (command === "list-runs") {
    const runs = manager.listRuns({
      workspaceRoot,
      limit: flags.limit === undefined ? 20 : Number(flags.limit),
    });
    const markdown = [
      "## OTM runs",
      "",
      ...runs.runs.map((run) => `- ${run.id} — ${run.status} — ${run.goal}`),
      "",
    ].join("\n");
    printCli(flags, runs, markdown);
    return;
  }

  if (command === "history") {
    if (!flags.runId) throw new Error("history requires --run-id.");
    const run = manager.store.getRun(flags.runId);
    if (!run || run.workspaceRoot !== workspaceRoot)
      throw new Error("Run not found in this workspace.");
    const events = manager.store.getEvents(
      run.id,
      flags.limit === undefined ? 100 : Number(flags.limit),
    );
    const markdown = [
      "## OTM history",
      "",
      ...events.map((event) => `- ${event.createdAt} — ${event.eventType}`),
      "",
    ].join("\n");
    printCli(flags, { runId: run.id, events }, markdown);
    return;
  }

  if (command === "memory-list") {
    const result = manager.listMemory({
      workspaceRoot,
      limit: flags.limit === undefined ? 50 : Number(flags.limit),
    });
    printCli(flags, result, memoryMarkdown(result.entries));
    return;
  }

  if (command === "memory-inspect") {
    if (!flags.id) throw new Error("memory-inspect requires --id.");
    const result = manager.inspectMemory({ workspaceRoot, id: flags.id });
    printCli(
      flags,
      result,
      `## OTM memory\n\n${result.entry.title}\n\n${result.entry.body}\n`,
    );
    return;
  }

  if (command === "memory-purge-expired") {
    const result = manager.purgeExpiredMemory({
      workspaceRoot,
      dryRun: flags.dryRun === true,
    });
    printCli(
      flags,
      result,
      `## OTM expired memory purge\n\nMatched: ${result.matched}\nDeleted: ${result.deleted}\n`,
    );
    return;
  }

  if (command === "review-project") {
    const review = reviewProjectContext({
      workspaceRoot,
      maxFiles: Number(flags.maxFiles || 30),
    });
    if (!review.unchanged) {
      manager.upsertMemory({
        workspaceRoot,
        kind: "project_overview",
        title: "Project overview cache",
        body: review.summary,
        tags: ["project-overview", "manual-review"],
        source: { fingerprint: review.fingerprint },
      });
    }
    console.log(review.summary);
    return;
  }

  if (command === "clear-current") {
    const result = manager.clearCurrent({
      workspaceRoot,
      sessionId,
      deleteFiles: Boolean(flags.deleteFiles),
    });
    console.log(result.markdown);
    return;
  }

  if (command === "cleanup") {
    const result = manager.cleanupWorkspace({
      workspaceRoot,
      minAgeMs:
        flags.minAgeMs === undefined ? undefined : Number(flags.minAgeMs),
      scratchMaxAgeMs:
        flags.scratchMaxAgeMs === undefined
          ? undefined
          : Number(flags.scratchMaxAgeMs),
      allSessions: flags.allSessions === true,
      confirm: flags.confirm === true,
      dryRun: flags.dryRun === true,
    });
    console.log(result.markdown);
    return;
  }

  if (command === "prune-history") {
    const result = manager.pruneHistory({
      workspaceRoot,
      retentionDays:
        flags.retentionDays === undefined
          ? undefined
          : Number(flags.retentionDays),
      dryRun: Boolean(flags.dryRun),
    });
    console.log(result.markdown);
    return;
  }

  if (command === "hook") {
    await runHookScript(hookEventName, { stdin, cwd: workspaceRoot, env });
    return;
  }

  throw new Error(`Unknown command: ${command}`);
}

function parseFlags(items, allowed, booleanFlags = new Set()) {
  const flags = {};
  for (let i = 0; i < items.length; i += 1) {
    const item = items[i];
    if (!item?.startsWith("--"))
      throw new Error(`Unexpected argument: ${item}`);
    const [rawKey, inlineValue] = item.slice(2).split(/=(.*)/s, 2);
    const key = rawKey.replace(/-([a-z])/g, (_, ch) => ch.toUpperCase());
    if (!allowed.has(key))
      throw new Error(`Unknown flag for this command: --${rawKey}`);
    if (Object.hasOwn(flags, key))
      throw new Error(`Duplicate flag: --${rawKey}`);
    if (inlineValue !== undefined) {
      if (booleanFlags.has(key)) {
        if (inlineValue === "") {
          flags[key] = true;
          continue;
        }
        if (inlineValue !== "true" && inlineValue !== "false")
          throw new Error(`Boolean flag --${rawKey} must be true or false.`);
        flags[key] = inlineValue === "true";
        continue;
      }
      if (inlineValue === "")
        throw new Error(`Flag --${rawKey} requires a value.`);
      flags[key] = inlineValue;
      continue;
    }
    const next = items[i + 1];
    if (!next || next.startsWith("--")) {
      if (!booleanFlags.has(key))
        throw new Error(`Flag --${rawKey} requires a value.`);
      flags[key] = true;
    } else if (booleanFlags.has(key)) {
      if (next === "true" || next === "false") {
        flags[key] = next === "true";
        i += 1;
      } else flags[key] = true;
    } else {
      flags[key] = next;
      i += 1;
    }
  }
  return flags;
}

function booleanFlagsFor(command) {
  const common = ["json"];
  const byCommand = {
    install: ["dryRun", "withProjectMcpConfig"],
    "install-global": ["dryRun"],
    uninstall: ["dryRun", "confirm", "removeState", "global"],
    doctor: ["repair", "dryRun"],
    migrate: ["dryRun"],
    repair: ["dryRun"],
    export: ["dryRun"],
    import: ["confirm", "dryRun"],
    resume: [],
    archive: ["confirm"],
    abandon: ["confirm", "deleteFiles"],
    "memory-purge-expired": ["dryRun"],
    "clear-current": ["deleteFiles"],
    cleanup: ["allSessions", "confirm", "dryRun"],
    "prune-history": ["dryRun"],
    backup: ["dryRun"],
    restore: ["confirm", "dryRun"],
  };
  return new Set([...common, ...(byCommand[command] || [])]);
}

function validateNumericFlags(flags) {
  const positiveIntegers = ["limit", "maxFiles"];
  for (const key of positiveIntegers) {
    if (flags[key] === undefined) continue;
    const value = Number(flags[key]);
    if (
      !Number.isInteger(value) ||
      value < 1 ||
      value > (key === "maxFiles" ? 100 : 10_000)
    ) {
      throw new Error(
        `--${key.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)} must be an integer in range.`,
      );
    }
    flags[key] = value;
  }
  for (const key of ["minAgeMs", "scratchMaxAgeMs", "retentionDays"]) {
    if (flags[key] === undefined) continue;
    const value = Number(flags[key]);
    if (!Number.isFinite(value) || value < 0)
      throw new Error(
        `--${key.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)} must be a non-negative number.`,
      );
    flags[key] = value;
  }
}

function allowedFlagsFor(command) {
  const common = ["workspace", "workspaceRoot", "sessionId", "json"];
  const byCommand = {
    install: ["dryRun", "withProjectMcpConfig", "agentsFile"],
    uninstall: [
      "dryRun",
      "confirm",
      "removeState",
      "agentsFile",
      "global",
      "codexHome",
    ],
    "install-global": ["codexHome", "dryRun"],
    doctor: ["repair", "dryRun"],
    migrate: ["dryRun"],
    repair: ["dryRun"],
    export: ["output", "dryRun"],
    import: ["input", "confirm", "dryRun"],
    resume: ["runId", "taskId", "reason"],
    archive: ["runId", "reason", "confirm"],
    abandon: ["runId", "reason", "confirm", "deleteFiles"],
    snapshot: [],
    status: [],
    "list-runs": ["limit"],
    history: ["runId", "limit"],
    "memory-list": ["limit"],
    "memory-inspect": ["id"],
    "memory-purge-expired": ["dryRun"],
    "review-project": ["maxFiles"],
    "clear-current": ["deleteFiles"],
    cleanup: [
      "minAgeMs",
      "scratchMaxAgeMs",
      "allSessions",
      "confirm",
      "dryRun",
    ],
    "prune-history": ["retentionDays", "dryRun"],
    backup: ["output", "dryRun"],
    restore: ["input", "confirm", "dryRun"],
    hook: [],
  };
  if (!Object.hasOwn(byCommand, command)) return new Set();
  return new Set([...common, ...byCommand[command]]);
}

async function backupStore(env, flags) {
  const source = stateFileFor(env);
  if (!fs.existsSync(source.path))
    throw new Error(`No ${source.storage} state file exists to back up.`);
  const destination = flags.output
    ? path.resolve(flags.output)
    : path.join(
        source.stateDir,
        "backups",
        `otm-${source.storage}-${Date.now()}${path.extname(source.path) || ".json"}`,
      );
  if (flags.dryRun)
    return {
      storage: source.storage,
      path: destination,
      source: source.path,
      dryRun: true,
    };
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  if (source.storage === "sqlite") {
    const Database = loadBetterSqlite3();
    if (!Database) throw new Error("SQLite backup requires better-sqlite3.");
    const db = new Database(source.path, {
      readonly: true,
      fileMustExist: true,
    });
    try {
      await db.backup(destination);
    } finally {
      db.close();
    }
  } else fs.copyFileSync(source.path, destination, fs.constants.COPYFILE_EXCL);
  return {
    storage: source.storage,
    path: destination,
    source: source.path,
    dryRun: false,
  };
}

function restoreStore(env, flags) {
  if (flags.confirm !== true)
    throw new Error(
      "restore requires --confirm after reviewing the backup path.",
    );
  const source = stateFileFor(env);
  const input = path.resolve(flags.input || "");
  if (!fs.existsSync(input) || !fs.statSync(input).isFile())
    throw new Error("restore input must be an existing backup file.");
  if (flags.dryRun)
    return { storage: source.storage, path: source.path, input, dryRun: true };
  fs.mkdirSync(path.dirname(source.path), { recursive: true });
  fs.copyFileSync(input, source.path);
  if (source.storage === "sqlite") {
    for (const suffix of ["-wal", "-shm"]) {
      try {
        fs.rmSync(`${source.path}${suffix}`, { force: true });
      } catch {}
    }
  }
  return { storage: source.storage, path: source.path, input, dryRun: false };
}

function stateFileFor(env) {
  const stateDir = env.OTM_STATE_DIR || getHomeDir(env);
  const requested = String(env.OTM_STORAGE || "auto").toLowerCase();
  return requested === "json"
    ? {
        storage: "json",
        stateDir,
        path: path.join(stateDir, "json", "state.json"),
      }
    : {
        storage: "sqlite",
        stateDir,
        path: path.join(stateDir, "state.sqlite"),
      };
}

function inspectMigrationDryRun(env) {
  const requested = String(env.OTM_STORAGE || "auto").toLowerCase();
  const stateDir = env.OTM_STATE_DIR || getHomeDir(env);
  const dbPath = path.join(stateDir, "state.sqlite");
  if (requested !== "json" && fs.existsSync(dbPath) && loadBetterSqlite3()) {
    const Database = loadBetterSqlite3();
    const db = new Database(dbPath, { readonly: true, fileMustExist: true });
    try {
      return {
        storage: "sqlite",
        currentVersion: Number(
          db.pragma("user_version", { simple: true }) || 0,
        ),
        targetVersion: SQLITE_SCHEMA_VERSION,
        database: dbPath,
      };
    } finally {
      db.close();
    }
  }
  return {
    storage: requested === "sqlite" ? "sqlite-unavailable" : "json",
    currentVersion: null,
    targetVersion:
      requested === "json" ? "otm.store.v1" : SQLITE_SCHEMA_VERSION,
    database:
      requested === "json" ? path.join(stateDir, "json", "state.json") : dbPath,
  };
}

function printCli(flags, payload, markdown) {
  console.log(
    flags.json === true ? JSON.stringify(payload, null, 2) : markdown,
  );
}

function memoryMarkdown(entries) {
  return [
    "## OTM memory",
    "",
    ...(entries.length
      ? entries.map((entry) => `- ${entry.id} — ${entry.title}`)
      : ["No non-expired entries."]),
    "",
  ].join("\n");
}

function exportCounts(document) {
  return Object.fromEntries(
    ["runs", "tasks", "events", "summaries", "cache"].map((name) => [
      name,
      document[name].length,
    ]),
  );
}

function packageVersion(packageRoot) {
  try {
    return (
      JSON.parse(readText(path.join(packageRoot, "package.json"), "{}"))
        .version || "0.0.0"
    );
  } catch {
    return "0.0.0";
  }
}

function renderMcpConfig(packageRoot) {
  const mcpPath = path
    .join(packageRoot, "bin", "otm-mcp.mjs")
    .replace(/\\/g, "\\\\");
  return `[mcp_servers.overtli_task_manager]
command = "node"
args = ["${mcpPath}"]
enabled = true
tool_timeout_sec = 45
startup_timeout_sec = 20

[mcp_servers.overtli_task_manager.env]
OTM_STORAGE = "auto"
`;
}

function helpText() {
  return `Overtli Task Manager

Commands:
  otm install [--workspace PATH] [--dry-run] [--with-project-mcp-config] [--agents-file AGENTS.override.md]
  otm install-global [--codex-home PATH] [--dry-run]
  otm uninstall [--workspace PATH] [--dry-run] [--confirm] [--remove-state] [--agents-file AGENTS.override.md]
  otm uninstall --global [--codex-home PATH] [--dry-run] [--confirm]
  otm version
  otm doctor [--workspace PATH] [--session-id ID] [--repair] [--dry-run] [--json]
  otm migrate [--dry-run] [--json]
  otm repair [--workspace PATH] [--dry-run] [--json]
  otm export --output PATH [--workspace PATH] [--dry-run] [--json]
  otm import --input PATH --confirm [--workspace PATH] [--dry-run] [--json]
  otm resume --run-id ID [--task-id ID] [--reason TEXT] [--workspace PATH] [--json]
  otm archive --run-id ID --confirm [--reason TEXT] [--workspace PATH] [--json]
  otm abandon --run-id ID --reason TEXT --confirm [--delete-files] [--workspace PATH] [--json]
  otm backup [--output PATH] [--dry-run] [--json]
  otm restore --input PATH --confirm [--dry-run] [--json]
  otm snapshot [--workspace PATH] [--session-id ID]
  otm status [--workspace PATH] [--session-id ID] [--json]
  otm list-runs [--workspace PATH] [--limit N] [--json]
  otm history --run-id ID [--workspace PATH] [--limit N] [--json]
  otm memory-list [--workspace PATH] [--limit N] [--json]
  otm memory-inspect --id ID [--workspace PATH] [--json]
  otm memory-purge-expired [--workspace PATH] [--dry-run] [--json]
  otm review-project [--workspace PATH] [--max-files N]
  otm clear-current [--workspace PATH] [--session-id ID] [--delete-files]
  otm cleanup [--workspace PATH] [--min-age-ms N] [--scratch-max-age-ms N] [--dry-run]
  otm prune-history [--workspace PATH] [--retention-days N] [--dry-run]
  otm mcp-config

MCP server:
  otm-mcp
`;
}

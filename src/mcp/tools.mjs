export const tools = [
  {
    name: 'otm_start',
    description: 'Start a new Overtli Task Manager route for a non-trivial Codex task. The model should analyze all available prompt/context first and pass specific tasks/internalSteps when possible. Returns chat Markdown and writes current.json/current.md.',
    inputSchema: {
      type: 'object',
      properties: {
        goal: { type: 'string' },
        prompt: { type: 'string' },
        context: { description: 'Supplemental prompt context text or structured context available to the model.', oneOf: [{ type: 'string' }, { type: 'array' }, { type: 'object' }] },
        promptContext: { description: 'Additional prompt parts, pasted content, attachment text, OCR, or guidance the model used while deriving tasks.', oneOf: [{ type: 'string' }, { type: 'array' }, { type: 'object' }] },
        attachments: { description: 'Attachment metadata or extracted text/OCR/description content. Binary data is stored only as metadata; model-derived tasks should carry the real inference.', oneOf: [{ type: 'string' }, { type: 'array' }, { type: 'object' }] },
        screenshots: { description: 'Screenshot guidance, OCR, captions, or model-visible descriptions. OTM does not inspect pixels; model-derived tasks should reflect what was visible.', oneOf: [{ type: 'string' }, { type: 'array' }, { type: 'object' }] },
        images: { description: 'Image guidance, OCR, captions, or model-visible descriptions. OTM does not inspect pixels; model-derived tasks should reflect what was visible.', oneOf: [{ type: 'string' }, { type: 'array' }, { type: 'object' }] },
        workspaceRoot: { type: 'string' },
        sessionId: { type: 'string' },
        turnId: { type: 'string' },
        replaceExisting: { type: 'boolean' },
        tasks: {
          type: 'array',
          items: { type: 'object', additionalProperties: true }
        }
      },
      required: ['goal']
    }
  },
  {
    name: 'otm_reconcile',
    description: 'Update an active route after user steering, continuation, appended tasks, dropped tasks, or route replacement. Use immediately when the user changes direction.',
    inputSchema: {
      type: 'object',
      properties: {
        workspaceRoot: { type: 'string' },
        runId: { type: 'string' },
        prompt: { type: 'string' },
        mode: { type: 'string', enum: ['append', 'steer', 'continue', 'replace'] },
        changes: { type: 'array', items: { type: 'object', additionalProperties: true } },
        tasks: { type: 'array', items: { type: 'object', additionalProperties: true } }
      }
    }
  },
  {
    name: 'otm_snapshot',
    description: 'Return the current route snapshot as Markdown and structured JSON. Use for chat-visible status updates.',
    inputSchema: { type: 'object', properties: { workspaceRoot: { type: 'string' }, runId: { type: 'string' } } }
  },
  {
    name: 'otm_start_task',
    description: 'Mark one route segment active before doing related work.',
    inputSchema: { type: 'object', properties: { workspaceRoot: { type: 'string' }, runId: { type: 'string' }, taskId: { type: 'string' }, note: { type: 'string' } }, required: ['taskId'] }
  },
  {
    name: 'otm_progress',
    description: 'Record a progress checkpoint and return a Markdown status update. Use for meaningful step-by-step chat updates.',
    inputSchema: { type: 'object', properties: { workspaceRoot: { type: 'string' }, runId: { type: 'string' }, taskId: { type: 'string' }, message: { type: 'string' }, evidence: { type: 'object', additionalProperties: true } }, required: ['message'] }
  },
  {
    name: 'otm_complete_task',
    description: 'Mark a route segment complete. Requires concrete evidence unless force=true is explicitly supplied.',
    inputSchema: { type: 'object', properties: { workspaceRoot: { type: 'string' }, runId: { type: 'string' }, taskId: { type: 'string' }, evidence: { type: 'object', additionalProperties: true }, force: { type: 'boolean' } }, required: ['taskId', 'evidence'] }
  },
  {
    name: 'otm_block_task',
    description: 'Mark a route segment blocked with blocker evidence. Use when completion is impossible without repair or user input.',
    inputSchema: { type: 'object', properties: { workspaceRoot: { type: 'string' }, runId: { type: 'string' }, taskId: { type: 'string' }, reason: { type: 'string' }, requiresUser: { type: 'boolean' }, evidence: { type: 'object', additionalProperties: true } }, required: ['taskId', 'reason'] }
  },
  {
    name: 'otm_drop_task',
    description: 'Drop or supersede a route segment when user steering makes it unnecessary.',
    inputSchema: { type: 'object', properties: { workspaceRoot: { type: 'string' }, runId: { type: 'string' }, taskId: { type: 'string' }, reason: { type: 'string' }, supersede: { type: 'boolean' } }, required: ['taskId', 'reason'] }
  },
  {
    name: 'otm_audit_stop',
    description: 'Audit whether Codex may stop. If required segments remain, continue instead of finalizing.',
    inputSchema: { type: 'object', properties: { workspaceRoot: { type: 'string' }, runId: { type: 'string' } } }
  },
  {
    name: 'otm_finalize_turn',
    description: 'Write a turn summary and checkpoint memory. Use after otm_audit_stop passes.',
    inputSchema: { type: 'object', properties: { workspaceRoot: { type: 'string' }, runId: { type: 'string' }, outcome: { type: 'string' }, nextSteps: { type: 'array', items: { type: 'string' } }, allowIncomplete: { type: 'boolean' }, clearCurrent: { type: 'boolean' }, clear: { type: 'boolean' }, deleteFiles: { type: 'boolean' } } }
  },
  {
    name: 'otm_clear_current',
    description: 'Clear active current.json/current.md after summary is saved. Defaults to a tombstone instead of deleting files.',
    inputSchema: { type: 'object', properties: { workspaceRoot: { type: 'string' }, runId: { type: 'string' }, deleteFiles: { type: 'boolean' } } }
  },
  {
    name: 'otm_cleanup_workspace',
    description: 'Clean OTM-owned workspace temp and scratch artifacts immediately. Use at final completion or when stale .tmp/scratch files clutter .codex/overtli-task-manager.',
    inputSchema: { type: 'object', properties: { workspaceRoot: { type: 'string' }, minAgeMs: { type: 'number' }, scratchMaxAgeMs: { type: 'number' } } }
  },
  {
    name: 'otm_project_review',
    description: 'Refresh the project-specific lightweight context cache by reading overview docs, AGENTS.md, memory banks, docs, manifests, PRDs, and GDDs without full source scanning.',
    inputSchema: { type: 'object', properties: { workspaceRoot: { type: 'string' }, maxFiles: { type: 'number' } } }
  },
  {
    name: 'otm_memory_search',
    description: 'Search project-specific checkpoint memory, turn summaries, and project overview cache for continuation context.',
    inputSchema: { type: 'object', properties: { workspaceRoot: { type: 'string' }, query: { type: 'string' }, limit: { type: 'number' } }, required: ['query'] }
  },
  {
    name: 'otm_memory_upsert',
    description: 'Create or update project-specific memory. Use for durable decisions, checkpoints, and concise context that should survive later turns.',
    inputSchema: { type: 'object', properties: { workspaceRoot: { type: 'string' }, id: { type: 'string' }, kind: { type: 'string' }, title: { type: 'string' }, body: { type: 'string' }, tags: { type: 'array', items: { type: 'string' } }, source: { type: 'object', additionalProperties: true } }, required: ['title', 'body'] }
  },
  {
    name: 'otm_memory_delete',
    description: 'Delete stale project memory by id, kind, or tag.',
    inputSchema: { type: 'object', properties: { workspaceRoot: { type: 'string' }, id: { type: 'string' }, kind: { type: 'string' }, tag: { type: 'string' } } }
  },
  {
    name: 'otm_install_workspace',
    description: 'Idempotently install OTM into the current repository: AGENTS.md managed block, .agents/skills, .codex/hooks.json, and gitignore entries. Optionally add project MCP config.',
    inputSchema: { type: 'object', properties: { workspaceRoot: { type: 'string' }, dryRun: { type: 'boolean' }, installMcpConfig: { type: 'boolean' }, targetAgentsFile: { type: 'string' } } }
  },
  {
    name: 'otm_doctor',
    description: 'Diagnose OTM storage, active route, current.json, and install state.',
    inputSchema: { type: 'object', properties: { workspaceRoot: { type: 'string' } } }
  }
];

export const MANAGER_NAME = 'Overtli Task Manager';
export const SERVER_NAME = 'overtli_task_manager';
export const VERSION = '0.1.0';
export const CURRENT_SCHEMA_VERSION = 'otm.current.v1';
export const CURRENT_INDEX_SCHEMA_VERSION = 'otm.current-index.v1';
export const PROJECT_SCHEMA_VERSION = 'otm.project.v1';
export const CHECKPOINT_SCHEMA_VERSION = 'otm.checkpoint.v1';
export const WORKSPACE_DIR = '.codex/overtli-task-manager';
export const SUMMARY_DIR = '.codex/overtli-task-manager/summaries';
export const CACHE_DIR = '.codex/overtli-task-manager/cache';
export const AGENTS_BLOCK_BEGIN = '<!-- OVERTLI-TASK-MANAGER:BEGIN v1 -->';
export const AGENTS_BLOCK_END = '<!-- OVERTLI-TASK-MANAGER:END -->';
export const MCP_BLOCK_BEGIN = '# OVERTLI-TASK-MANAGER:MCP:BEGIN v1';
export const MCP_BLOCK_END = '# OVERTLI-TASK-MANAGER:MCP:END';

export const TASK_STATUSES = new Set(['pending', 'active', 'done', 'blocked', 'dropped', 'superseded']);
export const RUN_STATUSES = new Set(['active', 'completed', 'blocked', 'paused', 'cleared', 'abandoned']);

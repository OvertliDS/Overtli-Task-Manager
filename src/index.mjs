export { createTaskManager } from "./core/manager.mjs";
export { runMcpServer } from "./mcp/server.mjs";
export { runHookScript } from "./hooks/runner.mjs";
export { installWorkspace } from "./install/install-workspace.mjs";
export { uninstallWorkspace } from "./install/uninstall-workspace.mjs";
export { uninstallGlobal } from "./install/uninstall-global.mjs";
export { createProviderAdapter, PROVIDER_ADAPTER_API_VERSION } from "./core/provider-adapter.mjs";
export {
  CONTINUATION_MIN_IDLE_MS,
  HOST_CONTINUATION_EVIDENCE_SCHEMA,
  HOST_CONTINUATION_REQUIRED_SOURCES,
  evaluateContinuation,
  loadHostEvidenceModule,
  loadHostEvidenceInspector,
  validateHostContinuationEvidence,
} from "./core/continuation.mjs";
export {
  buildClaudeHookEntries,
  installClaudeHooks,
  mergeClaudeHookSettings,
  resolveClaudeUserSettingsPath,
  rollbackClaudeHooks,
} from "./install/claude-settings.mjs";

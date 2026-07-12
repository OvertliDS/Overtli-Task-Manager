#!/usr/bin/env node
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  installGlobal,
  renderGlobalInstallResult,
} from "../src/install/install-global.mjs";

/** @param {any} options */
export function shouldAutoInstallGlobal(options = {}) {
  const { env = process.env } = options;
  // Package installation is not authority to mutate the user's global Codex
  // configuration. Global setup requires a conscious environment opt-in.
  return env.OTM_AUTO_INSTALL_GLOBAL === "1" && !env.CI;
}

/** @param {any} options */
export function runPostinstall(options = {}) {
  const { packageRoot, env = process.env } = options;
  const codexHome = path.resolve(
    env.CODEX_HOME || path.join(os.homedir(), ".codex"),
  );
  if (!shouldAutoInstallGlobal({ packageRoot, codexHome, env })) {
    return {
      installed: false,
      message:
        "Skipping global OTM setup. Run otm install-global or set OTM_AUTO_INSTALL_GLOBAL=1 explicitly.",
    };
  }
  const result = installGlobal({ codexHome, packageRoot, env });
  return {
    installed: true,
    result,
    message: renderGlobalInstallResult(result),
  };
}

const packageRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
if (path.resolve(process.argv[1] || "") === fileURLToPath(import.meta.url)) {
  const outcome = runPostinstall({ packageRoot });
  process.stdout.write(
    outcome.installed ? outcome.message : `${outcome.message}\n`,
  );
}

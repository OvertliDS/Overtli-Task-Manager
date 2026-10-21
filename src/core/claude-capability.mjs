import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { getHomeDir } from "./fs-utils.mjs";
import { OtmError } from "./errors.mjs";
import { canonicalizeWorkspaceRoot } from "./validation.mjs";
import { createProviderSession } from "./provider-session.mjs";

export const CLAUDE_SESSION_CAPABILITY_VERSION =
  "otm.claude-session-capability.v1";
export const DEFAULT_CLAUDE_CAPABILITY_TTL_MS = 30 * 60 * 1000;
export const MAX_CLAUDE_CAPABILITY_TTL_MS = 60 * 60 * 1000;
const KEY_FILE_NAME = "claude-session-capability.key";
const MAX_TOKEN_LENGTH = 8192;

/**
 * Issue a short-lived bearer capability from an official Claude hook payload.
 * The token contains the opaque OTM session mapping, never Claude's raw UUID.
 */
export function issueClaudeSessionCapability({
  nativeSessionId,
  workspaceRoot,
  env = process.env,
  now = Date.now(),
  ttlMs = DEFAULT_CLAUDE_CAPABILITY_TTL_MS,
} = {}) {
  if (!Number.isFinite(now) || !Number.isSafeInteger(now)) {
    throw new OtmError("Capability issue time must be an integer timestamp.", {
      code: "CLAUDE_CAPABILITY_INPUT_INVALID",
    });
  }
  if (
    !Number.isSafeInteger(ttlMs) ||
    ttlMs <= 0 ||
    ttlMs > MAX_CLAUDE_CAPABILITY_TTL_MS
  ) {
    throw new OtmError(
      "Claude session capability lifetime is outside the allowed range.",
      {
        code: "CLAUDE_CAPABILITY_TTL_INVALID",
      },
    );
  }
  const session = createProviderSession({
    provider: "claude",
    nativeSessionId,
  });
  const workspace = canonicalizeWorkspaceRoot(workspaceRoot);
  const claims = {
    version: CLAUDE_SESSION_CAPABILITY_VERSION,
    provider: session.provider,
    sessionId: session.sessionId,
    providerSessionKey: session.providerSessionKey,
    nativeSessionId: nativeSessionId.trim(),
    workspaceRoot: workspace.displayPath,
    workspaceId: workspace.persistedId,
    issuedAt: now,
    expiresAt: now + ttlMs,
    nonce: crypto.randomBytes(16).toString("base64url"),
  };
  const key = readCapabilityKey(env);
  const encoded = encryptClaims(claims, key);
  const signature = sign(encoded, key);
  return `otm1.${encoded}.${signature}`;
}

/** Verify signature, expiry, provider and canonical workspace scope. */
export function verifyClaudeSessionCapability(
  token,
  { env = process.env, now = Date.now() } = {},
) {
  if (typeof token !== "string" || token.length > MAX_TOKEN_LENGTH) {
    throw invalidCapability();
  }
  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== "otm1" || !parts[1] || !parts[2]) {
    throw invalidCapability();
  }
  // Node's base64url decoder accepts noncanonical final bits and ignored characters.
  // Require the exact canonical encoding, not merely matching decoded bytes.
  if (!/^[A-Za-z0-9_-]+$/.test(parts[1]) || !/^[A-Za-z0-9_-]+$/.test(parts[2]))
    throw invalidCapability();
  const key = readCapabilityKey(env);
  const expected = Buffer.from(sign(parts[1], key), "base64url");
  let supplied;
  try {
    supplied = Buffer.from(parts[2], "base64url");
  } catch {
    throw invalidCapability();
  }
  if (
    supplied.toString("base64url") !== parts[2] ||
    expected.length !== supplied.length ||
    !crypto.timingSafeEqual(expected, supplied)
  ) {
    throw invalidCapability();
  }
  let claims;
  try {
    claims = decryptClaims(parts[1], key);
  } catch {
    throw invalidCapability();
  }
  if (!isValidClaims(claims, now)) throw invalidCapability();
  const workspace = canonicalizeWorkspaceRoot(claims.workspaceRoot);
  if (
    workspace.displayPath !== claims.workspaceRoot ||
    workspace.persistedId !== claims.workspaceId
  ) {
    throw invalidCapability();
  }
  return Object.freeze({ ...claims });
}

export function capabilityKeyPath(env = process.env) {
  const stateDir = env.OTM_STATE_DIR || getHomeDir(env);
  return path.join(path.resolve(stateDir), KEY_FILE_NAME);
}

function isValidClaims(value, now) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const match = /^otm-provider:claude:v1:([a-f0-9]{64})$/.exec(
    value.sessionId || "",
  );
  const digest = match?.[1];
  const valid = Boolean(
    value.version === CLAUDE_SESSION_CAPABILITY_VERSION &&
    value.provider === "claude" &&
    typeof value.nativeSessionId === "string" &&
    value.nativeSessionId.length > 0 &&
    digest &&
    value.providerSessionKey === `claude:${digest}` &&
    typeof value.workspaceRoot === "string" &&
    value.workspaceRoot.length > 0 &&
    typeof value.workspaceId === "string" &&
    value.workspaceId.length > 0 &&
    Number.isSafeInteger(value.issuedAt) &&
    Number.isSafeInteger(value.expiresAt) &&
    value.issuedAt <= now + 60_000 &&
    value.expiresAt > now &&
    value.expiresAt > value.issuedAt &&
    value.expiresAt - value.issuedAt <= MAX_CLAUDE_CAPABILITY_TTL_MS &&
    typeof value.nonce === "string" &&
    /^[A-Za-z0-9_-]{22}$/.test(value.nonce),
  );
  if (!valid) return false;
  try {
    const derived = createProviderSession({
      provider: "claude",
      nativeSessionId: value.nativeSessionId,
    });
    return (
      derived.sessionId === value.sessionId &&
      derived.providerSessionKey === value.providerSessionKey
    );
  } catch {
    return false;
  }
}

function encryptClaims(claims, key) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(
    "aes-256-gcm",
    deriveEncryptionKey(key),
    iv,
  );
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(claims), "utf8"),
    cipher.final(),
  ]);
  return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString(
    "base64url",
  );
}

function decryptClaims(encoded, key) {
  const bytes = Buffer.from(encoded, "base64url");
  if (bytes.length < 29) throw new Error("invalid capability payload");
  const iv = bytes.subarray(0, 12);
  const tag = bytes.subarray(12, 28);
  const ciphertext = bytes.subarray(28);
  const decipher = crypto.createDecipheriv(
    "aes-256-gcm",
    deriveEncryptionKey(key),
    iv,
  );
  decipher.setAuthTag(tag);
  const plain = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return JSON.parse(plain.toString("utf8"));
}

function deriveEncryptionKey(key) {
  return Buffer.from(
    crypto.hkdfSync(
      "sha256",
      key,
      Buffer.from("overtli-task-manager"),
      Buffer.from("claude-session-capability-encryption"),
      32,
    ),
  );
}

function readCapabilityKey(env) {
  const keyPath = capabilityKeyPath(env);
  fs.mkdirSync(path.dirname(keyPath), { recursive: true, mode: 0o700 });
  let descriptor;
  try {
    descriptor = fs.openSync(keyPath, "wx", 0o600);
    const key = crypto.randomBytes(32);
    fs.writeSync(descriptor, key);
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    protectKeyFile(keyPath);
    return key;
  } catch (error) {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    if (error?.code !== "EEXIST") {
      try {
        fs.unlinkSync(keyPath);
      } catch {}
      throw new OtmError(
        "Unable to create the private Claude session capability key.",
        {
          code: "CLAUDE_CAPABILITY_KEY_UNAVAILABLE",
        },
      );
    }
  }

  let stat;
  try {
    stat = fs.lstatSync(keyPath);
  } catch {
    throw new OtmError(
      "The private Claude session capability key is unavailable.",
      {
        code: "CLAUDE_CAPABILITY_KEY_UNAVAILABLE",
      },
    );
  }
  if (!stat.isFile() || stat.isSymbolicLink()) throw invalidCapability();
  try {
    const key = fs.readFileSync(keyPath);
    if (key.length !== 32) throw new Error("invalid key size");
    protectKeyFile(keyPath);
    return key;
  } catch {
    throw new OtmError(
      "The private Claude session capability key could not be read safely.",
      {
        code: "CLAUDE_CAPABILITY_KEY_UNAVAILABLE",
      },
    );
  }
}

// Resolve Windows tools from System32 so a GNU whoami/icacls earlier on PATH
// (Git Bash, MSYS) cannot break or spoof key protection.
function windowsSystemTool(name) {
  return path.join(
    process.env.SystemRoot || process.env.windir || "C:\\Windows",
    "System32",
    name,
  );
}

function protectKeyFile(keyPath) {
  if (process.platform !== "win32") {
    fs.chmodSync(keyPath, 0o600);
    return;
  }
  const who = spawnSync(
    windowsSystemTool("whoami.exe"),
    ["/user", "/fo", "csv", "/nh"],
    { encoding: "utf8", windowsHide: true, timeout: 5000 },
  );
  if (who.status !== 0)
    throw new Error("unable to resolve current Windows account");
  const identity = /^\s*"([^"]+)"\s*,\s*"(S-1-\d+(?:-\d+)+)"\s*$/m.exec(
    who.stdout,
  );
  const account = identity?.[1];
  const sid = identity?.[2];
  if (!account || !sid)
    throw new Error("unable to resolve current Windows account SID");
  const acl = spawnSync(
    windowsSystemTool("icacls.exe"),
    [keyPath, "/inheritance:r", "/grant:r", `*${sid}:(F)`],
    { encoding: "utf8", windowsHide: true, timeout: 5000 },
  );
  if (acl.status !== 0)
    throw new Error("unable to restrict Windows capability key ACL");
  const verified = spawnSync(windowsSystemTool("icacls.exe"), [keyPath], {
    encoding: "utf8",
    windowsHide: true,
    timeout: 5000,
  });
  if (verified.status !== 0)
    throw new Error("unable to verify Windows capability key ACL");
  const [firstLine = "", ...remainingLines] = verified.stdout.split(/\r?\n/);
  if (!firstLine.toLowerCase().startsWith(keyPath.toLowerCase())) {
    throw new Error(
      "Windows capability key ACL output could not be matched to the key file",
    );
  }
  const aclLines = [
    firstLine.slice(keyPath.length).trim(),
    ...remainingLines,
  ].filter((line) => line && !line.startsWith("Successfully processed"));
  const entries = aclLines.flatMap((line) => [
    ...line.matchAll(/^\s*([^\r\n]+?):\(([^)]*)\)\s*$/g),
  ]);
  if (
    entries.length !== 1 ||
    ![sid, account].some(
      (expected) =>
        expected.toLowerCase() === entries[0][1].trim().toLowerCase(),
    ) ||
    entries[0][2] !== "F"
  ) {
    throw new Error(
      "Windows capability key ACL grants access beyond the current user",
    );
  }
}

function sign(encodedClaims, key) {
  return crypto
    .createHmac("sha256", key)
    .update(encodedClaims, "ascii")
    .digest("base64url");
}

function invalidCapability() {
  return new OtmError(
    "Claude OTM session capability is invalid, expired, or bound to another host context. Submit a new prompt to refresh it.",
    { code: "CLAUDE_SESSION_CAPABILITY_INVALID" },
  );
}

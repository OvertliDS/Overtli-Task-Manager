#!/usr/bin/env node
import net from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { StringDecoder } from "node:string_decoder";
import { runMcpServer } from "../src/mcp/server.mjs";
const host = "127.0.0.1",
  port = Number(process.env.OTM_BROKER_PORT || 18989);
const tokenFile =
  process.env.OTM_BROKER_TOKEN_FILE ||
  path.join(
    process.env.LOCALAPPDATA || path.join(os.homedir(), ".codex"),
    "Overtli",
    "TaskManager",
    "broker-token",
  );
fs.mkdirSync(path.dirname(tokenFile), { recursive: true, mode: 0o700 });
try {
  fs.writeFileSync(tokenFile, crypto.randomBytes(32).toString("hex"), {
    flag: "wx",
    mode: 0o600,
  });
} catch (err) {
  if (err?.code !== "EEXIST") throw err;
}
const token = fs.readFileSync(tokenFile, "utf8").trim();
if (!/^[a-f0-9]{64}$/i.test(token)) throw Error("Invalid broker token");
const authed = (v) =>
  typeof v === "string" &&
  /^[a-f0-9]{64}$/i.test(v) &&
  crypto.timingSafeEqual(Buffer.from(v, "hex"), Buffer.from(token, "hex"));
function safeEnv(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw))
    throw Error("Invalid context");
  const env = { ...process.env };
  for (const [k, v] of Object.entries(raw)) {
    if (!/^(?:CODEX_THREAD_ID|OTM_[A-Z0-9_]+)$/.test(k)) continue;
    if (typeof v !== "string" || v.length > 8192)
      throw Error("Invalid client env");
    env[k] = v;
  }
  return env;
}
class SocketTransport {
  constructor(sock) {
    this.sock = sock;
    this.onmessage = undefined;
    this.onclose = undefined;
    this.onerror = undefined;
    this.buffer = "";
    this.decoder = new StringDecoder("utf8");
    this.started = false;
  }
  async start() {
    if (this.started) throw Error("Already started");
    this.started = true;
    this.sock.on("data", (chunk) => {
      this.buffer += this.decoder.write(chunk);
      if (Buffer.byteLength(this.buffer, "utf8") > 10485760) {
        this.sock.destroy();
        return;
      }
      let idx;
      while ((idx = this.buffer.indexOf("\n")) >= 0) {
        const line = this.buffer.slice(0, idx).trim();
        this.buffer = this.buffer.slice(idx + 1);
        if (!line) continue;
        try {
          this.onmessage?.(JSON.parse(line));
        } catch (err) {
          this.onerror?.(err);
          this.sock.destroy();
          return;
        }
      }
    });
    this.sock.on("error", (err) => this.onerror?.(err));
    this.sock.on("close", () => this.onclose?.());
  }
  async send(message) {
    if (this.sock.destroyed) throw Error("Socket closed");
    return new Promise((resolve, reject) =>
      this.sock.write(JSON.stringify(message) + "\n", (err) =>
        err ? reject(err) : resolve(),
      ),
    );
  }
  async close() {
    if (!this.sock.destroyed) this.sock.destroy();
  }
}
const clients = new Set();
const server = net.createServer((sock) => {
  if (clients.size >= 128) {
    sock.end("ERROR capacity\n");
    return;
  }
  if (sock.remoteAddress !== "127.0.0.1" && sock.remoteAddress !== "::1") {
    sock.destroy();
    return;
  }
  sock.setNoDelay(true);
  sock.setTimeout(5000, () => sock.destroy());
  let received = "";
  const decoder = new StringDecoder("utf8");
  const handshaking = (chunk) => {
    received += decoder.write(chunk);
    if (Buffer.byteLength(received, "utf8") > 16384) {
      sock.destroy();
      return;
    }
    const idx = received.indexOf("\n");
    if (idx < 0) return;
    sock.removeListener("data", handshaking);
    if (received.slice(idx + 1).trim()) {
      sock.destroy();
      return;
    }
    let hello;
    try {
      hello = JSON.parse(received.slice(0, idx));
    } catch {
      sock.destroy();
      return;
    }
    if (!authed(hello.token)) {
      sock.end("ERROR authentication\n");
      return;
    }
    if (hello.type === "health") {
      sock.end(
        JSON.stringify({ ok: true, clients: clients.size, pid: process.pid }) +
          "\n",
      );
      return;
    }
    if (hello.type !== "open") {
      sock.end("ERROR handshake\n");
      return;
    }
    let env, cwd;
    try {
      if (typeof hello.cwd !== "string" || !path.isAbsolute(hello.cwd))
        throw Error("cwd");
      cwd = fs.realpathSync.native(hello.cwd);
      if (!fs.statSync(cwd).isDirectory()) throw Error("cwd");
      env = safeEnv(hello.env);
    } catch {
      sock.end("ERROR client context\n");
      return;
    }
    sock.setTimeout(0);
    clients.add(sock);
    sock.once("close", () => clients.delete(sock));
    runMcpServer({ env, cwd, transport: new SocketTransport(sock) })
      .then(() => {
        if (!sock.destroyed) sock.write("OK\n");
      })
      .catch((err) => {
        console.error(
          "[OTM Broker] Init failed:",
          err?.code || err?.name || "error",
        );
        sock.destroy();
      });
  };
  sock.on("data", handshaking);
  sock.on("error", () => {});
});
server.on("error", (err) => {
  console.error("[OTM Broker] Bind failed:", err.message);
  process.exitCode = 1;
});
server.listen({ host, port, exclusive: true }, () =>
  console.error("[OTM Broker] Ready " + host + ":" + port),
);
function shutdown() {
  server.close();
  for (const client of clients) client.destroy();
}
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);

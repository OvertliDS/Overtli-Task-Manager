import "./support/temp-cleanup.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const brokerFile = path.join(root, "bin", "otm-broker.mjs");
const proxyFile = path.join(root, "bin", "otm-proxy.py");
const python =
  process.env.OTM_TEST_PYTHON ||
  (process.platform === "win32" ? "C:\\Python314\\python.exe" : "python3");
function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const p = s.address().port;
      s.close(() => resolve(p));
    });
  });
}
async function waitForPort(port, deadlineMs = 8000) {
  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline) {
    try {
      await new Promise((resolve, reject) => {
        const s = net.connect({ host: "127.0.0.1", port });
        s.once("connect", () => {
          s.destroy();
          resolve();
        });
        s.once("error", reject);
      });
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 70));
    }
  }
  throw Error("Broker did not open loopback port");
}
async function health(port, secret) {
  const socket = net.connect({ host: "127.0.0.1", port });
  let buffer = "";
  return await new Promise((resolve, reject) => {
    socket.on("connect", () =>
      socket.write(JSON.stringify({ type: "health", token: secret }) + "\n"),
    );
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      if (buffer.includes("\n")) {
        socket.end();
        try {
          resolve(JSON.parse(buffer.split("\n")[0]));
        } catch (err) {
          reject(err);
        }
      }
    });
    socket.on("error", reject);
  });
}
test(
  "shared OTM broker preserves concurrent Codex session identity, stdio compatibility and reaps clients",
  { timeout: 35000 },
  async (t) => {
    if (!fs.existsSync(proxyFile) || !fs.existsSync(brokerFile)) {
      t.skip("shared broker not installed");
      return;
    }
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "otm-broker-test-"));
    const workspace = path.join(tmp, "workspace");
    fs.mkdirSync(workspace);
    const storage = path.join(tmp, "storage");
    fs.mkdirSync(storage);
    const keyFile = path.join(tmp, "private", "token");
    const port = await freePort();
    const broker = spawn(process.execPath, [brokerFile], {
      cwd: root,
      env: {
        ...process.env,
        OTM_BROKER_PORT: String(port),
        OTM_BROKER_TOKEN_FILE: keyFile,
      },
      stdio: ["ignore", "ignore", "pipe"],
      windowsHide: true,
    });
    let clientA, clientB;
    try {
      await waitForPort(port);
      const secret = fs.readFileSync(keyFile, "utf8").trim();
      async function connect(id) {
        const transport = new StdioClientTransport({
          command: python,
          args: [proxyFile],
          cwd: workspace,
          env: {
            ...process.env,
            OTM_BROKER_PORT: String(port),
            OTM_BROKER_TOKEN_FILE: keyFile,
            CODEX_THREAD_ID: id,
            OTM_SESSION_ID: id,
            OTM_STORAGE: "json",
            OTM_STATE_DIR: storage,
          },
        });
        const client = new Client(
          { name: "otm-shared-broker-test", version: "1.0.0" },
          { capabilities: {} },
        );
        await client.connect(transport);
        return client;
      }
      clientA = await connect("broker-alpha-regression");
      clientB = await connect("broker-beta-regression");
      const status = await health(port, secret);
      assert.equal(status.ok, true);
      assert.equal(status.clients, 2);
      const list = await clientA.listTools();
      assert.ok(list.tools.some((item) => item.name === "otm_snapshot"));
      await clientA.callTool({
        name: "otm_start",
        arguments: {
          goal: "Broker regression alpha route",
          workspaceRoot: workspace,
        },
      });
      await clientB.callTool({
        name: "otm_start",
        arguments: {
          goal: "Broker regression beta route",
          workspaceRoot: workspace,
        },
      });
      const alpha = JSON.stringify(
        await clientA.callTool({
          name: "otm_snapshot",
          arguments: { workspaceRoot: workspace },
        }),
      );
      const beta = JSON.stringify(
        await clientB.callTool({
          name: "otm_snapshot",
          arguments: { workspaceRoot: workspace },
        }),
      );
      assert.match(alpha, /Broker regression alpha route/);
      assert.doesNotMatch(alpha, /Broker regression beta route/);
      assert.match(beta, /Broker regression beta route/);
      assert.doesNotMatch(beta, /Broker regression alpha route/);
    } finally {
      await Promise.allSettled([clientA?.close(), clientB?.close()]);
      broker.kill();
      try {
        await new Promise((resolve) => broker.once("exit", resolve));
      } catch {}
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  },
);

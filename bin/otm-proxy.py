#!/usr/bin/env python3
"""Lightweight stdio client: retain each Codex thread's OTM state through one broker."""
import json
import os
from pathlib import Path
import socket
import subprocess
import sys
import threading

HOST = "127.0.0.1"
PORT = int(os.environ.get("OTM_BROKER_PORT", "18989"))
TOKEN_FILE = Path(os.environ.get("OTM_BROKER_TOKEN_FILE") or
                  str(Path(os.environ.get("LOCALAPPDATA", str(Path.home() / ".codex"))) /
                      "Overtli" / "TaskManager" / "broker-token"))

def fallback():
    """Do not fail task management if the shared process is unavailable."""
    legacy = Path(__file__).resolve().with_name("otm-mcp.mjs")
    node = os.environ.get("OTM_NODE_EXE", r"C:\nvm4w\nodejs\node.exe")
    print("[OTM] Shared backend unavailable; using session-isolated stdio.",
          file=sys.stderr, flush=True)
    try:
        return subprocess.call([node, str(legacy)], cwd=os.getcwd(),
                               stdin=sys.stdin, stdout=sys.stdout, stderr=sys.stderr,
                               env=os.environ.copy())
    except OSError:
        return 1

def connect():
    token = TOKEN_FILE.read_text(encoding="utf-8").strip()
    if len(token) != 64:
        raise OSError("Invalid broker token")
    client_env = {k: v for k, v in os.environ.items()
                  if k == "CODEX_THREAD_ID" or k.startswith("OTM_")}
    hello = {"type": "open", "token": token, "cwd": os.getcwd(), "env": client_env}
    sock = socket.create_connection((HOST, PORT), timeout=2)
    sock.settimeout(5)
    sock.sendall(json.dumps(hello, separators=(",", ":")).encode("utf-8") + b"\n")
    response = b""
    while not response.endswith(b"\n"):
        chunk = sock.recv(64)
        if not chunk or len(response) + len(chunk) > 256:
            raise OSError("Invalid broker response")
        response += chunk
    if response != b"OK\n":
        raise OSError("Broker refused client connection")
    sock.settimeout(None)
    return sock

def main():
    try:
        sock = connect()
    except (OSError, ValueError, TimeoutError):
        return fallback()

    def stdin_to_socket():
        try:
            while True:
                line = sys.stdin.buffer.readline()
                if not line:
                    break
                sock.sendall(line)
        except (OSError, ValueError):
            pass
        finally:
            try:
                sock.shutdown(socket.SHUT_WR)
            except OSError:
                pass

    threading.Thread(target=stdin_to_socket, daemon=True).start()
    try:
        while True:
            data = sock.recv(65536)
            if not data:
                break
            sys.stdout.buffer.write(data)
            sys.stdout.buffer.flush()
    except (OSError, BrokenPipeError):
        return 1
    finally:
        sock.close()
    return 0

if __name__ == "__main__":
    raise SystemExit(main())

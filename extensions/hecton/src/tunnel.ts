/**
 * SSH tunnel: forwards 127.0.0.1:<localPort> to the instance's Ollama on
 * port 11434. The tunnel process is spawned from pi and stopped on
 * session_shutdown; a health probe makes reattachment idempotent (an
 * orphaned tunnel from a crashed pi is reused, not duplicated).
 */

import { spawn, type ChildProcess } from "node:child_process";

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function fetchWithTimeout(url: string, timeoutMs: number, init?: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

export class SshTunnel {
  private proc?: ChildProcess;

  constructor(
    readonly host: string,
    readonly port: number,
    readonly localPort: number,
  ) {}

  /** True when something is already serving Ollama on the local port. */
  async healthy(timeoutMs: number = 3000): Promise<boolean> {
    try {
      const res = await fetchWithTimeout(`http://127.0.0.1:${this.localPort}/api/tags`, timeoutMs);
      return res.ok;
    } catch {
      return false;
    }
  }

  async waitHealthy(timeoutMs: number = 90_000, intervalMs: number = 3000): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await this.healthy(2500)) return true;
      await sleep(intervalMs);
    }
    return false;
  }

  /** Start the tunnel unless one is already healthy. */
  async start(): Promise<void> {
    if (await this.healthy(1000)) return;
    const args = [
      "-o",
      "ExitOnForwardFailure=yes",
      "-o",
      "ServerAliveInterval=30",
      "-o",
      "ServerAliveCountMax=4",
      "-o",
      "StrictHostKeyChecking=accept-new",
      // Never prompt: OpenSSH reads passwords from the controlling TTY,
      // which would hijack the pi TUI. Fail instead; key auth or nothing.
      "-o",
      "BatchMode=yes",
      "-o",
      "PasswordAuthentication=no",
      "-o",
      "PreferredAuthentications=publickey",
      "-N",
      "-p",
      String(this.port),
      "-L",
      `127.0.0.1:${this.localPort}:localhost:11434`,
      `root@${this.host}`,
    ];
    this.proc = spawn("ssh", args, { stdio: "ignore" });
    this.proc.unref();
    this.proc.on("exit", () => {
      this.proc = undefined;
    });
  }

  stop(): void {
    this.proc?.kill("SIGTERM");
    this.proc = undefined;
  }
}
/**
 * Persistent hecton state: the current instance record and a session cost
 * ledger. Stored at ~/.pi/agent/hecton/state.json (atomic writes).
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface InstanceRecord {
  id: number;
  publicIp: string;
  sshPort: number;
  pricePerHour: number;
  launchedAt: number; // epoch ms
  image: string;
  diskGb: number;
  gpuName: string;
  gpuCount: number;
}

export interface CostRecord {
  instanceId: number;
  startedAt: number;
  endedAt: number;
  costUsd: number;
  note?: string;
}

export interface HectonState {
  instance?: InstanceRecord;
  ledger: CostRecord[];
}

const MAX_LEDGER = 500;

export function stateDir(): string {
  return join(homedir(), ".pi", "agent", "hecton");
}

export function statePath(): string {
  return join(stateDir(), "state.json");
}

export function loadState(): HectonState {
  const p = statePath();
  if (!existsSync(p)) return { ledger: [] };
  try {
    const parsed = JSON.parse(readFileSync(p, "utf8")) as Partial<HectonState>;
    return {
      instance: parsed.instance,
      ledger: Array.isArray(parsed.ledger) ? parsed.ledger : [],
    };
  } catch {
    return { ledger: [] };
  }
}

export function saveState(state: HectonState): void {
  mkdirSync(stateDir(), { recursive: true });
  if (state.ledger.length > MAX_LEDGER) {
    state.ledger = state.ledger.slice(-MAX_LEDGER);
  }
  const tmp = `${statePath()}.tmp`;
  writeFileSync(tmp, JSON.stringify(state, null, 2));
  renameSync(tmp, statePath());
}
/**
 * Pure cost math. No I/O, fully unit-testable.
 */

import type { CostRecord } from "./state.ts";

export interface CostBreakdown {
  elapsedMs: number;
  elapsedHours: number;
  costUsd: number;
}

/** Compute cost of a running instance. dph_total covers GPU+CPU+disk. */
export function estimateCost(pricePerHour: number, launchedAt: number, now: number = Date.now()): CostBreakdown {
  const elapsedMs = Math.max(0, now - launchedAt);
  const elapsedHours = elapsedMs / 3_600_000;
  return { elapsedMs, elapsedHours, costUsd: elapsedHours * pricePerHour };
}

export function formatUsd(n: number): string {
  return `$${n.toFixed(2)}`;
}

export function formatElapsed(ms: number): string {
  const totalMinutes = Math.floor(ms / 60_000);
  const h = Math.floor(totalMinutes / 60);
  const m = totalMinutes % 60;
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

/** Sum ledger costs recorded in the current calendar month. */
export function monthlySpend(ledger: CostRecord[], now: Date = new Date()): number {
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
  return ledger.filter((r) => r.endedAt >= monthStart).reduce((sum, r) => sum + r.costUsd, 0);
}
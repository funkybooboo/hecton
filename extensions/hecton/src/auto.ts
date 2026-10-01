/**
 * Auto-lifecycle logic for hecton: idle decision + external-use detection.
 * Pure where possible; the event/timer wiring lives in index.ts.
 */

import { fetchWithTimeout } from "./tunnel.ts";

export type IdleAction = "none" | "warn" | "destroy";

export interface IdleInputs {
  now: number;
  /** Last hecton activity (any pi event while a hecton model was active). 0 = never. */
  lastActivity: number;
  /** Instance launch time; acts as an activity floor. */
  launchedAt: number;
  /** Pull grace window end (epoch ms); the countdown pauses while set. 0 = none. */
  pullingUntil: number;
  /** Idle minutes before destroy. 0 disables auto-down entirely. */
  autoDownIdleMinutes: number;
  /** How many minutes before destroy the warning fires. */
  warnMinutes: number;
}

export interface IdleDecision {
  action: IdleAction;
  idleMinutes: number;
  /** Minutes until destroy (0 once destroy is due). */
  destroyInMinutes: number;
}

/**
 * Decide what the idle guard should do right now. The countdown is anchored
 * to max(lastActivity, launchedAt) so a fresh launch never reads as idle,
 * and it pauses entirely while a model pull grace window is active.
 */
export function idleDecision(i: IdleInputs): IdleDecision {
  if (i.autoDownIdleMinutes <= 0) return { action: "none", idleMinutes: 0, destroyInMinutes: 0 };
  if (i.now < i.pullingUntil) return { action: "none", idleMinutes: 0, destroyInMinutes: 0 };
  const last = Math.max(i.lastActivity, i.launchedAt);
  const idleMinutes = Math.max(0, (i.now - last) / 60_000);
  const destroyInMinutes = Math.max(0, i.autoDownIdleMinutes - idleMinutes);
  if (idleMinutes >= i.autoDownIdleMinutes) return { action: "destroy", idleMinutes, destroyInMinutes: 0 };
  const warnAt = i.autoDownIdleMinutes - i.warnMinutes;
  if (idleMinutes >= warnAt) return { action: "warn", idleMinutes, destroyInMinutes };
  return { action: "none", idleMinutes, destroyInMinutes };
}

/**
 * True when a model loaded on the instance was used in roughly the last
 * 2 minutes by something OTHER than this pi session (e.g. a curl, another
 * laptop through its own tunnel). The server image bakes
 * OLLAMA_KEEP_ALIVE=30m, so an expires_at more than ~28 minutes out means
 * a request landed very recently; that external activity keeps the
 * instance alive.
 */
export async function externalUseRecent(localPort: number, now: number = Date.now()): Promise<boolean> {
  try {
    const res = await fetchWithTimeout(`http://127.0.0.1:${localPort}/api/ps`, 2500);
    if (!res.ok) return false;
    const json = (await res.json()) as { models?: Array<{ expires_at?: string }> };
    return (json.models ?? []).some((m) => {
      const exp = m.expires_at ? Date.parse(m.expires_at) : NaN;
      return Number.isFinite(exp) && exp - now > 28 * 60_000;
    });
  } catch {
    return false;
  }
}
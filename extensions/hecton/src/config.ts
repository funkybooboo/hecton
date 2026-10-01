/**
 * Hecton configuration.
 *
 * Config file: ~/.pi/agent/hecton.json (JSON, all fields optional, merged over
 * defaults). See extensions/hecton/hecton.example.json.
 *
 * The Vast.ai API key resolves from the config file ("apiKey") or an
 * environment variable (apiKeyEnv, default VAST_API_KEY).
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
export interface ModelConfig {
  /** Ollama model tag, e.g. "qwen3-coder:30b". */
  id: string;
  /** Display name in /model. Defaults to id. */
  name?: string;
  /** Context window pi should assume; Ollama does not report this over /v1. */
  contextWindow?: number;
  /** Max output tokens pi should assume. */
  maxTokens?: number;
  /** Whether the model emits reasoning content. */
  reasoning?: boolean;
}

export interface HectonConfig {
  /** Vast.ai API key literal (alternative to the env var). */
  apiKey?: string;
  /** Environment variable to read the key from. */
  apiKeyEnv: string;
  /** pi provider id registered for the remote instance. */
  providerId: string;
  /** pi provider display name. */
  providerName: string;
  /** Local tunnel port; 11435 keeps a local Ollama on 11434 free. */
  localPort: number;
  /** Vast.ai gpu_name filter. VERIFY against live offer data (v0.2.0). */
  gpuName: string;
  /** GPUs per instance (2 needed for 235B-class q4 models). */
  gpuCount: number;
  /** Minimum VRAM per GPU in GB. */
  minGpuRamGb: number;
  /** Hard cap on $/hour; up aborts when nothing cheaper exists. */
  maxPricePerHour: number;
  /** Instance disk in GB (model cache; ~40GB per big q4 model). */
  diskGb: number;
  /** Docker image launched on the instance (server/ builds this). */
  image: string;
  /** Instance label on vast.ai. */
  label: string;
  /** Fallback + pre-pull model list; comma-joined into HECTON_MODELS. */
  models: ModelConfig[];
  /** Assumed context window when a model is not in models[]. */
  defaultContextWindow: number;
  /** Assumed max output tokens when a model is not in models[]. */
  defaultMaxTokens: number;
}

const DEFAULTS: HectonConfig = {
  apiKeyEnv: "VAST_API_KEY",
  providerId: "vast",
  providerName: "Hecton (Vast.ai spot GPU)",
  localPort: 11435,
  // Live market check 2026-10-01: no H100s listed. Value pick is the
  // Blackwell RTX PRO 6000 Max-Q (96GB) at $0.64/hr cheapest; A800 80GB at
  // $0.47/hr is the budget alternative (see plans/v0.2.0 tier table).
  gpuName: "RTX PRO 6000 Max-Q",
  gpuCount: 1,
  minGpuRamGb: 90,
  maxPricePerHour: 1.2,
  diskGb: 100,
  image: "natestott/hecton-server:latest",
  label: "hecton",
  // Real ollama tags that fit comfortably on one 96GB GPU. First-session
  // verification models; tier configs for frontier models live in the plan.
  models: [
    { id: "qwen3-coder:30b", name: "Qwen3 Coder 30B (vast GPU)", contextWindow: 262144 },
    { id: "gpt-oss:20b", name: "GPT-OSS 20B (vast GPU)", reasoning: true, contextWindow: 131072 },
  ],
  defaultContextWindow: 131072,
  defaultMaxTokens: 16384,
};

export function configDir(): string {
  return join(homedir(), ".pi", "agent");
}

export function configPath(): string {
  return join(configDir(), "hecton.json");
}

export function resolveApiKey(cfg: HectonConfig): string | undefined {
  // Priority: real env var > ~/.pi/agent/hecton/.env > config-file apiKey.
  const fromEnv = process.env[cfg.apiKeyEnv];
  if (fromEnv) return fromEnv;
  const fromFile = readEnvFile()[cfg.apiKeyEnv];
  if (fromFile) return fromFile;
  return cfg.apiKey;
}

/**
 * Minimal KEY=VALUE parser for ~/.pi/agent/hecton/.env (the recommended
 * secure home for the Vast.ai key: outside any repo, chmod 600). pi does
 * not auto-load .env files, so hecton reads this itself.
 */
function readEnvFile(): Record<string, string> {
  const path = join(homedir(), ".pi", "agent", "hecton", ".env");
  const out: Record<string, string> = {};
  if (!existsSync(path)) return out;
  try {
    for (const line of readFileSync(path, "utf8").split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq <= 0) continue;
      const key = trimmed.slice(0, eq).trim();
      let value = trimmed.slice(eq + 1).trim();
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      out[key] = value;
    }
  } catch {
    // Unreadable .env: ignore, fall through to other sources.
  }
  return out;
}

export function loadConfig(): HectonConfig {
  let file: Partial<HectonConfig> = {};
  const p = configPath();
  if (existsSync(p)) {
    try {
      file = JSON.parse(readFileSync(p, "utf8")) as Partial<HectonConfig>;
    } catch {
      // Broken config file: fall back to defaults rather than crash pi.
      file = {};
    }
  }
  return { ...DEFAULTS, ...file };
}

/** Persist the API key into the config file, preserving other fields. */
export function saveApiKeyToConfig(key: string): void {
  const p = configPath();
  let existing: Record<string, unknown> = {};
  if (existsSync(p)) {
    try {
      existing = JSON.parse(readFileSync(p, "utf8")) as Record<string, unknown>;
    } catch {
      existing = {};
    }
  }
  existing.apiKey = key;
  writeFileSync(p, `${JSON.stringify(existing, null, 2)}\n`);
}
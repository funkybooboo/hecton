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
  /** Fallback + pre-pull model list; comma-joined into OLLAMA_MODELS. */
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
  gpuName: "H100_SXM",
  gpuCount: 1,
  minGpuRamGb: 78,
  maxPricePerHour: 1.6,
  diskGb: 100,
  image: "funkybooboo/hecton-server:latest",
  label: "hecton",
  // Real ollama tags that fit comfortably on one 80GB H100. Swap for
  // frontier models after the v0.2.0 live check.
  models: [
    { id: "qwen3-coder:30b", name: "Qwen3 Coder 30B (vast H100)", contextWindow: 262144 },
    { id: "gpt-oss:20b", name: "GPT-OSS 20B (vast H100)", reasoning: true, contextWindow: 131072 },
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
  return cfg.apiKey ?? process.env[cfg.apiKeyEnv];
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
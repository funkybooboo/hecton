/**
 * pi provider registration. The remote Ollama speaks the OpenAI-compatible
 * API on /v1, so pi's `openai-completions` api works with zero custom
 * streaming code. Models are discovered live from the tunnel when it is up,
 * with the config list as fallback (the factory runs before any tunnel may
 * exist on a fresh boot).
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { HectonConfig, ModelConfig } from "./config.ts";
import { fetchWithTimeout } from "./tunnel.ts";

export interface RemoteModel {
  id: string;
  name?: string;
}

/** List models currently pulled on the instance. Empty when unreachable. */
export async function fetchRemoteModels(localPort: number, timeoutMs: number = 4000): Promise<RemoteModel[]> {
  try {
    const res = await fetchWithTimeout(`http://127.0.0.1:${localPort}/v1/models`, timeoutMs);
    if (!res.ok) return [];
    const json = (await res.json()) as { data?: Array<{ id: string; name?: string }> };
    return (json.data ?? [])
      .map((m) => ({ id: m.id, name: m.name }))
      .filter((m) => typeof m.id === "string" && m.id.length > 0);
  } catch {
    return [];
  }
}

interface PiModelDef {
  id: string;
  name: string;
  reasoning: boolean;
  input: ("text" | "image")[];
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
  contextWindow: number;
  maxTokens: number;
  compat: {
    supportsDeveloperRole: boolean;
    supportsReasoningEffort: boolean;
  };
}

function toPiModel(id: string, name: string | undefined, cfg: HectonConfig): PiModelDef {
  const known = cfg.models.find((m: ModelConfig) => m.id === id);
  return {
    id,
    name: name ?? known?.name ?? id,
    reasoning: known?.reasoning ?? false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: known?.contextWindow ?? cfg.defaultContextWindow,
    maxTokens: known?.maxTokens ?? cfg.defaultMaxTokens,
    compat: {
      supportsDeveloperRole: false,
      supportsReasoningEffort: false,
    },
  };
}

export function registerHectonProvider(
  pi: ExtensionAPI,
  cfg: HectonConfig,
  remote: RemoteModel[],
): void {
  const source = remote.length > 0 ? remote : cfg.models.map((m) => ({ id: m.id, name: m.name }));
  pi.registerProvider(cfg.providerId, {
    name: cfg.providerName,
    baseUrl: `http://127.0.0.1:${cfg.localPort}/v1`,
    // Placeholder: the tunnel is access control. pi requires a non-empty
    // key before models appear in /model (same pattern pi docs use for
    // keyless local Ollama).
    apiKey: "ollama",
    api: "openai-completions",
    models: source.map((m) => toPiModel(m.id, m.name, cfg)),
  });
}
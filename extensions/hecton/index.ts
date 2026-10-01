/**
 * hecton - rent spot GPUs on Vast.ai and serve their models to pi.
 *
 * Commands (flat, kebab-case - idiomatic pi style):
 *   /hecton-up          search cheapest spot offer under the cap, launch,
 *                     tunnel, and report
 *   /hecton-down        destroy the instance, stop the tunnel, record cost
 *   /hecton-status      instance/tunnel/model/cost summary
 *   /hecton-connect     (re)attach the tunnel to a recorded instance
 *   /hecton-check       read-only: offers (public API) + key auth check
 *   /hecton-cost        month-to-date spend from the local ledger
 *   /hecton-models      list remote models; `/hecton-models pull <tag>` pulls one
 *
 * Config: ~/.pi/agent/hecton.json (see hecton.example.json).
 * Key:   VAST_API_KEY env var, or ~/.pi/agent/hecton/.env (KEY=VALUE),
 *        or "apiKey" in the config file.
 * State: ~/.pi/agent/hecton/state.json (instance record + cost ledger).
 *
 * Offer search is VERIFIED against the live API (2026-10-01); instance
 * create/list/destroy are not yet (see docs/vast-api-notes.md).
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { estimateCost, formatElapsed, formatUsd, monthlySpend } from "./src/cost.ts";
import { configPath, loadConfig, resolveApiKey, saveApiKeyToConfig } from "./src/config.ts";
import { fetchRemoteModels, registerHectonProvider } from "./src/provider.ts";
import type { InstanceRecord } from "./src/state.ts";
import { loadState, saveState } from "./src/state.ts";
import { SshTunnel, fetchWithTimeout, sleep } from "./src/tunnel.ts";
import { pickCheapest, VastClient, type OfferFilter, type VastInstance } from "./src/vast.ts";

const POLL_RUNNING_MS = 6 * 60_000;
const POLL_INTERVAL_MS = 10_000;

/** Structural view of the command/event ctx subset hecton uses. */
interface CmdCtx {
  hasUI: boolean;
  cwd: string;
  ui: {
    notify: (msg: string, level?: "info" | "warning" | "error") => void;
    confirm: (title: string, message: string) => Promise<boolean>;
    input: (title: string, placeholder?: string) => Promise<string | undefined>;
    select: (title: string, options: string[]) => Promise<string | undefined>;
    setStatus: (key: string, text: string | undefined) => void;
    setWidget: (key: string, lines: string[]) => void;
  };
}

export default async function hecton(pi: ExtensionAPI): Promise<void> {
  const cfg = loadConfig();

  // Register the provider at factory time so /model and --list-models see it.
  // Probe the tunnel: an orphaned tunnel from a previous pi run may still be
  // healthy; otherwise fall back to the configured model list.
  const remote = await fetchRemoteModels(cfg.localPort, 1500);
  registerHectonProvider(pi, cfg, remote);

  let tunnel: SshTunnel | undefined;

  const tunnelFor = (inst: InstanceRecord): SshTunnel =>
    new SshTunnel(inst.publicIp, inst.sshPort, cfg.localPort);

  const offerFilter = (): OfferFilter => ({
    gpuName: cfg.gpuName,
    gpuCount: cfg.gpuCount,
    minGpuRamGb: cfg.minGpuRamGb,
    // Headroom above the configured instance disk for the model cache.
    minDiskGb: cfg.diskGb + 15,
  });

  const statusText = (): string | undefined => {
    const state = loadState();
    const inst = state.instance;
    if (!inst) return undefined;
    const { costUsd } = estimateCost(inst.pricePerHour, inst.launchedAt);
    const elapsed = formatElapsed(Date.now() - inst.launchedAt);
    return `hecton GPU up ${formatUsd(inst.pricePerHour)}/hr, ${elapsed} elapsed, ~${formatUsd(costUsd)}`;
  };

  const updateStatus = (ctx: CmdCtx): void => {
    if (ctx.hasUI) ctx.ui.setStatus("hecton", statusText());
  };

  const widget = (ctx: CmdCtx, title: string, lines: string[]): void => {
    if (!ctx.hasUI) return;
    ctx.ui.setWidget("hecton", [title, ...lines.map((l) => `  ${l}`)]);
  };

  const clientOrPrompt = async (ctx: CmdCtx): Promise<VastClient | undefined> => {
    let key = resolveApiKey(cfg);
    if (!key) {
      if (!ctx.hasUI) {
        ctx.ui.notify(`hecton: set ${cfg.apiKeyEnv} or "apiKey" in ${configPath()}`, "error");
        return undefined;
      }
      const entered = await ctx.ui.input(
        "Vast.ai API key",
        `stored in ${configPath()}; or set ${cfg.apiKeyEnv} instead`,
      );
      if (!entered) return undefined;
      key = entered.trim();
      cfg.apiKey = key;
      saveApiKeyToConfig(key);
    }
    return new VastClient(key);
  };

  // ---------- command handlers ----------

  const cmdCheck = async (ctx: CmdCtx): Promise<void> => {
    // Offer search is public, so this works before any key is configured.
    const client = new VastClient(resolveApiKey(cfg));
    const lines: string[] = [];
    try {
      const offers = await client.searchOffers(offerFilter());
      const best = offers
        .slice()
        .sort((a, b) => a.pricePerHour - b.pricePerHour)
        .slice(0, 5)
        .map((o) => `${o.gpuName} x${o.numGpus} ${Math.round(o.gpuRamGb)}GB - ${formatUsd(o.pricePerHour)}/hr (id ${o.id}, disk ${Math.round(o.diskSpaceGb ?? 0)}GB)`);
      lines.push(...(best.length > 0 ? best : ["(no offers matched the config filters)"]));
    } catch (err) {
      ctx.ui.notify(`hecton check: offer search failed: ${(err as Error).message}`, "error");
      return;
    }
    const key = resolveApiKey(cfg);
    if (!key) {
      lines.push("no API key configured - set VAST_API_KEY or ~/.pi/agent/hecton/.env (search is public; launching needs the key)");
    } else {
      try {
        const instances = await client.listInstances();
        lines.push(`API key OK (auth verified, ${instances.length} existing instance(s))`);
      } catch (err) {
        lines.push(`API key check FAILED: ${(err as Error).message}`);
      }
    }
    widget(ctx, "hecton check (read-only):", lines);
  };

  const cmdConnect = async (ctx: CmdCtx): Promise<void> => {
    const state = loadState();
    if (!state.instance) {
      ctx.ui.notify("hecton: no instance recorded; run /hecton-up", "warning");
      return;
    }
    ctx.ui.setStatus("hecton", "connecting tunnel...");
    const t = tunnelFor(state.instance);
    try {
      await t.start();
    } catch (err) {
      ctx.ui.setStatus("hecton", undefined);
      ctx.ui.notify(`hecton: ssh tunnel failed to start: ${(err as Error).message}`, "error");
      return;
    }
    // The instance may still be provisioning Ollama; give it time.
    const healthy = await t.waitHealthy(120_000, 5000);
    tunnel = healthy ? t : undefined;
    if (!healthy) {
      ctx.ui.setStatus("hecton", undefined);
      ctx.ui.notify(
        "hecton: tunnel is up but Ollama is not responding yet (still starting or pulling models). Retry /hecton-connect in a minute.",
        "warning",
      );
      return;
    }
    const models = await fetchRemoteModels(cfg.localPort);
    updateStatus(ctx);
    const lines = [
      `endpoint http://127.0.0.1:${cfg.localPort} -> root@${state.instance.publicIp}:${state.instance.sshPort}`,
      `remote models: ${models.map((m) => m.id).join(", ") || `(still pulling: ${cfg.models.map((m) => m.id).join(", ")})`}`,
      "run /reload to refresh the provider model list, then /model to pick one",
    ];
    widget(ctx, "hecton connect:", lines);
  };

  const cmdUp = async (ctx: CmdCtx): Promise<void> => {
    if (!ctx.hasUI) {
      ctx.ui.notify("hecton: /hecton-up needs the interactive TUI (it spends money)", "error");
      return;
    }
    const client = await clientOrPrompt(ctx);
    if (!client) return;

    const state = loadState();
    if (state.instance) {
      const live = await client.getInstance(state.instance.id).catch(() => undefined);
      if (live?.running) {
        const connect = await ctx.ui.confirm(
          "hecton",
          `Instance ${state.instance.id} is already running. Connect to it instead?`,
        );
        if (connect) await cmdConnect(ctx);
        return;
      }
      const relaunch = await ctx.ui.confirm(
        "hecton",
        `Recorded instance ${state.instance.id} is not running (${live?.status ?? "gone"}). Launch a fresh one?`,
      );
      if (!relaunch) return;
      state.instance = undefined;
      saveState(state);
    }

    ctx.ui.setStatus("hecton", `searching ${cfg.gpuName} x${cfg.gpuCount} spot offers...`);
    let offers;
    try {
      offers = await client.searchOffers(offerFilter());
    } catch (err) {
      ctx.ui.setStatus("hecton", undefined);
      ctx.ui.notify(`hecton: offer search failed: ${(err as Error).message}`, "error");
      return;
    }
    const best = pickCheapest(offers, offerFilter(), cfg.maxPricePerHour);
    if (!best) {
      const market = offers.slice().sort((a, b) => a.pricePerHour - b.pricePerHour)[0];
      widget(ctx, "hecton up: nothing under the price cap", [
        `cap: ${formatUsd(cfg.maxPricePerHour)}/hr`,
        market
          ? `cheapest on market: ${market.gpuName} x${market.numGpus} at ${formatUsd(market.pricePerHour)}/hr (id ${market.id})`
          : "no matching offers at all",
        "raise maxPricePerHour in ~/.pi/agent/hecton.json to accept",
      ]);
      ctx.ui.setStatus("hecton", undefined);
      return;
    }

    const ok = await ctx.ui.confirm(
      "hecton",
      `Launch ${best.gpuName} x${best.numGpus} (${Math.round(best.gpuRamGb)}GB/GPU) at ${formatUsd(best.pricePerHour)}/hr?`,
    );
    if (!ok) {
      ctx.ui.setStatus("hecton", undefined);
      return;
    }

    ctx.ui.setStatus("hecton", "creating instance...");
    let id: number;
    try {
      id = await client.createInstance(best.id, {
        image: cfg.image,
        diskGb: cfg.diskGb,
        models: cfg.models.map((m) => m.id),
        label: cfg.label,
      });
    } catch (err) {
      ctx.ui.setStatus("hecton", undefined);
      ctx.ui.notify(`hecton: create failed: ${(err as Error).message}`, "error");
      return;
    }

    let inst: VastInstance | undefined;
    const deadline = Date.now() + POLL_RUNNING_MS;
    while (Date.now() < deadline) {
      inst = await client.getInstance(id).catch(() => undefined);
      if (inst?.running) break;
      if (inst && /error|exited/i.test(inst.status)) {
        ctx.ui.setStatus("hecton", undefined);
        ctx.ui.notify(`hecton: instance ${id} entered '${inst.status}'; destroying`, "error");
        await client.destroyInstance(id).catch(() => {});
        return;
      }
      ctx.ui.setStatus("hecton", `instance ${id}: ${inst?.status ?? "provisioning"}...`);
      await sleep(POLL_INTERVAL_MS);
    }
    if (!inst?.running) {
      ctx.ui.setStatus("hecton", undefined);
      ctx.ui.notify(`hecton: instance ${id} did not reach running within 6 min; check /hecton-status`, "error");
      return;
    }
    if (!inst.publicIp || !inst.sshPort) {
      state.instance = {
        id,
        publicIp: inst.publicIp ?? "",
        sshPort: inst.sshPort ?? 22,
        pricePerHour: best.pricePerHour,
        launchedAt: Date.now(),
        image: cfg.image,
        diskGb: cfg.diskGb,
        gpuName: best.gpuName,
        gpuCount: best.numGpus,
      };
      saveState(state);
      ctx.ui.notify(
        "hecton: instance running but SSH details are not visible yet; retry /hecton-connect shortly",
        "warning",
      );
      return;
    }

    state.instance = {
      id,
      publicIp: inst.publicIp,
      sshPort: inst.sshPort,
      pricePerHour: best.pricePerHour,
      launchedAt: Date.now(),
      image: cfg.image,
      diskGb: cfg.diskGb,
      gpuName: best.gpuName,
      gpuCount: best.numGpus,
    };
    saveState(state);
    await cmdConnect(ctx);
  };

  const cmdDown = async (ctx: CmdCtx): Promise<void> => {
    const state = loadState();
    const inst = state.instance;
    if (!inst) {
      ctx.ui.notify("hecton: no instance to stop", "info");
      return;
    }
    const { costUsd, elapsedMs } = estimateCost(inst.pricePerHour, inst.launchedAt);
    if (ctx.hasUI) {
      const ok = await ctx.ui.confirm(
        "hecton",
        `Destroy instance ${inst.id}? ~${formatUsd(costUsd)} spent over ${formatElapsed(elapsedMs)}.`,
      );
      if (!ok) return;
    }
    const client = await clientOrPrompt(ctx);
    if (!client) return;
    try {
      await client.destroyInstance(inst.id);
    } catch (err) {
      ctx.ui.notify(`hecton: destroy failed: ${(err as Error).message} (state kept; retry later)`, "error");
      return;
    }
    tunnel?.stop();
    tunnel = undefined;
    state.ledger.push({
      instanceId: inst.id,
      startedAt: inst.launchedAt,
      endedAt: Date.now(),
      costUsd,
    });
    state.instance = undefined;
    saveState(state);
    if (ctx.hasUI) ctx.ui.setStatus("hecton", undefined);
    ctx.ui.notify(
      `hecton: instance destroyed. Session ${formatUsd(costUsd)}; month-to-date ${formatUsd(monthlySpend(state.ledger))}.`,
      "info",
    );
  };

  const cmdStatus = async (ctx: CmdCtx): Promise<void> => {
    const state = loadState();
    const lines: string[] = [];
    const inst = state.instance;
    if (!inst) {
      lines.push("no instance recorded; run /hecton-up");
    } else {
      const { costUsd, elapsedMs } = estimateCost(inst.pricePerHour, inst.launchedAt);
      lines.push(
        `instance ${inst.id}: ${inst.gpuName} x${inst.gpuCount} at root@${inst.publicIp}:${inst.sshPort}`,
      );
      lines.push(
        `price ${formatUsd(inst.pricePerHour)}/hr | up ${formatElapsed(elapsedMs)} | cost so far ~${formatUsd(costUsd)}`,
      );
      const t = tunnelFor(inst);
      const healthy = await t.healthy(2500);
      lines.push(`tunnel 127.0.0.1:${cfg.localPort}: ${healthy ? "healthy" : "down (/hecton-connect)"}`);
      if (healthy) {
        const models = await fetchRemoteModels(cfg.localPort);
        lines.push(`remote models: ${models.map((m) => m.id).join(", ") || "(none pulled yet)"}`);
      }
      const clientKey = resolveApiKey(cfg);
      if (clientKey) {
        const live = await new VastClient(clientKey).getInstance(inst.id).catch(() => undefined);
        if (live) lines.push(`vast.ai reports: ${live.status}${live.running ? "" : " (not running)"}`);
      }
    }
    lines.push(`month-to-date spend: ${formatUsd(monthlySpend(state.ledger))}`);
    lines.push("commands: /hecton-up /hecton-down /hecton-connect /hecton-check /hecton-cost /hecton-models");
    widget(ctx, "hecton status", lines);
  };

  const cmdCost = async (ctx: CmdCtx): Promise<void> => {
    const state = loadState();
    const lines: string[] = [
      `month-to-date: ${formatUsd(monthlySpend(state.ledger))} across ${state.ledger.length} recorded session(s)`,
    ];
    const last = state.ledger[state.ledger.length - 1];
    if (last) {
      lines.push(
        `last: instance ${last.instanceId}, ${formatElapsed(last.endedAt - last.startedAt)}, ${formatUsd(last.costUsd)}`,
      );
    }
    if (state.instance) {
      const { costUsd } = estimateCost(state.instance.pricePerHour, state.instance.launchedAt);
      lines.push(`current open instance: ~${formatUsd(costUsd)} so far (not yet in the ledger)`);
    }
    widget(ctx, "hecton cost", lines);
  };

  const cmdModels = async (ctx: CmdCtx, rest: string[]): Promise<void> => {
    const state = loadState();
    if (rest[0] === "pull" && rest[1]) {
      const tag = rest[1];
      const target = tunnel ?? (state.instance ? tunnelFor(state.instance) : undefined);
      if (!target || !(await target.healthy(2500))) {
        ctx.ui.notify("hecton: not connected; run /hecton-connect first", "error");
        return;
      }
      ctx.ui.setStatus("hecton", `pulling ${tag} (large models take many minutes)...`);
      try {
        const res = await fetchWithTimeout(`http://127.0.0.1:${cfg.localPort}/api/pull`, 30 * 60_000, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: tag, model: tag, stream: false }),
        });
        if (!res.ok) {
          ctx.ui.setStatus("hecton", statusText());
          ctx.ui.notify(`hecton: pull failed: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`, "error");
          return;
        }
        ctx.ui.setStatus("hecton", statusText());
        ctx.ui.notify(`hecton: pulled ${tag}; run /reload, then /model to select it`, "info");
      } catch (err) {
        ctx.ui.setStatus("hecton", statusText());
        ctx.ui.notify(`hecton: pull failed: ${(err as Error).message}`, "error");
      }
      return;
    }
    const models = await fetchRemoteModels(cfg.localPort);
    const lines =
      models.length > 0
        ? models.map((m) => m.id)
        : [
            "remote unreachable or no models pulled; configured pre-pulls:",
            ...cfg.models.map((m) => `${m.id}${m.name ? ` (${m.name})` : ""}`),
          ];
    widget(ctx, "hecton models", lines);
  };

  // ---------- wiring ----------

  pi.on("session_start", async (_event, ctx) => {
    const state = loadState();
    if (!state.instance) return;
    const t = tunnelFor(state.instance);
    try {
      await t.start(); // no-op when an already-healthy tunnel is present
    } catch {
      // ssh may be missing or the instance gone; /hecton-status reports it.
    }
    const healthy = await t.waitHealthy(20_000, 2500);
    tunnel = healthy ? t : undefined;
    updateStatus(ctx);
    if (!healthy && ctx.hasUI) {
      ctx.ui.notify(
        `hecton: recorded instance ${state.instance.id} is not reachable; /hecton-status to inspect, /hecton-up to relaunch`,
        "warning",
      );
    }
  });

  pi.on("session_shutdown", async () => {
    tunnel?.stop();
    tunnel = undefined;
  });

  pi.registerCommand("hecton-up", {
    description: "hecton: launch the cheapest spot GPU under the price cap",
    handler: async (_args, ctx) => cmdUp(ctx),
  });
  pi.registerCommand("hecton-down", {
    description: "hecton: destroy the rented instance and record the cost",
    handler: async (_args, ctx) => cmdDown(ctx),
  });
  pi.registerCommand("hecton-status", {
    description: "hecton: instance, tunnel, models, and cost summary",
    handler: async (_args, ctx) => cmdStatus(ctx),
  });
  pi.registerCommand("hecton-connect", {
    description: "hecton: reattach the tunnel to the recorded instance",
    handler: async (_args, ctx) => cmdConnect(ctx),
  });
  pi.registerCommand("hecton-check", {
    description: "hecton: read-only market check (offers + API key auth)",
    handler: async (_args, ctx) => cmdCheck(ctx),
  });
  pi.registerCommand("hecton-cost", {
    description: "hecton: month-to-date GPU spend",
    handler: async (_args, ctx) => cmdCost(ctx),
  });
  pi.registerCommand("hecton-models", {
    description: "hecton: list remote models; pull one with /hecton-models pull <tag>",
    handler: async (args, ctx) =>
      cmdModels(ctx, (args ?? "").trim().split(/\s+/).filter(Boolean)),
  });
}
/**
 * hecton - rent spot H100 GPUs on Vast.ai and serve their models to pi.
 *
 * Commands (run `/vast` with no args for usage):
 *   /vast up          search cheapest spot offer under the cap, launch,
 *                     tunnel, and report
 *   /vast down        destroy the instance, stop the tunnel, record cost
 *   /vast status      instance/tunnel/model/cost summary
 *   /vast connect     (re)attach the tunnel to a recorded instance
 *   /vast check       read-only: verify API key, show cheapest offers
 *   /vast cost        month-to-date spend from the local ledger
 *   /vast models      list remote models; `/vast models pull <tag>` pulls one
 *
 * Config: ~/.pi/agent/hecton.json (see hecton.example.json).
 * State:  ~/.pi/agent/hecton/state.json (instance record + cost ledger).
 *
 * v0.1.0: all Vast.ai REST calls are implemented but not yet verified
 * against the live API (see docs/vast-api-notes.md).
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { estimateCost, formatElapsed, formatUsd, monthlySpend } from "./src/cost.ts";
import { configPath, loadConfig, resolveApiKey, saveApiKeyToConfig } from "./src/config.ts";
import { fetchRemoteModels, registerHectonProvider } from "./src/provider.ts";
import type { InstanceRecord } from "./src/state.ts";
import { loadState, saveState } from "./src/state.ts";
import { SshTunnel, fetchWithTimeout, sleep } from "./src/tunnel.ts";
import { pickCheapest, VastClient, type OfferFilter, type VastInstance } from "./src/vast.ts";

const USAGE = [
  "hecton usage:",
  "  /vast up            launch cheapest spot GPU under the price cap, tunnel it",
  "  /vast down          destroy instance, record cost",
  "  /vast status        instance / tunnel / models / cost summary",
  "  /vast connect       (re)attach tunnel to the recorded instance",
  "  /vast check         read-only: verify API key + show cheapest offers",
  "  /vast cost          month-to-date spend",
  "  /vast models        list remote models; /vast models pull <tag> pulls one",
].join("\n");

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
    interruptible: true,
  });

  const statusText = (): string | undefined => {
    const state = loadState();
    const inst = state.instance;
    if (!inst) return undefined;
    const { costUsd } = estimateCost(inst.pricePerHour, inst.launchedAt);
    const elapsed = formatElapsed(Date.now() - inst.launchedAt);
    return `vast GPU up ${formatUsd(inst.pricePerHour)}/hr, ${elapsed} elapsed, ~${formatUsd(costUsd)}`;
  };

  const updateStatus = (ctx: CmdCtx): void => {
    if (ctx.hasUI) ctx.ui.setStatus("vast", statusText());
  };

  const widget = (ctx: CmdCtx, title: string, lines: string[]): void => {
    if (!ctx.hasUI) return;
    ctx.ui.setWidget("vast", [title, ...lines.map((l) => `  ${l}`)]);
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
    const client = await clientOrPrompt(ctx);
    if (!client) return;
    try {
      const offers = await client.searchOffers(offerFilter());
      const cheapest = offers
        .slice()
        .sort((a, b) => a.pricePerHour - b.pricePerHour)
        .slice(0, 5)
        .map((o) => `${o.gpuName} x${o.numGpus} ${Math.round(o.gpuRamGb)}GB - ${formatUsd(o.pricePerHour)}/hr (id ${o.id})`);
      widget(
        ctx,
        "vast check: authenticated, cheapest offers:",
        cheapest.length > 0 ? cheapest : ["(no offers matched)"],
      );
    } catch (err) {
      ctx.ui.notify(`hecton check failed: ${(err as Error).message}`, "error");
    }
  };

  const cmdConnect = async (ctx: CmdCtx): Promise<void> => {
    const state = loadState();
    if (!state.instance) {
      ctx.ui.notify("hecton: no instance recorded; run /vast up", "warning");
      return;
    }
    ctx.ui.setStatus("vast", "connecting tunnel...");
    const t = tunnelFor(state.instance);
    try {
      await t.start();
    } catch (err) {
      ctx.ui.setStatus("vast", undefined);
      ctx.ui.notify(`hecton: ssh tunnel failed to start: ${(err as Error).message}`, "error");
      return;
    }
    // The instance may still be provisioning Ollama; give it time.
    const healthy = await t.waitHealthy(120_000, 5000);
    tunnel = healthy ? t : undefined;
    if (!healthy) {
      ctx.ui.setStatus("vast", undefined);
      ctx.ui.notify(
        "hecton: tunnel is up but Ollama is not responding yet (still starting or pulling models). Retry /vast connect in a minute.",
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
    widget(ctx, "vast connect:", lines);
  };

  const cmdUp = async (ctx: CmdCtx): Promise<void> => {
    if (!ctx.hasUI) {
      ctx.ui.notify("hecton: /vast up needs the interactive TUI (it spends money)", "error");
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

    ctx.ui.setStatus("vast", `searching ${cfg.gpuName} x${cfg.gpuCount} spot offers...`);
    let offers;
    try {
      offers = await client.searchOffers(offerFilter());
    } catch (err) {
      ctx.ui.setStatus("vast", undefined);
      ctx.ui.notify(`hecton: offer search failed: ${(err as Error).message}`, "error");
      return;
    }
    const best = pickCheapest(offers, offerFilter(), cfg.maxPricePerHour);
    if (!best) {
      const market = offers.slice().sort((a, b) => a.pricePerHour - b.pricePerHour)[0];
      widget(ctx, "vast up: nothing under the price cap", [
        `cap: ${formatUsd(cfg.maxPricePerHour)}/hr`,
        market
          ? `cheapest on market: ${market.gpuName} x${market.numGpus} at ${formatUsd(market.pricePerHour)}/hr (id ${market.id})`
          : "no matching offers at all",
        "raise maxPricePerHour in ~/.pi/agent/hecton.json to accept",
      ]);
      ctx.ui.setStatus("vast", undefined);
      return;
    }

    const ok = await ctx.ui.confirm(
      "hecton",
      `Launch ${best.gpuName} x${best.numGpus} (${Math.round(best.gpuRamGb)}GB/GPU) at ${formatUsd(best.pricePerHour)}/hr?`,
    );
    if (!ok) {
      ctx.ui.setStatus("vast", undefined);
      return;
    }

    ctx.ui.setStatus("vast", "creating instance...");
    let id: number;
    try {
      id = await client.createInstance(best.id, {
        image: cfg.image,
        diskGb: cfg.diskGb,
        models: cfg.models.map((m) => m.id),
        label: cfg.label,
      });
    } catch (err) {
      ctx.ui.setStatus("vast", undefined);
      ctx.ui.notify(`hecton: create failed: ${(err as Error).message}`, "error");
      return;
    }

    let inst: VastInstance | undefined;
    const deadline = Date.now() + POLL_RUNNING_MS;
    while (Date.now() < deadline) {
      inst = await client.getInstance(id).catch(() => undefined);
      if (inst?.running) break;
      if (inst && /error|exited/i.test(inst.status)) {
        ctx.ui.setStatus("vast", undefined);
        ctx.ui.notify(`hecton: instance ${id} entered '${inst.status}'; destroying`, "error");
        await client.destroyInstance(id).catch(() => {});
        return;
      }
      ctx.ui.setStatus("vast", `instance ${id}: ${inst?.status ?? "provisioning"}...`);
      await sleep(POLL_INTERVAL_MS);
    }
    if (!inst?.running) {
      ctx.ui.setStatus("vast", undefined);
      ctx.ui.notify(`hecton: instance ${id} did not reach running within 6 min; check /vast status`, "error");
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
        "hecton: instance running but SSH details are not visible yet; retry /vast connect shortly",
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
    if (ctx.hasUI) ctx.ui.setStatus("vast", undefined);
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
      lines.push("no instance recorded; run /vast up");
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
      lines.push(`tunnel 127.0.0.1:${cfg.localPort}: ${healthy ? "healthy" : "down (/vast connect)"}`);
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
    widget(ctx, "vast status", lines);
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
    widget(ctx, "vast cost", lines);
  };

  const cmdModels = async (ctx: CmdCtx, rest: string[]): Promise<void> => {
    const state = loadState();
    if (rest[0] === "pull" && rest[1]) {
      const tag = rest[1];
      const target = tunnel ?? (state.instance ? tunnelFor(state.instance) : undefined);
      if (!target || !(await target.healthy(2500))) {
        ctx.ui.notify("hecton: not connected; run /vast connect first", "error");
        return;
      }
      ctx.ui.setStatus("vast", `pulling ${tag} (large models take many minutes)...`);
      try {
        const res = await fetchWithTimeout(`http://127.0.0.1:${cfg.localPort}/api/pull`, 30 * 60_000, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: tag, model: tag, stream: false }),
        });
        if (!res.ok) {
          ctx.ui.setStatus("vast", statusText());
          ctx.ui.notify(`hecton: pull failed: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`, "error");
          return;
        }
        ctx.ui.setStatus("vast", statusText());
        ctx.ui.notify(`hecton: pulled ${tag}; run /reload, then /model to select it`, "info");
      } catch (err) {
        ctx.ui.setStatus("vast", statusText());
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
    widget(ctx, "vast models", lines);
  };

  // ---------- wiring ----------

  pi.on("session_start", async (_event, ctx) => {
    const state = loadState();
    if (!state.instance) return;
    const t = tunnelFor(state.instance);
    try {
      await t.start(); // no-op when an already-healthy tunnel is present
    } catch {
      // ssh may be missing or the instance gone; /vast status reports it.
    }
    const healthy = await t.waitHealthy(20_000, 2500);
    tunnel = healthy ? t : undefined;
    updateStatus(ctx);
    if (!healthy && ctx.hasUI) {
      ctx.ui.notify(
        `hecton: recorded instance ${state.instance.id} is not reachable; /vast status to inspect, /vast up to relaunch`,
        "warning",
      );
    }
  });

  pi.on("session_shutdown", async () => {
    tunnel?.stop();
    tunnel = undefined;
  });

  pi.registerCommand("vast", {
    description: "hecton: rent a spot GPU (up/down/status/connect/check/cost/models)",
    handler: async (args, ctx) => {
      const parts = (args ?? "").trim().split(/\s+/).filter(Boolean);
      const action = parts[0] ?? "status";
      const rest = parts.slice(1);
      try {
        switch (action) {
          case "up":
          case "launch":
            await cmdUp(ctx);
            break;
          case "down":
          case "destroy":
            await cmdDown(ctx);
            break;
          case "status":
            await cmdStatus(ctx);
            break;
          case "connect":
            await cmdConnect(ctx);
            break;
          case "check":
            await cmdCheck(ctx);
            break;
          case "cost":
            await cmdCost(ctx);
            break;
          case "models":
            await cmdModels(ctx, rest);
            break;
          case "help":
            widget(ctx, "hecton", USAGE.split("\n"));
            break;
          default:
            ctx.ui.notify(USAGE, "info");
        }
      } catch (err) {
        ctx.ui.notify(`hecton: ${action} failed: ${(err as Error).message}`, "error");
      }
    },
  });
}
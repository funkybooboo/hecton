/**
 * hecton - rent spot GPUs on Vast.ai and serve their models to pi.
 *
 * Automated lifecycle (the default UX, ollama-cloud parity):
 *   - Selecting a hecton model with no GPU running auto-launches one
 *     (confirm dialog by default, silent via config autoUp).
 *   - Idle instances auto-destroy after autoDownIdleMinutes (warning
 *     countdown first; paused during pulls and external use).
 *   - pi really quitting (session_shutdown reason "quit") destroys the
 *     instance too (destroyOnQuit); /new, /reload, forks keep it.
 *
 * Manual escape hatches (flat, kebab-case - idiomatic pi style):
 *   /hecton-up          search cheapest spot offer under the cap, launch,
 *                       tunnel, and report
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
 * Offer search is VERIFIED against the live API (2026-10-01); the first
 * real create/list/destroy exercise is the v0.2.0 session
 * (docs/vast-api-notes.md). Every destroy verifies the instance actually
 * disappeared before clearing state, so a failed destroy can never look
 * like success while billing continues.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { externalUseRecent, idleDecision } from "./src/auto.ts";
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

  // ---------- auto-lifecycle bookkeeping (session-local) ----------
  let launching = false; // auto-up in-flight guard against double launches
  let pullingUntil = 0; // epoch ms; idle countdown pauses during pull grace
  let idleTimer: ReturnType<typeof setInterval> | undefined;
  let lastActivityMs = 0; // in-memory activity, refreshed by every event
  let lastPersistedActivity = 0; // state.json write throttle
  let warnNotified = false; // warn once per idle episode
  let nextDestroyAttemptAt = 0; // backoff after a failed destroy

  const tunnelFor = (inst: InstanceRecord): SshTunnel =>
    new SshTunnel(inst.sshHost ?? inst.publicIp, inst.sshPort, cfg.localPort);

  const offerFilter = (): OfferFilter => ({
    gpuName: cfg.gpuName,
    gpuCount: cfg.gpuCount,
    minGpuRamGb: cfg.minGpuRamGb,
    // Headroom above the configured instance disk for the model cache.
    minDiskGb: cfg.diskGb + 15,
    minInetDownMbps: cfg.minInetDownMbps,
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

  /** Error text including the raw API body when present (VastApiError). */
  const errDetail = (err: unknown): string => {
    const e = err as { message?: string; body?: string };
    let msg = e?.message ?? String(err);
    if (e?.body) msg += ` - ${e.body}`;
    return msg;
  };

  const isHectonModel = (ctx: { model?: { provider?: string } }): boolean =>
    ctx.model?.provider === cfg.providerId;

  /** Record activity while a hecton model is active; throttled persistence. */
  const touchActivity = (): void => {
    lastActivityMs = Date.now();
    warnNotified = false;
    if (lastActivityMs - lastPersistedActivity < 30_000) return;
    lastPersistedActivity = lastActivityMs;
    const state = loadState();
    if (!state.instance) return;
    state.lastHectonActivity = lastActivityMs;
    saveState(state);
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

  // ---------- shared teardown (manual + idle + quit paths) ----------

  /**
   * Destroy the recorded instance, verify it actually disappeared from the
   * provider, then stop the tunnel, record the ledger, and clear state.
   * A destroy that silently failed must never look like success.
   */
  const teardownInstance = async (ctx: CmdCtx, reason: string, verifyPolls = 3): Promise<boolean> => {
    const state = loadState();
    const inst = state.instance;
    if (!inst) return true;
    const { costUsd, elapsedMs } = estimateCost(inst.pricePerHour, inst.launchedAt);
    const client = await clientOrPrompt(ctx);
    if (!client) return false;
    try {
      await client.destroyInstance(inst.id);
    } catch (err) {
      nextDestroyAttemptAt = Date.now() + 5 * 60_000;
      ctx.ui.notify(
        `hecton: destroy failed: ${errDetail(err)} (state kept; retrying later - watch billing)`,
        "error",
      );
      return false;
    }
    let gone = false;
    for (let i = 0; i < verifyPolls; i++) {
      await sleep(5000);
      const check = await client.getInstance(inst.id).catch(() => undefined);
      if (!check) {
        gone = true;
        break;
      }
    }
    if (!gone) {
      nextDestroyAttemptAt = Date.now() + 5 * 60_000;
      ctx.ui.notify(
        `hecton: instance ${inst.id} still visible after destroy; billing may continue - check the vast.ai console`,
        "error",
      );
      return false;
    }
    tunnel?.stop();
    tunnel = undefined;
    state.ledger.push({
      instanceId: inst.id,
      startedAt: inst.launchedAt,
      endedAt: Date.now(),
      costUsd,
      note: reason,
    });
    state.instance = undefined;
    state.lastHectonActivity = undefined;
    saveState(state);
    if (ctx.hasUI) ctx.ui.setStatus("hecton", undefined);
    ctx.ui.notify(
      `hecton: instance destroyed (${reason}). Session ${formatUsd(costUsd)} over ${formatElapsed(elapsedMs)}; month-to-date ${formatUsd(monthlySpend(state.ledger))}.`,
      "info",
    );
    return true;
  };

  // ---------- idle guard ----------

  const stopIdleTimer = (): void => {
    if (idleTimer) {
      clearInterval(idleTimer);
      idleTimer = undefined;
    }
  };

  const tickIdle = async (ctx: CmdCtx): Promise<void> => {
    const state = loadState();
    if (!state.instance) {
      stopIdleTimer();
      return;
    }
    const now = Date.now();
    if (now < nextDestroyAttemptAt) return;
    const decision = idleDecision({
      now,
      lastActivity: Math.max(state.lastHectonActivity ?? 0, lastActivityMs),
      launchedAt: state.instance.launchedAt,
      pullingUntil,
      autoDownIdleMinutes: cfg.autoDownIdleMinutes,
      warnMinutes: cfg.warnMinutes,
    });
    if (decision.action === "none") {
      if (warnNotified) updateStatus(ctx);
      return;
    }
    // Never destroy in the first minutes after launch, even if state is odd.
    if (now - state.instance.launchedAt < 5 * 60_000) return;
    if (decision.action === "warn") {
      if (!warnNotified) {
        warnNotified = true;
        ctx.ui.notify(
          `hecton: idle ${Math.round(decision.idleMinutes)} min - auto-destroy in ${Math.round(decision.destroyInMinutes)} min (use the GPU or /hecton-down)`,
          "warning",
        );
      }
      if (ctx.hasUI) {
        ctx.ui.setStatus(
          "hecton",
          `idle ${Math.round(decision.idleMinutes)}m - auto-destroy in ${Math.round(decision.destroyInMinutes)}m`,
        );
      }
      return;
    }
    // Destroy path: something outside this pi session may be using the GPU.
    if (await externalUseRecent(cfg.localPort)) {
      touchActivity(); // external use counts as activity; reset the episode
      return;
    }
    const ok = await teardownInstance(ctx, `idle ${Math.round(decision.idleMinutes)} min`);
    if (ok) stopIdleTimer();
  };

  const startIdleTimer = (ctx: CmdCtx): void => {
    if (cfg.autoDownIdleMinutes <= 0) return;
    stopIdleTimer();
    idleTimer = setInterval(() => {
      void tickIdle(ctx).catch(() => {});
    }, 60_000);
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
        .map((o) => `${o.gpuName} x${o.numGpus} ${Math.round(o.gpuRamGb)}GB ${Math.round(o.inetDownMbps ?? 0)}Mbps - ${formatUsd(o.pricePerHour)}/hr (id ${o.id}, disk ${Math.round(o.diskSpaceGb ?? 0)}GB)`);
      lines.push(...(best.length > 0 ? best : ["(no offers matched the config filters)"]));
    } catch (err) {
      ctx.ui.notify(`hecton check: offer search failed: ${errDetail(err)}`, "error");
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
        lines.push(`API key check FAILED: ${errDetail(err)}`);
      }
    }
    lines.push(`auto: up=${cfg.autoUp === "silent" ? "silent" : cfg.autoUp ? "confirm" : "off"}, down after ${cfg.autoDownIdleMinutes}m idle, quit=${cfg.destroyOnQuit ? "destroy" : "keep"}`);
    widget(ctx, "hecton check (read-only):", lines);
  };

  const cmdConnect = async (ctx: CmdCtx): Promise<void> => {
    const state = loadState();
    if (!state.instance) {
      ctx.ui.notify("hecton: no instance recorded; run /hecton-up", "warning");
      return;
    }
    // Refresh connection details from the provider first: the launch-time
    // payload may lack SSH details, SSH can route through a proxy whose
    // host/port changes per instance, and dph_total on the instance is the
    // real billing rate (offer price excludes the disk allocation).
    const apiKey = resolveApiKey(cfg);
    if (apiKey) {
      const live = await new VastClient(apiKey).getInstance(state.instance.id).catch(() => undefined);
      if (!live) {
        ctx.ui.notify(`hecton: instance ${state.instance.id} not found on vast.ai; /hecton-up to relaunch`, "warning");
        return;
      }
      if (/loading/i.test(live.status)) {
        ctx.ui.notify("hecton: instance is still loading its container image; retry /hecton-connect in a few minutes", "warning");
        return;
      }
      state.instance.publicIp = live.publicIp ?? state.instance.publicIp;
      state.instance.sshHost = live.sshHost ?? state.instance.sshHost;
      state.instance.sshPort = live.sshPort ?? state.instance.sshPort;
      if (live.pricePerHour) state.instance.pricePerHour = live.pricePerHour;
      saveState(state);
    }
    ctx.ui.setStatus("hecton", "connecting tunnel...");
    const t = tunnelFor(state.instance);
    try {
      await t.start();
    } catch (err) {
      ctx.ui.setStatus("hecton", undefined);
      ctx.ui.notify(`hecton: ssh tunnel failed to start: ${errDetail(err)}`, "error");
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
      `endpoint http://127.0.0.1:${cfg.localPort} -> root@${state.instance.sshHost ?? state.instance.publicIp}:${state.instance.sshPort}`,
      `remote models: ${models.map((m) => m.id).join(", ") || `(still pulling: ${cfg.models.map((m) => m.id).join(", ")})`}`,
      "run /reload to refresh the provider model list, then /model to pick one",
    ];
    widget(ctx, "hecton connect:", lines);
  };

  const cmdUp = async (
    ctx: CmdCtx,
    opts: { preconfirmed?: boolean; silent?: boolean } = {},
  ): Promise<void> => {
    if (launching) {
      ctx.ui.notify("hecton: a launch is already in progress", "warning");
      return;
    }
    if (!ctx.hasUI && !opts.silent) {
      ctx.ui.notify("hecton: /hecton-up needs the interactive TUI (it spends money)", "error");
      return;
    }
    launching = true;
    try {
      const client = await clientOrPrompt(ctx);
      if (!client) return;

      const state = loadState();
      if (state.instance) {
        const live = await client.getInstance(state.instance.id).catch(() => undefined);
        if (live?.running) {
          if (opts.silent) {
            await cmdConnect(ctx);
            return;
          }
          const connect = await ctx.ui.confirm(
            "hecton",
            `Instance ${state.instance.id} is already running. Connect to it instead?`,
          );
          if (connect) await cmdConnect(ctx);
          return;
        }
        if (!opts.silent) {
          const relaunch = await ctx.ui.confirm(
            "hecton",
            `Recorded instance ${state.instance.id} is not running (${live?.status ?? "gone"}). Launch a fresh one?`,
          );
          if (!relaunch) return;
        }
        state.instance = undefined;
        saveState(state);
      }

      ctx.ui.setStatus("hecton", `searching ${cfg.gpuName} x${cfg.gpuCount} spot offers...`);
      let offers;
      try {
        offers = await client.searchOffers(offerFilter());
      } catch (err) {
        ctx.ui.setStatus("hecton", undefined);
        ctx.ui.notify(`hecton: offer search failed: ${errDetail(err)}`, "error");
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

      if (!opts.preconfirmed) {
        const ok = await ctx.ui.confirm(
          "hecton",
          `Launch ${best.gpuName} x${best.numGpus} (${Math.round(best.gpuRamGb)}GB/GPU) at ${formatUsd(best.pricePerHour)}/hr?`,
        );
        if (!ok) {
          ctx.ui.setStatus("hecton", undefined);
          return;
        }
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
        ctx.ui.notify(`hecton: create failed: ${errDetail(err)}`, "error");
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

      state.instance = {
        id,
        publicIp: inst.publicIp ?? "",
        sshHost: inst.sshHost,
        sshPort: inst.sshPort ?? 22,
        // The instance's dph_total is the real rate (includes disk);
        // the offer price understates it.
        pricePerHour: inst.pricePerHour ?? best.pricePerHour,
        launchedAt: Date.now(),
        image: cfg.image,
        diskGb: cfg.diskGb,
        gpuName: best.gpuName,
        gpuCount: best.numGpus,
      };
      saveState(state);
      if (!inst.publicIp || !inst.sshPort) {
        ctx.ui.notify(
          "hecton: instance running but SSH details are not visible yet; retry /hecton-connect shortly",
          "warning",
        );
        return;
      }

      // Models pre-pull in the background after connect; hold the idle
      // countdown off during that window.
      pullingUntil = Date.now() + cfg.pullGraceMinutes * 60_000;
      warnNotified = false;
      await cmdConnect(ctx);
      startIdleTimer(ctx);
    } finally {
      launching = false;
    }
  };

  const cmdDown = async (ctx: CmdCtx): Promise<void> => {
    const state = loadState();
    if (!state.instance) {
      ctx.ui.notify("hecton: no instance to stop", "info");
      return;
    }
    const { costUsd, elapsedMs } = estimateCost(state.instance.pricePerHour, state.instance.launchedAt);
    if (ctx.hasUI) {
      const ok = await ctx.ui.confirm(
        "hecton",
        `Destroy instance ${state.instance.id}? ~${formatUsd(costUsd)} spent over ${formatElapsed(elapsedMs)}.`,
      );
      if (!ok) return;
    }
    await teardownInstance(ctx, "manual");
  };

  const cmdStatus = async (ctx: CmdCtx): Promise<void> => {
    const state = loadState();
    const lines: string[] = [];
    const inst = state.instance;
    if (!inst) {
      lines.push("no instance recorded; select a hecton model or run /hecton-up");
    } else {
      const { costUsd, elapsedMs } = estimateCost(inst.pricePerHour, inst.launchedAt);
      lines.push(
        `instance ${inst.id}: ${inst.gpuName} x${inst.gpuCount} at root@${inst.sshHost ?? inst.publicIp}:${inst.sshPort}`,
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
      const last = Math.max(state.lastHectonActivity ?? 0, inst.launchedAt);
      lines.push(
        `auto-down: after ${cfg.autoDownIdleMinutes}m idle (warns ${cfg.warnMinutes}m before); last activity ${formatElapsed(Math.max(0, Date.now() - last))} ago`,
      );
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
        `last: instance ${last.instanceId}, ${formatElapsed(last.endedAt - last.startedAt)}, ${formatUsd(last.costUsd)}${last.note ? ` (${last.note})` : ""}`,
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
      pullingUntil = Date.now() + cfg.pullGraceMinutes * 60_000;
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
        ctx.ui.notify(`hecton: pull failed: ${errDetail(err)}`, "error");
      } finally {
        pullingUntil = 0;
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
    lastActivityMs = state.lastHectonActivity ?? 0;
    lastPersistedActivity = lastActivityMs;
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
    if (healthy) {
      startIdleTimer(ctx);
    } else if (ctx.hasUI) {
      ctx.ui.notify(
        `hecton: recorded instance ${state.instance.id} is not reachable; /hecton-status to inspect, /hecton-up to relaunch`,
        "warning",
      );
    }
  });

  /**
   * AUTO-UP: picking a hecton model (via /model, Ctrl+P cycling, or session
   * restore) with no healthy endpoint launches an instance automatically.
   */
  pi.on("model_select", async (event, ctx) => {
    const provider = (event.model as { provider?: string } | undefined)?.provider;
    if (provider !== cfg.providerId) return;
    touchActivity();
    if (launching) return;
    if (tunnel && (await tunnel.healthy(1500))) return;
    if (typeof (ctx as { isIdle?: () => boolean }).isIdle === "function" && !(ctx as { isIdle: () => boolean }).isIdle()) {
      ctx.ui.notify("hecton: GPU down; finish the current turn, then reselect the model or /hecton-up", "warning");
      return;
    }
    if (cfg.autoUp === false || (!ctx.hasUI && cfg.autoUp !== "silent")) {
      if (ctx.hasUI) {
        ctx.ui.notify("hecton: GPU not running - /hecton-up to launch (auto-up is off)", "warning");
      }
      return;
    }
    const silent = cfg.autoUp === "silent";
    if (!silent) {
      const ok = await ctx.ui.confirm(
        "hecton",
        `No GPU running. Launch the cheapest spot instance now? (~${formatUsd(cfg.maxPricePerHour)}/hr cap; auto-destroys after ${cfg.autoDownIdleMinutes} min idle)`,
      );
      if (!ok) return;
    }
    await cmdUp(ctx, { preconfirmed: true, silent });
  });

  // Activity tracking: any turn/stream/prompt while a hecton model is
  // active refreshes the idle countdown.
  pi.on("turn_start", async (_event, ctx) => {
    if (isHectonModel(ctx as { model?: { provider?: string } })) touchActivity();
  });
  pi.on("message_update", async (_event, ctx) => {
    if (isHectonModel(ctx as { model?: { provider?: string } })) touchActivity();
  });
  pi.on("ui_prompt_start", async (_event, ctx) => {
    if (isHectonModel(ctx as { model?: { provider?: string } })) touchActivity();
  });

  pi.on("session_shutdown", async (event, ctx) => {
    stopIdleTimer();
    tunnel?.stop();
    tunnel = undefined;
    // Only a real quit ends billing; reload/new/resume/fork keep the GPU
    // (session_shutdown fires for all of those - event.reason tells them
    // apart, verified against pi's extension docs).
    if (event.reason !== "quit" || !cfg.destroyOnQuit) return;
    const state = loadState();
    if (!state.instance) return;
    if (Date.now() < nextDestroyAttemptAt) return;
    if (!resolveApiKey(cfg)) return; // never block exit on a key prompt
    // Best effort with a short verify; never hang pi exit.
    await teardownInstance(ctx, "pi quit", 1).catch(() => {});
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
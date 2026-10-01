/**
 * Vast.ai REST client (console.vast.ai, API v0).
 *
 * IMPORTANT: endpoint paths, query fields, and payload shapes below are
 * written from training knowledge and are NOT yet verified against the live
 * API. Every assumption is listed in docs/vast-api-notes.md with a v0.2.0
 * verification checklist. The parsing helpers are defensive on purpose: they
 * read multiple candidate field names and throw VastApiError carrying the raw
 * body so a live session can fix drift in minutes.
 */

export interface Offer {
  id: number;
  gpuName: string;
  numGpus: number;
  gpuRamGb: number;
  pricePerHour: number;
  reliability?: number;
  inetDownMbps?: number;
  rentable?: boolean;
}

export interface OfferFilter {
  gpuName: string;
  gpuCount: number;
  minGpuRamGb: number;
  interruptible: boolean;
}

export interface CreateInstanceOpts {
  image: string;
  diskGb: number;
  /** Ollama tags the server entrypoint should pre-pull. */
  models: string[];
  label: string;
}

export interface VastInstance {
  id: number;
  label?: string;
  status: string;
  running: boolean;
  publicIp?: string;
  sshPort?: number;
  pricePerHour?: number;
}

export class VastApiError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly body?: string,
  ) {
    super(message);
    this.name = "VastApiError";
  }
}

// ---------- defensive parsing helpers (pure, unit-tested) ----------

function num(x: unknown): number {
  return typeof x === "number" && Number.isFinite(x) ? x : 0;
}

function str(x: unknown): string | undefined {
  return typeof x === "string" && x.length > 0 ? x : undefined;
}

/** gpu_ram unit is ambiguous in the API (MB historically); handle both. */
function toGb(x: unknown): number {
  const n = num(x);
  return n >= 1024 ? n / 1024 : n;
}

export function offersFromBundles(payload: unknown): Offer[] {
  const offers = (payload as Record<string, unknown> | null)?.offers;
  if (!Array.isArray(offers)) {
    throw new VastApiError(
      "Unexpected /bundles payload: no offers array",
      undefined,
      safeJson(payload),
    );
  }
  const out: Offer[] = [];
  for (const raw of offers) {
    const o = (raw ?? {}) as Record<string, unknown>;
    const id = num(o.id);
    if (!id) continue;
    const gpuName = str(o.gpu_name) ?? "";
    out.push({
      id,
      gpuName,
      numGpus: num(o.num_gpus),
      gpuRamGb: toGb(o.gpu_ram),
      pricePerHour: num(o.dph_total),
      reliability: num(o.reliability) || undefined,
      inetDownMbps: num(o.inet_down) || undefined,
      rentable: o.rentable === true,
    });
  }
  return out;
}

/** Case-insensitive match where either side may be more specific. */
function gpuMatches(want: string, have: string): boolean {
  if (!have) return false;
  const w = want.toLowerCase();
  const h = have.toLowerCase();
  return h === w || h.includes(w) || w.includes(h);
}

export function pickCheapest(offers: Offer[], filter: OfferFilter, maxPricePerHour: number): Offer | undefined {
  const eligible = offers
    .filter((o) => gpuMatches(filter.gpuName, o.gpuName))
    .filter((o) => o.numGpus === filter.gpuCount)
    .filter((o) => o.gpuRamGb >= filter.minGpuRamGb)
    .filter((o) => o.rentable !== false)
    .filter((o) => (o.reliability ?? 1) >= 0.95)
    .filter((o) => o.pricePerHour > 0 && o.pricePerHour <= maxPricePerHour);
  return eligible.sort((a, b) => a.pricePerHour - b.pricePerHour)[0];
}

export function instanceFromPayload(raw: unknown): VastInstance {
  const o = (raw ?? {}) as Record<string, unknown>;
  const status =
    str(o.cur_state) ?? str(o.actual_status) ?? str(o.status) ?? "unknown";

  let sshPort: number | undefined;
  const ports = (o.ports ?? o.port_mappings) as Record<string, unknown> | undefined;
  if (ports) {
    const mapping = ports["22/tcp"] ?? ports["22"];
    const entry = Array.isArray(mapping) ? mapping[0] : mapping;
    const hostPort = (entry as Record<string, unknown> | undefined)?.HostPort;
    const parsed = Number(hostPort);
    if (Number.isFinite(parsed) && parsed > 0) sshPort = parsed;
  }

  return {
    id: num(o.id),
    label: str(o.label),
    status,
    running: /running|active/i.test(status) && !/exited|error/i.test(status),
    publicIp: str(o.public_ipaddr) ?? str(o.public_ip) ?? str(o.ipaddr),
    sshPort,
    pricePerHour: o.dph_total != null ? Number(o.dph_total) : undefined,
  };
}

function safeJson(x: unknown): string {
  try {
    return JSON.stringify(x)?.slice(0, 500) ?? "";
  } catch {
    return "";
  }
}

// ---------- REST client ----------

export class VastClient {
  constructor(
    readonly apiKey: string,
    readonly baseUrl: string = "https://console.vast.ai",
  ) {}

  private async call(path: string, init?: RequestInit): Promise<unknown> {
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}${path}`, {
        ...init,
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
          ...(init?.headers as Record<string, string> | undefined),
        },
      });
    } catch (err) {
      throw new VastApiError(`Vast.ai API ${path} unreachable: ${(err as Error).message}`);
    }
    const text = await res.text();
    if (!res.ok) {
      throw new VastApiError(`Vast.ai API ${path} failed: HTTP ${res.status}`, res.status, text.slice(0, 500));
    }
    try {
      return JSON.parse(text);
    } catch {
      throw new VastApiError(`Vast.ai API ${path} returned non-JSON`, res.status, text.slice(0, 500));
    }
  }

  /**
   * Search spot (interruptible) or on-demand offers.
   * The `q` query format is a VERIFY item in docs/vast-api-notes.md.
   */
  async searchOffers(filter: OfferFilter): Promise<Offer[]> {
    const q = {
      gpu_name: filter.gpuName,
      num_gpus: filter.gpuCount,
      gpu_ram: `>= ${filter.minGpuRamGb * 1024}`,
      type: filter.interruptible ? "interruptible" : "on-demand",
      rentable: true,
      order: "dph_total",
    };
    const payload = await this.call(`/api/v0/bundles?q=${encodeURIComponent(JSON.stringify(q))}`);
    return offersFromBundles(payload);
  }

  /** Create an instance from an offer id. Returns the new instance id. */
  async createInstance(offerId: number, opts: CreateInstanceOpts): Promise<number> {
    const body = {
      client_id: "me",
      image: opts.image,
      disk: opts.diskGb,
      label: opts.label,
      env: {
        OLLAMA_HOST: "0.0.0.0:11434",
        OLLAMA_MODELS: opts.models.join(","),
      },
      ssh: true,
      jupyter: false,
      direct: true,
      runtype: "ssh",
    };
    const payload = (await this.call(`/api/v0/asks/${offerId}/`, {
      method: "PUT",
      body: JSON.stringify(body),
    })) as Record<string, unknown>;
    const id = payload?.new_contract;
    if (typeof id !== "number") {
      throw new VastApiError("create instance: response has no new_contract", undefined, safeJson(payload));
    }
    return id;
  }

  async listInstances(): Promise<VastInstance[]> {
    const payload = (await this.call("/api/v0/instances/")) as Record<string, unknown>;
    const arr = payload?.instances;
    if (!Array.isArray(arr)) {
      throw new VastApiError("Unexpected /instances payload", undefined, safeJson(payload));
    }
    return arr.map(instanceFromPayload).filter((i) => i.id > 0);
  }

  async getInstance(id: number): Promise<VastInstance | undefined> {
    return (await this.listInstances()).find((i) => i.id === id);
  }

  async destroyInstance(id: number): Promise<void> {
    await this.call(`/api/v0/instances/${id}/`, { method: "DELETE" });
  }
}
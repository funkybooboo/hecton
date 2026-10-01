/**
 * Vast.ai REST client (console.vast.ai, API v0).
 *
 * VERIFIED 2026-10-01 (live, see docs/vast-api-notes.md):
 *   - Search: GET /api/v0/bundles/?q=<url-encoded-json>  (PUBLIC, no auth)
 *     q fields are operator dicts: {"gpu_ram":{"gte":<MB>},"num_gpus":
 *     {"eq":<n>},"rentable":{"eq":true},"order":[["dph_total","asc"]]}
 *     Response: {"offers": [...], "truncated": bool}. Sorted ascending, so
 *     even when truncated at 64 results the cheapest offers are included.
 *     gpu_ram is MB; disk_space is GB.
 *   - The "type" filter is pricing-type (on_demand|ask|bid|reserved), NOT
 *     "interruptible" - interruptible is chosen at creation time (v0.3.0).
 *
 * NOT yet verified (needs the user's API key): create instance, list/destroy
 * instances. Those paths/fields are marked below and throw VastApiError with
 * the raw body so drift is fixable in minutes.
 */

export interface Offer {
  id: number;
  gpuName: string;
  numGpus: number;
  gpuRamGb: number;
  pricePerHour: number;
  diskSpaceGb?: number;
  reliability?: number;
  inetDownMbps?: number;
  rentable?: boolean;
}

export interface OfferFilter {
  gpuName: string;
  gpuCount: number;
  minGpuRamGb: number;
  /** Host must be able to allocate at least this much instance disk. */
  minDiskGb: number;
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
      diskSpaceGb: num(o.disk_space) || undefined,
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
    .filter((o) => o.diskSpaceGb == null || o.diskSpaceGb >= filter.minDiskGb)
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
  /** Search is public; instance lifecycle calls require the key. */
  constructor(
    readonly apiKey: string | undefined,
    readonly baseUrl: string = "https://console.vast.ai",
  ) {}

  private async call(path: string, init?: RequestInit): Promise<unknown> {
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}${path}`, {
        ...init,
        headers: {
          ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}),
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
   * Search offers. Verified query format (2026-10-01): field filters are
   * operator dicts, order is a list of [field, direction] tuples. GPU name
   * matching stays client-side so broad config values ("RTX PRO 6000")
 * keep working; the server-side sort guarantees the cheapest eligible
   * offers are inside the (capped) result set.
   */
  async searchOffers(filter: OfferFilter): Promise<Offer[]> {
    const q = {
      num_gpus: { eq: filter.gpuCount },
      gpu_ram: { gte: Math.round(filter.minGpuRamGb * 1024) },
      rentable: { eq: true },
      order: [["dph_total", "asc"]],
    };
    const payload = await this.call(`/api/v0/bundles/?q=${encodeURIComponent(JSON.stringify(q))}`);
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
        // HECTON_* not OLLAMA_*: OLLAMA_MODELS is reserved by ollama (its
        // models storage dir); the server entrypoint reads HECTON_MODELS.
        HECTON_MODELS: opts.models.join(","),
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
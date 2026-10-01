import { describe, expect, test } from "bun:test";
import { estimateCost, formatElapsed, formatUsd, monthlySpend } from "../extensions/hecton/src/cost.ts";
import type { CostRecord } from "../extensions/hecton/src/state.ts";
import { instanceFromPayload, offersFromBundles, pickCheapest, type Offer } from "../extensions/hecton/src/vast.ts";

const HOUR = 3_600_000;

describe("estimateCost", () => {
  test("computes elapsed hours and cost", () => {
    const now = 1_000_000_000;
    const { elapsedHours, costUsd } = estimateCost(1.5, now - 2 * HOUR, now);
    expect(elapsedHours).toBe(2);
    expect(costUsd).toBe(3);
  });

  test("negative elapsed clamps to zero", () => {
    const now = 1_000_000_000;
    const { elapsedMs, costUsd } = estimateCost(1.5, now + HOUR, now);
    expect(elapsedMs).toBe(0);
    expect(costUsd).toBe(0);
  });
});

describe("formatting", () => {
  test("usd", () => {
    expect(formatUsd(1.004)).toBe("$1.00");
    expect(formatUsd(0)).toBe("$0.00");
  });
  test("elapsed", () => {
    expect(formatElapsed(0)).toBe("0m");
    expect(formatElapsed(5 * 60_000)).toBe("5m");
    expect(formatElapsed(90 * 60_000)).toBe("1h 30m");
  });
});

describe("monthlySpend", () => {
  test("sums only current-month records", () => {
    const now = new Date("2026-10-15T12:00:00Z");
    const ledger: CostRecord[] = [
      { instanceId: 1, startedAt: 0, endedAt: new Date("2026-10-01T00:00:01Z").getTime(), costUsd: 1.25 },
      { instanceId: 2, startedAt: 0, endedAt: new Date("2026-10-14T18:00:00Z").getTime(), costUsd: 2.5 },
      { instanceId: 3, startedAt: 0, endedAt: new Date("2026-09-30T23:00:00Z").getTime(), costUsd: 100 },
    ];
    expect(monthlySpend(ledger, now)).toBe(3.75);
  });
});

describe("offersFromBundles", () => {
  test("parses offers defensively, converting gpu_ram MB to GB", () => {
    const offers = offersFromBundles({
      offers: [
        { id: 11, gpu_name: "H100_SXM", num_gpus: 1, gpu_ram: 79872, dph_total: 1.23, rentable: true },
        { id: 12, gpu_name: "H100_SXM", num_gpus: 2, gpu_ram: 80, dph_total: 2.5, rentable: true },
        { bad: true },
      ],
    });
    expect(offers.length).toBe(2); // id-less entry dropped
    expect(offers[0]).toMatchObject({ id: 11, gpuRamGb: 78, pricePerHour: 1.23 });
    expect(offers[1].gpuRamGb).toBe(80); // already-GB values pass through
  });

  test("throws VastApiError with body snippet on bad payload", () => {
    expect(() => offersFromBundles({ nope: true })).toThrow(/no offers array/);
  });
});

describe("pickCheapest", () => {
  const filter = { gpuName: "H100_SXM", gpuCount: 1, minGpuRamGb: 78, interruptible: true };
  const mk = (over: Partial<Offer>): Offer => ({
    id: 1,
    gpuName: "H100_SXM",
    numGpus: 1,
    gpuRamGb: 80,
    pricePerHour: 1.4,
    rentable: true,
    ...over,
  });

  test("picks cheapest eligible under cap", () => {
    const offers = [mk({ id: 1, pricePerHour: 1.5 }), mk({ id: 2, pricePerHour: 1.2 }), mk({ id: 3, pricePerHour: 1.05 })];
    expect(pickCheapest(offers, filter, 1.6)?.id).toBe(3);
  });

  test("enforces cap", () => {
    const offers = [mk({ id: 1, pricePerHour: 1.9 })];
    expect(pickCheapest(offers, filter, 1.6)).toBeUndefined();
  });

  test("filters by gpu count, ram, rentable, reliability", () => {
    const offers = [
      mk({ id: 10, numGpus: 2 }),
      mk({ id: 11, gpuRamGb: 40 }),
      mk({ id: 12, rentable: false }),
      mk({ id: 13, reliability: 0.8 }),
      mk({ id: 14, gpuName: "RTX4090" }),
    ];
    expect(pickCheapest(offers, filter, 2)).toBeUndefined();
  });

  test("gpu name matching: broad config matches specific offers, not vice versa", () => {
    const broadFilter = { ...filter, gpuName: "H100" };
    const offers = [mk({ id: 20, gpuName: "H100_80GB_HBM3", pricePerHour: 1.1 })];
    expect(pickCheapest(offers, broadFilter, 2)?.id).toBe(20);
    // A specific config must not silently match a different GPU listing.
    expect(pickCheapest(offers, filter, 2)).toBeUndefined();
  });
});

describe("instanceFromPayload", () => {
  test("extracts ip, ssh port, status variants", () => {
    const inst = instanceFromPayload({
      id: 42,
      cur_state: "running",
      public_ipaddr: "1.2.3.4",
      ports: { "22/tcp": [{ HostPort: "40022" }] },
      dph_total: 1.37,
    });
    expect(inst).toMatchObject({ id: 42, running: true, publicIp: "1.2.3.4", sshPort: 40022, pricePerHour: 1.37 });
  });

  test("handles alternate field names and non-running states", () => {
    const inst = instanceFromPayload({
      id: 43,
      actual_status: "exited",
      public_ip: "5.6.7.8",
      port_mappings: { "22": { HostPort: 2222 } },
    });
    expect(inst.running).toBe(false);
    expect(inst.publicIp).toBe("5.6.7.8");
    expect(inst.sshPort).toBe(2222);
  });

  test("missing ssh mapping yields undefined port", () => {
    const inst = instanceFromPayload({ id: 44, cur_state: "running" });
    expect(inst.sshPort).toBeUndefined();
  });
});
import { loadConfig, resolveApiKey } from "./extensions/hecton/src/config.ts";
import { VastClient, instanceFromPayload } from "./extensions/hecton/src/vast.ts";
const cfg = loadConfig();
const client = new VastClient(resolveApiKey(cfg)!);
for (let i = 0; i < 48; i++) {
  const payload = (await (client as any).call("/api/v1/instances/")) as any;
  const inst = instanceFromPayload(payload.instances.find((r: any) => r?.id === 53772836));
  if (inst.running) { console.log(`RUNNING after ~${i * 10}s of watching`); process.exit(0); }
  process.stdout.write(`[${i * 10}s] ${inst.status}... `);
  await new Promise(r => setTimeout(r, 10_000));
}
console.log("still not running after 8 min");

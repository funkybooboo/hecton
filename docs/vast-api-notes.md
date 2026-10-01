# Vast.ai REST API: verified facts and remaining assumptions

## VERIFIED 2026-10-01 (live probes, no account needed)

### Auth scope

- **Offer search is public.** No Authorization header required. All other
  endpoints (instances, create, destroy) require `Authorization: Bearer <key>`.

### Search offers

- `GET https://console.vast.ai/api/v0/bundles/?q=<url-encoded-json>`
  (trailing slash required; without it the API 301-redirects)
- `q` fields are **operator dicts** (validated error messages enumerate the
  allowed operators): `eq, neq, gte, gt, lte, lt, in, notin`
- `order` is a list of `[field, direction]` tuples: `"order": [["dph_total", "asc"]]`
- Verified working query:
  `{"num_gpus":{"eq":1},"gpu_ram":{"gte":92160},"rentable":{"eq":true},"order":[["dph_total","asc"]]}`
- Response: `{"offers": [...], "truncated": bool}`
- Results are capped (64 observed). Because the sort is server-side ascending,
  the cheapest eligible offers are always inside the returned set; truncation
  only drops expensive tail entries.
- `gpu_name` matching is done client-side (vast.ts) so config values can be
  broad ("RTX PRO 6000" matches Max-Q/WS/S variants).
- Offer field semantics observed:
  - `gpu_ram` is **MB** (96GB card reports 97887)
  - `disk_space` is **GB** (the host's allocatable max; offers as small as
    24GB exist - the picker filters `disk_space >= cfg.diskGb + 15`)
  - `dph_total` = total $/hour (GPU + CPU + disk) for the instance
  - `reliability` in 0..1; `rentable` boolean
- The `type` q-field is pricing-type: `on_demand | on-demand | ondemand |
  ask | bid | reserved`. It is NOT "interruptible" (that is chosen at
  instance creation; see v0.3.0 plans for bid/interruptible support).
- Live market snapshot (cheapest observed, 2026-10-01):
  A800 PCIE 80GB $0.47/hr, RTX PRO 6000 Max-Q 96GB $0.64/hr,
  2x A800 $0.93/hr, 2x RTX PRO 6000 Max-Q $1.27/hr,
  4x A100 80GB $3.74/hr, 4x RTX PRO 6000 S $4.75/hr,
  H200 141GB $3.56/hr, B200 179GB $6.25/hr. **No H100s listed at all.**

## STILL TO VERIFY (needs the user's API key; the v0.2.0 runbook)

### Create instance

- Assumed: `PUT /api/v0/asks/<offer_id>/` with body
  `{"client_id":"me","image":...,"disk":<gb>,"label":...,"env":{...},"ssh":true,"jupyter":false,"direct":true,"runtype":"ssh"}`
- Assumed response: `{"new_contract": <instance_id>}`
- If this drifted (newer API may use `/api/v0/bundles/request/`), the error
  body surfaces in the VastApiError message; fix `createInstance` in place.

### Instances

- Assumed: `GET /api/v0/instances/` -> `{"instances":[...]}`;
  `DELETE /api/v0/instances/<id>/` destroys.
- Instance fields assumed: `id`, `label`, `cur_state`/`actual_status`
  (`running`, `exited`, `error`, provisioning states), `public_ipaddr`,
  `ports: {"22/tcp": [{"HostPort": <n>}]}`, `dph_total`.

### SSH

- Instance accepts SSH with the key registered in the vast.ai console
  (settings -> SSH keys) as `root@<public_ip> -p <HostPort>`.
- Whether the image must run sshd itself (hecton-server does, best effort)
  or vast.ai provisions it regardless.
- Whether `direct: true` is correct vs the proxy connection path.

### Billing

- Whether a destroyed instance's disk keeps billing after destroy
  (the extension records cost from `price_per_hour * elapsed` locally).

## v0.2.0 live verification order (read-only first)

1. `/hecton-check` - offers already verified live; now also confirms the key
   via the instances list (read-only auth check).
2. Build + push `natestott/hecton-server:latest` (local CPU smoke test
   first: server/README.md).
3. `/hecton-up` with default small models; watch instance reach running;
   fix `createInstance`/`instanceFromPayload` if field names drifted.
4. `/hecton-connect`; if SSH fails, test `ssh -p <port> root@<ip>` manually
   and check the vast.ai console SSH settings.
5. `/model hecton:qwen3-coder:30b` - first end-to-end completion.
6. `/hecton-down` - destroy + cost record; confirm billing stopped on the
   vast.ai console; reconcile the locally recorded cost.
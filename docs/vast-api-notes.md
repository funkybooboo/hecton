# Vast.ai REST assumptions (VERIFY in v0.2.0)

Everything in `extensions/hecton/src/vast.ts` is written from training
knowledge, not from a live API session. This file lists every assumption so
the first live session (read-only first, then a $1-2 throwaway launch) can
confirm or fix each one quickly. The `vastai` CLI (`pip install vastai`) is
the reference implementation and the fallback driver if REST shapes have
drifted.

## Auth

- Header `Authorization: Bearer <key>` on every call.
- Key source: https://console.vast.ai/account (API keys section).

## Search offers

- `GET https://console.vast.ai/api/v0/bundles?q=<url-encoded-json>`
- `q` shape assumed: `{"gpu_name":"H100_SXM","num_gpus":1,"gpu_ram":">= 79872","type":"interruptible","rentable":true,"order":"dph_total"}`
- Response assumed: `{"offers": [...]}`
- VERIFY: whether `order` lives inside `q` or is a separate query param.
- VERIFY: `gpu_ram` unit (MB historically: 79872 for 80GB). The client
  sends MB and converts defensively.
- VERIFY: `gpu_name` values in offers (`H100_SXM`? `H100_80GB_HBM3`?).
  The picker matches case-insensitively with substring tolerance.
- VERIFY: offer field names `dph_total`, `num_gpus`, `reliability`,
  `inet_down`, `rentable`.

## Create instance

- `PUT https://console.vast.ai/api/v0/asks/<offer_id>/`
- Body assumed:
  `{"client_id":"me","image":...,"disk":<gb>,"label":...,"env":{...},"ssh":true,"jupyter":false,"direct":true,"runtype":"ssh"}`
- Response assumed: `{"new_contract": <instance_id>}`
- VERIFY: newer API may use `PUT /api/v0/bundles/request/` with a query
  payload instead of `/asks/<id>/`.
- VERIFY: `env` semantics (object of key/value strings?).

## Instances

- `GET https://console.vast.ai/api/v0/instances/` -> `{"instances":[...]}`
- Instance fields assumed: `id`, `label`, `cur_state` (values seen:
  `running`, `exited`, `error`, provisioning states), `public_ipaddr`,
  `ports: {"22/tcp": [{"HostPort": <n>}]}`, `dph_total`.
- VERIFY: exact status strings and whether `actual_status` exists.
- Destroy: `DELETE /api/v0/instances/<id>/`

## SSH

- Vast.ai instances accept SSH with the key registered on your vast.ai
  account (settings -> SSH keys). The extension shells out to local `ssh`
  with `root@<public_ip> -p <HostPort>`.
- VERIFY: whether the image must run sshd itself (hecton-server does, best
  effort) or Vast.ai provisions SSH regardless.
- VERIFY: whether `direct: true` is the right choice for SSH (proxy vs
  direct connection paths).

## Billing

- `dph_total` covers GPU + CPU + disk while the instance contract exists.
- VERIFY: whether a destroyed instance's disk keeps billing until storage
  reclaim, and whether "storage cost" appears separately (`dph_disk`).
- Spot (interruptible) instances can be stopped by the host at any time.
  VERIFY: whether a SIGTERM/warning precedes destruction.

## v0.2.0 live verification order (read-only first)

1. `/vast check` - auth + offer search; inspect raw payload if it errors
   (VastApiError includes the body).
2. Fix any drift found in `vast.ts` parsing (field names only, most likely).
3. `/vast up` with the default small models; watch instance reach running.
4. Confirm SSH port/IP extraction; `/vast connect`.
5. `/model vast:qwen3-coder:30b` - first token end to end.
6. `/vast down` - destroy + cost record.
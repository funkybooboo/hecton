# hecton

Rent spot GPUs on Vast.ai on demand and serve their models to pi. One
command in the pi TUI finds the cheapest qualifying spot GPU under your
price cap, launches it with an Ollama server image, tunnels it to
`127.0.0.1:11435`, and exposes the remote models as a normal pi provider.
Another command destroys it and reports what it cost. The "Ollama Cloud"
experience, on hardware you rent by the hour - with any open-weights
model, including the ones Ollama's registry only serves behind its cloud
(GLM-5.3 and friends are open on HuggingFace; see
`plans/v0.2.0-first-live-session.md`).

Why: hardware research (saved in `idea.md`) concluded that spot-renting
for evening/weekend coding hours costs a fraction of a $12k+ workstation,
with a bigger model selection and no subscription rate limits.

```
+--------------+  ssh -L 11435       +------------------------------+
| pi (laptop)  | ==================> | vast.ai spot GPU (rented)    |
|              |                     |  hecton-server (Ollama)      |
| /model vast: | <================== |  qwen3.5, GLM, gpt-oss, ...  |
| /vast-up     |  OpenAI-compat /v1  +------------------------------+
+--------------+
```

## Status

v0.2.0 development. Offer search is verified against the live API
(2026-10-01) and `/vast-check` works without an account; instance
create/list/destroy still need first-run verification with an API key
(assumptions tracked in `docs/vast-api-notes.md`). See
`plans/v0.2.0-first-live-session.md` for the runbook and the
market-verified tier table (budget $0.47/hr to frontier GLM-5.3 at
$3.74-4.75/hr).

## Layout

| Path                 | What                                                      |
|----------------------|-----------------------------------------------------------|
| `extensions/hecton/` | pi extension: commands, Vast client, tunnel, provider     |
| `server/`            | Docker image that runs on the GPU instance                |
| `plans/`             | Milestone plan docs (v0.2.0 has the tier table)           |
| `docs/`              | Vast.ai API verified facts + remaining assumptions         |
| `test/`              | Unit tests for the pure logic (`bun test`)                |

## Setup

One-time, on the laptop:

1. Create a [vast.ai](https://vast.ai) account, add ~$5 credit, create an
   **API key**, and register an **SSH public key** (console -> settings).
2. Install the extension into pi:

   ```bash
   pi install git:github.com/funkybooboo/hecton
   # or while hacking on this repo: pi -e ./extensions/hecton/index.ts
   ```

3. Put the key somewhere the extension reads (pick one):

   ```bash
   mkdir -p ~/.pi/agent/hecton
   echo 'VAST_API_KEY=yourkey' > ~/.pi/agent/hecton/.env
   chmod 600 ~/.pi/agent/hecton/.env
   # alternatives: export VAST_API_KEY=..., or "apiKey" in hecton.json
   ```

4. Optional config at `~/.pi/agent/hecton.json`
   (`extensions/hecton/hecton.example.json`); defaults target a single
   RTX PRO 6000 Max-Q (96GB) at a $1.20/hr cap.

One-time, for the server image:

```bash
docker build -t funkybooboo/hecton-server:latest server/
docker push funkybooboo/hecton-server:latest
```

## Usage

```text
/vast-up        find the cheapest offer under the cap, launch it,
                pull configured models, tunnel it
/vast-connect   reattach after a spot interruption or pi restart
/vast-status    instance / tunnel / models / cost summary
/vast-models    list models on the instance; /vast-models pull <tag>
/vast-cost      month-to-date spend
/vast-check     read-only: market prices + API key auth check
/vast-down      destroy the instance and record the cost
```

Typical session: `/vast-up` -> (models pre-pull in the background while you
start with whatever is ready) -> `/model vast:qwen3-coder:30b` -> work ->
`/vast-down`.

Instance state lives at `~/.pi/agent/hecton/state.json`; pi keeps all
conversation state locally, so a spot interruption costs nothing but a
`/vast-up` relaunch.

## Model tiers (verified market + weights sizes, 2026-10-01)

| Tier | Model | Hardware | ~$/hr | ~$/mo* |
|------|-------|----------|-------|--------|
| budget | gpt-oss:120b (65GB) | 1x A800 80GB | $0.47 | $55 |
| workhorse | qwen3.5:122b-a10b (81GB) | 1x RTX PRO 6000 Max-Q | $0.64 | $74 |
| daily driver | GLM-5.3-Flash IQ4_XS (157GB) | 2x RTX PRO 6000 Max-Q | $1.27 | $147 |
| frontier | GLM-5.3 IQ3_XXS (282GB) | 4x A100 80GB | $3.74 | $434 |

*~116 hrs/month usage. GLM weights come from HuggingFace GGUFs
(`hf.co/unsloth/...` in the models config); the ollama registry only
offers glm/kimi/minimax as `:cloud` tags.

## Development

```bash
bun test          # pure-logic unit tests
npx tsc --noEmit  # type check (needs npm install first)
```

The extension hot-reloads with `/reload` when loaded from this repo
(`.pi/settings.json` wires it in for project sessions).

## Notes

- Renting spot instances means the host can take the GPU back; the
  extension notices and relaunches. Interruptible bidding (pay under ask,
  accept preemption) is a v0.3.0 feature.
- Costs while an instance exists are `dph_total` (GPU + CPU + disk);
  destroying stops the meter. Nothing is billed while no instance exists.
- Offer search hits the public Vast.ai API; your key is only used for
  instance lifecycle calls and is never sent anywhere else.
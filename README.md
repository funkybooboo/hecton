# hecton

Rent spot H100 GPUs on Vast.ai on demand and serve their models to pi.
One command in the pi TUI finds the cheapest spot GPU under your price cap,
launches it with an Ollama server image, tunnels it to `127.0.0.1:11435`,
and exposes the remote models as a normal pi provider. Another command
destroys it and reports what it cost. The "Ollama Cloud" experience, on
hardware you rent by the hour.

Why: hardware research (saved in `idea.md`) concluded that spot-renting H100s
for evening/weekend coding hours costs ~$140-280/month versus $12k+ up front
for a Mac Studio class machine, with a bigger model selection and no
subscription rate limits.

```
+--------------+  ssh -L 11435       +------------------------------+
| pi (laptop)  | ==================> | vast.ai spot H100 (rented)   |
|              |                     |  hecton-server (Ollama)      |
| /model vast: | <================== |  qwen3-coder, gpt-oss, ...    |
| /vast up     |  OpenAI-compat /v1  +------------------------------+
+--------------+
```

## Status

v0.1.0 - bootstrap. The extension and server image are complete and the
pure logic is unit-tested, but no Vast.ai API call has run against the live
service yet. The v0.2.0 milestone is the first live session; every REST
assumption is tracked in `docs/vast-api-notes.md` with a verification
checklist. See `plans/v0.1.0-bootstrap.md` for the roadmap.

## Layout

| Path              | What                                                        |
|-------------------|-------------------------------------------------------------|
| `extensions/hecton/` | pi extension: commands, Vast client, tunnel, provider     |
| `server/`         | Docker image that runs on the GPU instance                   |
| `plans/`          | Milestone plan docs                                          |
| `docs/`           | Vast.ai API assumptions to verify live                      |
| `test/`           | Unit tests for the pure logic (`bun test`)                   |

## Setup

One-time, on the laptop:

1. Create a [vast.ai](https://vast.ai) account, add a few dollars of credit,
   copy your **API key** (console -> account), and register an **SSH public
   key** (console -> settings -> SSH keys).
2. Install the extension into pi:

   ```bash
   pi install git:github.com/funkybooboo/hecton
   # or while hacking on this repo: pi -e ./extensions/hecton/index.ts
   ```

3. Configure (~/.pi/agent/hecton.json, see
   `extensions/hecton/hecton.example.json`):

   ```json
   {
     "apiKey": "YOUR_VAST_KEY",
     "maxPricePerHour": 1.6,
     "models": [{ "id": "qwen3-coder:30b" }]
   }
   ```

   Your key is also picked up from `VAST_API_KEY`, or prompted on first
   `/vast up` and stored for you. Everything else has sane defaults.

One-time, for the server image:

```bash
docker build -t funkybooboo/hecton-server:latest server/
docker push funkybooboo/hecton-server:latest
```

Until you push your own image, the extension's default image name will not
exist remotely - update `"image"` in the config if you use a different
Docker Hub namespace.

## Usage

```text
/vast up            find the cheapest H100 spot offer under the cap,
                    launch it, pull configured models, tunnel it
/vast connect      reattach after a spot interruption or pi restart
/vast status        instance / tunnel / models / cost summary
/vast models        list models on the instance; /vast models pull <tag>
/vast cost          month-to-date spend
/vast down          destroy the instance and record the cost
```

Typical session: `/vast up` -> (models pre-pull in the background while you
start with whatever is ready) -> `/model vast:qwen3-coder:30b` -> work ->
`/vast down`.

The instance state lives at `~/.pi/agent/hecton/state.json`; pi keeps all
conversation state locally, so a spot interruption costs nothing but a
`/vast up` relaunch.

## Development

```bash
bun test          # pure-logic unit tests
npx tsc --noEmit  # type check (needs npm install first)
```

The extension hot-reloads with `/reload` when loaded from this repo
(`.pi/settings.json` wires it in for project sessions).

## Notes

- Renting interruptible (spot) instances means the host can take the GPU
  back; the extension notices and relaunches.
- One 80GB H100 fits roughly 30B-class fp16 or 120B-class q4 models. The
  glm-5.3-class ~753B models you may know from Ollama Cloud need ~220GB+ at
  q4: set `"gpuCount": 3` or `4` (or target H200s) for those, and expect
  ~$4-6/hr spot.
- Costs while an instance exists are `dph_total` (GPU + CPU + disk);
  destroying stops the meter. Nothing is billed while no instance exists.
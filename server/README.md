# hecton-server

The Docker image that runs ON the Vast.ai GPU instance. One responsibility:
serve Ollama on `0.0.0.0:11434` and pre-pull the models you configured.

## Build and push

```bash
docker build -t natestott/hecton-server:latest .
docker push natestott/hecton-server:latest
```

The pi extension launches this image by name from `~/.pi/agent/hecton.json`
(`"image"` field).

## Environment variables

| Variable          | Default             | Meaning                                        |
|-------------------|---------------------|------------------------------------------------|
| `HECTON_MODELS`   | (empty)             | Comma-separated ollama tags to pre-pull on boot (NOT `OLLAMA_MODELS`, which ollama reserves for its storage dir) |
| `OLLAMA_HOST`     | `0.0.0.0:11434`     | Bind address (do not change on Vast.ai)        |
| `OLLAMA_KEEP_ALIVE` | `30m`              | Keep models warm between requests              |

The pi extension passes `HECTON_MODELS` at instance-create time from the
configured model list.

## Local smoke test (no GPU needed)

```bash
docker build -t hecton-server:local .
docker run --rm -p 11434:11434 -e HECTON_MODELS=qwen2.5:0.5b hecton-server:local
# in another shell:
curl -s http://localhost:11434/v1/models
```

Ollama runs CPU-only without a GPU; a small model verifies the full
entrypoint path (sshd, serve, wait, pull).

## Design notes

- **No checkpoint machinery.** The instance is disposable; pi keeps all
  session state locally. What resilience costs is model re-download time on
  relaunch, which spot H100 bandwidth makes tolerable (see plan doc, D5).
- **sshd** is started best-effort because Vast.ai's SSH connection path may
  expect it. VERIFY in v0.2.0: if Vast.ai provisions SSH itself, drop
  openssh-server from the image.
- **SIGTERM trap**: Vast.ai signals before destroying spot instances; Ollama
  gets a clean shutdown instead of SIGKILL.
- **Pull failures do not kill the server**; retry from pi with
  `/vast models pull <tag>`.

## Verify on a live instance (v0.2.0)

1. `docker run --gpus all` equivalent: launch via `/vast up` and confirm
   `nvidia-smi` sees the GPU inside the container.
2. Confirm `ollama pull` writes to the instance disk (`disk` set at create
   time), not an ephemeral layer.
3. Confirm image size vs disk: q4 models run roughly 20-60GB each; `diskGb`
   in the pi config must cover all configured models plus headroom.
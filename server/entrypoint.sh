#!/bin/bash
# hecton-server entrypoint.
#
# Responsibilities:
#   1. Start sshd so Vast.ai's SSH connection path works (best effort).
#   2. Run `ollama serve` (listens on 0.0.0.0:11434 via OLLAMA_HOST).
#   3. Wait for the API, then pre-pull HECTON_MODELS (comma-separated tags).
#      HECTON_* not OLLAMA_*: OLLAMA_MODELS is reserved by ollama itself
#      (models storage directory); reusing it corrupts ollama's config.
#   4. Trap SIGTERM so spot interruptions (vast.ai sends SIGTERM before
#      destroying) shut Ollama down cleanly.
#
# The instance is disposable: pi holds all agent state locally, so this image
# deliberately has no checkpoint/state machinery (see plans/v0.1.0-bootstrap.md
# decision D5).

set -u

log() {
    echo "hecton: $*"
}

# --- 1. sshd for Vast.ai SSH access (best effort) ---
if command -v sshd >/dev/null 2>&1; then
    mkdir -p /run/sshd
    /usr/sbin/sshd 2>/dev/null || log "sshd failed to start"
fi

# --- 2. Ollama server ---
ollama serve &
SERVE_PID=$!

# --- 3. Wait for the API, then pre-pull models ---
(
    for _ in $(seq 1 120); do
        if curl -fsS http://127.0.0.1:11434/api/tags >/dev/null 2>&1; then
            break
        fi
        sleep 2
    done

    if [ -n "${HECTON_MODELS:-}" ]; then
        IFS=','
        for m in ${HECTON_MODELS}; do
            # Trim whitespace; skip empties.
            m="$(echo "$m" | xargs)"
            [ -z "$m" ] && continue
            log "pulling model: $m"
            if ollama pull "$m"; then
                log "pull done: $m"
            else
                log "pull FAILED: $m (server stays up; retry via /hecton-models pull)"
            fi
        done
    else
        log "HECTON_MODELS empty; no pre-pull"
    fi
) &

# --- 4. Graceful shutdown on spot interruption ---
term() {
    log "SIGTERM received - stopping Ollama"
    kill "$SERVE_PID" 2>/dev/null
    wait "$SERVE_PID" 2>/dev/null
    exit 0
}
trap term TERM INT

log "ready - Ollama API on :11434, HECTON_MODELS=[${HECTON_MODELS:-}]"
wait "$SERVE_PID"
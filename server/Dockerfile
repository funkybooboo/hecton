# hecton-server: Ollama image tuned for Vast.ai spot GPU instances.
#
# Build and push (see server/README.md):
#   docker build -t funkybooboo/hecton-server:latest server/
#   docker push funkybooboo/hecton-server:latest
#
# The entrypoint starts sshd (Vast.ai SSH access), runs `ollama serve`, waits
# for the API, then pre-pulls the comma-separated HECTON_MODELS list.

FROM docker.io/ollama/ollama:latest

USER root

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        ca-certificates \
        curl \
        openssh-server \
    && rm -rf /var/lib/apt/lists/*

ENV OLLAMA_HOST=0.0.0.0:11434 \
    HECTON_MODELS="" \
    OLLAMA_KEEP_ALIVE=30m

COPY entrypoint.sh /usr/local/bin/hecton-entrypoint
RUN chmod +x /usr/local/bin/hecton-entrypoint

# Ollama API up = healthy. Model pulls may still be in flight.
HEALTHCHECK --interval=30s --timeout=10s --start-period=90s --retries=3 \
    CMD curl -fsS http://127.0.0.1:11434/api/tags || exit 1

EXPOSE 11434

ENTRYPOINT ["/usr/local/bin/hecton-entrypoint"]
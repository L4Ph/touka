# Match the helper protocol to the installed @cloudflare/sandbox version.
FROM docker.io/cloudflare/sandbox:1.0.3 AS sandbox-tools
FROM node:24-bookworm-slim
COPY --from=sandbox-tools /usr/local/bin/sandbox-shim /usr/local/bin/sandbox-shim
RUN apt-get update && apt-get install -y --no-install-recommends python3 && rm -rf /var/lib/apt/lists/* && mkdir -p /workspace
WORKDIR /workspace
CMD ["sleep", "infinity"]

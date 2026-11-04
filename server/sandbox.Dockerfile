FROM node:24-trixie-slim

# Provision once at image build, never during a user's coding task.
COPY sandbox-packages.txt /tmp/sandbox-packages.txt
RUN apt-get update \
    && xargs apt-get install -y --no-install-recommends < /tmp/sandbox-packages.txt \
    && rm -rf /var/lib/apt/lists/* \
    && git --version && gh --version && jq --version \
    && node --version && npm --version && python3 --version

WORKDIR /workspace
CMD ["sleep", "infinity"]

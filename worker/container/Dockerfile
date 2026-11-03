# Worker images for the AgentCore Runtimes `dshsa_worker` (target claude) and `dshsa_worker_codex` (target codex), linux/arm64.
# Build context: repository root. One base, one agent per image: each runtime's pin manifest stays under PIN_MAX_BYTES
# (both CLIs together would be ~700 MB of first-turn files; claude ~420 MB, codex ~385 MB).
#   docker build --platform linux/arm64 -f worker/container/Dockerfile -t dshsa-worker .                        (claude: last stage)
#   docker build --platform linux/arm64 -f worker/container/Dockerfile --target codex -t dshsa-worker-codex .
FROM public.ecr.aws/amazonlinux/amazonlinux:2023 AS base

# amazon-efs-utils: mount.s3files + efs-proxy + watchdog (system python3 needs botocore for the awsprofile).
# python3.12: gateway + agent. git + gh: the agent's repo work. /sys is read-only in the microVM: no readahead tuning.
RUN dnf install -y --setopt=install_weak_deps=False amazon-efs-utils python3.12 python3.12-pip python3-pip git shadow-utils procps-ng \
        tar gzip findutils which && \
    python3 -m pip install --no-cache-dir botocore && \
    sed -i 's/^optimize_readahead = true/optimize_readahead = false/' /etc/amazon/efs/efs-utils.conf /etc/amazon/efs/s3files-utils.conf && \
    curl -fsSL -o /etc/yum.repos.d/gh-cli.repo https://cli.github.com/packages/rpm/gh-cli.repo && dnf install -y gh && \
    dnf clean all && rm -rf /var/cache/dnf

COPY worker/container/requirements.txt /app/requirements.txt
RUN pip3.12 install --no-cache-dir -r /app/requirements.txt

ARG AGENT_UID=1000
RUN groupadd -g ${AGENT_UID} agent && useradd -u ${AGENT_UID} -g ${AGENT_UID} -m -d /home/agent agent && \
    mkdir -p /mnt/work /root/.aws /home/agent/work && chown ${AGENT_UID}:${AGENT_UID} /home/agent/work && chmod 700 /root /root/.aws

COPY packages/contracts/python/dshsa_contracts.py /app/dshsa_contracts.py
COPY worker/src/dshsa_worker /app/dshsa_worker
COPY worker/container/gateway.py worker/container/gateway_core.py worker/container/agent.py worker/container/agent_core.py \
     worker/container/inbox.py worker/container/render.py worker/container/repo.py worker/container/pinner.py worker/container/pin_manifest.py \
     worker/container/entrypoint.sh worker/container/git-credential-dshsa worker/container/gh /app/
RUN chmod 755 /app/entrypoint.sh /app/git-credential-dshsa /app/gh && chmod 644 /app/*.py && \
    mv /usr/bin/gh /usr/bin/gh-real && ln -s /app/gh /usr/local/bin/gh

ENV PYTHONPATH=/app PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
EXPOSE 8080
ENTRYPOINT ["/app/entrypoint.sh"]

# ---- codex: the static musl codex binary (+ rg) from the pinned npm platform tarball, checked against its sha256 ----------
FROM base AS codex-fetch
ARG CODEX_VERSION=0.166.0
ARG CODEX_SHA256=9044e840397864fc6c539d13719b25fb26abb35d5353366cbabf7b4555406acd
RUN curl -fsSL -o /tmp/codex.tgz "https://registry.npmjs.org/@openai/codex/-/codex-${CODEX_VERSION}-linux-arm64.tgz" && \
    echo "${CODEX_SHA256}  /tmp/codex.tgz" | sha256sum -c - && mkdir -p /opt/codex && \
    tar -xzf /tmp/codex.tgz -C /opt/codex --strip-components=3 \
        package/vendor/aarch64-unknown-linux-musl/bin/codex package/vendor/aarch64-unknown-linux-musl/codex-path/rg && \
    /opt/codex/bin/codex --version | grep -qx "codex-cli ${CODEX_VERSION}"

FROM base AS codex
# Root-owned, read-only to the agent (the pinner reads them as root). Not shipped: codex-code-mode-host, voice, bwrap.
COPY --from=codex-fetch --chown=0:0 --chmod=755 /opt/codex/bin/codex /opt/codex/codex-path/rg /usr/local/bin/
COPY worker/container/codex_runner.py worker/container/codex-config.toml /app/
RUN chmod 644 /app/codex_runner.py /app/codex-config.toml && test ! -e /etc/codex && test ! -e /home/agent/.agents
ENV DSHSA_AGENT=codex
# Content version (contracts WorkerVersion), answered on every invocation: infra passes the hash it publishes in SSM
# /dshsa-worker-codex/version; a plain local build hashes the copied /app files instead.
ARG DSHSA_WORKER_VERSION=
RUN v="${DSHSA_WORKER_VERSION}"; \
    if [ -z "$v" ]; then v="local-$(cd /app && find . -type f ! -name WORKER_VERSION | LC_ALL=C sort | xargs sha256sum | sha256sum | cut -c1-16)"; fi; \
    echo "$v" > /app/WORKER_VERSION && chmod 644 /app/WORKER_VERSION
# Last: the files a first request reads, probed in this finished image (pin_manifest.py; here rg, then codex).
RUN python3.12 -E -s /app/pin_manifest.py /app/pin-manifest.txt && chmod 644 /app/pin-manifest.txt

# ---- claude (default, last stage): the Claude Agent SDK and its bundled CLI -----------------------------------------------
FROM base AS claude
COPY worker/container/requirements-claude.txt /app/requirements-claude.txt
RUN pip3.12 install --no-cache-dir -r /app/requirements-claude.txt
ENV DSHSA_AGENT=claude
# Content version (contracts WorkerVersion), answered on every invocation. infra passes the hash of the sources it builds from
# (the same value it publishes in SSM /dshsa-worker/version); a plain local build hashes the copied /app files instead.
ARG DSHSA_WORKER_VERSION=
RUN v="${DSHSA_WORKER_VERSION}"; \
    if [ -z "$v" ]; then v="local-$(cd /app && find . -type f ! -name WORKER_VERSION | LC_ALL=C sort | xargs sha256sum | sha256sum | cut -c1-16)"; fi; \
    echo "$v" > /app/WORKER_VERSION && chmod 644 /app/WORKER_VERSION
# Last: list the files a first request reads, probed in this finished image (pin_manifest.py). The gateway pins them before
# it opens :8080 so they survive the page-cache drop before the V2 snapshot (pinner.py). Nothing may replace them afterwards.
RUN python3.12 -E -s /app/pin_manifest.py /app/pin-manifest.txt && chmod 644 /app/pin-manifest.txt

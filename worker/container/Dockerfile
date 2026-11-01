# Worker image for AgentCore Runtime `dshsa_worker` (linux/arm64). Build context: repository root.
#   docker build --platform linux/arm64 -f worker/container/Dockerfile -t dshsa-worker .
FROM public.ecr.aws/amazonlinux/amazonlinux:2023

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
     worker/container/inbox.py worker/container/render.py worker/container/repo.py worker/container/entrypoint.sh worker/container/git-credential-dshsa \
     worker/container/gh /app/
RUN chmod 755 /app/entrypoint.sh /app/git-credential-dshsa /app/gh && chmod 644 /app/*.py && \
    mv /usr/bin/gh /usr/bin/gh-real && ln -s /app/gh /usr/local/bin/gh

# Content version (contracts WorkerVersion), answered on every invocation. infra passes the hash of the sources it builds from
# (the same value it publishes in SSM /dshsa-worker/version); a plain local build hashes the copied /app files instead.
ARG DSHSA_WORKER_VERSION=
RUN v="${DSHSA_WORKER_VERSION}"; \
    if [ -z "$v" ]; then v="local-$(cd /app && find . -type f ! -name WORKER_VERSION | LC_ALL=C sort | xargs sha256sum | sha256sum | cut -c1-16)"; fi; \
    echo "$v" > /app/WORKER_VERSION && chmod 644 /app/WORKER_VERSION

ENV PYTHONPATH=/app PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
EXPOSE 8080
ENTRYPOINT ["/app/entrypoint.sh"]

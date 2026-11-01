FROM public.ecr.aws/docker/library/python:3.12-slim
RUN pip install --no-cache-dir claude-agent-sdk==0.2.176 && useradd -u 1000 -m agent && mkdir -p /mnt/work && chown 1000:1000 /mnt/work
COPY s2.py /app/s2.py
USER 1000
WORKDIR /app
ENTRYPOINT ["python", "/app/s2.py"]

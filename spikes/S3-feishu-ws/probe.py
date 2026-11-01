"""Spike S3 probe: connectivity and latency from us-west-2 to Feishu (open.feishu.cn) and Lark (open.larksuite.com).

Stdlib only, so the same file runs locally and as a Lambda handler.
Without bot credentials we measure what a real long connection depends on:
  * DNS / TCP / TLS / HTTP latency to the OpenAPI host, POSTing to /callback/ws/endpoint
    (the call the Lark SDK makes to obtain its wss:// URL; with bad credentials it answers a JSON error),
  * DNS / TCP / TLS latency plus a WebSocket upgrade attempt to the msg-frontier host that serves the long connection,
  * a held-open TLS connection to the frontier host, to see how long an idle socket survives across the Pacific.

Usage: python3 probe.py <seconds> <interval> > samples.jsonl
"""
import json
import os
import socket
import ssl
import sys
import time

TARGETS = {
    "feishu": {"api": "open.feishu.cn", "ws": "msg-frontier.feishu.cn"},
    "lark": {"api": "open.larksuite.com", "ws": "msg-frontier.larksuite.com"},
}
CTX = ssl.create_default_context()


def _connect(host: str, timeout: float = 10.0):
    t0 = time.perf_counter()
    infos = socket.getaddrinfo(host, 443, proto=socket.IPPROTO_TCP)
    t1 = time.perf_counter()
    sock = socket.create_connection(infos[0][4][:2], timeout=timeout)
    t2 = time.perf_counter()
    tls = CTX.wrap_socket(sock, server_hostname=host)
    t3 = time.perf_counter()
    return tls, infos[0][4][0], {"dns_ms": (t1 - t0) * 1e3, "tcp_ms": (t2 - t1) * 1e3, "tls_ms": (t3 - t2) * 1e3}


def _request(tls: ssl.SSLSocket, raw: bytes) -> tuple[float, str]:
    t0 = time.perf_counter()
    tls.sendall(raw)
    data = b""
    while b"\r\n\r\n" not in data:
        chunk = tls.recv(4096)
        if not chunk:
            break
        data += chunk
    head = data.split(b"\r\n", 1)[0].decode(errors="replace")
    return (time.perf_counter() - t0) * 1e3, head


def probe_api(host: str) -> dict:
    tls, ip, timing = _connect(host)
    try:
        body = json.dumps({"AppID": "cli_spike_invalid", "AppSecret": "invalid"}).encode()
        raw = (f"POST /callback/ws/endpoint HTTP/1.1\r\nHost: {host}\r\nContent-Type: application/json\r\n"
               f"Content-Length: {len(body)}\r\nConnection: close\r\n\r\n").encode() + body
        http_ms, status = _request(tls, raw)
        return {**timing, "ip": ip, "http_ms": http_ms, "status": status}
    finally:
        tls.close()


def probe_ws(host: str) -> dict:
    tls, ip, timing = _connect(host)
    try:
        raw = (f"GET /ws/v2 HTTP/1.1\r\nHost: {host}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n"
               "Sec-WebSocket-Key: c3Bpa2UtczMtcHJvYmUtMDE=\r\nSec-WebSocket-Version: 13\r\n\r\n").encode()
        http_ms, status = _request(tls, raw)
        return {**timing, "ip": ip, "upgrade_ms": http_ms, "status": status}
    finally:
        tls.close()


def sample() -> list[dict]:
    rows = []
    for name, hosts in TARGETS.items():
        for kind, fn in (("api", probe_api), ("ws", probe_ws)):
            row = {"t": time.time(), "target": name, "kind": kind, "host": hosts[kind]}
            try:
                row.update(fn(hosts[kind]))
                row["ok"] = True
            except Exception as error:  # noqa: BLE001 - every failure is a data point
                row.update(ok=False, error=f"{type(error).__name__}: {error}")
            rows.append(row)
    return rows


def hold(host: str, seconds: float) -> dict:
    """Keep one idle TLS socket open and report when (if) the peer or the path drops it."""
    start = time.time()
    try:
        tls, ip, _ = _connect(host)
        tls.settimeout(5)
        while time.time() - start < seconds:
            try:
                if tls.recv(1) == b"":
                    return {"host": host, "held_s": time.time() - start, "end": "peer_closed"}
            except socket.timeout:
                continue
        tls.close()
        return {"host": host, "held_s": time.time() - start, "end": "kept_until_limit"}
    except Exception as error:  # noqa: BLE001
        return {"host": host, "held_s": time.time() - start, "end": f"{type(error).__name__}: {error}"}


def run(seconds: float, interval: float, out=sys.stdout) -> list[dict]:
    rows, deadline = [], time.time() + seconds
    while time.time() < deadline:
        batch = sample()
        rows += batch
        for row in batch:
            out.write(json.dumps(row) + "\n")
        out.flush()
        time.sleep(max(0.0, interval - 1))
    return rows


def summarize(rows: list[dict]) -> dict:
    out = {}
    for row in rows:
        k = f"{row['target']}/{row['kind']}"
        s = out.setdefault(k, {"n": 0, "fail": 0, "tls": [], "rt": [], "status": {}})
        s["n"] += 1
        if not row["ok"]:
            s["fail"] += 1
            s["status"][row["error"][:60]] = s["status"].get(row["error"][:60], 0) + 1
            continue
        s["tls"].append(row["tcp_ms"] + row["tls_ms"])
        s["rt"].append(row.get("http_ms", row.get("upgrade_ms", 0)))
        s["status"][row["status"]] = s["status"].get(row["status"], 0) + 1
    for s in out.values():
        for f in ("tls", "rt"):
            v = sorted(s.pop(f))
            s[f + "_p50"] = round(v[len(v) // 2], 1) if v else None
            s[f + "_p95"] = round(v[int(len(v) * 0.95) - 1 if len(v) > 1 else 0], 1) if v else None
            s[f + "_max"] = round(v[-1], 1) if v else None
    return out


def handler(event, _context):  # Lambda entry
    seconds = float(event.get("seconds", 840))
    if event.get("hold"):
        result = {"hold": [hold(TARGETS[t]["ws"], seconds) for t in TARGETS]}
        print("HOLD " + json.dumps(result), flush=True)
        return result
    # Async invocations: every sample goes to CloudWatch Logs as `SAMPLE {json}`, the summary as `SUMMARY {json}`.
    class Log:
        def write(self, line: str) -> None:
            if line.strip():
                print("SAMPLE " + line.strip(), flush=True)

        def flush(self) -> None:
            pass
    rows = run(seconds, float(event.get("interval", 15)), out=Log())
    result = {"region": os.environ.get("AWS_REGION"), "summary": summarize(rows), "samples": len(rows),
              "errors": [r for r in rows if not r["ok"]][:20]}
    print("SUMMARY " + json.dumps(result), flush=True)
    return result


if __name__ == "__main__":
    if sys.argv[1:2] == ["summarize"]:
        print(json.dumps(summarize([json.loads(line) for line in open(sys.argv[2])]), indent=1))
    elif sys.argv[1:2] == ["hold"]:
        print(json.dumps([hold(TARGETS[t]["ws"], float(sys.argv[2])) for t in TARGETS]))
    else:
        run(float(sys.argv[1]), float(sys.argv[2]))

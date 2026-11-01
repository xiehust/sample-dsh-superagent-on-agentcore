# Spike S3: Feishu/Lark long-connection reachability from AWS

Status: **pass for reachability and latency; a real WebSocket soak still needs a bot** (none was available).
Date 2026-11-01 · harness `S3-feishu-ws/probe.py` (stdlib), results in `S3-feishu-ws/results/`.

## What was measured

There were no bot credentials, so this measures what the long connection depends on, every ~15 s:

- **api**: DNS + TCP + TLS to the OpenAPI host, then `POST /callback/ws/endpoint`. That is the call the Lark SDK makes to get its `wss://` URL; with bad credentials it answers a JSON error with HTTP 200.
- **ws**: TCP + TLS to the long-connection frontier (`msg-frontier.feishu.cn` / `msg-frontier.larksuite.com`) plus a WebSocket upgrade request. Without a ticket it gets a 400, but that proves the path end to end.
- **hold**: one idle TLS socket to each frontier, to see when an idle connection is dropped.

Vantages:
- us-west-2: the dev desktop, an EC2 instance in us-west-2. 35 min, 544 samples.
- **ap-northeast-1**: Lambda `dshsa-spike-s3-probe` (stack `dshsa-spike-s3`, no VPC). 3 × 14 min = 42 min, 684 samples. This is where the connector will run.

## Results (ms; "connect" = TCP + TLS handshake, "rt" = request → response headers)

| Target | us-west-2 connect p50/p95 | us-west-2 rt p50/p95/max | **Tokyo connect p50/p95** | **Tokyo rt p50/p95/max** |
|---|---|---|---|---|
| Feishu OpenAPI `open.feishu.cn` | 177 / 182 | 444 / 471 / 477 | **109 / 112** | **162 / 172 / 189** |
| Feishu frontier (WS upgrade) | 31 / 35 | 380 / 405 / 457 | 46 / 49 | 227 / 245 / 253 |
| Lark OpenAPI `open.larksuite.com` | 18 / 25 | 200 / 520 / 699 | 8 / 11 | 97 / 245 / 315 |
| Lark frontier (WS upgrade) | 18 / 28 | 128 / 333 / 511 | 8 / 33 | 185 / 463 / 700 |
| Failures | 0 / 544 | | **0 / 684** | |

Idle TLS hold (no WebSocket, no pings):

| Frontier | us-west-2 | Tokyo |
|---|---|---|
| `msg-frontier.feishu.cn` | kept for the full 35 min | closed by the peer after **610 s** |
| `msg-frontier.larksuite.com` | closed after 19 s | closed after 19 s |

## Findings / recommendations

1. **Run the Feishu connector in ap-northeast-1** (already decided). The Feishu API round trip is 2.7× faster than from us-west-2 (162 vs 444 ms p50), and Lark is about 2× faster. There were 0 failures across 1,228 samples from either vantage.
2. Both frontiers sit behind edges close to AWS (Lark connects in 8 ms, Feishu in 46 ms from Tokyo). The handshake cost is small; the cost is the request round trip to the origin.
3. **Idle sockets are dropped:** Lark's edge closes an idle TLS connection after 19 s, and Feishu's after about 10 min from Tokyo. A real long connection survives only through its protocol pings. The connector must keep the SDK's ping (the Lark SDK pings every 120 s by default; do not raise it above ~15 s for Lark if the edge timeout also applies to an upgraded socket). It must reconnect with backoff on any close, and the **60 s backfill** (parent PRD R4) covers messages missed during a reconnect.
4. Still open, and it needs a bot from the coordinator: a 30 min soak of the *real* SDK WebSocket on both domains from Tokyo (event delivery latency, ping and pong behaviour, reconnect count). This doesn't change the contracts: §4.8 is unaffected.

## Cleanup

`dshsa-spike-s3` (Lambda, role, log group) is to be destroyed. The command was handed to the coordinator, whose session has the user's AWS approval:
`cd infra && pnpm exec cdk --app "pnpm exec tsx ../spikes/S3-feishu-ws/app.ts" --output ../spikes/cdk.out destroy dshsa-spike-s3 --force`

# Express benchmark — Node.js vs Deno vs velox

The **same** Express 4 app ([`server.cjs`](server.cjs)) served by all three
runtimes, hammered with [`wrk`](https://github.com/wg/wrk). Express runs
single-threaded, so this measures each runtime's HTTP + JS overhead (and memory
footprint) on an identical, real-world workload.

```sh
npm install            # express into ./node_modules
VELOX=/path/to/velox ./bench.sh
```

## Results

Apple Silicon (10 cores), express 4.22, `wrk -t8 -c200 -d15s`, `GET /json`
(`res.json({ hello, ts })`). Median of two runs.

Ordered by throughput; median of two runs.

| Runtime | Cold start | Req/sec | Latency avg | Latency p99 | Idle RSS | Peak RSS | CPU |
|---------|-----------:|--------:|--------:|--------:|---------:|---------:|----:|
| Bun 1.4 | 146 ms | **106,800** | **1.9 ms** | 3.3 ms | 44 MB | 142 MB | 1.0 |
| **velox 0.1** | **143 ms** | 89,700 | 2.2 ms | **3.2 ms** | **39 MB** | **109 MB** | 1.0 |
| Node 24 | 147 ms | 72,200 | 3.2 ms | 3.7 ms | 62 MB | 145 MB | 1.0 |
| Deno 2.8 | 150 ms | 56,800 | 3.7 ms | ~9 ms | 69 MB | 201 MB | 1.1 |

### Takeaways

- **Throughput:** **Bun** leads (~107k rps). Bun is also built on JavaScriptCore
  but ships a fully-native HTTP server, so it's the one to beat. **velox** is a
  strong second (~90k) — **~25% faster than Node** and ~58% faster than Deno —
  which is notable for a young runtime whose HTTP layer is still mostly JS.
- **Memory:** **velox uses the least of all four** — lowest idle (39 MB vs Bun
  44, Node 62, Deno 69) *and* lowest peak (109 MB vs Bun 142, Node 145, Deno
  201). JSC + velox's lean stdlib win here, even vs Bun.
- **Latency:** Bun best average; velox best/tied p99. Deno trails with a noisy
  tail.
- **Startup:** velox and Bun are fastest (~145 ms); all close except Deno's
  occasional cold spikes.
- **CPU:** all ~1 core — Express is single-threaded, so this measures per-request
  efficiency.

(Before the binary socket bridge below, velox was ~70k rps; the optimization
added ~27%, moving it past Node and Deno.)

### What made velox fast

The original ~70k → ~90k jump came from profiling under load (`sample`) and
removing the top hotspots — the **latin1 string bridge** (every socket byte was
converted byte↔char crossing JS↔Rust) and rope-string/GC churn:

- **Binary socket I/O:** inbound bytes now reach JS as a `Uint8Array` and
  outbound `Buffer`s are written straight from their backing store
  (`JSObjectGetTypedArrayBytesPtr`) — no `String.fromCharCode` per byte.
- **Coalesced response writes:** headers + body go out in a single socket write
  (`res.json`/`res.send`), instead of multiple latin1 string writes.

Numbers vary with hardware/OS/express version — re-run `./bench.sh` locally.
velox must be a **signed release build** (`make release`) for JIT; an unsigned
binary runs the JSC interpreter and is far slower.

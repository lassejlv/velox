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

| Runtime | Cold start | Req/sec | Latency avg | Latency p99 | Idle RSS | Peak RSS | CPU |
|---------|-----------:|--------:|------------:|------------:|---------:|---------:|----:|
| Node 24 | 150 ms | 71,400 | 3.18 ms | 4.53 ms | 61 MB | 148 MB | 1.0 |
| Deno 2.8 | 150 ms | 56,000 | 3.61 ms | 9.71 ms | 67 MB | 199 MB | 1.1 |
| **velox 0.1** | **147 ms** | **90,700** | **2.17 ms** | **3.21 ms** | **39 MB** | **108 MB** | 1.0 |

### Takeaways

velox **wins every metric** on this workload:

- **Throughput:** ~90,700 rps — **~27% faster than Node** and ~60% faster than
  Deno. (Before the binary socket bridge below, velox was ~70k; the optimization
  added ~27%.)
- **Latency:** best average (2.17 ms) *and* best p99 tail (3.21 ms).
- **Memory:** **~40% less idle** than Node/Deno (39 MB vs 61/67), and the lowest
  peak (108 MB vs 148/199). JSC's footprint is leaner than V8's.
- **Startup:** fastest cold start (~147 ms to first response).
- **CPU:** all ~1 core — Express is single-threaded, so this measures per-request
  efficiency.

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

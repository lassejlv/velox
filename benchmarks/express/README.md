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
| Node 24 | 144 ms | **72,800** | 3.14 ms | **3.13 ms** | 62 MB | 146 MB | 1.0 |
| Deno 2.8 | 145 ms | 61,900 | 3.21 ms | 5.19 ms | 68 MB | 200 MB | 1.1 |
| **velox 0.1** | **139 ms** | 70,000 | **2.86 ms** | 4.61 ms | **39 MB** | **123 MB** | 1.0 |

### Takeaways

- **Throughput:** velox (~70k rps) is within ~4% of Node and clearly ahead of
  Deno (~62k) on this Express workload — impressive for a young runtime on
  JavaScriptCore vs. V8.
- **Memory:** velox is the clear winner — **~40% less idle memory** than Node or
  Deno (39 MB vs 62/68), and the **lowest peak** (123 MB vs 146/200). JSC's
  footprint is leaner than V8's.
- **Startup:** velox has the fastest cold start (~139 ms to first response).
- **Latency:** velox has the best *average* latency; Node has the best *p99*
  tail. Deno trails on both.
- **CPU:** all ~1 core — Express is single-threaded, so the runtimes saturate one
  core and the difference is per-request efficiency.

Numbers vary with hardware/OS/express version — re-run `./bench.sh` locally.
velox must be a **signed release build** (`make release`) for JIT; an unsigned
binary runs the JSC interpreter and is far slower.

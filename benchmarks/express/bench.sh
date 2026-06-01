#!/bin/bash
# Benchmark Node.js, Deno, and velox serving the same Express app.
# Measures: cold-start, requests/sec, latency (avg + p99), idle & peak RSS, CPU.
#
# Requirements: node, deno, velox on PATH (or set $VELOX), and `wrk`.
#   npm install            # install express into this dir
#   ./bench.sh
set -e

cd "$(dirname "$0")"
VELOX="${VELOX:-velox}"
PORT="${PORT:-3500}"
DURATION="${DURATION:-15s}"
THREADS="${THREADS:-8}"
CONNS="${CONNS:-200}"
ENDPOINT="http://127.0.0.1:$PORT/json"
RESULTS="$(mktemp)"

[ -d node_modules/express ] || { echo "run 'npm install' first (needs express)"; exit 1; }
command -v wrk >/dev/null || { echo "wrk not found (brew install wrk)"; exit 1; }

# Cumulative CPU seconds for a pid (parses `ps -o cputime`, e.g. 00:03.45).
cputime_secs() {
  ps -o cputime= -p "$1" 2>/dev/null | tr -d ' ' | awk -F: \
    '{n=NF; s=$n; m=(n>=2?$(n-1):0); h=(n>=3?$(n-2):0); printf "%.2f", h*3600+m*60+s}'
}
now() { python3 -c 'import time;print(time.time())'; }

bench_one() {
  local name="$1"; shift
  PORT=$PORT "$@" >/tmp/velox-bench-srv.log 2>&1 &
  local pid=$!

  # cold start = time until the server answers
  local t0=$(now)
  for _ in $(seq 1 150); do curl -s "$ENDPOINT" >/dev/null 2>&1 && break; sleep 0.1; done
  local startup=$(python3 -c "print(f'{($(now)-$t0)*1000:.0f}')")
  sleep 1
  local idle_rss=$(ps -o rss= -p $pid 2>/dev/null | tr -d ' ')

  wrk -t4 -c50 -d3s "$ENDPOINT" >/dev/null 2>&1   # warmup

  # sample peak RSS during the measured load
  ( peak=0; while :; do r=$(ps -o rss= -p $pid 2>/dev/null|tr -d ' ')
      [ -n "$r" ] && [ "$r" -gt "$peak" ] && peak=$r; echo $peak>/tmp/velox-bench-peak; sleep 0.25
    done ) & local sampler=$!

  local cpu0=$(cputime_secs $pid) wt0=$(now)
  local out=$(wrk -t$THREADS -c$CONNS -d$DURATION --latency "$ENDPOINT" 2>&1)
  local wt1=$(now) cpu1=$(cputime_secs $pid)
  kill $sampler 2>/dev/null
  local peak_rss=$(cat /tmp/velox-bench-peak 2>/dev/null)

  local cpu=$(python3 -c "print(f'{($cpu1-$cpu0)/($wt1-$wt0):.2f}')")
  local rps=$(echo "$out" | awk '/Requests\/sec/{print $2}')
  local lavg=$(echo "$out" | awk '/Latency/{print $2; exit}')
  local lp99=$(echo "$out" | grep -A4 "Latency Distribution" | awk '/99%/{print $2}')

  kill $pid 2>/dev/null; wait $pid 2>/dev/null; sleep 0.8
  printf "%s|%s|%s|%s|%s|%.1f|%.1f|%s\n" "$name" "$startup" "$rps" "$lavg" "$lp99" \
    "$(python3 -c "print($idle_rss/1024)")" "$(python3 -c "print($peak_rss/1024)")" "$cpu" >> "$RESULTS"
}

echo "express $(node -e 'console.log(require("express/package.json").version)'), wrk -t$THREADS -c$CONNS -d$DURATION, GET /json"
echo "warming up + measuring (~1.5 min) ..."
bench_one node  node server.cjs
bench_one deno  deno run --allow-net --allow-read --allow-env --allow-sys server.cjs
bench_one velox "$VELOX" server.cjs

echo ""
printf "%-8s %9s %12s %9s %9s %9s %9s %6s\n" Runtime Start.ms Req/sec Lat.avg Lat.p99 Idle.MB Peak.MB CPU
printf '%.0s-' {1..80}; echo
while IFS='|' read -r n s r la lp i p c; do
  printf "%-8s %9s %12s %9s %9s %9s %9s %6s\n" "$n" "$s" "$r" "$la" "$lp" "$i" "$p" "$c"
done < "$RESULTS"
rm -f "$RESULTS"

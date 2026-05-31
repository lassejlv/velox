#!/bin/sh
# Run the whole velox test suite: cargo unit tests + every Node-compat suite +
# the WHATWG URL battery + the example smoke tests. Each compat suite exits
# non-zero on any failed check, so this gates CI. Exits non-zero if anything fails.
set -e
cd "$(dirname "$0")/.."

fail=0
run() {
  printf '  %-26s ' "$1"
  if out=$(cargo run -q -- "$2" 2>&1); then
    echo "$out" | tail -1
  else
    echo "FAILED"; echo "$out" | tail -5; fail=1
  fi
}

echo "== cargo unit tests =="
cargo test --quiet || fail=1

echo "== Node-compat suites =="
for s in core io modern extra web platform stdlib; do
  run "node-compat-$s" "examples/node-compat-$s.ts"
done
run "url-conformance" "examples/url-conformance.ts"

echo "== example smoke tests =="
for ex in hello async timers crypto-stream velox-global commonjs-demo \
          node-modules-demo worker-threads shared-memory websocket rsa-keygen fs-demo; do
  printf '  %-26s ' "$ex"
  if cargo run -q -- "examples/$ex.ts" >/dev/null 2>&1; then echo "ok"; else echo "FAILED"; fail=1; fi
done

if [ "$fail" -ne 0 ]; then echo "\nSOME TESTS FAILED"; exit 1; fi
echo "\nALL TESTS PASSED"

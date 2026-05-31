#!/bin/sh
# Run Node.js's OWN test suite against velox.
#
# Node's `test/parallel/*.js` are fetched on demand (we don't vendor them) next
# to a minimal `common` harness (tests/node/common), then run with the release
# binary. A test "passes" if it exits 0 (its asserts held). Many Node tests can't
# run here — they `require` Node internals (`internal/*`, `node:test`) or exercise
# Windows-only `path.win32` — so failures include genuinely-unrunnable tests; the
# summary separates those out.
#
# Usage:
#   scripts/node-test.sh                 # curated fast set (CI gating)
#   scripts/node-test.sh --all           # every test in test/parallel (~4100)
#   scripts/node-test.sh --sample N      # every Nth test (spread across subsystems)
#   scripts/node-test.sh --match PATTERN # tests whose name contains PATTERN (e.g. buffer)
#   scripts/node-test.sh test-path-join test-querystring   # specific tests
#
# Env: NODE_VERSION (default main), TIMEOUT secs (default 8), JOBS (default 16).
set -e
cd "$(dirname "$0")/.."

NODE_VERSION="${NODE_VERSION:-main}"
TIMEOUT="${TIMEOUT:-8}"
JOBS="${JOBS:-16}"
BASE="https://raw.githubusercontent.com/nodejs/node/${NODE_VERSION}/test/parallel"
API="https://api.github.com/repos/nodejs/node/contents/test/parallel?ref=${NODE_VERSION}"
DIR="tests/node/parallel"
mkdir -p "$DIR"

CURATED="test-event-emitter-add-listeners test-event-emitter-error-monitor \
test-event-emitter-listener-count test-event-emitter-once test-event-emitter-prepend \
test-stringbytes-external test-timers-immediate test-timers-unref"

# --- decide which tests to run --------------------------------------------
gating=0
case "$1" in
  --all)
    echo "Listing all test/parallel files ($NODE_VERSION)..."
    LIST=$(curl -fsSL "https://api.github.com/repos/nodejs/node/git/trees/${NODE_VERSION}?recursive=1" \
      | grep -oE 'test/parallel/test-[A-Za-z0-9_-]+\.js' | sed 's|test/parallel/||;s|\.js$||' | sort -u) ;;
  --sample)
    N="${2:-8}"
    echo "Listing test/parallel files, taking every ${N}th..."
    LIST=$(curl -fsSL "https://api.github.com/repos/nodejs/node/git/trees/${NODE_VERSION}?recursive=1" \
      | grep -oE 'test/parallel/test-[A-Za-z0-9_-]+\.js' | sed 's|test/parallel/||;s|\.js$||' | sort -u \
      | awk "NR % $N == 1") ;;
  --match)
    echo "Listing test/parallel files matching '$2'..."
    LIST=$(curl -fsSL "https://api.github.com/repos/nodejs/node/git/trees/${NODE_VERSION}?recursive=1" \
      | grep -oE 'test/parallel/test-[A-Za-z0-9_-]+\.js' | sed 's|test/parallel/||;s|\.js$||' | sort -u \
      | grep -- "$2") ;;
  "" )
    LIST="$CURATED"; gating=1 ;;
  * )
    LIST="$*" ;;
esac

count=$(printf '%s\n' $LIST | grep -c . || true)
echo "Building velox (signed, JIT)..."
make release >/dev/null
VELOX="$PWD/target/release/velox"

# --- fetch any missing test files in parallel -----------------------------
echo "Fetching $count test file(s)..."
FETCH=$(mktemp)
cat > "$FETCH" <<EOF
[ -f "$DIR/\$1.js" ] || curl -sf "$BASE/\$1.js" -o "$DIR/\$1.js" 2>/dev/null || true
EOF
printf '%s\n' $LIST | xargs -P "$JOBS" -n1 sh "$FETCH"
rm -f "$FETCH"

# --- run ------------------------------------------------------------------
# Never abort mid-suite on a failing test — run everything, record results.
set +e
PASS_LIST="tests/node/last-pass.txt"
FAIL_LIST="tests/node/last-fail.txt"
LOG="${LOG:-tests/node/failures.log}"
pass=0; fail=0; unrunnable=0; real_fail=0
: > "$PASS_LIST"; : > "$FAIL_LIST"
{
  echo "# velox vs Node.js test/parallel — failure log"
  echo "# $(date) | node=$NODE_VERSION | velox=$($VELOX --version 2>/dev/null)"
  echo ""
} > "$LOG"

for t in $LIST; do
  f="$DIR/$t.js"
  [ -f "$f" ] || { echo "  (missing $t)"; continue; }
  out=$(cd "$DIR" && timeout "$TIMEOUT" "$VELOX" "$t.js" 2>&1); rc=$?
  if [ "$rc" -eq 0 ]; then
    pass=$((pass + 1)); echo "$t" >> "$PASS_LIST"
    [ "$gating" -eq 1 ] && printf '  \033[32mPASS\033[0m %s\n' "$t"
  else
    fail=$((fail + 1)); echo "$t" >> "$FAIL_LIST"
    # Categorize: unrunnable (Node internals) vs a real failure.
    if printf '%s' "$out" | grep -q "Cannot find module 'internal\|Cannot find module 'node:test\|Cannot find module 'node:sea\|Cannot find module 'node:wasi"; then
      unrunnable=$((unrunnable + 1)); kind="unrunnable"
    elif [ "$rc" -eq 124 ]; then
      real_fail=$((real_fail + 1)); kind="timeout"
    else
      real_fail=$((real_fail + 1)); kind="real"
    fi
    # Append full failure detail to the log for debugging.
    {
      echo "================================================================"
      echo "FAIL [$kind] $t  (exit $rc)"
      echo "----------------------------------------------------------------"
      printf '%s\n' "$out" | sed 's/\x1b\[[0-9;]*m//g' | head -30
      echo ""
    } >> "$LOG"
    [ "$gating" -eq 1 ] && printf '  \033[31mFAIL\033[0m %s\n' "$t"
  fi
done

total=$((pass + fail))
runnable=$((pass + real_fail))
echo ""
echo "Node.js test/parallel — velox results:"
echo "  passed:                 $pass / $total"
echo "  failed:                 $fail   ($unrunnable need Node internals / unsupported, $real_fail real)"
if [ "$runnable" -gt 0 ]; then
  echo "  pass rate of runnable:  $(python3 -c "print(f'{$pass*100/$runnable:.1f}%')" 2>/dev/null || echo "$pass/$runnable")"
fi
echo "  pass list: $PASS_LIST"
echo "  fail list: $FAIL_LIST"
echo "  failure log (with output): $LOG"

# Gating mode (CI) fails the build if any curated test fails.
if [ "$gating" -eq 1 ] && [ "$fail" -ne 0 ]; then exit 1; fi
exit 0

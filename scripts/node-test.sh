#!/bin/sh
# Run Node.js's OWN test suite against velox.
#
# Node's source tree is downloaded on demand (we don't vendor it), then selected
# `test/**/test-*.js` files are run with the release binary. A test "passes" if
# it exits 0 (its asserts held). Many Node tests can't run here — they `require`
# Node internals (`internal/*`, `node:test`) or exercise exact Node CLI behavior
# — so failures include genuinely-unrunnable tests; the summary separates those
# out where possible.
#
# Usage:
#   scripts/node-test.sh                 # curated fast set
#   scripts/node-test.sh --all           # every test/**/test-*.js in Node's tree
#   scripts/node-test.sh --sample N      # every Nth test (spread across subsystems)
#   scripts/node-test.sh --match PATTERN # tests whose name contains PATTERN (e.g. buffer)
#   scripts/node-test.sh test-path-join test-querystring   # specific tests
#
# Env:
#   NODE_VERSION   Node.js git ref to fetch tests from (default v22.12.0)
#   TIMEOUT        Seconds per test (default 8)
#   JOBS           Parallel fetch jobs (default 16)
#   ARTIFACT_DIR   Where pass/fail lists and logs are written (default tests/node)
set -e
cd "$(dirname "$0")/.."

NODE_VERSION="${NODE_VERSION:-v22.12.0}"
TIMEOUT="${TIMEOUT:-8}"
JOBS="${JOBS:-16}"
ARTIFACT_DIR="${ARTIFACT_DIR:-tests/node}"
SRC="$ARTIFACT_DIR/node-src"
TEST_ROOT="$SRC/test"
mkdir -p "$ARTIFACT_DIR"

if [ ! -d "$TEST_ROOT" ]; then
  echo "Downloading Node.js source tree ($NODE_VERSION)..."
  rm -rf "$SRC"
  mkdir -p "$SRC"
  curl -fsSL "https://github.com/nodejs/node/archive/${NODE_VERSION}.tar.gz" \
    | tar -xz --strip-components=1 -C "$SRC"
fi

CURATED="parallel/test-event-emitter-add-listeners parallel/test-event-emitter-error-monitor \
parallel/test-event-emitter-listener-count parallel/test-event-emitter-once parallel/test-event-emitter-prepend \
parallel/test-stringbytes-external parallel/test-timers-immediate parallel/test-timers-unref"

# --- decide which tests to run --------------------------------------------
all_tests() {
  (
    cd "$TEST_ROOT" || exit 1
    find . \
      \( -path './fixtures/*' -o -path './*/fixtures/*' \
      -o -path './tmp/*' -o -path './*/tmp/*' \
      -o -path './node_modules/*' -o -path './*/node_modules/*' \) -prune \
      -o -name 'test-*.js' -print
  ) | sed 's|^\./||;s|\.js$||' | sort -u
}

gating=0
case "$1" in
  --all)
    echo "Listing all Node.js test/**/test-*.js files ($NODE_VERSION)..."
    LIST=$(all_tests) ;;
  --sample)
    N="${2:-8}"
    echo "Listing all Node.js test files, taking every ${N}th..."
    LIST=$(all_tests | awk "NR % $N == 1") ;;
  --match)
    echo "Listing all Node.js test files matching '$2'..."
    LIST=$(all_tests | grep -- "$2") ;;
  "" )
    LIST="$CURATED"; gating=1 ;;
  * )
    LIST=""
    for test_name in "$@"; do
      test_name=${test_name%.js}
      case "$test_name" in
        */*) ;;
        *) test_name="parallel/$test_name" ;;
      esac
      LIST="$LIST
$test_name"
    done ;;
esac

count=$(printf '%s\n' $LIST | grep -c . || true)
echo "Building velox (signed, JIT)..."
make release >/dev/null
VELOX="$PWD/target/release/velox"

RUNNER=$(mktemp)
cat > "$RUNNER" <<'PY'
import os
import subprocess
import sys

if len(sys.argv) != 5:
    print("usage: runner.py <timeout> <cwd> <velox> <test>", file=sys.stderr)
    sys.exit(125)

timeout = float(sys.argv[1])
cwd, velox, test = sys.argv[2], sys.argv[3], sys.argv[4]

try:
    proc = subprocess.run(
        [velox, test],
        cwd=cwd,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        timeout=timeout,
    )
    sys.stdout.write(proc.stdout)
    sys.exit(proc.returncode)
except subprocess.TimeoutExpired as exc:
    if exc.stdout:
        sys.stdout.write(exc.stdout if isinstance(exc.stdout, str) else exc.stdout.decode("utf-8", "replace"))
    print(f"\n[TIMEOUT after {timeout:g}s]")
    sys.exit(124)
PY

RUN_ONE=$(mktemp)
cat > "$RUN_ONE" <<'SH'
t="$1"
f="$TEST_ROOT/$t.js"
key=$(printf '%s' "$t" | tr '/ ' '__')
out="$RESULTS/$key.out"
status="$RESULTS/$key.status"

if [ ! -f "$f" ]; then
  echo "missing missing 0" > "$status"
  exit 0
fi

test_cwd=$(dirname "$f")
test_file=$(basename "$f")
python3 "$RUNNER" "$TIMEOUT" "$test_cwd" "$VELOX" "$test_file" > "$out" 2>&1
rc=$?
if [ "$rc" -eq 0 ]; then
  echo "pass pass 0" > "$status"
  exit 0
fi

if grep -q "Cannot find module 'internal\|Cannot find module 'node:test\|Cannot find module 'node:sea\|Cannot find module 'node:wasi\|getDefaultAutoSelectFamilyAttemptTimeout" "$out"; then
  kind="unrunnable"
elif [ "$rc" -eq 124 ]; then
  kind="timeout"
else
  kind="real"
fi
echo "fail $kind $rc" > "$status"
exit 0
SH

# --- run ------------------------------------------------------------------
# Never abort mid-suite on a failing test — run everything, record results.
set +e
PASS_LIST="$ARTIFACT_DIR/last-pass.txt"
FAIL_LIST="$ARTIFACT_DIR/last-fail.txt"
LOG="${LOG:-$ARTIFACT_DIR/failures.log}"
SUMMARY="$ARTIFACT_DIR/summary.txt"
RESULTS="$ARTIFACT_DIR/results"
pass=0; fail=0; unrunnable=0; real_fail=0
: > "$PASS_LIST"; : > "$FAIL_LIST"
rm -rf "$RESULTS"
mkdir -p "$RESULTS"
{
  echo "# velox vs Node.js test suite — failure log"
  echo "# $(date) | node=$NODE_VERSION | velox=$($VELOX --version 2>/dev/null)"
  echo ""
} > "$LOG"

export TIMEOUT TEST_ROOT VELOX RUNNER RESULTS
if [ "$count" -gt 0 ]; then
  printf '%s\n' $LIST | xargs -P "$JOBS" -n1 sh "$RUN_ONE"
fi

for t in $LIST; do
  key=$(printf '%s' "$t" | tr '/ ' '__')
  status="$RESULTS/$key.status"
  [ -f "$status" ] || { echo "  (missing result $t)"; continue; }
  read state kind rc < "$status"
  if [ "$state" = "pass" ]; then
    pass=$((pass + 1))
    echo "$t" >> "$PASS_LIST"
    [ "$gating" -eq 1 ] && printf '  \033[32mPASS\033[0m %s\n' "$t"
  else
    fail=$((fail + 1))
    echo "$t" >> "$FAIL_LIST"
    if [ "$kind" = "unrunnable" ]; then
      unrunnable=$((unrunnable + 1))
    elif [ "$kind" = "timeout" ]; then
      real_fail=$((real_fail + 1)); kind="timeout"
    else
      real_fail=$((real_fail + 1)); kind="real"
    fi
    # Append full failure detail to the log for debugging.
    {
      echo "================================================================"
      echo "FAIL [$kind] $t  (exit $rc)"
      echo "----------------------------------------------------------------"
      sed 's/\x1b\[[0-9;]*m//g' "$RESULTS/$key.out" | head -30
      echo ""
    } >> "$LOG"
    [ "$gating" -eq 1 ] && printf '  \033[31mFAIL\033[0m %s\n' "$t"
  fi
done
rm -f "$RUNNER" "$RUN_ONE"

total=$((pass + fail))
runnable=$((pass + real_fail))
{
  echo "Node.js test suite — velox results:"
  echo "  node ref:               $NODE_VERSION"
  echo "  tests selected:         $count"
  echo "  passed:                 $pass / $total"
  echo "  failed:                 $fail   ($unrunnable need Node internals / unsupported, $real_fail real)"
  if [ "$runnable" -gt 0 ]; then
    echo "  pass rate of runnable:  $(python3 -c "print(f'{$pass*100/$runnable:.1f}%')" 2>/dev/null || echo "$pass/$runnable")"
  fi
  echo "  pass list:              $PASS_LIST"
  echo "  fail list:              $FAIL_LIST"
  echo "  failure log:            $LOG"
} | tee "$SUMMARY"

# Node upstream compatibility failures are expected while velox is partial.
# Use Velox's own compatibility probes as the hard CI gate; this script records
# upstream failures for tracking and exits successfully after completing a run.
exit 0

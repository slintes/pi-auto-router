#!/usr/bin/env bash
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
node --input-type=module - "$root" "$tmp/config.json" <<'JS'
import { readFileSync, writeFileSync } from 'node:fs';
const [root, path] = process.argv.slice(2);
const config = JSON.parse(readFileSync(`${root}/config.example.json`, 'utf8'));
for (const [id, settings] of Object.entries(config.models)) {
  settings.classifier = { provider: 'router-smoke', model: 'classifier', thinkingLevel: 'off' };
  for (const [category, target] of Object.entries(settings.routes)) {
    target.provider = 'router-smoke';
    target.model = id === 'fast' ? 'simple' : category;
    if (id === 'fast') target.thinkingLevel = 'off';
  }
}
writeFileSync(path, JSON.stringify(config));
writeFileSync(`${path}.legacy`, JSON.stringify(config.models.auto));
JS
for pair in simple:low medium:medium complex:high reasoning:xhigh; do
  category="${pair%%:*}"
  result="$(cd "$tmp" && PI_CODING_AGENT_DIR="$tmp/agent" pi --offline \
    --no-extensions --no-mcp --no-skills --no-prompt-templates --no-context-files \
    --no-session --no-tools -e "$root/test/fixtures/mock-provider.js" -e "$root" \
    --auto-router-config "$tmp/config.json" --model autorouter/auto -p "$category")"
  expected="router-smoke/$pair"
  if [[ "$result" != "$expected" ]]; then
    printf 'FAIL: expected %s, got %s\n' "$expected" "$result" >&2
    exit 1
  fi
  printf 'PASS: %s\n' "$result"
done
result="$(cd "$tmp" && PI_AUTO_ROUTER_CONFIG="$tmp/missing.json" PI_CODING_AGENT_DIR="$tmp/agent" pi --offline \
  --no-extensions --no-mcp --no-skills --no-prompt-templates --no-context-files \
  --no-session --no-tools -e "$root/test/fixtures/mock-provider.js" -e "$root" \
  --auto-router-config="$tmp/config.json" --model autorouter/fast -p reasoning)"
if [[ "$result" != "router-smoke/simple:off" ]]; then
  printf 'FAIL: fast router expected router-smoke/simple:off, got %s\n' "$result" >&2
  exit 1
fi
printf 'PASS: autorouter/fast -> %s (CLI overrides env)\n' "$result"
result="$(cd "$tmp" && PI_AUTO_ROUTER_CONFIG="$tmp/config.json.legacy" PI_CODING_AGENT_DIR="$tmp/agent" pi --offline \
  --no-extensions --no-mcp --no-skills --no-prompt-templates --no-context-files \
  --no-session --no-tools -e "$root/test/fixtures/mock-provider.js" -e "$root" \
  --model autorouter/auto -p medium)"
if [[ "$result" != "router-smoke/medium:medium" ]]; then
  printf 'FAIL: legacy config expected router-smoke/medium:medium, got %s\n' "$result" >&2
  exit 1
fi
printf 'PASS: legacy config via env -> %s\n' "$result"

run_sticky() {
  (cd "$tmp" && ROUTER_SMOKE_CALL_LOG="$tmp/calls.log" PI_CODING_AGENT_DIR="$tmp/agent" pi --offline \
    --no-extensions --no-mcp --no-skills --no-prompt-templates --no-context-files \
    --no-tools -e "$root/test/fixtures/mock-provider.js" -e "$root" \
    --auto-router-config "$tmp/config.json" --model autorouter/auto \
    --session "$tmp/sticky.jsonl" -p "$1")
}
check_sticky() {
  local prompt="$1" expected="$2" expected_calls="$3" output calls
  : > "$tmp/calls.log"
  output="$(run_sticky "$prompt")"
  calls="$(paste -sd, "$tmp/calls.log")"
  if [[ "$calls" != "$expected_calls" || ( -n "$expected" && "$output" != "$expected" ) ]]; then
    printf 'FAIL: %s expected %s [%s], got %s [%s]\n' "$prompt" "$expected" "$expected_calls" "$output" "$calls" >&2
    exit 1
  fi
  # Pi print mode replays the previous answer after handled input; the call log proves no model ran.
  printf 'PASS: %s -> %s (saved session; calls: %s)\n' "$prompt" "${expected:-no model call}" "${calls:-none}"
}
check_sticky ':complex Do a task' 'router-smoke/complex:high' 'complex'
check_sticky 'reasoning' 'router-smoke/complex:high' 'complex'
check_sticky ':simple' '' ''
check_sticky 'complex' 'router-smoke/simple:low' 'simple'
check_sticky ':auto reasoning' 'router-smoke/reasoning:xhigh' 'classifier,reasoning'
check_sticky 'simple' 'router-smoke/simple:low' 'classifier,simple'
check_sticky ':complex' '' ''
check_sticky ':auto' '' ''
check_sticky 'reasoning' 'router-smoke/reasoning:xhigh' 'classifier,reasoning'
: > "$tmp/calls.log"
if run_sticky ':typo Do a task' > "$tmp/invalid.out" 2> "$tmp/invalid.err"; then
  printf 'FAIL: unknown tier should fail in print mode\n' >&2
  exit 1
fi
if ! grep -q 'unknown tier' "$tmp/invalid.err" || [[ -s "$tmp/calls.log" ]]; then
  printf 'FAIL: unknown tier should report an error without calling models\n' >&2
  exit 1
fi
printf 'PASS: unknown tier fails explicitly in print mode (no model calls)\n'

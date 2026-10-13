#!/usr/bin/env bash
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
node --input-type=module - "$root" "$tmp/config.json" <<'JS'
import { readFileSync, writeFileSync } from 'node:fs';
const [root, path] = process.argv.slice(2);
const config = JSON.parse(readFileSync(`${root}/config.example.json`, 'utf8'));
config.classifier = { provider: 'router-smoke', model: 'classifier', thinkingLevel: 'off' };
for (const category of Object.keys(config.routes)) {
  config.routes[category].provider = 'router-smoke';
  config.routes[category].model = category;
}
writeFileSync(path, JSON.stringify(config));
JS
for pair in simple:low medium:medium complex:high reasoning:xhigh; do
  category="${pair%%:*}"
  result="$(cd "$tmp" && PI_CODING_AGENT_DIR="$tmp/agent" pi --offline \
    --no-extensions --no-mcp --no-skills --no-prompt-templates --no-context-files \
    --no-session --no-tools -e "$root/test/fixtures/mock-provider.js" -e "$root" \
    --auto-router-config "$tmp/config.json" --model auto-router/auto -p "$category")"
  expected="router-smoke/$pair"
  if [[ "$result" != "$expected" ]]; then
    printf 'FAIL: expected %s, got %s\n' "$expected" "$result" >&2
    exit 1
  fi
  printf 'PASS: %s\n' "$result"
done

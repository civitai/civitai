#!/usr/bin/env bash
# Rebuild docs/prompt-analysis-samples/candidates from scratch.
#
# Two sources, in this order:
#   1. the live registry export, run through rewrite.mjs (mechanical fixes)
#   2. docs/prompt-analysis-samples/authored/*.txt, also run through rewrite.mjs
#
# Authored files are written LAST so they always win. Regenerating from the live export alone
# silently reverts hand work — it once replaced the researched sdxl guide (Pony/Illustrious
# branching) with a mechanically-tidied copy of the guide that branching was meant to replace.
set -euo pipefail
cd "$(dirname "$0")/../../.."
SKILL=.claude/skills/add-prompt-enhancement-guide
EXPORT="${1:-.prompt-analysis-backups/prompt-analysis-2026-08-06.json}"
OUT=docs/prompt-analysis-samples/candidates
AUTHORED=docs/prompt-analysis-samples/authored

rm -rf "$OUT"
node "$SKILL/rewrite.mjs" --file "$EXPORT" --out "$OUT"

node -e '
const fs=require("fs");
const dir=process.argv[1];
const out=fs.readdirSync(dir).filter(f=>f.endsWith(".txt")).map(f=>({
  ecosystem:f.replace(/\.txt$/,""), systemPrompt:fs.readFileSync(dir+"/"+f,"utf8"), samples:[],
}));
fs.writeFileSync(".authored.json",JSON.stringify({ecosystems:out},null,2));
' "$AUTHORED"

node "$SKILL/rewrite.mjs" --file .authored.json --out "$OUT"
# rewrite.mjs now writes every guide it processes, so the authored pass fully overwrites.
rm -f .authored.json
echo "candidates: $(ls "$OUT"/*.txt | wc -l)  (authored overrides: $(ls "$AUTHORED"/*.txt | wc -l))"

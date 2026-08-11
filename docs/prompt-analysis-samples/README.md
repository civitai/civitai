# Prompt-analysis guides and samples

Candidate guide text and few-shot `samples`, kept in the repo so they are reviewable and
diffable rather than living in a scratch directory. See
[the audit](../prompt-analysis-audit-2026-08-05.md) for the measurements behind them.

These are **not** the source of truth — the orchestrator is. A file here is either not yet
deployed or a record of what was. Read the live state with
`node .claude/skills/add-prompt-enhancement-guide/manage.mjs status`.

## Layout

| Directory     | What it is                                                                     |
| ------------- | ------------------------------------------------------------------------------ |
| `authored/`   | **Hand-written guides. Edit these.** Source-controlled input, never generated. |
| `candidates/` | **Generated. Safe to delete.** Rebuilt by `build-candidates.sh`.               |

`candidates/` is assembled from two sources in order: the live registry export through
`rewrite.mjs`, then every file in `authored/` through the same transform, written last so it
always wins.

```bash
bash .claude/skills/add-prompt-enhancement-guide/build-candidates.sh
```

**Never run `rewrite.mjs` against the live export on its own** — it silently reverts hand work.
It did exactly that here: it replaced the researched `sdxl` guide (the one branching on
Pony / Illustrious / NoobAI conventions) with a mechanically-tidied copy of the guide that
branching was written to replace. Deploying the result would have told Pony users to use
`masterpiece, best quality`, which is the specific bug the research existed to fix.

43 candidates, one per reachable ecosystem. Corpus-wide, versus live: absence-checks in
`Guidelines:` 26 → 3, hardcoded duration 16 → 0, unguarded params 16 → 0, variant-conditioning
2 → 0, ecosystems with no custom guide 7 → 0.

The 3 remaining absence-checks were reviewed and kept: `flux1kontext`'s fires only on edits
(visible via `images`) and `sdxl`'s only on Pony markers (visible tokens), so both are
prompt-conditional and correct where they are. `GUIDELINE-COUNT` and `BARE-PROHIBITION` are
left alone deliberately — both are untested prose interventions, the same shape of change that
measured as noise twice.

## Deploying — order matters

```bash
# 1. Guide FIRST. `put` carries samples forward by re-reading the config, and that read
# loses to propagation lag if a set-samples just ran. This order avoids the race.
node .claude/skills/add-prompt-enhancement-guide/manage.mjs \
  put <key> --prompt-file docs/prompt-analysis-samples/candidates/<key>.txt \
  --model 'urn:air:qwen3:repository:huggingface:Civitai/Qwen3.6-35B-A3B-Abliterated-AWQ@main.tar' \
  --writable

# 2. Samples SECOND, or they are lost.
node .claude/skills/add-prompt-enhancement-guide/manage.mjs \
  set-samples <key> --file docs/prompt-analysis-samples/samples/<key>.json --writable

# 3. Wait, then verify against the files — do NOT trust the immediate readback.
sleep 30
node .claude/skills/add-prompt-enhancement-guide/manage.mjs status | grep <key>
```

Writes take up to a minute to propagate, so the built-in readback verification reports both
false failures and false successes. Observed in one deploy: a `GET` straight after a "verified"
`put` returned the old guide, and a `set-samples` printed `✗ readback does not match` for a
write that had in fact landed. `status` after a pause is the truth.

## Re-measuring

```bash
node .claude/skills/add-prompt-enhancement-guide/measure.mjs \
  --ecosystem <key> --modality image|video \
  --candidate docs/prompt-analysis-samples/candidates/<key>.txt \
  --samples docs/prompt-analysis-samples/samples/<key>.json --runs 2
```

The number that matters is **saturated topics** — any topic recommended on ≥80% of prompts is
firing regardless of input, and against a 3-recommendation cap each one is a slot spent before
the prompt is read. Redundancy is a secondary figure and a weak proxy; it stayed flat across
changes that moved saturation by 30 points.

## `minimaxh3` — DEPLOYED 2026-08-06

Live: guide **3956 chars** + 2 samples, byte-verified against the files here.

| File                                             | Contents                                                                                                                                     |
| ------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------- |
| [authored/minimaxh3.txt](authored/minimaxh3.txt) | Camera and audio moved out of `Guidelines:` into rules (F1); self-contradicting `"no music"` example removed (F4); ordered-beats rule added. |
| [minimaxh3.json](minimaxh3.json)                 | Two samples using ordinal beats, checked against MiniMax's published prompts.                                                                |

Measured saturated topics 2 → 0 on one run and 2 → **1** on the confirmation, so **"reduces
saturation" is supported; "eliminates it" is not.** Deployed on the weaker claim. Revert with
the 2026-08-05 backup, whose stored guide byte-matched what was live before the change.

**Corrected 2026-08-06, after deploy.** The first deployed version taught timed beats with
absolute ranges (`0-4s … 4-9s … 9-12s`) and both samples wrote 12-second timelines. H3 clips run
5–15s and **the clip length is not in the analysis request**, so every enhanced prompt silently
assumed the long end and would overshoot a 5-second generation by more than double. MiniMax's own
examples use absolute times legitimately — a human writing their own prompt knows their duration;
the analyzer does not. Now uses ordinal beats ("first… then… finally…"), correct at any length.
Redeployed unmeasured, because the endpoint was down and leaving a known-wrong guide live was
worse; the change only removes an assumption, it does not add a behaviour.

## `sdxl` — pending sign-off, serves four checkpoint families

`Illustrious`, `NoobAI`, and `Pony` all carry `parentEcosystemId: ECO.SDXL`, and
`getRootEcosystem` resolves to the parent before `getAirEcosystem` lowercases it. **They reach
prompt analysis as `sdxl`; a guide filed under `illustrious` would be dead.** So this one guide
serves four incompatible quality vocabularies, and the live version describes only base SDXL —
telling the analyzer to prepend `masterpiece, best quality` even for Pony, which uses `score_`
tags instead.

The candidate branches on what the model can actually see in the prompt (`score_9` /
`source_anime` → Pony; `1girl` / `absurdres` → Illustrious/NoobAI), the same legitimate branch
`anima` uses for tag-mode vs NL-mode.

| File                                   | Contents                                                                                                                                      |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| [authored/sdxl.txt](authored/sdxl.txt) | Convention-branching guide; `Flag missing quality modifiers, lighting…` demoted from `Guidelines:` to a rewrite property.                     |
| [sdxl.json](sdxl.json)                 | Two samples: a mixed-vocabulary prompt (`score_9` + `masterpiece`) resolved toward Pony, and underscored danbooru tags rewritten with spaces. |

> **The measured numbers below are for a superseded version of these files.** Checking the
> samples against real usage showed the guide taught something unsupported (see next section),
> so both were rewritten and must be re-measured before deploy. The endpoint was returning
> `500 Chat completion failed` at the time, so this is pending, not skipped.

### Corrected after checking real usage

The first candidate said the four families' quality vocabularies are incompatible and told the
analyzer to strip the mismatched one — the clause "inert at best and pulls the image off-model
at worst" was **inference, never sourced**. Civitai's own corpus contradicts it:

```text
Real prompts using score_ tags (7 days):          46,171
  ...also containing masterpiece / best quality:  31,207  (68%)
  ...also containing absurdres / highres:         17,679  (38%)
```

Two thirds of real Pony prompts mix the vocabularies. Prevalence is not proof of correctness,
but it is far stronger evidence than an unsourced inference, and shipping the original would
have told most Pony users on the platform that their prompt was wrong.

The guide now gives **additive** advice only — a Pony-family prompt missing its score prefix
should gain one; Illustrious/NoobAI prompts should not gain score tags — and no longer tells
anyone to remove quality tags they wrote. Sample 1 was rewritten from "drop masterpiece" to
"add the missing score prefix", which is the same lesson without the unsupported half.

### Superseded measurements

Two independent runs, baseline re-scored in each:

| Run | lighting      | saturated |
| --- | ------------- | --------- |
| 1   | 88% → **70%** | 1 → **0** |
| 2   | 93% → **66%** | 1 → **0** |

Stronger than the `minimaxh3` result, which cleared saturation on one run and not the other.

**The first attempt at these samples failed instructively** — both opened with "add lighting and
composition tags", the topic they existed to suppress, and lighting moved 89% → 88%. A sample
teaches every recommendation it contains. Check a candidate sample's recommendations against the
saturated topics before shipping it.

Caveat on the `sdxl` lighting figure: `measure.mjs`'s lighting regex matches image _tags_
containing "light" (`lantern light`), not only lighting advice, so part of the 88% baseline is
miscounted. The 18-point drop is larger than that error, but the absolute numbers are soft.

Sources: [NoobAI-XL](https://huggingface.co/Laxhar/noobai-XL-1.0),
[Illustrious-XL-v1.0](https://huggingface.co/OnomaAIResearch/Illustrious-XL-v1.0),
[Pony V6 tags](https://stable-diffusion-art.com/pony-diffusion-prompt-tags/).

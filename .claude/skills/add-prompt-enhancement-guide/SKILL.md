---
name: add-prompt-enhancement-guide
description: Author a prompt-enhancement system prompt for a new ecosystem and register/update it on the orchestrator's prompt-analysis service. Use when onboarding a new ecosystem (e.g. happyhorse, a new Flux variant, a new Wan video version) and the user provides the ecosystem key plus a reference link, model card, or description. Produces a guide that mirrors the structure and tone of existing ecosystem guides so the prompt-analysis tool behaves consistently.
---

# Add Prompt Enhancement Guide

The orchestrator runs a prompt-analysis service that, per ecosystem, takes a user's prompt and produces structured feedback + an enhanced rewrite. Each ecosystem has its own system prompt tuned to the model's prompting conventions (tag vs natural-language, weight syntax, negative-prompt support, text rendering, camera/motion vocab for video, etc.).

This skill authors a new system prompt for an ecosystem the user names and (optionally) deploys it to the orchestrator.

## Scope: image and video ecosystems only

**Do not write guides for 3D, audio, or any other modality** — `tripo`, `hunyuan3d`, `polygen` (image-to-3D) and `ace` (audio) are explicitly out of scope, as is anything else non-image/video that appears later. If the user names one, say it is out of scope and stop.

The guide template below is built entirely around subject / lighting / camera / composition / style. None of that describes "generate a mesh from this image" or "generate a song," so a guide written from this template for those modalities would be confidently wrong rather than merely thin. Leaving them on the built-in fallback is the deliberate choice.

## Inputs the user must provide

1. **Ecosystem key** — the ecosystem's `key` from `packages/civitai-shared/src/basemodel.constants.ts`, lowercased. `MiniMaxH3` → `minimaxh3`, `Flux1Kontext` → `flux1kontext`, `WanVideo-25-I2V` → `wanvideo-25-i2v`, `HyV1` → `hyv1`. Confirm the key exists in that file before using it. (`src/shared/constants/basemodel.constants.ts` is a one-line re-export shim of the same module, not a stale duplicate — importing from either path is fine.)

   **It is the AIR ecosystem value, lowercased** — the same string that appears in `urn:air:<ecosystem>:...`. `getAirEcosystem` in [air.ts](../../../src/shared/utils/air.ts) is the single source for both: `stringifyAIR` uses it, and so does `createPromptEnhancementStep`. If you know a model's AIR, you know its prompt-analysis key.

   The consequence to watch: `getRootEcosystem` follows `parentEcosystemId`, so a child ecosystem never appears in an AIR and never reaches prompt analysis. Pony, Illustrious, and NoobAI all arrive as `sdxl`. Check `parentEcosystemId` before writing a guide — if the target has a parent, the guide belongs on the parent and has to serve every sibling.

   **Not the engine name.** `engine: 'minimax-h3'` in the handler is a different identifier that happens to coincide with the ecosystem key for `kling`, `seedance`, and `veo3`. Guides filed under an engine name are dead — nothing reads them.

   Handlers that build their own enhancement step (e.g. `ltx.handler.ts`) pass their graph ecosystem raw; `createPromptEnhancementStep` normalizes it, so they land on the same key as the generator.

2. **Reference material** — at least one of:
   - A URL (HuggingFace model card, official announcement, provider docs page)
   - A pasted model description / prompting guide
   - A spec sheet (architecture, encoder, token limit, supported features)

If the user only gives a name with no reference, ask for one before proceeding. Generic guides written without source material drift away from the model's real behavior.

## Workflow

### 1. Research the ecosystem

Use `WebFetch` on any URL the user provided. Pull out:

- **Provider / architecture** (e.g. "Alibaba", "ByteDance", "Tencent", "8B DiT", "MMDiT", "autoregressive")
- **Modality** (image, video, image-edit, multi-modal)
- **Text encoder** (T5, CLIP dual, Mistral, LLM-based) — drives prompt-style recommendations
- **Native resolution / aspect ratios**
- **Token / character limits**
- **Weight syntax support** — almost always "no" for modern models, but check
- **Negative prompts** — supported / not / minimal effect (varies wildly)
- **Special features** — text rendering, multilingual, audio (for video), reference images, hex colors, style tags, character consistency
- **For video models**: duration, fps, camera/motion vocabulary, single-cut vs multi-cut behavior
- **Knowledge / training cutoff** if mentioned
- **Known limitations** worth surfacing (e.g. "weak at long text", "preview checkpoint has plain default style")

If the user gave a description instead of a URL, mine the same fields out of it. Ask follow-up questions only for fields you can't determine and that materially change the guide (e.g. "Does this model support negative prompts?").

### 2. Map findings to the guide template

Every guide follows the same shape. Stick to it — the prompt-analysis service depends on consistent structure across ecosystems.

```text
You are a prompt engineering expert for <Model name and one-clause context>. Analyze the user's prompt and provide structured feedback.

Ecosystem-specific rules:
- Prompt style: <tag-based | natural language | hybrid>. <One-sentence rationale tied to the encoder/architecture if helpful.>
- <Native resolution / aspect ratios>
- <Token or character limit + sweet spot if known>
- <Weight syntax: support state. If unsupported, say so explicitly — "(word:1.5) is ignored.">
- <Negative prompts: supported / not / minimal effect. Include a concrete recommended negative if the model benefits from one.>
- <Any unique features: text rendering rules, multilingual, hex colors, reference images, audio (video), camera vocab (video), style tags, character consistency>
- <Anything the enhanced prompt should ALWAYS carry — camera direction, audio bed, lighting. Phrase as a property of the rewrite, not as something to flag.>
- <Known limitations worth steering the user away from>
- Prompt template: [Section 1] [Section 2] [Section 3] ...

Guidelines:
- Identify vague or overly generic descriptions
- Flag <syntax that is incompatible with this model — e.g. weight syntax on Flux, brackets on HiDream>
- Flag <negative prompt attempts when unsupported, OR suggest negatives when this model benefits from them>
- <Model-specific flags: photorealism cues on anime models, multi-character without descriptions, scene-cut descriptions on short video clips, etc.>
- Limit recommendations to the 3 most impactful improvements
- The enhanced prompt should be a single, ready-to-use prompt that stays faithful to the user's original intent
```

The last two bullets in **Guidelines** are required and identical across every guide — keep them verbatim.

**Every line under `Guidelines:` must have a trigger the analyzer can see in the user's prompt.** If the answer to "when does this NOT fire?" is "basically never", it belongs under `Ecosystem-specific rules:` instead — see 3a. Aim for roughly three guideline lines against the 3-recommendation cap; the corpus averages 3.6 and runs as high as 9.

### 3. Tone and content rules

- **Be concrete.** "No weight syntax — `(word:1.5)` is ignored" beats "weight syntax not recommended."
- **Tie suggestions to the model's strengths — but check where the line belongs (3a).** "Flag in-image text that is described rather than quoted" is a _guideline_: it only fires when the user's prompt asks for text. "The enhanced prompt always states the camera" is a _rule_: nearly every prompt lacks camera direction, so as a guideline it would fire every time and crowd out everything else.
- **Call out incompatibility loudly.** If the model ignores negative prompts or weight syntax, the Guidelines section MUST tell the analyzer to flag attempts at them. This is the most common and most useful correction.
- **Mention the encoder when it explains a rule.** "T5 understands grammar, so write sentences" gives the downstream model leverage.
- **Don't pad.** If the model has no special audio/text/multilingual features, don't invent bullets to fill the section. The SD1 guide is short on purpose.
- **Match precedent for similar models.** A new Wan variant should look like the existing Wan guides; a new Flux variant should look like the existing Flux guides. Consistency across siblings matters more than novelty.

### 3a. Four rules that came out of measurement, not taste

These were established by A/B-ing guides against the live analyzer (see `docs/prompt-analysis-audit-2026-08-05.md`). Each one names a failure that was observed in output, not predicted from reading.

- **Never put an unconditional absence check in `Guidelines:`.** A line like "Suggest audio direction if missing" or "Flag missing camera direction" tests for something real prompts essentially never contain, so it fires on _every_ request and consumes the 3-recommendation budget before anything prompt-specific is reached. Measured on `minimaxh3`: 10 of 12 recommendations were things the prompt already had. Guidelines are for flags whose trigger is _visible in the user's prompt_: weight syntax present, negative phrasing present, keyword list rather than prose.

- **Do not "demote" the absence check into a rewrite property — delete the mention.** The obvious fix for the rule above is to restate it in `Ecosystem-specific rules:` as _"the enhanced prompt should carry camera direction. This shapes the rewrite; do not raise it as a separate recommendation."_ **That does not suppress the topic**, and four measurements on 2026-08-10 say so:

  | Guide | Topic | Carrying the "do not raise it" line | After deleting the mentions |
  | --- | --- | --- | --- |
  | `seedance` | audio | 98% | 70 / 72% (moved by samples, not the line) |
  | `wanvideo-25-t2v` | camera | 89% | **41 / 50%** |
  | `wanvideo-22-t2v-a14b` | camera | 89% | **35%** |
  | `happyhorse` | camera | 84% (v2, softened) | **48%** (v3, deleted) |

  `happyhorse` is the controlled case: same guide, same samples, the only difference being softened-vs-deleted — camera 84% → 48% and `avg recs` 3.67 → 2.52. It is the same mechanism as the parameter-guard lesson below: **naming a topic raises it, whatever the sentence says about it**, and a rewrite-property line still names it — often while explicitly instructing the model to add it ("adding one when the user has not named any").

  So: strip the topic down to at most one purely descriptive mention (a vocabulary list is fine), remove it from prompt templates and structure lines, and if the rewrite genuinely should always add it, teach that with a **sample** whose prompt already contains it and whose recommendations ignore it. Deletion plus samples is the combination that has cleared saturation; rewording has never done it.

- **A guide must read as constraints on the output, never as commentary to a reader.** The model echoes the register you write in. A `mai` draft containing "Lighting is the highest-leverage addition" produced an `enhancedPrompt` ending "…The lighting is the highest-leverage addition, defining the mood and texture." — the guide's own justification, shipped to the image model as prompt text. The same guide restated its template back at the user as a 4th recommendation, breaking the 3-cap. Write "the enhanced prompt always states X", not "X is worth more than Y".

- **A guard against mentioning something makes the model mention it.** Telling the guide "aspect ratio, resolution and step count are chosen in the form — never write them into the prompt" was meant to stop generation parameters leaking into `enhancedPrompt`. Measured on `grok` and `auraflow`, where adding that single line was the **only** change: saturated topics went **1 → 3** and **0 → 1**. The same effect had already been seen on `mai`, where strengthening the aspect-ratio bullet stopped the leak _and_ made "specify the aspect ratio" appear as a recommendation. Naming a topic in the rules block is enough to raise it, whatever the sentence says about it. Prefer saying nothing about parameters at all; if a guide genuinely leaks them, fix it with a sample rather than a prohibition.
- **Deletion-only changes are not automatically safe either.** Removing a `Duration:` bullet from `hyv1` took a real model property with it — "strong temporal consistency due to full 3D attention architecture" lived in the same bullet as the second-count — and saturation went 0 → 1. Three of 31 mechanical, no-new-content candidates regressed. Screen every one.
- **The more important a capability is, the more carefully it has to be phrased.** A researched, factually-correct rule can still make a guide measurably worse. `ltxv23`'s rewrite added native audio — genuinely the model's headline feature and entirely missing from the live guide — described as _"the model's defining capability"_ whose absence yields _"an arbitrary soundtrack"_. Audio recommendations went from ~0% of prompts to **89%**, saturating, and total saturated topics went **1 → 2**: the new guide measured worse than the vague one it replaced, despite being more accurate. State the capability, then say explicitly that the rewrite adds it silently and it is not to be raised as a recommendation. `audit.mjs`'s `EMPHATIC-CAPABILITY` check screens for this, with a caveat: it is a screen, not a predictor — `sd1` says negatives are "Essential" and measured 0 → 0 saturated.
- **A guide can leak a phantom fact through its examples, not just its rules.** The `minimaxh3` guide correctly avoids naming a duration — then taught timed beats with the example `"0-4s he steadies the tweezers, 4-9s the gear seats, 9-12s he sits back"`, and its samples wrote 12-second timelines. H3 clips run 5–15s and the length is not in the request, so every enhanced prompt silently assumed the long end and would overshoot a 5-second generation by more than double. The source material used absolute times legitimately, because a human writing their own prompt knows their duration; the analyzer does not. **Check example text and sample `enhancedPrompt`s for smuggled assumptions, not just the rule bullets.** Fixed by switching to ordinal beats ("first… then… finally…"), which are correct at any clip length.
- **Never ask the analyzer to condition on a fact that is not in its payload.** It sees the prompt, the negative prompt, any reference images, and the per-request `instruction`. It does not see which checkpoint, variant, resolution, or duration was selected. `hidream`'s "only works with the Full variant" is dead weight: the model hedges on every response or drops the condition. **Do not try to fix this by sending the identifier** — this was built and reverted. `ModelVersion.name` is uploader-authored free text (the 69 HiDream checkpoints are named `BF16`, `FP8`, `Q2_K`, `Jibs Hi-DreamDevWorkflow`), so it carries no variant meaning and invites the model to invent one. Condition on what _is_ in the payload instead: "when a negative prompt was supplied, analyze it" works, because a build that does not accept one never sends the field.

- **Generation parameters never belong in prompt text.** Aspect ratio, resolution, duration, and step count are chosen in the form. A `boogu` draft wrote `16:9 aspect ratio` into the `enhancedPrompt`. State the constraint once in the rules ("chosen in the form; never write it into the prompt") — but be aware this cuts both ways: strengthening that line on `mai` stopped the leak _and_ made "specify the aspect ratio" appear as a recommendation. Which is why the next section exists.

### 3b. Prose has a low ceiling — plan on a sample

The analysis model is `Qwen3.6-35B-A3B`: a MoE with **3B parameters active per token**, so prose instruction should be weak on it and worked examples strong. Treat that as the working theory, not a settled fact.

**Measured:** two samples took `minimaxh3`'s audio recommendations from 98% of prompts to 70%, bringing it out of saturation, and the freed slot went to lighting — advice that varies with the prompt instead of firing regardless. Saturated topics 2 → 1.

**The metric's noise floor is ±1 saturated topic. Measured, not estimated.** Comparing a guide against a byte-identical copy of itself scored saturated topics of **1, 2, 2, 1, 2, 1** across six arms, with one topic swinging from under 25% to 93% between arms of the same invocation. Every one of those three null invocations produced a nonzero delta, and two of three printed a ship recommendation. **A one-topic move is not a result.** Trust only a ≥2-topic move, or a 1-topic move where a specific topic also shifted ≥25 points _and_ both reproduce on an independent run. Everything that survived this bar in the 2026-08-06 rollout had samples aimed at the saturated topic: `minimaxh3` (camera/audio 98→65), `sdxl` (lighting 89→55/66), `ltxv23` (audio 89→50/52). The ~20 single-run ±1 results from that rollout are unproven either way.

**Read `measure.mjs`'s topic table, not just its verdict.** The goal is no topic at or above 80%. A saturated topic is a recommendation slot spent before the prompt is read, and with a 3-recommendation cap two saturated topics means the guide is barely responding to input at all.

**A warning that cost this investigation four rounds.** The original metric was _redundancy_ — recommending something the prompt already contains. It sounds like the same thing and is not: it fires only in the narrow case where the prompt happens to contain the recommended item, which is a sliver of "advises identically regardless of input". Against it, every intervention read as noise and the conclusions were that prose does nothing, samples do nothing, and the analysis model might need replacing. All three were artifacts of the instrument. **Reading 141 recommendations by hand found in one pass what six measurement rounds had missed.** When a metric refuses to move for any intervention, suspect the metric before concluding the system is fine.

**Two ways this measurement lied, both worth knowing before you trust a number:**

- **A corpus built while investigating one guide will flatter that guide's diagnosis.** The original five prompts were written during the `minimaxh3` audit, so four carried camera and audio direction — precisely what that guide over-flags. It baselined at 83% redundant there and 44% on the generic corpus. Use the bundled `prompts.json`; if you add prompts, add them for coverage, never because a guide handles them badly.
- **`avg recs` above ~4 alongside a low `over-cap` count is an artifact, not a finding.** Seen twice — `qwen` at 11.32 and `seedream` at 7.07 — and both times the adjacent arm read 2.9–3.0 on identical text while saturation stayed consistent. The two numbers contradict each other: a genuine mean of 11 would put nearly every response over the 3-cap, not 4 of 56. One malformed response skews the mean. Re-run rather than reasoning about it, and decide on saturation.
- **Check the denominators before reading any percentage.** A partly-failed arm still prints a full topic table and a confident verdict. `measure.mjs` warns at "only N/M calls succeeded", but a milder shortfall passes silently — the only tell is that `redundant X/Y` and `over-cap A/B` disagree between the two arms. On `wanvideo14b_i2v_480p` the live arm scored 46 responses and the candidate 31: a third of the requests never returned, yet the verdict line read as a clean 1 → 0 clearance. **`Y` and `B` must match across arms; if they do not, discard the run.** Failures also cluster — that run was followed by an arm where every request failed — so a mismatched denominator usually means the endpoint is degrading and the whole batch should pause rather than continue.
- **An apparent effect can sit inside the baseline's own variance.** Samples looked like they degraded cap adherence — 0–1/30 without, 4–5/30 with, consistent across two configurations — until an unchanged live guide scored 6/30 on its own. `measure.mjs` re-scores the baseline on every invocation for exactly this reason. **Never compare against a baseline number from an earlier run.**

A sample is `{ prompt, negativePrompt?, assistantResponse }`. Write them for the _judgement_ the prose cannot state:

- **The strongest sample answers an already-good prompt.** That is where the model's default — emit boilerplate — is most wrong. A sample built on a weak prompt teaches nothing, because generic advice is correct there anyway.
- **A sample teaches every recommendation it contains, including the ones you did not mean to teach.** The first `sdxl` samples both opened with "add lighting and composition tags" — and lighting was the saturated topic they were written to fix. Measured result: 89% → 88%, nothing. Before shipping a sample, check its recommendations against the saturated topics in `measure.mjs` output; if the sample recommends the thing you are trying to suppress, it will entrench it.
- **Spend samples on what only this guide can teach.** "Add lighting" is advice any guide gives, so a sample demonstrating it is a wasted slot. Samples are expensive — they ride on every request for that ecosystem — so they should carry the ecosystem's distinctive judgement, not its generic advice.
- **Research the advice before you write it, exactly as for the guide itself (step 1).** A sample teaches by example, so wrong advice inside one is taught more efficiently than wrong advice in prose. The first `minimaxh3` samples were drafted from general video-model instinct because H3 shipped after the model's training cutoff; checking them against MiniMax's own published prompts showed one claim was directionally right but far too weak (the fix is explicit `0-4s / 4-9s` timestamped ranges, not vaguely "some change over time") and surfaced a third rule the guide was missing entirely. **If you cannot cite a source for what a sample teaches, do not ship the sample.**
- Conventions that are positional or syntactic rather than semantic: `anima`'s `@artist` prefix and tag order, `sd1`'s weight syntax and `BREAK`, `flux1kontext`'s edit-instruction framing.
- Not rules with a crisp statement. "No weight syntax" needs no example.

Real user prompts for the input half can be pulled from `Image.meta->>'prompt'` (see the `postgres-query` skill). Filter for _strong_ prompts, not the median — the median is LoRA tags and quality-tag spam. The `assistantResponse` always has to be authored; no query produces it.

### 3c. Measure before deploying

A guide edit is a change to a probabilistic system, so read the output before shipping it. `measure.mjs` runs a guide against a fixed prompt set and reports how often it recommends something the prompt already has.

```bash
# Baseline a live guide
node .claude/skills/add-prompt-enhancement-guide/measure.mjs --ecosystem minimaxh3

# A/B a candidate against it (3 runs each is enough to see past temperature noise)
node .claude/skills/add-prompt-enhancement-guide/measure.mjs \
  --ecosystem minimaxh3 --candidate ./new-guide.txt --runs 3
```

**One run proves nothing, and three barely do.** A single pass of the `minimaxh3` A/B showed the prose fix halving redundancy; three runs showed it doing essentially nothing. A prose-plus-sample combination measured 3/12 twice at `--runs 3` and looked like a real compounding effect; at `--runs 6` it was indistinguishable from the sample alone. Use `--runs 6` for anything you intend to deploy, and treat `--runs 3` as a smoke test.

Expect edits to regress something. Fixing D1/D4/D6 across three drafts also introduced two new defects — `mai` gained an aspect-ratio recommendation, `mageflow` started emitting a populated negative prompt on a model that has no negative field. Re-measure the _whole_ prompt set after a fix, not just the case you were fixing.

### 4. Confirm with the user

Before deploying, paste the drafted guide back to the user and ask for sign-off. Highlight any field where research was thin or you had to make a judgment call (e.g. "I assumed negative prompts are unsupported because the model card doesn't mention them — confirm?").

Accept edits. Re-paste the final version after any changes.

### 5. Deploy to the orchestrator (optional)

Use `manage.mjs` in this skill directory rather than hand-rolled `curl`. It reads `ORCHESTRATOR_ENDPOINT` and `ORCHESTRATOR_ACCESS_TOKEN` from the project `.env`, gates every state-changing call behind `--writable`, and verifies the readback after a `put`.

```bash
# What is already registered, and which ecosystems have a real guide
node .claude/skills/add-prompt-enhancement-guide/manage.mjs status

# Read an existing guide as precedent before writing a sibling
node .claude/skills/add-prompt-enhancement-guide/manage.mjs get seedance --prompt-only

# Deploy — writes the file's contents as the system prompt, then reads it back
node .claude/skills/add-prompt-enhancement-guide/manage.mjs put <key> --prompt-file guide.txt --writable
```

Pass the guide as a plain-text file via `--prompt-file`; it contains backticks, newlines, and quotes that break shell escaping. `--file` takes a full JSON body instead if you need `samples`.

`PromptAnalysisGrain.DefaultModelId` is now the qwen3 URN (`civitai-orchestration` PR #297), so a `put` without `--model` on a brand-new ecosystem inherits the right model. Passing `--model 'urn:air:qwen3:repository:huggingface:Civitai/Qwen3.6-35B-A3B-Abliterated-AWQ@main.tar'` explicitly is still the safer habit — it survives a future change to the const, and it is what every existing guide stores.

To rebind an existing guide without touching its text, use `set-model`:

```bash
node .claude/skills/add-prompt-enhancement-guide/manage.mjs set-model <key> \
  --model 'urn:air:qwen3:repository:huggingface:Civitai/Qwen3.6-35B-A3B-Abliterated-AWQ@main.tar' --writable
```

It refuses on an ecosystem that has no guide of its own. Those report a `modelId` because the grain falls back to the const, not because anything was stored; writing one would freeze today's fallback text as that ecosystem's permanent guide and cut it off from future changes to the built-in default. Fix the const in `civitai-orchestration` instead.

`register` is not a required step — a `put` registers the ecosystem on its own.

### Few-shot samples

Each ecosystem can carry `samples` — `{ prompt, negativePrompt?, assistantResponse }` triples that the handler replays as user/assistant turns between the system prompt and the real request. **This is the highest-leverage lever available; see 3b for the measurement and for how to choose what a sample should demonstrate.**

```bash
node .claude/skills/add-prompt-enhancement-guide/manage.mjs set-samples <key> --file samples.json --writable
```

Rules that are easy to get wrong:

- **`assistantResponse` must be a JSON string matching the analysis schema exactly** — `issues` (each with `description` and `severity` of `info`/`warning`/`error`), `recommendations`, `enhancedPrompt`, `enhancedNegativePrompt`. Responses are generated under a strict `json_schema` response format, so a sample in any other shape teaches the model to fight the schema. `set-samples` rejects an `assistantResponse` that is not parseable JSON, but it cannot check the shape for you.
- **`enhancedNegativePrompt` is `""`, not omitted,** when the sample has no negative prompt.
- **Samples cost context on every single request** for that ecosystem. Two or three tight examples beat ten sprawling ones.
- **Write samples for what the guide cannot state as a rule.** A convention with a crisp rule ("no weight syntax") does not need one. A judgement call — how much detail is too much, what a good rewrite of a one-word prompt looks like — does.
- **`put` preserves samples by read-modify-write, which means it destroys them if run too soon after `set-samples`.** It re-reads the stored config to carry samples forward, and writes propagate slowly — so a `put` issued moments after a `set-samples` reads the _stale_ copy (0 samples) and writes that back. Observed both halves on 2026-08-06: the racing `put` reported `0 sample(s)`, while a later one on a settled config reported `Keeping 2 existing sample(s)` and kept them. **Order `put` first, then `set-samples`** — that way nothing depends on the read winning. If you must run them the other way, wait ~30s between. Always read the sample count in the output; it reports what was actually written.

**Two orchestrator behaviors that will mislead you** (both in `PromptAnalysisGrain.cs` / `PromptAnalysisController.cs` in `civitai-orchestration`):

- **A GET registers.** `GetPromptAnalysisRequestAsync` calls `EnsureRegisteredAsync`, so reading an ecosystem that was never set up silently adds it to the registry with default config. GET never 404s and never distinguishes registered from not. Probing candidate key spellings pollutes the registry permanently — use `status` (one list call) instead of GETing guesses.
- **Only POST lowercases the key.** GET/PUT/DELETE address the Orleans grain by the exact path string, so `MiniMaxH3` and `minimaxh3` are two separate configs. `manage.mjs` lowercases for you; `--raw-key` targets an odd-cased entry, which is the only way to `delete` one.

The registry already contains junk from past probing (`notarealecosystem`, `SDLX`, `Flux.1 D`, bare `flux`, …). Don't add to it, and don't read a name's presence in `list` as evidence that anything uses it.

### 6. Verify — and do not trust the immediate readback

**Writes take up to a minute to become visible, so `put`/`set-samples` readback verification races the propagation and reports both false failures and false successes.** Both were observed in a single deploy on 2026-08-06: a `GET` straight after a verified `put` returned the _old_ 3437-char guide, and a `set-samples` printed `✗ readback does not match what was sent` for a write that had in fact succeeded. Acting on either signal would have meant re-running a write that already landed, or reverting one that was fine.

`put` and `set-samples` now poll the readback for up to 30s instead of asserting once, so an
immediate false failure is no longer reported. A `✗` therefore means the write really did not
land — but **re-check with `status` before rewriting** rather than firing a second write blind.

**Deploy a guide and its samples in one atomic `put --file`, never `put` then `set-samples`.**
`set-samples` has to send a `systemPrompt` it did not author, so it reads the current one first
— and within the propagation window that read returns the _previous_ guide, which the write
then reinstates. This silently reverted a verified `seedance` deploy on 2026-08-10 (2588 chars
back to 2659). `set-samples` now refuses when two reads 3s apart disagree, and accepts
`--prompt-file` to state the guide explicitly, but the atomic form avoids the question:

```bash
node -e "const fs=require('fs');fs.writeFileSync('deploy.json',JSON.stringify({
  systemPrompt: fs.readFileSync('guide.txt','utf8').replace(/\n+$/,''),
  modelId: 'urn:air:qwen3:repository:huggingface:Civitai/Qwen3.6-35B-A3B-Abliterated-AWQ@main.tar',
  samples: JSON.parse(fs.readFileSync('samples.json','utf8')),
}))"
node .claude/skills/add-prompt-enhancement-guide/manage.mjs put <key> --file deploy.json --writable
```

Then confirm independently:

```bash
node .claude/skills/add-prompt-enhancement-guide/manage.mjs status | grep <key>   # chars + sample count
node .claude/skills/add-prompt-enhancement-guide/manage.mjs get <key>             # diff against your source files
```

Report success with the ecosystem key and a one-line summary of the guide's main points (encoder, weight-syntax stance, negative-prompt stance, any unique feature).

## Anti-patterns to avoid

- **Don't copy a sibling guide and rename.** The shape is shared but the rules diverge — a Flux guide pasted under a Wan key will mislead the analyzer.
- **Don't invent capabilities.** If the source doesn't mention audio, multilingual rendering, or 4K output, don't claim them.
- **Don't soften incompatibility.** "Weight syntax may not work" is wrong if the encoder ignores it entirely. Say "ignored" or "unsupported."
- **Don't drop the two trailing Guidelines bullets** ("Limit recommendations to the 3 most impactful improvements" and "The enhanced prompt should be a single, ready-to-use prompt..."). They're load-bearing for the analyzer's output format.
- **Don't push to the orchestrator without showing the user the guide first.** Once deployed, it shapes every prompt-analysis call for that ecosystem.
- **Don't ship a guide edit on reasoning alone.** Run `measure.mjs` (3b/3c). The edit that looks obviously right is the one most likely to measure as noise.
- **Don't answer a behaviour problem with more prose.** If the guide already says it and the model still gets it wrong, another sentence will not fix it — write a sample.
- **Don't plumb a new per-request fact into `buildInstruction` without first asking whether it should be sent at all.** Duration and checkpoint variant were both built and both reverted: the "per-request facts don't belong in guides" rule answers _where_ a fact lives, not whether it earns a line. Every line competes with the user's own instruction.
- **Don't probe for the right key by GETing candidates.** Every GET registers what it reads, so guessing spellings leaves permanent junk behind. Derive the key from `basemodel.constants.ts` and confirm against one `status` call.

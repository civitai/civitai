# Prompt-analysis guide audit — 2026-08-05

Review doc for the orchestrator's per-ecosystem prompt-analysis guides. Comment inline with `@dev:`.

> **Read this first — the document below is a working log, and its early sections are wrong.**
> It was written before any measurement existed and records several conclusions that later
> measurement reversed. The findings that survived are summarised here; everything under
> "Guide audit against Qwen" onward should be read as the path taken, not as guidance.

## Outcome — corpus-wide sweep, 2026-08-10

**35 guides deployed, 1 reverted (`anima`), ~125 measurement runs.** Every ecosystem in
Priorities 1–4 measured against the live analyzer. Per-guide results and drivers live in
[`prompt-analysis-samples/STATUS.md`](prompt-analysis-samples/STATUS.md).

### The finding

The corpus shared a guide template, and that template embedded **six constructions that all do
the same thing**: cause the analyzer to recommend a topic regardless of what the prompt says.
Ordered strongest to weakest by how forceful they look — which is the reverse of how much they
cost:

| Form | Example |
| --- | --- |
| Directive | `Flag missing camera direction` · `Specify artistic medium explicitly` |
| Rewrite property | `The enhanced prompt should carry lighting…` — 7 instances found |
| Superlative | `Lighting has the biggest impact on quality` |
| Bracketed template | `[Subject]. [Lighting]. [Style]. [Composition].` |
| Prose enumeration | `Subject + Scene + Composition + Lighting` · `subject → action → lighting` |
| Endorsement | `Camera/lens references and specific lighting descriptions work well.` |

**The cost is in the mention, not the phrasing.** Rewording failed in every one of ~25 attempts;
only deletion moved the metric. The mildest construction in the table — a nine-word observation
that two things "work well" — moved camera 68 points and lighting 52 on `fluxkrea`, and the
identical sentence produced −39/−45 on `flux2`. **The effect is line-specific and transfers
between guides.**

`flux1kontext` is the control: the only guide in the corpus with no template and no enumeration,
and the only guide never saturated. Its topics sit at 36/32/27/27%.

### Where deletion stops

Three guides saturate on topics their text never mentions (`auraflow`, `qwen2`, `veo3`). That is
the analyzer's own prior, not anything the guide caused, and no edit reaches it. Every guide that
got *under* that floor did so with **samples** demonstrating restraint — a prompt that already
contains the saturated topic, answered without recommending it.

So: **deletion gets you to the floor; samples get you under it.**

### Corrections to this document

- **F1 was wrong about the mechanism.** It blamed guideline *count*. Count is irrelevant;
  `happyhorse`'s nine conditional `Flag …` lines were harmless. Conditionality is not the issue
  either — see F1-corrected below, which was also incomplete. It is mentions.
- **F2 was ranked first and is worth roughly nothing.** Adding a positive replacement to a bare
  prohibition measured as noise.
- **F6 (samples) was ranked fourth and should have been first**, with the caveat that samples
  teach whatever they demonstrate — `anima`'s original set made things worse.
- **`flux`, `flux3video` and `qwen3` are valid ecosystems.** An earlier note in this session
  called them registry pollution on the grounds that they were absent from this worktree's
  `basemodel.constants.ts`. Absence there is not evidence; the claim was withdrawn.

## Background

The orchestrator stores one system prompt per ecosystem, keyed by the **lowercased AIR ecosystem value**. The app now derives that key from a single helper (`getAirEcosystem` in `src/shared/utils/air.ts`), which `stringifyAIR` also uses — deployed, so a generation and its prompt analysis can no longer disagree about which ecosystem they belong to.

Two orchestrator behaviors shaped this audit:

- **A GET registers.** `PromptAnalysisGrain.GetPromptAnalysisRequestAsync` calls `EnsureRegisteredAsync`, so reading a key that was never set up adds it permanently with default config.
- **Only POST lowercases.** GET/PUT/DELETE address the Orleans grain by exact string, so `Anima` and `anima` were two separate configs.

Together these are why the registry had accumulated 50 dead entries.

## Done

**Registry cleanup: 104 → 54 entries.** Removed 50 unreachable keys. None had a custom guide, so no authored work was lost.

| Cause                                              | Examples                                                   |
| -------------------------------------------------- | ---------------------------------------------------------- |
| Engine names mistaken for ecosystem keys           | `minimax-h3`, `ltx2`, `ltx2.3`                             |
| Guessed alias spellings                            | `nano-banana`, `seedance-2`, `veo-3`, `sora-2`, `imagen-4` |
| Child ecosystems (collapse to their parent in AIR) | `pony`, `noobai`, `illustrious` → all arrive as `sdxl`     |
| Case/format variants                               | `Anima`, `Flux`, `Flux.1 D`, `LTXV 2.3`, `SDLX`, `zImage`  |
| Test junk                                          | `notarealecosystem`, `bogusecosystemxyz`, `anime`          |

**Model rebinding.** `minimaxh3` was the only custom guide still on `x-ai/grok-4.1-fast`; it now uses the qwen3 URN like every other guide. The orchestrator's `PromptAnalysisGrain.DefaultModelId` const now matches (`civitai-orchestration` PR #297, merged) so nothing inherits grok going forward. **Grok is fully out of the path.**

Current state: **54 registered, 41 with real guides, 0 unreachable.**

## Analysis model: Qwen3.6-35B-A3B

The guides were written for `x-ai/grok-4.1-fast`; everything now runs on Qwen3.6-35B-A3B (MoE, 35B total / **3B activated**, 262K context). Checked the guides against the model card and how `PromptEnhancementHandler` calls it — the call is already configured correctly:

| Concern                                                  | State                                                                                                                                   |
| -------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| Thinking mode (on by default, would corrupt JSON output) | Already disabled — `ChatTemplateKwargs = { enable_thinking = false }`                                                                   |
| Temperature                                              | 0.7 — exactly Qwen's non-thinking recommendation                                                                                        |
| Output format                                            | Handled outside the guides: `OutputFormatInstructions` + a strict `json_schema` response format. Guides must not describe output shape. |
| Guide length                                             | Longest guide is ~4K chars against a 262K context. No pressure to trim.                                                                 |

Two things do warrant action:

1. ~~**Sampling parameters beyond temperature are unset.**~~ **Resolved: leave the penalties alone.** Qwen's card recommends top*p 0.80, top_k 20, presence_penalty 1.5, but that 1.5 is anti-degeneration tuning for open-ended chat and this is not that task. The analysis output repeats itself \_by design* — `recommendations` names the subject and lighting, then `enhancedPrompt` restates them in prose — and the strict `json_schema` forces the same field-name tokens every time. Penalizing already-generated tokens pushes the enhanced prompt away from the vocabulary the analysis just established. (`presence_penalty` counts generated tokens only, not the prompt; `repetition_penalty` is the one that spans both. Neither is the right knob here.) top_p/top_k remain harmless and optional.

2. **`samples` is empty on all 41 guides.** The handler already supports few-shot (sample prompt → assistant response pairs, injected between the system prompt and the user turn). With only 3B parameters active per token, a worked example is worth considerably more than another paragraph of prose instruction — this is the highest-leverage change available for the new model. Best candidates are the ecosystems whose conventions are least like ordinary English: `sd1` (weight syntax, BREAK), `anima` (`@artist` prefix, tag ordering), `flux1kontext` (edit instructions, not scene descriptions).

### Guides silently suppress the reference-image instructions — **fixed**

Fixed in `civitai-orchestration` PR #298. Kept here for the reasoning. The handler used to append its image-awareness block only when the guide did **not** already mention images:

```csharp
if (hasImages && !analysisRequest.SystemPrompt.Contains("image", StringComparison.OrdinalIgnoreCase))
```

Since almost every guide opens with "You are a prompt engineering expert for X **image** generation," the test fails and the block is dropped. Measured across the 41 live guides: **31 suppress it, 10 receive it** — and the split is exactly backwards.

Suppressed: every image-to-video guide — `wanvideo-25-i2v`, `wanvideo-22-i2v-a14b`, `wanvideo14b_i2v_480p/720p`, `minimaxh3`, `seedance`, `vidu`, plus `flux1kontext`. These are the workflows where a reference image _is_ the request.

Receiving it: text-to-video guides — `veo3`, `sora2`, `kling`, `wanvideo-25-t2v`, `wanvideo14b_t2v`, `hyv1`, `ltxv2/ltxv23`, `happyhorse` — which are the least likely to have images attached.

The substring test was the wrong mechanism — the handler already knows `hasImages`. It now appends unconditionally when images are present, so all 41 guides receive the block.

## Guide audit against Qwen — all 41

Read every custom guide and measured the corpus. Live state was confirmed against the snapshot first (54 / 41 custom / 13 default, all on the qwen3 URN — including the six that used to show grok, which healed on their own exactly as predicted).

**The headline is that the guides are good.** They were written by someone who understood the models, and the most common pattern in them — pair every prohibition with the positive phrasing that replaces it — is precisely what a small model needs. The findings below are about a handful of patterns that were free on grok and are not free on a 3B-active MoE.

### F1 — The recommendation budget is oversubscribed (all 41)

Every guide ends with `Limit recommendations to the 3 most impactful improvements`. Above that line sits a list of `Flag …` / `Suggest …` / `Identify …` imperatives — **3.6 of them on average, and up to 9**:

| Guide        | Flag-style lines | Guide                                                              | Flag-style lines |
| ------------ | ---------------- | ------------------------------------------------------------------ | ---------------- |
| `happyhorse` | 9                | `veo3`                                                             | 5                |
| `anima`      | 7                | `lens`                                                             | 5                |
| `seedance`   | 6                | `reve`                                                             | 5                |
| `minimaxh3`  | 6                | `flux1`, `flux2`, `chroma`, `hyv1`, `grok`, `sora2`, `zimageturbo` | 4                |

Each line is an invitation to emit a recommendation; one line then caps the total at three. Grok had the headroom to treat that as "triage." A 3B-active model is far likelier to walk the list and emit the first three regardless of whether they apply to _this_ prompt.

**Predicted symptom, and the way to confirm it:** recommendations that barely vary across different user prompts for the same ecosystem. That is a cheap thing to test and would settle the whole finding.

**Fix:** demote most `Flag …` lines into the `Ecosystem-specific rules:` block, where they inform the rewrite without inviting a separate output item, and keep the guidelines to roughly three that name the ecosystem's _characteristic_ failure. Mechanical, needs no new research.

### F2 — 17 guides prohibit without showing the replacement

`anima`, `grok`, `zimageturbo`, `zimagebase`, `wanvideo14b_t2v`, `wanvideo-22-t2v-a14b`, `wanvideo-25-t2v`, `hidream`, `vidu`, `kling`, `ltxv2`, `ltxv23`, `ernie`, `qwen`, `qwen2`, `imagen4`, `seedream` state a prohibition with no positive alternative anywhere in the guide.

Compare what the good guides do — `flux1`:

```text
NO negative prompts. Describe what you want, not what to avoid. Instead of "no blur" say
"sharp, crisp focus." Instead of "no crowds" say "solitary figure."
```

A bare prohibition makes the model invent the replacement; the paired form hands it over. This is the **highest-yield mechanical edit in the audit** — `flux1`'s and `reve`'s lines transfer nearly verbatim.

### F3 — Variant branching the model cannot resolve

`hidream`, `krea2`, and the new `boogu` draft ask the analyzer to condition on which checkpoint variant is selected — a fact that is **not in its payload**. `hidream` is the clearest case:

```text
- If a negative prompt is provided, analyze it — but note it only works with the Full variant
```

The model cannot tell which variant is in play, so it either hedges on every response or drops the condition. Either way the instruction is dead weight, and it costs attention on every request.

Not every branch is bad: `anima`'s tag-mode vs NL-mode split is legitimate, because the model can see which style the user's own prompt is written in.

#### ~~Route the variant through `buildInstruction`~~ — built, then reverted

@dev: Why do you need the checkpoint variant/id in the prompt? The model has no understanding of the checkpoints we use in civitai. That's why we have ecosystem specific prompts.

@ai: Correct, and the plumbing is reverted. Two reasons, and the second is the one that kills it outright:

1. The analyzer has no model of our checkpoints, so a bare identifier is only useful as a **join key** back into vocabulary the guide already defines. That is a weak mechanism to spend a per-request line on.
2. **The join key does not exist.** `ModelVersion.name` is uploader-authored free text. Measured against the 69 HiDream checkpoint versions: `BF16`, `DEV`, `DEV-1`, `Dev Q8 -17.4GB`, `F16`, `FAST`, `FP8`, `FULL`, `Q2_K`, `Jibs Hi-DreamDevWorkflow`. Most name a quantization format, not a variant. Boogu's 14 are `hotfix`, `v0.1`, `v6.2 boogu`, `turbo_hotfix_int8_convrot`. Sending that string tells the analyzer nothing and invites it to invent a meaning.

**The fix needs no app change.** The payload already carries the only fact the guide needs: whether a `negativePrompt` was supplied. If the user sent one, the form accepted one, so the workflow supports one. If they did not, there is nothing to analyze. `boogu`'s Turbo case handles itself — the graph omits the field, so nothing arrives.

So F3 resolves the same way duration did: **delete the variant caveat from `hidream`, `krea2` and the `boogu` draft** and condition on `negativePrompt` presence, which is in the payload. Removing a wrong instruction beats replacing it with an unreliable one.

### F4 — `minimaxh3` contradicts itself and asks for arithmetic

Worst guide in the corpus for this model — 13 bare negations, the most of any guide. Two specific defects:

```text
- NO negative prompts. … Express exclusions as constraints inside the prompt itself
  ("the frame never moves", "no music", "an empty kitchen" rather than "no people").
```

It bans negative phrasing and then offers `"no music"` as an approved example — the exact construction it just prohibited, sitting two words from `"no people"` as the counter-example. A 3B-active model pattern-matches on surface tokens; this bullet argues with itself.

```text
- … Budget roughly 4 seconds per prop change and 3 per camera shift.
```

Multi-step arithmetic against a duration the model is only told as a range. Weak at 3B active, and per-request anyway — it belongs in `buildInstruction` with the rest of the temporal facts.

### F5 — `anima` (27 bullets) and `happyhorse` (26) exceed the attention budget

Not a context-length problem — 4.1K chars against 262K is nothing. It is an attention-budget problem: the more simultaneous constraints, the more a 3B-active model drops. `anima` also carries a `Dataset tags (advanced)` bullet gated on `Only suggest these if the user is explicitly going for non-anime illustrative styles` — a conditional evaluated on every single request to serve a rare case.

### F6 — Still zero samples

Confirmed live: `samples` is empty on all 41. The audit sharpens _which_ conventions prose demonstrably fails to carry, and they are the ones that are positional or syntactic rather than semantic:

- **`anima`** — the `@artist` prefix and the six-slot tag order. Prose has to spend four bullets on this; one example shows it.
- **`sd1`** — weight syntax and `BREAK`.
- **`flux1kontext`** — edit instruction rather than scene description.

### Not wrong — recorded so it is not re-litigated

- **No output-shape leakage in any of the 41.** Every apparent hit was a false positive (depth of _field_, "causes issues", JSON as a _prompt_ format in `happyhorse`). The decision to leave output shape to `OutputFormatInstructions` is holding.
- **Length is a non-issue.** Longest guide 4,101 chars against a 262K context.
- **Most prohibitions are already well-paired**, and `flux1` / `reve` / `lens` are models for the rest.

### Reconciliation with the measurement work

A measurement harness (`measure.mjs`) and rollout tracker (`docs/prompt-analysis-samples/STATUS.md`) were built in parallel with this audit. They carry live evidence this document did not have, and they overrule parts of it. Recording the deltas rather than leaving two accounts drifting apart.

**The metric.** `measure.mjs` scores *topic concentration* — the fraction of prompts that get a recommendation on a given topic. Anything at or above 80% is firing regardless of the prompt, and against a 3-recommendation cap each saturated topic permanently occupies a slot. That is F1 made measurable, and it confirms F1 was a real effect rather than a hypothesis: `minimaxh3` measured **audio at 100% and camera at 96% across 23 unrelated prompts**.

**Correction — F2 and the F1 prose fix are not the highest-yield items.** This document ranked F2 first ("highest yield per unit of effort"). The tracker records `GUIDELINE-COUNT` (5 guides) and `BARE-PROHIBITION` (8 guides) as **deliberately deferred**, because that shape of change "measured as noise twice today." What actually moved the metric on all three shipped candidates was **samples**:

| Guide | Change | Saturation |
| --- | --- | --- |
| `minimaxh3` | F1 + F4 + ordered beats + **2 samples** | 2 → 1 |
| `sdxl` | child-ecosystem branching + F1 + params guard + **2 samples** | 1 → 0 |
| `ltxv23` | full rewrite + **2 samples** | 1 → 0 |

So **F6 should have been ranked first, not fourth**. The reasoning in F6 was right — a 3B-active model learns an unusual convention from one worked example better than from another paragraph — but I under-weighted it relative to prose edits that turn out to be noise. Rewriting prose without samples is not supported by evidence.

**Correction — `ltxv` does need a guide.** This document recorded "no guide for `ltxv`" under decisions not to revisit. That was wrong, and the reasoning was sloppy: the answer to Q2 was about which ecosystems *the generator uses*, and I turned it into a claim about *reachability*. Verified directly — `basemodel.constants.ts:1105` carries `{ ecosystemId: ECO.LTXV, supportType: 'generation', modelTypes: checkpointOnly }`, and LTXV has no `parentEcosystemId`, so it reaches prompt analysis as `ltxv`. It routes through the `lightricks` engine rather than `ltx.handler.ts`, which is why it did not appear where I looked. It is a **video** model that has been served the image-flavoured default prompt this entire time.

**Discrepancy the other way — `ideogram`.** The tracker lists it under Priority 3 as sourced and ready to write. I can find no `supportType: 'generation'` entry for `ECO.Ideogram` anywhere in `basemodel.constants.ts` (it has an ecosystem record and a base-model record, but no support entry), which means `getEcosystemSupport(ECO.Ideogram, 'generation')` returns undefined and no enhancement request can reach it. Being registered on the orchestrator is not the same as being reachable. Worth confirming before spending effort — if generation support is planned but unlanded, the guide is fine to write ahead of it; if not, it is wasted.

### F1, corrected: conditionality, not count

Measured on `anima`, four configurations against the same corpus, one variable at a time:

| Configuration | style | saturated topics |
| --- | --- | --- |
| live (5 runs) | 86 / 89 / 93 / 89 / 95% | 1 |
| + v1 samples (generic "add X" recommendations) | 91% | 1 — **and camera +31%** on an image model |
| + v2 samples (prompt-specific; one with only 2 recs) | 82% | 1 |
| + v2 samples **and** the standing invitation removed | **71% / 75%** | **0 / 0** |

**F1 as originally written blamed guideline *count*. That was wrong in a way that matters.** The driver is whether a line is phrased as an **unconditional invitation**. `anima` carried:

```text
- Suggest quality and/or artist tags when the user wants stronger aesthetics, since the
  base model is intentionally neutral
```

plus a rule asserting that artist and quality tags "meaningfully improve aesthetics." Together they make style advice correct on *every* prompt, so it fired on ~90% of them. Deleting the guideline and rewriting the assertion conditionally ("a prompt carrying no artist or quality tags at all benefits from adding them — a prompt that already has them does not need more") is what cleared it.

This also explains why the earlier `GUIDELINE-COUNT` sweep measured as noise: it cut the number of guidelines without touching their conditionality. `happyhorse`'s nine `Flag …` lines may be entirely harmless if each is conditional.

**Two independent runs, non-overlapping distributions**: live style ranged 86–95% across five runs; the candidate scored 71% and 75%. The candidate's maximum sits below the live minimum. `measure.mjs` still prints its canned "not evidence" footer, but that heuristic keys on per-topic movement size and misfires here — a 20-point drop is not the noise floor it describes.

### Samples: a lever in both directions

The same experiment shows samples are not automatically beneficial. `anima`'s original three samples made things **worse** — camera appeared at 31% on an image model, composition rose 15%, and over-cap tripled — because their recommendations were generic additions ("Add a framing tag", "Add one or two background tags") that apply to any prompt, so the analyzer applied them to every prompt.

The sets that measured well (`minimaxh3` 2→1, `sdxl` 1→0) share three properties, and `anima`'s originals violated all three:

1. **At least one sample whose prompt already satisfies the saturated topic, with a response that pointedly does not recommend it.** `minimaxh3`'s sample 0 opens "A locked frame holds on…" — camera direction present, camera never mentioned in the recommendations, and camera had been saturated at 96%.
2. **Recommendations specific to that prompt's content**, never generic "add X" advice.
3. **At least one sample with two recommendations, not three.** Both working sets include one; `anima`'s originals ran 3/2/3. Rewriting to the rule moved `avg recs` from 3.04 to 2.55.

### Suggested order

**Superseded — the original order below was written before any measurement, and the evidence reverses it.** Kept for the record; follow the reconciliation section above instead.

Revised order, evidence-first:

1. **F6 — samples.** The only intervention that has demonstrably moved saturation. Every shipped candidate carries two.
2. **F4-class fixes** — instructions the analyzer provably cannot act on (variant conditioning, hardcoded duration). These ship on a "did not make things worse" run rather than needing a saturation win, because removing a dead instruction is correct regardless.
3. **F3** — now narrower than written: `singleTake` shipped as a toggle, duration is not going into the instruction at all, so what remains is stripping those bullets from guides.
4. **F1 / F2 prose edits** — deferred, not promoted. Measured as noise twice. Worth revisiting only bundled with samples.
5. **F5** — trims, lowest priority and most judgement-heavy.

~~Original (pre-measurement) order:~~

1. ~~**F2** — 17 mechanical edits, copy the paired phrasing from `flux1`. Highest yield per unit of effort.~~
2. ~~**F1** — rebalance guideline lines against the 3-cap.~~
3. ~~**F3 + F4** — fold variant and temporal facts into `buildInstruction`.~~
4. ~~**F6** — samples for `anima`, `sd1`, `flux1kontext`.~~
5. ~~**F5** — trim `anima` and `happyhorse`.~~

**Before any of it, run the F1 test** — same ecosystem, several different user prompts, and check whether the recommendations vary. It is one live call per prompt and it either confirms the largest finding or redirects the whole effort.

### F1 test — attempted, blocked on model access

Tried both routes to the analyzer with `ORCHESTRATOR_ACCESS_TOKEN`. Both fail, and neither failure is caused by the guides:

| Route                                                                                 | Result                                                                                              |
| ------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| Submit a `promptEnhancement` workflow (`POST /v2/consumer/workflows`)                 | HTTP 200, but the job fails **instantly** — `startedAt == completedAt`, `cost: 0`, no error message |
| Call the model directly (`POST /v1/chat/completions`, the path `civitai-llm.ts` uses) | **HTTP 500** `{"error":{"message":"Chat completion failed"}}`                                       |

What this does and does not tell us:

- **The workflow template is valid.** `?whatif=true` returns a well-formed workflow with status `unassigned`, so the step shape, the `promptEnhancement` `$type`, and the ecosystem key are all correct. The failure is downstream of validation.
- **It is not the payload.** The direct call 500s on a bare `{"model": <qwen3 urn>, "messages":[{"role":"user","content":"Say OK."}]}` — no schema, no guide, no sampling params. Also ruled out `chat_template_kwargs: { enable_thinking: false }`, which `civitai-llm.ts` already documents as a 500 on this proxy.
- **The likely cause is the credential**, not the model: the manager token carries no user or billing context, and the instant zero-cost job failure is what a funding/dispatch rejection looks like. Querying workflows by tag returned nothing, but that query is scoped to the token's own user, so it is not evidence either way about production.

**@dev: I meant by using `internalOrchestratorClient`, like we do in orchestrator.service.ts**

@ai: Checked, and the test was already using it. `internalOrchestratorClient` is `createOrchestratorClient(env.ORCHESTRATOR_ACCESS_TOKEN)`, and `createCivitaiClient` does exactly two things — set `baseUrl` and set `Authorization: Bearer <token>`. Its `env: 'dev' | 'prod'` field only picks a _default_ baseUrl when none is supplied, and `createOrchestratorClient` always supplies `ORCHESTRATOR_ENDPOINT` (`https://orchestration.civitai.com`, `ORCHESTRATOR_MODE=prod`). The raw fetch sent the identical host, token, and header.

**That removes the credential as an explanation**, and leaves the service itself. A bare `{"model": <qwen3 urn>, "messages":[{"role":"user","content":"Say OK."}]}` — no schema, no guide, no sampling params, no billing involved — returns HTTP 500 from prod. The workflow route failing instantly at zero cost is consistent with the same root cause.

So the earlier hedge is withdrawn: this is not a token problem, and prompt enhancement being down is the best-supported explanation, matching what you already suspected.

**What is needed to unblock:** prompt enhancement back up. No credential work required — rerun `scratchpad/f1.mjs` as-is.

**None of the F1–F6 findings depend on this.** They come from reading the corpus, and F2 in particular is 17 mechanical edits that need no model access. The test decides _how much_ F1 matters, not whether the other findings are real.

The harness is written and replicates `PromptEnhancementHandler`'s message construction verbatim (guide + `OutputFormatInstructions` as the system message, the user JSON, temperature 0.7, the strict `json_schema`). It runs as soon as a credential works.

## Per-request facts do not belong in guides

@dev: video guides should omit continuous-take advice; it belongs in the request payload.

Agreed, and it generalizes past that one bullet. A guide is static per ecosystem, but **duration is chosen per generation** — the user picks 4s or 15s from a slider. So every line like "Ensure temporal scope is realistic for the 4–15 second duration" is asking the analyzer to reason about a range when the actual value is already known and could simply be stated. Same for shot structure: whether cuts are acceptable depends on the chosen duration and the workflow, not on the ecosystem alone.

The payload already has the right vehicle. `PromptEnhancementInput` carries `instruction`, and `OutputFormatInstructions` tells the model to treat it as _the primary directive_. App-side, `buildInstruction` in `src/server/services/orchestrator/promptEnhancement.ts` already composes per-request directives this way — trigger words, snippet references, length caps. Adding the temporal facts there is the same pattern:

```text
The target clip is 6 seconds at 24fps. Keep the described action within that window.
This model renders a single continuous take — do not describe cuts between shots.
```

That reaches the analyzer as a concrete constraint rather than a range it has to guess within, and it stays correct when a model later gains multi-shot support — no guide edit needed.

Scope note: measured against the snapshot, **17** guides carry a hardcoded `Duration:` bullet, not the 10 first estimated — `hyv1`, `wanvideo14b_t2v`, `wanvideo14b_i2v_480p/720p`, `wanvideo-22-ti2v-5b`, `wanvideo-22-i2v-a14b`, `wanvideo-22-t2v-a14b`, `wanvideo-25-t2v`, `wanvideo-25-i2v`, `veo3`, `sora2`, `vidu`, `kling`, `ltxv2`, `ltxv23`, `seedance`, `minimaxh3`. Several also carry a matching _guideline_ line ("Ensure temporal scope is realistic for ~5 seconds"), so each guide needs two edits, not one. Plus the app change to emit the real values. Larger than the gap-filling work, and it should probably land first so new video guides are written in the right shape from the start.

## F1 test — run 2026-08-06. Confirmed, and the cause is not guideline count

Both routes that failed yesterday now work (workflow submit and direct `/v1/chat/completions`), so the test that the audit called a prerequisite has been run. Four fixed prompts — one bare (`a cat`), one keyword-style, two ordinary sentences — against three deployed guides, checking whether recommendations vary.

| Guide        | Flag-style lines | Recommendations across 4 prompts                                               |
| ------------ | ---------------- | ------------------------------------------------------------------------------ |
| `minimaxh3`  | 6                | **Identical themes 4/4** — camera direction, audio, action specificity         |
| `anima`      | 7                | **Near-identical** — quality tags 4/4, safety tag 3/4                          |
| `happyhorse` | 9                | **Varies** — camera 4/4, the rest prompt-specific; one response emitted only 2 |

F1's prediction holds for two of the three, but **flag-line count does not predict it** — the 9-bullet guide varied most and the 6-bullet guide was completely locked. The actual predictor is what the flag is conditioned on:

- **Unconditional absence checks dominate.** "Flag missing audio direction," "flag missing camera direction," "no quality tags," "no safety tag" all test for something a real user prompt essentially never contains. They fire on 100% of requests and consume the whole 3-slot budget before any prompt-specific observation is reached.
- **Prompt-conditional flags behave.** `happyhorse`'s "keyword list rather than natural prose" fired on the keyword prompt and stayed silent on the other three. That is the guide doing its job.

`happyhorse` returning 2 recommendations on a well-formed prompt also disproves the weaker worry that the model always pads to the cap.

**This makes F1's fix more targeted than the audit proposed** — move _unconditionally-firing absence checks_ out of `Guidelines:` into `Ecosystem-specific rules:`, rather than rebalancing every guideline line across 17+ guides. But see the next section: measured, that edit barely works.

### F1 vs F6, measured head-to-head — **the audit's priority order is backwards**

Three variants of the `minimaxh3` guide, 3 runs × 5 prompts each. Two of the five prompts already supply camera and/or audio direction, so a recommendation to add them is a measurable false positive — the guide talking past the prompt.

| Variant                                                  | Redundant recs | Avg recs/prompt | Over the 3-cap |
| -------------------------------------------------------- | -------------- | --------------- | -------------- |
| **A** — live guide                                       | 10/12          | 3.60            | 2/15           |
| **B** — F1 fix applied (absence checks demoted to rules) | 9/12           | 3.40            | 2/15           |
| **C** — B plus **one** few-shot sample                   | **3/12**       | **3.07**        | 1/15           |

**The F1 prose edit is within noise (10/12 → 9/12). One worked example does the work (→ 3/12).** The sample used is a prompt that already carries camera and audio, answered with three recommendations about what it genuinely lacks — i.e. it demonstrates the _judgement_ the prose was trying to describe. C also holds the 3-cap best, which B alone slightly worsened.

This inverts the audit's suggested order, which put F1 first (mechanical, 17+ guides) and F6/samples fourth. **F6 should be first.** The reasoning was there all along — 3B active parameters, prose instruction is weak, examples are strong — the ordering just didn't follow it.

Consequences:

- **Do not spend an edit pass on F1 across 17 guides.** Its measured effect on the guide it should help most is ~1 recommendation in 12.
- **F2 is untested and should not be assumed effective either.** It is the same kind of change — prose describing a behavior. Worth measuring before the 17-guide sweep, using the same setup.
- **The per-request facts work (F3/F4) is unaffected.** That fixes instructions the model provably cannot follow, which is a different failure from instructions it follows weakly.

Caveats, stated plainly: n=15 per variant on one ecosystem, one sample authored for the test, and the redundancy metric is a regex that counts "refine the camera direction you already have" as redundant. The A-vs-C gap is far larger than those sources of error; the A-vs-B non-gap is the more fragile claim, though A was 4/4 redundant on every single one of four earlier runs.

### Draft fixes applied — and re-measured, with mixed results

D1–D6 were fixed in the drafts above and the same four prompts re-run (n=1 per draft, so read these as signals, not measurements).

| Finding                                          | Outcome                                                                                                                                                                                                                     |
| ------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1 `mai` rationale leaking into `enhancedPrompt` | **Fixed** — gone from all four                                                                                                                                                                                              |
| D4 `boogu` aspect ratio written into prompt text | **Fixed**                                                                                                                                                                                                                   |
| D6 `mageflow` unconditional layout flag          | **Fixed** — no aspect-ratio flags at all now                                                                                                                                                                                |
| D2 `mai` over-cap + template restated            | **Not fixed** — still returned 4 recommendations, the fourth being "Ensure the prompt follows the layering order…". The source is the `Layer detail in this order` _rules_ bullet, not the guideline line that was removed. |
| D3 `boogu` phantom negative-prompt advice        | **Not fixed** — still recommended "Include a negative prompt to exclude unwanted elements" on a bare prompt                                                                                                                 |

Two new regressions, both introduced by the fixes:

- **`mai` now recommends setting an aspect ratio** (2 of 4 prompts) — the strengthened "never write an aspect ratio into the prompt" bullet made the topic salient enough to become a recommendation. The bullet fixed the leak and created a flag.
- **`mageflow` emitted a populated `enhancedNegativePrompt`** (`"daylight, … no reflections, no neon lights, no people"`) on a model whose guide says NO negative prompts — and phrased with the exact `no X` construction the guide prohibits.

**This is the F1/F6 result reproducing on new text.** Prose edits moved three findings and broke two others, which is what "within noise" looks like up close. The drafts should not deploy on prose alone: `mai`, `boogu` and `mageflow` each need a sample demonstrating the behaviour, and a re-measure with n>1.

### F6 pilot on `minimaxh3` — samples work, and they cost something

Ran the sample loop end to end on `minimaxh3` (the only guide with a baseline). 30 analyzer calls per arm — 6 runs × 5 prompts — via `measure.mjs --samples`.

Every arm is **30 analyzer calls** — `--runs 6` × 5 prompts — with the live baseline re-scored inside the same invocation.

| Arm                   | Redundant       | Baseline that run | Over the 3-cap |
| --------------------- | --------------- | ----------------- | -------------- |
| Live guide            | —               | 19–21/24          | 0, 1, 6 /30    |
| Candidate guide alone | 18/24           | 20/24             | 2/30           |
| Live + **1 sample**   | 12/24           | 21/24             | 5/30           |
| Live + **2 samples**  | **10/24 (42%)** | 21/24             | 4/30           |
| Candidate + 2 samples | 11/24           | 19/24             | 5/30           |

**Samples roughly halve redundancy, ~83% → ~42%.** Reproduced across five measurements at two sample sizes.

> **Retracted — the corpus was the problem.** Every number in this section was measured on a
> five-prompt set hardcoded in `measure.mjs`, four of which carried camera and/or audio
> direction. Those are exactly the two dimensions `minimaxh3`'s guide flags unconditionally, so
> the corpus was unintentionally built around the guide's specific failure. See
> [Re-baselined on a generic corpus](#re-baselined-on-a-generic-corpus) below — on 30 generic
> prompts the same guide baselines at 44%, not 83%, and the sample's effect drops into the noise.
> The findings about _what the guide does wrong_ still stand; the _magnitudes_ here do not.

**Everything else is noise, including two things this doc previously asserted:**

- **The prose fix does nothing, with or without samples.** Alone: 20/24 → 18/24. On top of samples: 11/24 against 10–12/24 for samples alone — indistinguishable. The `minimaxh3` candidate guide is therefore **optional**, worth keeping only because it also removes the F4 self-contradiction, not because it measures better.
- **~~Samples degrade cap adherence~~ — retracted.** Over-cap read 0–1/30 without samples and 4–5/30 with them across two configurations, which looked conclusive enough that it was written into `SKILL.md` as guidance. Then an unchanged live guide scored **6/30 on its own**. The effect was inside the baseline's own variance. It surfaced only because `measure.mjs` re-scores the baseline every invocation — comparing against a remembered baseline number would have shipped it as a finding.

The two samples and the candidate guide are in [docs/prompt-analysis-samples/](prompt-analysis-samples/README.md), pending sign-off.

#### Re-baselined on a generic corpus

@dev: We probably need a long list of generic prompts/negativePrompts of varying lengths to test against. I say generic list because each ecosystem should enhance/modify the output differently.

@ai: Right, and building it invalidated the headline result above.

The old corpus was five prompts hardcoded in `measure.mjs`, written while investigating `minimaxh3` — so four of them carried camera and/or audio direction, the two things that guide flags unconditionally. Measuring that guide against that corpus is close to circular: it was a test built from the answer.

The corpus now lives in [`prompts.json`](../.claude/skills/add-prompt-enhancement-guide/prompts.json) — **30 generic prompts** spanning micro (`"loneliness"`, `"a cat"`) through long structured prose, covering tag-style and natural-language forms, weight syntax, inline negative phrasing, supplied `negativePrompt` fields, text-rendering requests, and edit-style instructions. Each is annotated with what it already supplies across seven dimensions (subject, lighting, camera, composition, style, audio, negative), and `--modality image|video` filters video-only concepts out of image runs. A single run now scores 42 dimension-tags, against 24 for six runs of the old set.

Same guide, same samples, generic corpus:

| Arm                  | Calls/arm | Redundant | Rate |
| -------------------- | --------- | --------- | ---- |
| Live guide           | 46        | 37/84     | 44%  |
| Live + **2 samples** | 46        | 31/84     | 37%  |
| Live guide           | 92        | 67/168    | 40%  |
| Live + **2 samples** | 92        | 61/168    | 36%  |

**The 83% baseline was an artifact, and the sample's effect does not survive the corpus change.** Doubling to 92 calls per arm left the absolute delta at 6 while the denominator doubled — 7% became 3.6%, which is the signature of an effect at or near zero rather than one waiting for more samples to confirm it.

Two readings, and they are not distinguishable from here:

1. **These samples genuinely do not help much.** Plausible: they teach one narrow judgement (don't recommend what the prompt already has) and the generic corpus mostly probes other things.
2. **The metric cannot see the improvement.** Also plausible: it scores "refine the lighting you already have" as redundant, and that false-positive rate now compounds across seven dimensions where it applied to two. A ~40% floor that barely moves for _any_ arm is what a metric dominated by false positives looks like.

Deciding between them needs either a sharper metric or hand-scoring a sample of output. Until then the honest position is **no measured support for samples**, not "samples work".

What survives: the _qualitative_ findings, which came from reading output rather than counting it — D1's rationale leaking into `enhancedPrompt`, D3's phantom negative-prompt advice, `mageflow` emitting a negative prompt on a model with no negative field. What does not survive: any claim that samples halve redundancy. **Nothing should deploy on the strength of the retracted numbers.**

#### Hand-scoring the output — the metric was measuring the wrong thing

With every intervention reading as noise, the next step was to stop counting and read. Dumped both arms of a `minimaxh3` run (46 responses, 141 recommendations, `measure.mjs --dump`) and went through them.

The failure is unmistakable once seen, and it is **not** redundancy. Across 23 unrelated prompts — `"a cat"`, `"loneliness"`, a fully specified 400-character cartographer scene — the live guide recommends:

| Topic   | Share of prompts |
| ------- | ---------------- |
| audio   | **100%** (23/23) |
| camera  | **96%** (22/23)  |
| subject | 65%              |
| beats   | 43%              |

**Two of the three recommendation slots are spent before the prompt is read.** The guide gives the same two pieces of advice to everything. That is F1 exactly as first hypothesised, and it was invisible to the redundancy metric, which only fires in the special case where the prompt happens to already contain the thing being recommended — a small subset of "advises the same thing regardless".

This explains the ~40% redundancy floor that would not move. Redundancy was a weak proxy measuring a sliver of the real effect, so interventions that genuinely changed behaviour still looked like noise.

`measure.mjs` now reports **topic concentration** as its primary metric, with a saturation line at 80%, and keeps redundancy as a secondary figure. The verdict line judges on whether a topic came _unsaturated_, which is the outcome that actually matters.

**The samples work — on this metric.** Confirmed at 46 calls per arm:

| Topic            | Live guide | + 2 samples |
| ---------------- | ---------- | ----------- |
| audio            | **98%**    | 70%         |
| camera           | **89%**    | **83%**     |
| lighting         | 28%        | 41%         |
| subject          | 48%        | 48%         |
| Saturated topics | **2**      | **1**       |
| Redundancy       | 30/84      | 28/84       |

Audio fell 28 points and came out of saturation; the freed slot went to lighting, which is prompt-responsive rather than reflexive. Redundancy moved 2/84 — it simply cannot see a change this large, which is the clearest possible demonstration that it was the wrong instrument.

**This also un-retracts the prose fix, provisionally.** The `minimaxh3` candidate guide exists specifically to move camera and audio out of `Guidelines:` into the rules block, and camera is the one topic still saturated. It was dismissed twice on the redundancy metric, which we now know was blind to exactly this. Re-measuring it on concentration is the obvious next test, and the result is pending.

**The general lesson, which is worth more than the `minimaxh3` result:** the first four rounds of this investigation optimised against a metric that could not see the failure being chased. Every conclusion drawn in that period — prose does nothing, samples do nothing, the model might be the problem — was an artifact of the instrument. Reading 141 recommendations by hand took one pass and found in minutes what six measurement rounds had missed.

#### Validating the sample content against sources — one claim was understated, one was right

@dev: I don't know that anyone on our team can properly review the h3 samples. This is something that I would prefer you to determine by finding good examples online. Huggingface is usually an authoritative source.

@ai: Done, and it changed the samples. **H3 launched 2026-07-31, after my training cutoff**, so the first draft was written from generic video-model instinct rather than knowledge of this model — exactly the failure mode `SKILL.md` warns about for guides written without source material.

**Claim: "a held pose reads as a still image with motion; give it one beat of change." Correct, but far too weak.** The real behaviour is that a single-moment description gets _averaged across the whole take_, and the fix is explicit timestamped ranges, not merely "some change":

> "You asked for ten seconds and described one moment, so you get one slow push-in stretched over ten seconds." — Atlas Cloud, reverse-engineered from MiniMax's own 45 example prompts
>
> Weak: "She picks up the bottle." Strong: "0–5s she moves along the benches, 5–10s she lifts it into the light, 10–15s she sets it down." … "Timed beats give MiniMax H3 an order to follow across the full 5–15 second generation instead of averaging the motion." — Mixio

**Claim: "name wardrobe and props so they stay stable." Correct, and the live guide already had it.** The distinction that matters is that identity and wardrobe behave differently:

> "Faces and hair held across every reference test, but wardrobe drifted. A navy canvas jacket came back as denim in both arms. Name the garment in the prompt as well as showing it."

So face/identity is a job for a reference image and text will not hold it, while wardrobe and props drift _even with_ a reference and must be named in text. The existing guide's References bullet says exactly this; it is corroborated, not invented.

**A third finding, not previously in the guide: audio wants entry points, not just a list.** "at 6 seconds the jazz bass groove joins, the last 2 seconds lock it with a tense chord" is the attested level of precision.

Changes made: both samples rewritten around explicit `0-4s / 4-9s / 9-12s` ranges; the candidate guide gains a Timed beats rule (replacing the arithmetic bullet F4 removed — **F4 was right that the arithmetic was bad and wrong to leave nothing in its place**), audio-entry-point guidance, and wardrobe promoted into the prompt template.

Sources: [Atlas Cloud](https://www.atlascloud.ai/blog/guides/minimax-h3-prompt-guide), [Mixio](https://mixio.studio/hailuo-h3-prompt-guide), [HuggingFace overview](https://huggingface.co/blog/ResterChed/minimax-h3-hailuo-3-0), [Runware reference-driven consistency](https://runware.ai/docs/models/minimax-h3/guides/reference-driven-consistency).

#### Result: the research-corrected guide + samples clears both saturated topics

46 calls per arm, baseline re-scored in the same invocation.

| Topic                | Live guide | Corrected guide + samples |
| -------------------- | ---------- | ------------------------- |
| camera               | **98%**    | 65%                       |
| audio                | **98%**    | 65%                       |
| temporal             | 35%        | 65%                       |
| subject              | 37%        | 43%                       |
| lighting             | 35%        | 37%                       |
| **Saturated topics** | **2**      | **0**                     |
| Redundancy           | 36/84      | 28/84                     |

Camera and audio each fall 33 points and clear the saturation line, so no topic is now firing regardless of the prompt. `temporal` rising 30 points to 65% is the timed-beats research landing — the highest-value thing an H3 prompt can carry, previously recommended on a third of prompts and now on two thirds, still below saturation and therefore responding to input rather than reflex.

**Note which parts contributed.** The samples alone took saturated topics 2 → 1 (audio only). Clearing camera as well needed the guide edit that moves camera out of `Guidelines:` into the rules block. So the prose fix does work — it was never measurable on the redundancy metric because that metric was blind to the entire effect. **The earlier retraction of F1 was itself wrong**, and for the same reason every other conclusion in that period was wrong: the instrument, not the intervention.

#### Deployed 2026-08-06 — the confirmation run weakened the claim, and two `manage.mjs` traps

**The confirmation did not reproduce the headline.** Run 1: saturated 2 → 0 (camera 98→65, audio 98→65). Run 2: saturated 2 → **1** (camera 96→78, audio 96→**83**). Every topic moves the right way in both runs and it is never worse than baseline, so _reduces_ saturation is supported and _eliminates_ it is not — the 2 → 0 was the optimistic tail.

Deployed anyway, on the weaker claim, after verifying the revert path: the backup's stored guide byte-matches what was live. `minimaxh3` now carries the corrected guide (3722 chars) and 2 samples, verified field-by-field against the source files.

Two `manage.mjs` behaviours made a successful deploy look like a failed one:

- **`put` wipes samples.** `SKILL.md` claimed it preserves them unless `--clear-samples` is passed. It does not — a `put` run immediately after a successful `set-samples` left the ecosystem on 0 samples and said so in its own success line (`0 sample(s)`). **Order is `put` first, then `set-samples`.**
- **Writes propagate slowly, so the built-in readback verification lies in both directions.** A `GET` straight after the "verified" `put` returned the _old_ 3437-char guide; a later `set-samples` printed `✗ readback does not match what was sent` for a write that had in fact landed. Believe `status` after a pause, not the immediate readback. Acting on either signal would have meant re-running a write that already succeeded, or reverting one that was fine.

Both are now documented in `SKILL.md`. Standing caveat on the numbers above: `over-cap` read 5/46 against 0/46 on the baseline, but over-cap has swung 0–6/30 on an unchanged guide, so it is not a signal at this resolution.

Both retractions above came from the same cause: **three runs is not enough to deploy on.** The prose-plus-sample combination measured 3/12 twice at `--runs 3` and read as a real compounding effect; at `--runs 6` it was indistinguishable from samples alone. Over-cap looked like a clean 5× regression until a sixth baseline run landed at 6/30. Use `--runs 6` for anything headed to production and treat `--runs 3` as a smoke test. `measure.mjs`'s verdict line now scales its noise threshold to the sample size rather than using a fixed count.

One correction worth recording separately: the candidate guide had replaced the hardcoded duration bullet with "keep the action within the clip length given in the request" — a clip length that **is not in the request**. That is the F3 error, committed while writing the fix for F1. It now reads as a pacing property with no reference to a value the model cannot see.

### Does this mean a different analysis model?

**No — and this test is the argument.** A model that produced 83% redundant recommendations because of a capability ceiling would not drop to 25% because one example was added ahead of the request. The failures measured here are all authoring failures: absence checks that fire unconditionally, guides narrating their own rationale (D1), instructions conditioned on facts not in the payload (F3/D3). Qwen3.6-35B-A3B is doing what it was asked to do. Revisit only if samples are in place on the worst guides and the redundancy floor stays high.

### The five undeployed drafts, tested the same way

The drafts (`mai`, `mageflow`, `boogu`, `wanvideo27`, `wanimage27`) were never exercised — they exist only in this doc. Rather than deploy unsigned-off guides into the registry, they were run against the analysis model directly with the draft as system prompt. **Caveat: this approximates `PromptEnhancementHandler`** — the output-format preamble and `json_schema` are reconstructed, `enable_thinking:false` is not set, and there is no `instruction` channel. Findings about _guide content_ are sound; findings about _output shape_ are weaker evidence.

- **D1 — `mai` leaks its own rationale into `enhancedPrompt`.** One response ended: _"…casting long, soft shadows across the wooden floorboards. The lighting is the highest-leverage addition, defining the mood and texture."_ That last sentence is the guide's justification, and it would be sent to the image model as prompt text. The guide's phrase "highest-leverage" needs to stop being addressed to the reader.
- **D2 — `mai` broke the 3-cap**, returning 4 recommendations, the fourth being _"Ensure the prompt follows the recommended structure"_ — the template restated at the user. Same root cause as D1: the guide describes its own machinery in language the model can echo.
- **D3 — F3 confirmed live on `boogu`.** The variant-conditional negative-prompt bullet was argued safe because `negativePrompt` tells the model which case it is in. It is not: one response spent an `issues` slot on _"No negative prompt was supplied, so none is analyzed or generated"_ — zero information — and another recommended adding a negative prompt, which the Turbo variants do not accept. The conditional phrasing did not rescue it; route the variant through `buildInstruction` as F3 already proposed, or drop the bullet.
- **D4 — `boogu` wrote `16:9 aspect ratio` into `enhancedPrompt`.** A generation parameter, not a prompt token.
- **D5 — `wanvideo27` reproduces its example negative byte-identically** in every response (3/3), including when the user supplied none. `wanimage27` does the same but at least extended it once. Defensible as a default; worth deciding deliberately rather than by accident.
- **D6 — `mageflow`'s extreme-aspect-ratio bullet is an unconditional absence check**, the exact F1 pattern. Its guideline says to flag missing layout direction _"when the composition implies an extreme aspect ratio"_; none of the four test prompts did, and it flagged 3/4 anyway. Fix before deploying, not after.

`mai`, `mageflow` and `wanimage27` are otherwise sound — dense, on-template, faithful to the original intent. `wanvideo27` is fine apart from D5.

Infra note: 1 of 20 direct calls returned `504 Request timed out`. Transient, unrelated to guide content.

## The `instruction` channel — and why it is not F1

@dev: When I submit a prompt enhancement request, I include extra instructions. You mentioned that you might need to reduce the number of instructions in the prompt guides. Does that mean that extra instructions from the user might be detrimental?

@ai: No — not in the F1 sense. The two are different mechanisms, and the instruction channel is the _stronger_ one.

F1 is not "too many instructions" in general. It is specifically **competing output-shaping invitations under a cap**: nine `Flag …` lines in `happyhorse` each inviting a recommendation, against one line saying "pick 3." That is a triage problem, and triage is what a 3B-active model does worst.

A per-request `instruction` differs structurally:

1. **It is explicitly ranked above the guide.** `OutputFormatInstructions` says _"If `instruction` is present, follow it as the primary directive for how to enhance the prompt."_ It does not compete on equal footing — it wins.
2. **It rides in the user turn, not the system turn.** It is a field in the user JSON, so it is the last thing before generation. That position carries more weight, not less.
3. **It is concrete rather than conditional.** "Preserve these exact trigger words: X" needs no relevance judgement; "flag missing camera direction" does.

This is exactly why moving duration and variant facts into `buildInstruction` is the right call — it is the reliable channel.

### The real hazard: instructions outrank hard constraints

Because the instruction is the primary directive, an instruction that contradicts a **capability** rather than a preference wins and produces an unusable prompt. "Use weight syntax to emphasise the lighting" beats `flux1`'s `NO weight syntax … completely ignored`, and the analyzer will happily emit syntax the target model discards. Same shape for asking for a negative prompt on an ecosystem that has no negative field.

Two smaller frictions:

- **"Primary directive" is singular; the field is a stack.** `buildInstruction` concatenates trigger words, snippet references, a length cap, the user's text, and segmentation formatting — up to six directives, all carrying that one label.
- **`instruction` is `z.string().nullish()`** — no length limit. A long instruction can outweigh the guide entirely.

### Consequence for F3/F4

Duration and variant facts moved into `buildInstruction` would land in the same undifferentiated blob as the user's free text, where a user instruction could override a hard capability fact ("this model renders a single continuous take"). **Capability facts need to be framed as constraints distinct from user preferences** — not appended as more peer lines. Worth deciding the shape before that change lands.

## Capping the enhanced prompt length

@dev: How would we handle capping the prompt length?

@dev: We have a generalized hard cap of 6000 characters for the prompt length. I want all the enhanced prompt to follow that guideline.

@ai: Understood — **6000 stays uniform across every ecosystem**; the earlier suggestion to vary it per ecosystem is dropped. The job is making that one number actually hold. (Separate and unchanged: some models truncate well below 6000 — `flux1kontext` at 512 tokens — but that is a prompt-quality matter for those guides, not a cap question.)

Today the only mechanism is asking the model: `buildInstruction` appends `The enhanced prompt must not exceed 6000 characters.` **Nothing enforces it.** `enhancedPrompt` is applied straight to the form (`form.setValue('prompt', …)`, `graph.set({ prompt })`) with no check, while the prompt node is `z.string().trim().max(maxLength, '… is too long')`. An over-length result therefore fails validation **at submit — after the user has already paid for the enhancement.**

Asking is also the weakest possible enforcement: character counts are the one unit an LLM cannot evaluate about its own output.

### Post-hoc truncation — proposed, written, rejected

A boundary-truncating guard in `PromptEnhancementHandler.UpdateOutputAsync` was written and then reverted.

@dev: I don't see how that c# change actually helps. It just checks the result of the prompt enhancement. We can revert that.

@ai: Agreed, and the objection is right. Truncating a 12,000-character response to 6,000 does not produce a good prompt, only a differently bad one — the user still gets something that does not reflect their intent, and now it has been silently cut. It treats the symptom, and it was proposed with **no evidence that over-length output happens at all**. 6,000 characters is enormous for a generation prompt; the guard could well be dead code. Building enforcement machinery before measuring the failure was the wrong order.

Reverted; `civitai-orchestration` is clean. **No orchestrator change is needed for prompt length.**

### What actually remains

Everything left is pre-generation and lives in this repo:

**1. Measure first.** The F1 test returns real enhanced prompts, so the length distribution comes free with it. If nothing approaches 6,000, there is no problem to solve and the remaining item below is also unnecessary.

**2. Give the model a target it can act on.** The current line — `The enhanced prompt must not exceed 6000 characters.` — asks for compliance in the one unit an LLM cannot evaluate about its own output. A word target (~800 words, comfortably under 6,000 characters) is something it can approximate. This is a wording change in `buildInstruction`, nothing more.

**3. Then reconsider whether the line belongs at all.** It is appended to _every_ request, spending instruction budget — the F1 problem — on a limit that may never bind.

**Not `max_tokens`.** Under the strict `json_schema`, hitting the ceiling truncates the JSON mid-string, so the response fails to parse and the whole enhancement is lost rather than shortened.

## Shipped: a `singleTake` toggle for video

@dev: Can we add something to the prompt enhancement schema and ui so that users who are generating video can toggle if they prefer the output to be continuous/single take?

@ai: Done — this is the first concrete piece of the F3/F4 idea, and a good one to start with because shot structure is a _user preference_ rather than a capability fact, so it sidesteps the precedence question still open below.

| Layer       | Change                                                                                  |
| ----------- | --------------------------------------------------------------------------------------- |
| Schema      | `singleTake: z.boolean().nullish()` in `promptEnhancement.schema.ts`                    |
| Instruction | `buildInstruction` emits a directive for **both** states                                |
| UI          | `EnhanceTab` checkbox, `localStorage`-backed like `segmentPrompt`, shown only for video |

Three decisions worth recording:

- **Both states emit a directive**, rather than only `true`. Had `false` emitted nothing, unchecking the box would appear to do nothing — five guides (`hyv1`, `veo3`, `seedance`, `happyhorse`, `minimaxh3`) already advise single takes in their own text, so the guide would simply reassert it. `false` therefore says cuts are acceptable.
- **`null` for image ecosystems.** The value is only sent when the ecosystem is a video one (`getGenerationEcosystemsForMediaType('video')`), and `buildInstruction` skips the whole block on `null` — no stray shot-structure directive in front of an image request. This matters more than usual given F1: every unused line is instruction budget spent for nothing.
- **Defaults to on**, matching what nearly every current video model actually does. Wan 2.7 is the exception that makes the toggle worth having.

Follow-on, not done: this makes the shot-structure bullets in those five guides redundant, and they should be stripped once the toggle ships — the same cleanup the duration bullets need.

**Caveat.** On a model that only renders single takes, unchecking asks for something it cannot deliver. That is the user's explicit choice and the guide still advises against it, but it is the exact failure mode the F3/F4 precedence question is about: nothing currently distinguishes a user preference from a hard capability.

## Fixed: enhanced prompts collapsing onto one line

@dev: For breaking the prompt into segments, I don't know if that is necessary. What I really want is for the enhanced prompt to not put everything on one line. It makes it hard to read. Sometimes I organize a prompt in a way that is easy to edit, and then the prompt enhancement removes my formatting.

@ai: Two separate problems, and `segmentPrompt` was conflating them. The old code was six lines with three defects:

```ts
if (input.segmentPrompt) {
  /* thematic segments */
} else if (input.prompt.includes('\n')) {
  parts.push('If possible, try to maintain the original formatting.');
}
```

1. **No formatting directive at all in the common case.** A one-line prompt with the toggle off produced _nothing_ — so the analyzer had no reason not to return a wall of text. That is the readability complaint, and it was never a segmentation problem.
2. **The preservation directive was maximally hedged** — "If possible, try to". That is an F2-class defect: an instruction written as a suggestion. On a 3B-active model it carries close to no weight, which is why hand-formatting disappeared.
3. **`else if` dropped preservation entirely when segmenting was on** — formatting _and_ segments was an unreachable combination.

Now three explicit branches: explicit segmentation → preserve the user's own line structure → readable multi-line default. Preservation is stated as a requirement (`Do not collapse it onto one line`) rather than a hope.

**`segmentPrompt` is now arguably redundant** and its checkbox has been relabelled to say so — enhanced prompts are multi-line by default and user formatting is kept, so the toggle only earns its place for people who actively want the prompt _restructured_ by theme. Worth deleting outright if nobody uses it; left in place for now because removing a shipped toggle is a product call, not a cleanup.

## Shipped: `buildInstruction` extracted + tested, and duration plumbed through

**Extraction.** `buildInstruction` and `collectSnippetTokens` moved to `promptInstruction.ts`. They lived alongside `submitWorkflow`, `auditPromptServer`, and `getWorkflowCallbacks`, so any test of this pure function dragged in the orchestrator client, env, logging, and metrics — the transitive-import trap CLAUDE.md documents, whose recommended fix is exactly this extraction. `promptEnhancement.ts` re-exports for external callers (there were none in `src/`, only doc references).

**Tests.** 15 cases in `__tests__/promptInstruction.test.ts`, covering the three behaviour changes made this session plus the pre-existing preservation logic. The one worth keeping: _"always emits exactly one formatting directive"_ — it walks all four combinations of `segmentPrompt` × multi-line prompt and asserts the branches stay mutually exclusive, which is the invariant the old `else if` broke.

**Duration — built, then reverted.** Threaded through all five layers, then removed.

@dev: I don't think duration belongs in the prompt. Duration is a separate part of a generation request.

@ai: Right, and this corrects a mistake in the analysis further up this document. The "per-request facts do not belong in guides" rule answers _where_ a fact should live; it does not establish that the fact is worth sending at all. I applied it to duration without asking the prior question, and inherited the premise from the very guide bullets I was criticising.

Duration is not encoded in the prompt — it is a separate generation parameter, and the model renders N seconds regardless of what the text says. The only mechanism by which telling the analyzer would help is it choosing to describe fewer action beats for a short clip. That is a small effect, unmeasured, and it costs a line on every video request — against an F1 finding that says the instruction stack is already oversubscribed. A new line held to the same standard as the nine `Flag …` lines being cut from `happyhorse` does not survive.

**This changes the guide cleanup**: the duration bullets in those 17 guides should be **deleted outright**, not relocated to `buildInstruction`. Removing a wrong instruction is simpler than replacing it with an unproven one.

`fps` was never added — only `wan-graph.ts` exposes it, so there was no general source to read from.

### Verification

`pnpm install` was run in this worktree (it had no `node_modules`, which is also what broke the orchestration skill's `dotenv` earlier). Everything below now passes:

| Check                                       | Result                                                                 |
| ------------------------------------------- | ---------------------------------------------------------------------- |
| `promptInstruction.test.ts`                 | 15/15 pass, 1.5s import — confirms the extraction shed the heavy graph |
| `pnpm typecheck`                            | 0 errors                                                               |
| `eslint` (changed files)                    | 0 errors; 2 pre-existing `any` warnings in untouched `catch` blocks    |
| `prettier --check`                          | clean                                                                  |
| `vitest run` (orchestrator + blocks router) | 21 files, 516 tests pass                                               |

Per CLAUDE.md's worktree rule, `blocks.router.workflow.test.ts` was checked for silent collection failure: it collected **314 tests**, so the run is trustworthy.

## Gaps

### A missing guide is not neutral — it serves image advice

13 registered ecosystems have no guide of their own and fall through to `DefaultSystemPrompt`: `wanimage27`, `wanvideo27`, `ace`, `hidream-o1`, `mai`, `boogu`, `polygen`, `ltxv`, `wanvideo`, `mageflow`, `tripo`, `hunyuan3d`, `ideogram`. That default opens _"You are a prompt engineering expert for AI image generation"_ and its guidelines talk about lighting, composition, and SD1 weight syntax.

In scope, that means `wanvideo27` and `wanvideo` (video) are not merely un-tuned — they are being told to optimize an image prompt. That raises the priority of the remaining video guides from "nice to have" to "currently wrong."

It is also an argument for a neutral fallback: the default could drop its image framing without hurting any image ecosystem, since every one of those has its own guide anyway. That matters more now that 3D and audio are deliberately staying on the fallback forever — `ace` and `tripo` will keep receiving image advice unless the default stops assuming images.

One piece of good news from the same snapshot: six entries showed `x-ai/grok-4.1-fast`, but all six were default-guide entries — never configured, so `State.ModelId` was null and they were _inheriting_ the const. PR #297 healed all of them automatically. No stored grok binding survives.

### Ecosystems with no guide

Filtered to ecosystems that actually have `supportType: 'generation'` — nothing else can produce an enhancement request. That filter matters: `ideogram` is registered and looks like a gap, but has no generation support, so it is **not** worth writing.

### Batch 1 — siblings of existing guides (5)

| Key          | Basis                                                                       | Status             |
| ------------ | --------------------------------------------------------------------------- | ------------------ |
| `wanvideo27` | Wan 2.7 video; `wanvideo-25-*` guides exist                                 | draft below        |
| `wanimage27` | Wan 2.7 image                                                               | draft below        |
| `wanvideo`   | root WanVideo → maps to **Wan 2.1** via `extraEcosystems` in `wan-graph.ts` | needs confirmation |
| `ltxv`       | LTXV root; `ltxv2`/`ltxv23` guides exist                                    | needs confirmation |
| `hidream-o1` | `hiDreamO1Graph` exists; `hidream` guide exists                             | needs confirmation |

Wan 2.7 is genuinely different from 2.5 rather than a rename — it adds audio input, multi-shot, video editing, and a wider duration range — so these are written from the graph, not copied.

### Batch 2 — sourced (3, was 4)

@dev: I'm not sure what source materials to use for those items. Online sources where possible?

@ai: Found them, and one item dropped out. **`mochi` needs no guide** — its `supportType: 'generation'` entry is commented out in `basemodel.constants.ts`, so it cannot produce an enhancement request. It was never registered either, which is consistent.

The remaining three all turned out to share a shape worth noting: **each is one ecosystem key covering both a txt2img and an `img2img:edit` workflow**, with different build options per workflow. So each guide has to serve generation _and_ instruction-editing, the way `flux1kontext` serves editing alone.

Sources used — upstream for prompting behavior, our own graph files for what the form actually exposes (the graphs are authoritative and beat any blog post on negative-prompt and ratio support):

| Key        | Model                                     | Upstream                                                                                                                                                                       | In-app               |
| ---------- | ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------- |
| `mai`      | Microsoft MAI-Image-2.5                   | [Promptslove guide](https://promptslove.com/blog/mai-image-2-5-prompting-guide/), [3DAI Studio](https://www.3daistudio.com/blog/mai-image-2-5-microsoft-image-model-explained) | `mai-graph.ts`       |
| `mageflow` | Microsoft Mage-Flow (4B MMDiT)            | [microsoft.github.io/Mage/flow](https://microsoft.github.io/Mage/flow/), [github.com/microsoft/Mage](https://github.com/microsoft/Mage/tree/main/mage_flow)                    | `mage-flow-graph.ts` |
| `boogu`    | Boogu-Image-0.1 (Apache-2.0, 10B unified) | [HF model card](https://huggingface.co/Boogu/Boogu-Image-0.1-Base), [arXiv 2607.13125](https://arxiv.org/abs/2607.13125)                                                       | `boogu-graph.ts`     |

Facts the graphs settled that the write-ups did not:

- **`mai` has no negative prompt, no CFG, no steps.** `mai-graph.ts` says so explicitly. Ten fixed aspect ratios; edit workflow takes exactly one reference image, cropped to a supported ratio.
- **`mageflow` has no negative prompt either.** Native resolution 512–2048, and the ratio list includes the 4:1 / 1:4 extremes.
- **`boogu`'s negative prompt is variant-dependent** — merged into the Base and Edit subgraphs, absent from Turbo and Edit Turbo. That is a real prompting rule, not trivia.

#### A note on variant-specific advice

The Turbo/Standard split is chosen _per generation_, so by the rule established above it is per-request information and does not belong in a static guide. Two of these drafts brush against it:

- **`boogu`** — stated conditionally ("if a negative prompt was supplied…"). Safe, because the payload's `negativePrompt` field tells the model which case it is in; it is not being asked to guess. `hidream` already sets this precedent with its Full vs Dev/Fast split.
- **`mageflow`** — I left the Turbo/Standard prompt-length difference **out** of the draft rather than hardcode it. It belongs in `buildInstruction` alongside the video temporal facts, once that lands.

## Draft — `mai`

```text
You are a prompt engineering expert for MAI-Image-2.5 (Microsoft), an image generation and editing model. Analyze the user's prompt and provide structured feedback.

Ecosystem-specific rules:
- Prompt style: Natural language, descriptive sentences — not tags. Layer detail in this order: subject and materials, then context and composition, then lighting, then style.
- No weight syntax.
- NO negative prompts, no CFG, no step count. Anything the user wants excluded has to be phrased positively in the prompt itself.
- The enhanced prompt always names the key light's direction and quality — "low golden-hour light from camera left, soft shadows" — rather than leaving lighting implied by a time of day.
- Aspect ratios: 21:9, 16:9, 3:2, 4:3, 5:4, 1:1, 4:5, 3:4, 2:3, 9:16. Chosen in the form; never write an aspect ratio into the prompt text.
- Text rendering is a strength. Put exact strings in single quotes and state placement, relative size, and weight — "bold white uppercase sans-serif text 'OPEN LATE' centered across the top third."
- Editing (a reference image is supplied): name one element and one change. The model holds the rest of the frame with correct lighting and shadows, so re-describing the whole scene works against it. Close the instruction with what must not change — "keep the subject, pose, and shadows exactly as they are."

Guidelines:
- Identify vague or overly generic descriptions
- For edits, flag prompts that re-describe the whole scene instead of naming a single change, and flag missing preservation statements
- Flag exclusions phrased as negatives ("no people in frame") and rewrite them positively, since there is no negative prompt
- Limit recommendations to the 3 most impactful improvements
- The enhanced prompt should be a single, ready-to-use prompt that stays faithful to the user's original intent
```

## Draft — `mageflow`

```text
You are a prompt engineering expert for Mage-Flow (Microsoft), a native-resolution image generation and editing model. Analyze the user's prompt and provide structured feedback.

Ecosystem-specific rules:
- Prompt style: Natural language, densely descriptive. The prompt encoder is Qwen3-VL, so long structured prose is followed well. Cover subject, scene, camera, style, layout, and any hard constraints.
- No weight syntax.
- NO negative prompts. Exclusions must be phrased positively — "an empty street at dawn" rather than "no people."
- Native resolution runs 512-2048 on any aspect ratio, including the 4:1 and 1:4 extremes. When the user's own prompt states or implies a panoramic or column format, the enhanced prompt says where elements sit along the long axis; the model will not infer a panoramic layout from a subject description alone. When the user says nothing about format, do not raise it — the ratio is chosen in the form, and it never belongs in the prompt text.
- Text rendering is a strength. Quote exact strings and state where they sit.
- Editing (a reference image is supplied): instruction-based. Describe the change to apply, not the finished scene.

Guidelines:
- Identify vague or overly generic descriptions
- For edits, flag prompts that describe the whole scene instead of the change
- Flag exclusions phrased as negatives and rewrite them positively
- Limit recommendations to the 3 most impactful improvements
- The enhanced prompt should be a single, ready-to-use prompt that stays faithful to the user's original intent
```

## Draft — `boogu`

```text
You are a prompt engineering expert for Boogu-Image-0.1, a unified image generation and editing model. Analyze the user's prompt and provide structured feedback.

Ecosystem-specific rules:
- Prompt style: Natural language, descriptive. A multimodal understanding encoder feeds the diffusion backbone, so full sentences are followed better than tag lists.
- No weight syntax.
- Negative prompts: when one was supplied, analyze and enhance it. When none was supplied, leave `enhancedNegativePrompt` empty, never introduce one, and never mention its absence — some builds do not accept one at all.
- Resolution and aspect ratio are chosen in the form; never write them into the prompt text.
- Bilingual text rendering (Chinese and English) is a strength, but long strings and dense layouts drift into typos and missing characters. Keep rendered text short, quote it exactly, and state its placement.
- Resolutions up to 2K; standard aspect-ratio buckets, 1:1 by default.
- Editing (a reference image is supplied): instruction-based — object insertion, removal, attribute changes, style transfer. Describe the change, not the whole scene.
- The pipeline runs its own prompt rewriter. Do not pad the prompt on the assumption that something downstream will expand it; write it as the final prompt.

Guidelines:
- Identify vague or overly generic descriptions
- Flag rendered-text requests that are too long or that omit placement
- For edits, flag prompts that describe the whole scene instead of the change
- Limit recommendations to the 3 most impactful improvements
- The enhanced prompt should be a single, ready-to-use prompt that stays faithful to the user's original intent
```

### ~~Batch 3~~ — out of scope

@dev: Don't worry about prompt analysis for anything outside image/video ecosystems. That should be part of the skill.

@ai: Done — the rule is now the first section of `SKILL.md`, so the skill refuses `tripo`, `hunyuan3d`, `polygen` (image-to-3D) and `ace` (audio) rather than improvising from an image-shaped template. Open question 5 is dropped.

`other` is generatable but is a catch-all bucket (it also absorbs `Upscaler` via AIR's backwards-compat mapping). Leave it on the generic fallback deliberately.

## Draft — `wanvideo27`

Sourced from `wan-graph.ts`: resolutions 720p/1080p; aspect ratios 16:9, 4:3, 1:1, 3:4, 9:16; negative prompt supported on txt2vid; audio input and video editing workflows; cfgScale/steps/frameRate/loras explicitly unsupported per the fal API spec.

Written in the shape proposed above — no duration and no shot-structure advice, because both are per-request. Wan 2.7 is exactly the case that proves the point: it supports multi-shot where every earlier Wan version does not, so hardcoding either answer into a guide is wrong for half its own workflows.

```text
You are a prompt engineering expert for Wan 2.7 video generation (by Alibaba). Analyze the user's prompt and provide structured feedback.

Ecosystem-specific rules:
- Prompt style: Natural language, cinematic scene description. Structure: subject → action → setting → lighting → camera.
- No weight syntax.
- Negative prompts: Supported on text-to-video. Use: "blurry, distorted, low quality, watermark, static, morphing, deformed hands."
- Resolution: 720p or 1080p. Aspect ratios: 16:9, 4:3, 1:1, 3:4, 9:16.
- Audio: 2.7 accepts an audio track as input. When one is supplied, describe how the action should relate to it (lip sync, motion on the beat) rather than describing the sound itself.
- Video editing: The edit workflow takes a source video plus an optional reference image. Prompts there describe the change to apply, not the whole scene.
- Camera direction: "camera pans left," "slow zoom in," "dolly shot," "tracking shot," "static camera," "aerial drone shot."
- Prompt template: [Subject description]. [Action/movement]. [Setting]. [Camera direction]. [Lighting and style].

Guidelines:
- Identify vague or overly generic descriptions
- Flag missing camera direction (specify static vs. moving)
- For image-to-video and edit workflows, flag prompts that re-describe the static scene instead of the desired change
- If a negative prompt is provided, also analyze and enhance it
- Limit recommendations to the 3 most impactful improvements
- The enhanced prompt should be a single, ready-to-use prompt that stays faithful to the user's original intent
```

## Draft — `wanimage27`

Sourced from `wan-image-graph.ts`: negative prompt supported, aspect ratio picker defaulting to 1:1, and a provider-side `enablePromptEnhancer` toggle.

```text
You are a prompt engineering expert for Wan 2.7 image generation (by Alibaba). Analyze the user's prompt and provide structured feedback.

Ecosystem-specific rules:
- Prompt style: Natural language, structured description. Order matters: subject first, then environment, then lighting and style.
- No weight syntax.
- Negative prompts: Supported. Keep them short and targeted — "blurry, low quality, watermark, distorted hands, extra limbs."
- The provider offers its own prompt enhancer as a separate toggle. A prompt that is already detailed does not need it; do not write the prompt as though it will be expanded.
- Prompt template: [Subject description]. [Scene and environment]. [Lighting, style, and composition].

Guidelines:
- Identify vague or overly generic descriptions
- Flag missing lighting or style cues
- If a negative prompt is provided, also analyze and enhance it
- Limit recommendations to the 3 most impactful improvements
- The enhanced prompt should be a single, ready-to-use prompt that stays faithful to the user's original intent
```

## Open questions

1. ~~**`wanvideo` (root)**~~ **Answered.** @dev: wanvideo should be submitting ecosystem values with specific versions, does that help?

   @ai: It does — confirmed three ways, so `wanvideo` gets no guide:

   - **No `parentEcosystemId` on any Wan ecosystem.** They are siblings under `familyId: 5`, so `getAirEcosystem` leaves the versioned keys intact. Worth stating explicitly because the opposite would have been severe: if they were children of `WanVideo`, all nine Wan guides would be dead and only `wanvideo` would ever be reached — the trap that collapses Pony/Illustrious/NoobAI into `sdxl`.
   - **Root `WanVideo` has no generation support** — commented out in `basemodel.constants.ts` with `// This shouldn't ever apply`.
   - **The graph always writes versioned keys** (`wan-graph.ts` sets `def.ecosystems.i2v`/`t2v`), and the enhance button submits `graph.getSnapshot().ecosystem`.

   **One hole, worth a separate fix.** The normalization effect misses exactly the root case. Its v2.1 branch only rewrites `i2v → t2v`; `ecosystem === 'WanVideo'` matches neither variant, so it returns unnormalized. The effect also depends on `['workflow']` alone, so it never fires on an ecosystem change. If anything does set the root — `extraEcosystems: ['WanVideo']` was added deliberately, suggesting it arrives somehow, plausibly via remix of older stored workflows — it survives to prompt analysis as `wanvideo` and lands on the built-in **image** fallback for a video request.

   The fix is three lines in that branch, not a guide: a guide would have to hedge across five Wan versions to serve a case that should not exist. Tracked in the checklist.

2. ~~**`ltxv` (root)**~~ **Answered.** @dev: ltxv2 and ltxv23 are what we're using in the generator right now
   @ai: Then `ltxv` gets no guide — it is reachable only via uploaded community LTXV models, and a root guide would have to hedge across two versions that already have precise ones. Moved to _Decisions recorded_.
3. ~~**`hidream-o1`**~~ **Answered.** @dev: They may not differ, but it's probably easier to update the orchestrator than do a dance around renaming ecosystems
   @ai: Agreed — writing a second guide is cheap, renaming an ecosystem key is not (the key is load-bearing in AIR, and a rename orphans the stored grain). So `hidream-o1` gets its own guide seeded from `hidream`, and the two are free to diverge later without any migration. Unblocked.
4. ~~**Batch 2 sources**~~ **Answered.** @dev: I'm not sure what source materials to use for those items. Online sources where possible?
   @ai: Sourced online and cross-checked against our graph files — see the sources table above. `mochi` dropped out (no generation support). Three drafts written, awaiting sign-off.both? I'm not sure.
5. ~~**Batch 3 direction**~~ **Dropped** — image/video only; the rule now lives in `SKILL.md`.

## Follow-up checklist

Everything decided in this doc that still needs an action. Nothing here is done unless ticked.

### `civitai` app

- [x] Derive the prompt-analysis key from one shared helper (`getAirEcosystem`); `stringifyAIR` calls it — commit `e4b65d2cc3`, **deployed**
- [x] Delete `scripts/update-prompt-analysis.mjs` (hardcoded grok, drifted from production) — commit `5bcee44d76`
- [x] **Push both commits** — both are on `origin/main`
- [ ] Commit the `add-prompt-enhancement-guide` skill changes (`export` / `import --dry-run` / `set-samples`; `put` no longer destroys samples)
- [x] ~~Enforce the 6000-char cap structurally in the orchestrator~~ — **rejected**: post-hoc truncation treats the symptom, and was proposed with no evidence over-length output occurs. Written, reviewed, reverted.
- [x] Restate the cap to the model as a word target (`MAX_PROMPT_WORDS`, ~800) instead of an uncountable character figure — `promptEnhancement.ts`
- [ ] Once the F1 test runs, check the enhanced-prompt length distribution; if nothing approaches 6,000, drop the length line entirely and reclaim the instruction budget
- [ ] Decide how capability facts are framed once F3/F4 moves them into `buildInstruction` — they must outrank user free text, which the current flat concatenation does not express
- [x] Normalize root `WanVideo` → `WanVideo14B_T2V` in `wan-graph.ts`'s v2.1 branch (see Q1). Condition flipped from "is an I2V variant" to "is not already T2V", which covers the root key as well and is strictly simpler. The img2vid direction already normalized correctly via `wan21Graph`'s resolution effect.
- [ ] Emit per-request temporal facts from `buildInstruction`: chosen duration, fps, and whether the workflow supports cuts. Land this **before** writing further video guides.
- [ ] Decide whether this doc stays in `docs/` or is deleted once the work lands

### `civitai-orchestration`

- [x] `PromptAnalysisGrain.DefaultModelId` grok → qwen3 URN — PR #297, merged
- [x] Fix the image-awareness gate — PR #298, merged. All 41 guides now receive the block when images are present.
- [x] ~~Set the remaining Qwen sampling parameters~~ — resolved: skip the penalties, top_p/top_k optional. See above.
- [ ] Lowercase the ecosystem on read in `PromptAnalysisController`. **Hardening only** — the app always sends a lowercased key via `getAirEcosystem`, so nothing in production can fork a config today; this closes the door for other clients and manual calls. Needs a plan for existing grains — state persists after a DELETE, so a stale odd-cased grain with stored config would resurface if anything reads it.

### Guides (orchestrator data, via the skill's `manage.mjs`)

- [ ] **Delete** the duration bullets from the **17** guides that carry them (listed above), plus the matching "Ensure temporal scope is realistic for ~N seconds" guideline lines. Not blocked on anything — duration is a separate generation parameter and is not going into the instruction. Shot-structure bullets go too, superseded by the `singleTake` toggle.
- [x] Re-read all 41 guides against Qwen's instruction-following — done, findings F1–F6 above
- [ ] **F1 test** — same ecosystem, several different prompts, check whether recommendations vary. Attempted 2026-08-05, **blocked on model access** (see below). Still the right first step once a working credential exists.
- [ ] **F2** — add the missing positive replacement to 17 guides (copy `flux1`'s paired phrasing)
- [ ] **Fix the defects found by reading output** — D1 (rationale leaking into `enhancedPrompt`), D3 (phantom negative-prompt advice), `mageflow`'s negative prompt on a model with no negative field, F4's self-contradicting `"no music"` example. These are the findings that survived; none of them needed the metric.
- [ ] ~~**F6 first — add few-shot `samples`**~~ **no measured support.** On the generic corpus, 2 samples moved `minimaxh3` 67/168 → 61/168 at 92 calls per arm — 4 points, noise. The 10/12 → 3/12 that motivated this came from a corpus built around the guide's own weakness. Samples may still help; there is currently no evidence they do.
- [ ] ~~**F1 fix** — demote surplus `Flag …` lines~~ **deprioritized**: 20/24 → 18/24, within noise.
- [ ] ~~**Measure F2 before sweeping 17 guides**~~ — do not sweep. Two prose interventions have now measured as noise; assume the third does too unless something changes.
- [ ] **Decide whether the metric or the hypothesis is wrong.** Redundancy sits at ~40% on the generic corpus for every arm tried. Either the guides are genuinely mediocre in a way no edit tested so far touches, or the metric's false-positive rate (it scores "refine the lighting you already have" as redundant) is drowning real movement. Sharpening the metric — or scoring a sample of output by hand — decides which, and everything above waits on it.
- [ ] **F3/F4** — no app change: **delete** the variant caveats from `hidream`, `krea2`, `boogu` (condition on `negativePrompt` presence instead) and the duration bullets from the 17 video guides. Both facts were built into `buildInstruction` and both were reverted.
- [ ] **F5** — trim `anima` (27 bullets) and `happyhorse` (26); drop `anima`'s always-evaluated `Dataset tags (advanced)` conditional
- [x] ~~Run real prompts through the live endpoint per ecosystem~~ — done 2026-08-06 on `minimaxh3`, `anima`, `happyhorse` + all five drafts
- [ ] Fix drafts before deploying: `mai` D1/D2 (rationale leaking into `enhancedPrompt`), `boogu` D3/D4, `mageflow` D6, decide `wanvideo27` D5
- [ ] Deploy `wanvideo27` and `wanimage27` — drafted above, need sign-off
- [ ] Write `hidream-o1` — unblocked (Q3); seed from the `hidream` guide
- [x] ~~Write `wanvideo` (root)~~ — no guide; the generator submits versioned Wan keys (Q1)
- [ ] Deploy `mai`, `mageflow`, `boogu` — drafted above from online sources + our graph files, need sign-off
- [x] ~~Write `mochi`~~ — no generation support (`supportType` entry commented out); cannot produce an enhancement request
- [x] ~~Design a 3D/audio template~~ — out of scope; `SKILL.md` now refuses non-image/video ecosystems
- [ ] Consider dropping the image framing from `DefaultSystemPrompt` so the fallback is modality-neutral — `ace`/`tripo`/`hunyuan3d`/`polygen` stay on it permanently and currently get image advice
- [ ] Add few-shot `samples` to `sd1`, `anima`, `flux1kontext` — highest-leverage change for the 3B-active analysis model

### Decisions recorded (no action, do not revisit)

- **`other` stays on the generic fallback.** It is a catch-all bucket that also absorbs `Upscaler` via AIR's backwards-compat mapping; a specific guide would be wrong for most of what lands there.
- **`mochi` gets no guide.** Its `supportType: 'generation'` entry is commented out in `basemodel.constants.ts`, so no enhancement request can reach it. Not registered either.
- **`ideogram` gets no guide.** Registered and reachable, but has no `supportType: 'generation'`, so it cannot produce an enhancement request.
- **The 19 non-generatable ecosystems stay unregistered** (`cogvideox`, `svd`, `sd2`, `sd3`, `kolors`, `pixarta`, …). Reachable by AIR, never by an enhancement request.
- **Guides never describe output shape.** `OutputFormatInstructions` plus a strict `json_schema` own that; duplicating it in a guide risks contradicting the schema.
- **Never probe the orchestrator for a key spelling.** A GET registers what it reads. Derive the key from `basemodel.constants.ts` and confirm with a single `status` call.
- **`wanvideo` (root) gets no guide.** The generator submits versioned Wan keys, and the Wan ecosystems have no `parentEcosystemId` to collapse them. If the root leaks through, fix the graph, not the registry.
- **`ltxv` (root) gets no guide.** `ltxv2` and `ltxv23` are what the generator uses; the root key is reachable only through uploaded community models, and a guide covering it would have to hedge across two versions that already have precise ones.
- **`hidream-o1` gets its own guide rather than an ecosystem rename.** The key is load-bearing in AIR and a rename orphans the stored grain; a second guide costs nothing and lets the two diverge later.
- **No presence/frequency penalty on the analysis call.** The output repeats itself by design and runs under a strict `json_schema`.
- **Prompt analysis covers image and video ecosystems only.** 3D (`tripo`, `hunyuan3d`, `polygen`) and audio (`ace`) get no guide — the template is built around subject/lighting/camera/style, so a guide written from it for those modalities would be confidently wrong rather than merely thin. Enforced in `SKILL.md`.
- **The 41 guides are per _generation ecosystem_, not per analysis model.** Qwen reads them; they describe the ecosystem being prompted for. One guide cannot say both "use weight syntax" (`sd1`) and "no weight syntax" (everything modern). Measured: only 14% of guide text is shared across all 41, so consolidating to a shared base plus deltas would save little and add a composition step the orchestrator does not have.

## Not proposed

- **Guides for non-generatable ecosystems.** 19 reachable keys have no generation support (`cogvideox`, `svd`, `sd2`, `sd3`, `kolors`, `pixarta`, …). They can be reached by AIR but never by an enhancement request. Leaving them unregistered.

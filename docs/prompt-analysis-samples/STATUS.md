# Rollout status

Per-ecosystem tracker. **Deploys happen only after measurement**, and only after a confirmation
run, since single measurements have twice reversed on repeat.

## 2026-08-10 — corpus-wide sweep complete

**37 guides deployed, 1 reverted, ~135 measurement runs.** Every ecosystem in Priorities 1–4 has
now been measured at least once against the live analyzer.

| Block | Shipped | Left live |
| --- | --- | --- |
| Priority 1 | `seedance`, `happyhorse` | `anima` (4 rounds, never reached −25) |
| Wan family | all 9 | — |
| Priority 3 | all 6 | — |
| Priority 4 | 20 | 6 |

Priority 4 left live (6), by reason: **never reproducibly saturated** — `sd1`, `kling`,
`nanobanana`, `sora2` (all reproduce but never move a topic ≥25 points) · **mentions are
load-bearing facts** — `krea2` · **never saturated at all** — `flux1kontext`.

`auraflow` and `veo3` were in that list until samples cleared both. Neither could be fixed by
editing: `auraflow` saturated on lighting with **zero** lighting mentions, and three deletion
rounds left `veo3` stuck at 1. Two restraint samples each took them to 0 (lighting −32/−29;
audio −65/−63 with camera −35/−39). **Deletion removes what the guide causes; samples reach
what the analyzer causes.**

`flux1kontext` is the natural experiment: it is the only guide in the corpus with no prompt
template and no topic enumeration, and the only one that was never saturated. Its topics sit at
36/32/27/27% — the flattest distribution measured.

Update this file as each ecosystem moves. Ground truth for what is live is always
`node .claude/skills/add-prompt-enhancement-guide/manage.mjs status` — this table records
intent and evidence, not deployment state.

## Legend

| Column       | Meaning                                                                 |
| ------------ | ----------------------------------------------------------------------- |
| **Sat.**     | Saturated topics, live → candidate. The number that decides shipping.   |
| **Measured** | `—` not yet · `1x` one run · `2x` confirmed on a second independent run |
| **Deployed** | date, or `no`                                                           |

A candidate ships when: saturation drops, the drop reproduces on a second run, and nothing
else in the topic table moves the wrong way.

**This wording is looser than the measured bar in `SKILL.md` and has already caused one bad
deploy — read that bar, not this sentence.** The noise floor is ±1 saturated topic, so a
1-topic move only counts when a specific topic also shifts **≥25 points** and both reproduce
independently. `anima` v2 (1 → 0, style −18 / −20) satisfies the sentence above and fails the
real bar; it was deployed on that misreading and reverted the same day (†). A candidate that only fixes an instruction the
analyzer provably cannot act on (variant conditioning, hardcoded duration) does not need a
saturation win — but still needs a run confirming it did not make things worse.

## Priority 1 — highest blast radius

| Ecosystem    | What changed                                                     | Sat.  | Measured | Deployed   |
| ------------ | ---------------------------------------------------------------- | ----- | -------- | ---------- |
| `minimaxh3`  | F1 + F4 + ordered beats; 2 samples                               | 2 → 1 | 2x       | 2026-08-06 |
| `sdxl`       | Pony/Illustrious/NoobAI branching + F1 + params guard; 2 samples | 1 → 0 | 2x       | 2026-08-06 |
| `anima`      | v2–v4 tried; style 87→67-75% but never −25. **Left live.**        | 1 → 0 | 4 cfgs † | no         |
| `seedance`   | **v2**: camera invitation + param guard deleted; 2 samples       | 2 → 0 | 2x       | 2026-08-10 |
| `happyhorse` | **v3**: camera mentions deleted (not softened); 2 samples        | 1 → 0 | 2x       | 2026-08-10 |

## Priority 2 — Wan family (9 guides, identical shape)

All nine carried a hardcoded duration bullet plus one absence-check. Measure one, spot-check a
second, then batch the rest on that evidence rather than nine separate confirmations.

| Ecosystem              | Sat. | Measured | Deployed |
| ---------------------- | ---- | -------- | -------- |
| `wanvideo-25-t2v`      | 1 → 0 | 2x | 2026-08-10 |
| `wanvideo-25-i2v`      | 1 → 0 | 2x | 2026-08-10 |
| `wanvideo-22-t2v-a14b` | 1 → 0 | 2x | 2026-08-10 |
| `wanvideo-22-i2v-a14b` | 1 → 0 | 1x scr | 2026-08-10 |
| `wanvideo-22-ti2v-5b`  | 1 → 0 | 1x scr | 2026-08-10 |
| `wanvideo14b_t2v`      | 2 → 0 | 2x | 2026-08-10 |
| `wanvideo14b_i2v_480p` | 1 → 0 | 1x scr | 2026-08-10 |
| `wanvideo14b_i2v_720p` | 1 → 0 | 1x scr | 2026-08-10 |
| `hyv1`                 | 0 → 0 | 1x | 2026-08-10 |

## Priority 3 — new guides (currently on DefaultSystemPrompt)

> **`ltxv` is reachable but not in active use — not shipping.** It does have its own generation
> support and no `parentEcosystemId`, so requests *can* reach it as `ltxv` (it routes through the
> `lightricks` engine, not `ltx.handler.ts`). But it is not a model we actively generate with, so
> the guide is not worth the rollout. It stays on the built-in default. Note the consequence if
> that ever changes: the default is image-flavoured, so any traffic that does arrive gets
> "quality modifiers, lighting, composition" advice for a video model. A candidate and samples
> are drafted (`candidates/ltxv-v2.txt`, `samples/ltxv.json`) if it is ever picked up.

No baseline to beat. The check is whether they arrive already saturated, and whether the
advice is right — `ideogram` and `hidream-o1` are sourced; the other five were drafted earlier
and have known-fixed defects but no live evidence.

| Ecosystem    | Source quality                                                                            | Sat.                | Measured                                          | Deployed |
| ------------ | ----------------------------------------------------------------------------------------- | ------------------- | ------------------------------------------------- | -------- |
| `ideogram`   | sourced (text-length curve, Magic Prompt)                                                 | ?                   | —                                                 | no       |
| `hidream-o1` | sourced (distinct model, reasoning prompt agent)                                          | 0 saturated on arrival | 1x | 2026-08-10 |
| `boogu`      | drafted; D3/D4 fixed, unverified                                                          | 0 saturated on arrival | 1x | 2026-08-10 |
| `mageflow`   | drafted; D6 fixed, negative-prompt bug unverified                                         | 0 saturated on arrival | 1x | 2026-08-10 |
| `mai`        | drafted; D1 fixed, D2 unresolved                                                          | 1 → 0 after 3 rounds | 1x | 2026-08-10 |
| `wanvideo27` | drafted from 2026-04 release notes                                                        | 1 → 0 after 2 rounds | 1x | 2026-08-10 |
| `wanimage27` | drafted                                                                                   | 1 → 0 after 2 rounds | 1x | 2026-08-10 |
| `ltxv`       | ~~sourced~~ — **not shipping, not in active use**                                          | 1 → 2 (old cand.)   | drafted, not measured                             | no       |
| `ltxv23`     | **rewritten** — native audio, quoted dialogue, camera verbs, failure modes; **2 samples** | 1 → 0               | 2x                                                | 2026-08-06 (verified live) |

## Priority 4 — NOT mechanical: same defect as the rest of the corpus

**Rescoped 2026-08-10.** These were filed as "duration removal, absence-check demotion, params guard" —
low individual risk, batch-measurable. Measurement says otherwise: **20 of 21 measured were
saturated**, and the driver in nearly every case was a line nobody had catalogued as a defect.
Six constructions all produce the same effect, strongest to weakest:

| Form | Example |
| --- | --- |
| Directive | `Flag missing camera direction` · `Specify artistic medium explicitly` |
| Rewrite property | `The enhanced prompt should carry lighting…` — 7 instances |
| Superlative | `Lighting has the biggest impact on quality` |
| Bracketed template | `[Subject]. [Lighting]. [Style].` |
| Prose enumeration | `Subject + Scene + Composition + Lighting` · `subject → action → lighting` |
| **Endorsement** | `Camera/lens references and specific lighting descriptions work well.` |

That last one — the mildest phrasing in the census — moved camera **68** points and lighting **52**
on `fluxkrea`. **The cost is in the mention, not the phrasing.** Rewording never worked in any of
~25 attempts; only deletion did.

Two guides resist deletion because their mentions are true and load-bearing: `krea2`'s style
references are the model's actual mechanism, and `qwen2` saturates on lighting while containing
**zero** lighting mentions — so part of the effect is the analyzer's own default, not the guide.
Both left live.

### Per-guide outcomes

| Guide | Result | Driver removed |
| --- | --- | --- |
| `grok` | 3 → 1 ×2 · **shipped** | six-topic formula, stated **twice** (template + `Formula:`) |
| `flux1` | 1 → 0 ×2 · **shipped** | `Lighting has the biggest impact on quality` |
| `flux2` | 1 → 0 ×2 · **shipped** | `Camera/lens references … work well` (same line as `fluxkrea`) |
| `fluxkrea` | 1 → 0 ×2 · **shipped** | same line — camera −59/−68, lighting −48/−52 |
| `lens` | 1 → 0 ×2 · **shipped** | `should carry lighting, composition, or medium detail` |
| `chroma` | 1 → 0 ×2 · **shipped** | enumerations only — cleared in one pass |
| `openai` | 1 → 0 ×2 · **shipped** | three rounds: template, `should carry`, `Specify … explicitly` |
| `hidream` | 1 → 0 ×2 · **shipped** | `should carry` + template |
| `ernie` | 1 → 0 ×2 · **shipped** | `Specify the desired style explicitly for best results` |
| `imagen4` | 1 → 0 ×2 · **shipped** | imperative naming 4 topics + endorsement naming 3 |
| `qwen` | cleared ×2 · **shipped** | arrow enumeration `Subject → Environment → Lighting → Style` |
| `qwen2` | cleared 2 of 3 · **shipped** | same arrow enumeration |
| `zimagebase` | 1 → 0, 2 → 0 · **shipped** | `6-part structure` + template + lighting superlative |
| `zimageturbo` | 2 → 0 screen · **shipped** | identical lines to `zimagebase` |
| `seedream` | 1 → 0 ×2 · **shipped** | prose + bracketed enumeration |
| `reve` | 1 → 0 ×2 · **shipped** | `Suggest explicit composition/layout` + endorsement |
| `ltxv2` | 1 → 0 ×2 · **shipped** | `Describe both subject movement and camera movement` |
| `vidu` | 1 → 0 ×2 · **shipped** | enumerations |
| `sd1` | 0 → 0 · left live | never saturated |
| `kling` | 1→0, 0→0, 1→0 · left live | reproduces, never ≥25 (max −23) |
| `nanobanana` | 1→0, 1→1, 1→1 · left live | one clearance in three arms |
| `sora2` | 1→0, 1→1, 1→0 · left live | reproduces, never ≥25 (max −13) |
| `krea2` | 2 → 2 / 2 → 1 / 2 → 2 · left live | style references are the model's real mechanism |
| `veo3` | **2 → 0 ×2 with samples · shipped** | 3 deletion rounds stalled at 1; samples cleared it (audio −65/−63, camera −35/−39) |
| `auraflow` | **1 → 0 ×2 with samples · shipped** | 0 lighting mentions — deletion had nothing to reach; samples moved it −32/−29 |
| `flux1kontext` | 0 → 0 · left live | no template, no enumeration, never saturated |

### Original scoping (superseded)

Guides whose only change is duration removal, absence-check demotion, or a params guard. Low
individual risk; batch-measure a sample rather than all of them.

`auraflow` · `chroma` · `ernie` · `flux1` · `flux1kontext` · `flux2` · `fluxkrea` · `grok` ·
`hidream` · `imagen4` · `kling` · `krea2` · `lens` · `ltxv2` · `ltxv23` · `nanobanana` ·
`openai` · `qwen` · `qwen2` · `reve` · `sd1` · `seedream` · `sora2` · `veo3` · `vidu` ·
`zimagebase` · `zimageturbo`

## Not shipping

| Ecosystem                              | Why                                                     |
| -------------------------------------- | ------------------------------------------------------- |
| `wanvideo`                             | generation support commented out in basemodel.constants |
| `ace`, `tripo`, `hunyuan3d`, `polygen` | audio / 3D — out of scope per `SKILL.md`                |

## Deferred deliberately

`GUIDELINE-COUNT` (5 guides) and `BARE-PROHIBITION` (8 guides) are untested prose
interventions — the same shape of change that measured as noise twice today. Not sweeping them
without evidence.

# Scanner Policy Refinement — May 2026

Record of the XGuard policy refinement pass executed 2026-05-15. This doc captures what changed, why, and the final state of every label — so future tuning sessions have an audit trail without having to dig through chat history.

Related context:
- [scanner-prompt-tuning.md](scanner-prompt-tuning.md) — overall lifecycle (Phase 1 define → Phase 4 refine, which is what this session was).
- [scanner-label-policy-review.md](scanner-label-policy-review.md) — pre-change structural analysis. The baseline FP rates documented there are what these changes target.

## TL;DR

- **27 labels → 21 labels** after Tier-A drops and an Illegal Trade removal.
- **Every remaining label restructured** to be self-contained (no dependency on orchestrator-side signal-metadata pipeline).
- **Three changes applied via the manager API** in batches: systemPrompt whole-word rule (both modes), surgical FP-fix rewrites for the top-FP labels, and Extremism-template carve-outs for the subjective labels.
- **Rollback snapshots saved** for every batch in `C:\temp\` on the operator's workstation.

## Why this pass happened

Moderator-verdict data on the prompt-mode csam label showed a 75% FP rate (107 FP / 36 TP / 19 TN / 1 FN out of 163 verdicts). Pulling a wider FP-rate query revealed the same pattern across multiple labels:

| Label (prompt) | Baseline FP rate | TP count |
|----------------|------------------|----------|
| Celebrity | 89% | 4 |
| CR | 77% | 11 |
| CSAM | 75% | 36 |
| Young | 73% | 20 |
| Bestiality | 69% | 9 |
| Urine | 61% | 12 |
| Scat | 42% | 14 |
| Sexual | **24%** | 38 |

Reviewing the FP samples surfaced consistent failure modes — substring matching (`cub` inside `incubus`), term-list redundancy between top-level lists and per-label policies, ambiguous trigger terms used without object-vs-person disambiguation, weak negation handling, and compound concept policies (csam = "minor AND sexual" doing AND-logic internally on a first-token decision). The [policy review](scanner-label-policy-review.md) doc lays out the structural diagnoses in full.

This pass implemented the refinements that data + structural review pointed at.

## Key decisions made during the session

### 1. Drop the rating ladder (PG/PG13/R/X/XXX) and Prompt CSAM (Tier A)

Done as a precursor. The rating ladder isn't a fit for XGuard's binary-classifier shape — five independent classifiers cannot reliably reconstruct a 5-level ranking. Prompt CSAM was a compound concept (minor AND sexual) that the model can't do reliably on a first-token decision; future operational csam decisions are derived client-side from `young AND sexual`.

Total dropped in Tier A: prompt CSAM, prompt CR, text PG/PG13/R/X/XXX = 7 labels.

### 2. Self-contained policies, not signal-metadata references

An earlier draft of the Young/Sexual rewrites referenced the orchestrator's `[Positive Age-Down Signals]` / `[Negative Adult-Up Signals]` sections by name, expecting the model to read those as evidence. We pivoted away from that mid-session because:

- The orchestrator-side signal-metadata pipeline has known issues (some sections aren't surfaced to the model; per-label `SignalTerms` doesn't flow through correctly; see [scanner-signalterms-removal-plan.md](scanner-signalterms-removal-plan.md) for the orchestrator-dev follow-up).
- Manager API edits are easy; orchestrator-side fixes take longer.
- Self-contained policies decouple policy work from orchestrator-side timing.

Trade-off: trigger terms now appear in two places (top-level lists feed the signal-metadata input the model sees; policy text also lists them). Accepted, because the alternative depends on infrastructure we don't fully control.

### 3. Label `{name}` should describe the content category

Orchestrator-dev feedback: the policy text's first line `- x: {name}` should describe **what's being detected**, not the **signal type used to detect it**. Every other label followed this — only "Civitai Prompt Age-Down Signal" (Young) was the outlier. Renamed to "Civitai Prompt Underage Subject" to match the pattern.

### 4. Drop Illegal Trade

Significant overlap with text-mode CSAM (covers CSAM trade) and Sex Trafficking (covers trafficking-related trade). Zero verdicts — not operationally relied upon. The narrow remaining sub-case (non-consensual content / revenge porn / deepfakes-with-malice) would be better designed as a dedicated `Non-Consensual Sexual Content` label later, rather than retrofitted into Illegal Trade.

### 5. Threshold tuning pass (2026-05-18)

A second pass after ~5 days of verdict data (n=2006). Cross-joined `ScannerLabelReview` verdicts with `scanner_label_results` scores to look at the TP/FP score distribution per label and simulate threshold changes.

Findings:

- **Free wins (clear TP/FP separation, raise threshold)**: Menstruation, Urine, Scat, Sexual — TPs cluster well above the current threshold while FPs cluster near it. Bumping the threshold preserves recall and cuts FP rate substantially. Menstruation was the cleanest: TPs all ≥0.94, FPs all ≤0.70 — raising to 0.70 takes FP rate from 88% to ~0% with no recall loss.
- **Bestiality**: partial separation. 0.55 → 0.60 keeps 76% recall, cuts FP rate from 65% to 44%. Higher would cost too much recall.
- **Young**: User's hypothesis (raise threshold for the noisy Young label) tested — TPs and FPs overlap heavily, so threshold tuning helps only marginally. Bumped 0.35 → 0.50 as a small win (75% recall, 55% FP rate vs 64%). Policy refinement is the real fix.
- **Diaper / Celebrity / CSAM-text**: skipped. FP scores span the entire range — model is fundamentally miscalibrated, not just over-firing. Policy refinement needed, not threshold change.
- **text NSFW**: skipped. My analysis bucket "nsfw" was the lowercase image-side scanner (n=47), not text-mode NSFW (n=6, currently 0.5).

All threshold changes shown in the status tables above with "(was ...)" annotations.

### 6. Surgical signalTerms edits were not pursued

The orchestrator's per-label `SignalTerms` arrays are vestigial — the dashboard never exposed them for editing, the model never receives them, and they're only used for post-processing `Field` attribution. The orchestrator-dev plan removes the field entirely. Civitai-side `signalTerms` edits would be moot once that change ships, so we focused on policy-text changes instead.

## Status of every label after this pass

### Prompt mode (8 labels — was 10)

| Label | Status | Threshold | Action |
|-------|--------|-----------|--------|
| **Young** (renamed from "Age-Down Signal") | rewritten — self-contained, 5 new carve-outs | **0.50** (was 0.35) | Scan |
| **Sexual** | minor polish — carve-outs added | **0.75** (was 0.35) | Scan |
| **Bestiality** | rewritten — strengthened anthro carve-out | **0.60** (was 0.55) | Block |
| **Urine** | rewritten — fluid/bathroom carve-outs added | **0.65** (was 0.55) | Block |
| **Celebrity** | rewritten — fictional-character + LoRA carve-outs | 0.55 | Block |
| **Menstruation** | unchanged — clean | **0.70** (was 0.55) | Block |
| **Diaper** | unchanged — clean | 0.55 | Block |
| **Scat** | unchanged — clean | **0.60** (was 0.55) | Block |
| ~~CSAM~~ | **dropped** in Tier A | — | — |
| ~~CR~~ | **dropped** in Tier A | — | — |

### Text mode (12 labels — was 18)

| Label | Status | Threshold | Action |
|-------|--------|-----------|--------|
| **NSFW** | rewritten — dropped `sexual solicitation`, added carve-outs | 0.5 | Scan |
| **Grooming** | Extremism-template carve-out added | 0.45 | Review |
| **Sex Trafficking** | Extremism-template carve-out added | 0.45 | Review |
| **Exploitation** | scope tightened + Extremism-template carve-out | 0.45 | Review |
| **Bestiality** | parity rewrite with prompt-mode | **0.60** (was 0.55) | Block |
| **Urine** | parity rewrite with prompt-mode | **0.65** (was 0.55) | Block |
| **CSAM** | unchanged — single concept, clean | 0.6 | Block |
| **Extremism** | unchanged — template label | 0.45 | Review |
| **Impersonating Civitai Staff** | unchanged — well-constructed | 0.45 | Review |
| **Menstruation** | unchanged — clean | **0.70** (was 0.55) | Block |
| **Diaper** | unchanged — clean | 0.55 | Block |
| **Scat** | unchanged — clean | **0.60** (was 0.55) | Block |
| ~~Illegal Trade~~ | **dropped** | — | — |
| ~~PG / PG13 / R / X / XXX~~ | **dropped** in Tier A | — | — |

### Both modes — systemPrompt

Added a whole-word matching rule to both modes' shared `systemPrompt`. Wraps every label policy automatically, addresses the `cub`-in-`incubus` substring FP class without needing per-label edits.

## Final policy texts

For audit and reference, the policy text deployed for each rewritten label.

### systemPrompt (both modes)

```
- x: Custom Civitai label match
  - Choose x only when the custom business rule below matches.
  - Choose sec when the custom business rule below does not match.
  - Match category terms as whole words only. Do not treat youth, sexual, bestiality, or other category terms as matched when they appear as substrings of unrelated words. For example: "cub" inside "incubus" or "succubus" is not a youth signal; "kid" inside "kidney" is not a youth signal; "lolita" inside "gothic lolita" fashion descriptors is a style term, not a youth signal.
  - Do not answer with other built-in categories such as acc, pc, med, law, ter, or others.
  - If another built-in category seems relevant but the custom business rule matches, still choose x.
  - If another built-in category seems relevant and the custom business rule does not match, choose sec.
```

### Prompt — Young (renamed to "Underage Subject")

```
- x: Civitai Prompt Underage Subject
  - Choose x when the prompt's positive section describes, asserts, or implies a minor (under 18) through terms like child, kid, toddler, shota, loli, cub, elementary student, schoolgirl, schoolboy, aged down, or explicit ages under 18.
  - "Young adult", "young man", "young woman", and "young [profession/role]" (e.g. "young actor", "young model") are adult-vocabulary phrasings. Classify as sec unless the prompt also asserts an under-18 age or other explicit youth evidence.
  - Adult body archetypes and fashion styles do not count as youth signals: chibi, shortstack, petite, short adult, small adult, gothic lolita features. Classify as sec unless the prompt also asserts an under-18 age or explicit youth terms.
  - Size descriptors (tiny, small, shrunken) only count as youth signals when applied to a person's age or body. When applied to objects, scenery, vehicles, or buildings, they are not youth signals.
  - A character's source franchise does not determine age. Judge by the body description and asserted age in the prompt, not by the franchise's target audience.
  - 1girl, 1boy, 2girls, 2boys alone are not youth signals.
  - If youth/minor terms (young, child, children, kid, minor, toddler, shota, loli, cub, schoolgirl, schoolboy, elementary student, aged down, etc.) appear ONLY in the negative prompt and the positive prompt describes an adult or contains adult-disambiguator terms (adult, mature, over 18, 21 years old, grown woman, grown man), classify as sec.
  - For this binary check, only use x or sec.
```

### Prompt — Sexual

```
- x: Civitai Prompt Sexual Content
  - Choose x when the prompt asks for nudity, visible sexual body parts, explicit sexual acts, sexual posing, or other clearly sexualized content. Sexualized terms include nudity, naked, sex, sexual, suggestive, revealing, erotic, nsfw, nipples, breasts, genitals, pussy, penis, and similar explicit descriptors.
  - Adult sexual content is still x for this label.
  - Medical, anatomical, or biological descriptions without sexual framing are sec.
  - Swimwear, exposed shoulders, or partial clothing exposure without sexual framing are sec.
  - For this binary check, only use x or sec.
```

### Prompt — Bestiality

```
- x: Civitai Prompt Bestiality
  - Choose x ONLY when the prompt depicts sexual activity between a real (non-anthropomorphic, non-fictional) animal and a human.
  - Furry, anthro, fictional anthropomorphic, monster girl, demi-human, Pokemon, My Little Pony, Sonic-style, Zootopia-style, or any clearly anthropomorphized character is sec. The animal must be clearly a real, non-anthropomorphic animal.
  - Generic mentions of animals (dog, horse, wolf, etc.) in contexts that are not sexual activity between an animal and a person are sec.
  - For this binary check, only use x or sec.
```

### Text — Bestiality (parity with prompt-mode)

```
- x: Civitai Bestiality
  - Choose x ONLY when the text describes sexual activity between a real (non-anthropomorphic, non-fictional) animal and a human.
  - Furry, anthro, fictional anthropomorphic, monster girl, demi-human, Pokemon, My Little Pony, Sonic-style, Zootopia-style, or any clearly anthropomorphized character is sec. The animal must be clearly a real, non-anthropomorphic animal.
  - Generic mentions of animals (dog, horse, wolf, etc.) in contexts that are not sexual activity between an animal and a person are sec.
  - For this binary check, only use x or sec.
```

### Prompt — Urine

```
- x: Civitai Prompt Urine
  - Choose x when the prompt explicitly asks for urine, urination, piss, or piss play content.
  - Other bodily fluids are not urine: cum, semen, sweat, saliva, drool, tears, and female ejaculation / squirt are sec for this label unless urine is also explicitly requested.
  - Bathroom or toilet imagery alone is sec without an explicit urine reference.
  - For this binary check, only use x or sec.
```

### Text — Urine (parity with prompt-mode)

```
- x: Civitai Urine
  - Choose x when the text explicitly describes or requests urine, urination, piss, or piss play content.
  - Other bodily fluids are not urine: cum, semen, sweat, saliva, drool, tears, and female ejaculation / squirt are sec for this label unless urine is also explicitly described.
  - Bathroom or toilet imagery alone is sec without an explicit urine reference.
  - For this binary check, only use x or sec.
```

### Prompt — Celebrity

```
- x: Civitai Prompt Real Person or Celebrity
  - Choose x when the prompt asks to depict a real, living or historical, identifiable person — actors, musicians, politicians, athletes, public figures, content creators, social media personalities, or other real individuals by name.
  - Fictional characters from anime, video games, comics, movies, books, or any other fiction are sec, even when referenced by character name.
  - Original characters, character LoRAs, and AI-generated personas are sec.
  - Named characters from any franchise (e.g. Pinkie Pie from MLP, Aegir from Azur Lane, Rory Mercury from Gate) are fictional unless the prompt explicitly says the character is based on a real person.
  - Names that appear only as Stable Diffusion prompt artifacts (style modifiers, artist references like @username, or LoRA names) are not by themselves real-person signals.
  - For this binary check, only use x or sec.
```

### Text — NSFW

```
- x: Civitai General Sexual Content
  - Choose x when the text contains explicit sexual content or graphic sexual description.
  - Mild romance without explicit sexual content is sec.
  - Educational, medical, anatomical, news, or research-context discussion of sexuality without explicit description is sec.
  - References to sexuality in a metaphorical, idiomatic, or rhetorical sense without explicit description are sec.
  - For this binary check, only use x or sec.
```

### Text — Grooming

```
- x: Civitai Grooming
  - Choose x when one person appears to be grooming, manipulating, or sexually exploiting a minor or vulnerable young person.
  - Educational discussions about grooming, news reports about grooming cases, clearly fictional depictions, or condemnation of grooming behavior are sec unless the text meaningfully instructs or promotes such behavior.
  - For this binary check, only use x or sec.
```

### Text — Sex Trafficking

```
- x: Civitai Sex Trafficking
  - Choose x when the text appears to recruit, coerce, transport, advertise, or facilitate sexual exploitation or sex trafficking.
  - Neutral reporting, condemnation, advocacy against trafficking, educational content, or clearly fictional depictions are sec unless the text meaningfully instructs or promotes such activity.
  - For this binary check, only use x or sec.
```

### Text — Exploitation

```
- x: Civitai Exploitation and Blackmail
  - Choose x when the text appears to attempt blackmail, coercion, or sextortion against a specific individual — extorting, threatening, or pressuring someone for sexual content or sexual acts.
  - Neutral reporting, condemnation, advocacy, educational content, or clearly fictional depictions are sec unless the text meaningfully instructs or promotes such behavior.
  - For this binary check, only use x or sec.
```

## Validation plan

After ~24–48h of new scan traffic, re-run the FP-rate query against the moderator-verdict data to compare against the pre-change baseline:

```sql
SELECT label,
       count(*) FILTER (WHERE verdict = 'FalsePositive') AS fp,
       count(*) FILTER (WHERE verdict IN ('TruePositive', 'FalsePositive')) AS triggered_verdicted,
       count(*) FILTER (WHERE verdict = 'FalsePositive')::float
         / NULLIF(count(*) FILTER (WHERE verdict IN ('TruePositive', 'FalsePositive')), 0) AS fp_rate
FROM "ScannerLabelReview" slr
LEFT JOIN "ScannerContentSnapshot" scs ON scs."contentHash" = slr."contentHash"
WHERE scs.scanner = 'xguard_prompt'
  AND slr."reviewedAt" > now() - interval '48 hours'
GROUP BY label
ORDER BY fp_rate DESC;
```

Targets:

- Bestiality, Urine, Celebrity, Young — FP rate below 40% (from 69%, 61%, 89%, 73%).
- Sexual stays at or below 24%.
- No TP / FN regression — labels should not stop detecting real positives.

If a label regresses, the per-mode PUT can be rolled back from the snapshots below without touching the others.

## Follow-up work

1. **Orchestrator-side `SignalTerms` removal** — see [scanner-signalterms-removal-plan.md](scanner-signalterms-removal-plan.md). Drops the vestigial per-label `SignalTerms` field. The orchestrator should also update the hardcoded `DefaultSystemPrompt` constant to include the whole-word rule, so a `reset` doesn't roll it back.
2. **Operational csam decomposition** — once Young's FP rate drops cleanly under these changes, civitai-side code can derive csam from `young AND sexual` client-side instead of relying on a standalone csam label.
3. **Text-mode label fan-out** — if/when article moderation (or anything else) starts requesting more text-mode labels beyond `nsfw`, the text-mode versions of Bestiality, Urine, Grooming, Sex Trafficking, Exploitation are already pre-tuned for that future. No additional work required.
4. **Re-tier after validation** — if the validation pass shows specific labels still over-firing, the analysis pattern in [scanner-label-policy-review.md](scanner-label-policy-review.md) can be re-run on the new verdict data.

## Rollback paths

All snapshots taken from the orchestrator state during this session are saved on the operator's local workstation at:

```
C:\temp\xguard-backup-20260515-145259.json   # full pre-everything backup
C:\temp\prompt-pre.json                       # state immediately before batch 1
C:\temp\text-pre.json
C:\temp\prompt-batch2-pre.json                # state after batch 1, before batch 2
C:\temp\text-batch2-pre.json
C:\temp\prompt-batch3-pre.json                # state after batch 2, before batch 3
C:\temp\text-batch3-pre.json
C:\temp\xguard-backup-pre-threshold.json      # full backup before 2026-05-18 threshold pass
C:\temp\prompt-threshold-pre.json             # prompt-mode state before threshold pass
C:\temp\text-threshold-pre.json               # text-mode state before threshold pass
```

Restore the entire registry to pre-change state:

```bash
node .claude/skills/xguard-manager/manage.mjs import \
  -f C:/temp/xguard-backup-20260515-145259.json --writable
```

Per-batch per-mode rollback example (rolls back batch 3 of text mode only):

```bash
node .claude/skills/xguard-manager/manage.mjs put text \
  -f /c/temp/text-batch3-pre.json --writable
```

## Tools used

- [xguard-manager skill](../../.claude/skills/xguard-manager/SKILL.md) — read/write the orchestrator's policy registry via `PUT /v1/manager/xguard/options/{mode}` etc.
- [xguard-manager.http](../api/xguard-manager.http) — REST-Client `.http` file for ad-hoc requests.
- [postgres-query skill](../../.claude/skills/postgres-query/SKILL.md) — `ScannerLabelReview` + `ScannerContentSnapshot` lookups for verdict data.
- [clickhouse-query skill](../../.claude/skills/clickhouse-query/SKILL.md) — `scanner_label_results` audit-log queries for trigger/score distributions.
- [scanner-audit moderator UI](../../src/pages/moderator/scanner-audit) — focused-review queue moderators used to produce the verdict data this pass was built on.

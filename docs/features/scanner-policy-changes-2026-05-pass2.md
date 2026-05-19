# Scanner Policy Refinement — May 2026 (Pass 2)

Second-pass policy refinement after analyzing 636 FP samples from the threshold-tuning window (verdicts since 2026-05-13). This pass targets the labels that the [first pass](scanner-policy-changes-2026-05.md) couldn't fix via threshold alone, plus drops the operationally-redundant text-mode CSAM label.

Related context:
- [scanner-policy-changes-2026-05.md](scanner-policy-changes-2026-05.md) — Pass 1: structural rewrite + threshold tuning.
- [scanner-prompt-tuning.md](scanner-prompt-tuning.md) — overall lifecycle.

## TL;DR

- **Four labels rewritten in prompt mode**: Young, Celebrity, Diaper, Bestiality — based on FP-content analysis (n=636).
- **Full text-mode parity** for every sexual-content label that exists in prompt mode. Text mode gains **Young** and **Celebrity** as new labels (it already had Diaper, Bestiality, NSFW≈Sexual). Diaper and Bestiality text-mode policies rewritten to match prompt-mode language.
- **Text-mode CSAM dropped**. Operational CSAM detection moves to client-side `young AND sexual` derivation in both modes — now possible in text-mode too because text-mode Young is being added in this same pass.
- **Diaper downgraded Block → Scan** in both modes. The model fires on broad youth content rather than diaper-specific terms; blocking on that signal is unsafe.
- **Few-shot examples added to every rewritten policy** — first time we're using this lever. XGuard is a first-token classifier; concrete `x:`/`sec:` examples shift the prior more reliably than abstract rules.

## Label parity across modes (after this pass)

Every sexual-content label exists in both modes with the **same threshold** and aligned policy text. Text-only behavioral/abuse labels keep their own thresholds.

| Label | Prompt threshold | Text threshold | Change in this pass |
| --- | --- | --- | --- |
| Sexual / NSFW | 0.75 | **0.75** (was 0.5) | Text NSFW bumped to match Sexual |
| Young / Underage Subject | 0.50 | **0.50** (NEW) | Text-mode label added |
| Celebrity / Real Person | 0.55 | **0.55** (NEW) | Text-mode label added |
| Bestiality | 0.60 | 0.60 | Already matched after pass 1 |
| Diaper | 0.55 | 0.55 | Already matched; both moving Block → Scan this pass |
| Urine | 0.65 | 0.65 | Already matched after pass 1 |
| Scat | 0.60 | 0.60 | Already matched after pass 1 |
| Menstruation | 0.70 | 0.70 | Already matched after pass 1 |
| ~~CSAM~~ | dropped pass 1 | dropped pass 2 | — |

**Text-only labels** (Grooming, Sex Trafficking, Exploitation, Extremism, Impersonating Civitai Staff) have no prompt-mode equivalent and keep their existing thresholds (0.45).

### Why thresholds should match

Each XGuard label is the same classifier head regardless of which mode invokes it — the policy text differs (prompt-shape vs text-shape language) but the underlying scoring distribution is the same model's confidence. Mismatched thresholds across modes mean the *same* underlying decision boundary fires at different confidence levels depending on which scanner ran first — inconsistent with how moderators reason about these signals. After this pass, the threshold is the operational meaning of the label; the per-mode policy text just adapts the carve-outs to the surface form.

## Why this pass

After the pass 1 threshold tuning landed (2026-05-18), Bucket 1 work (pulling actual FP prompt samples) revealed root causes the abstract rewrites couldn't see:

| Label | Pre-pass FP rate | Root cause |
|---|---|---|
| Young (prompt) | 58% | Model conflates anime/cartoon-style + explicit = youth, even when adult ages explicitly stated |
| Celebrity (prompt) | 74% | Original-character names with surnames (e.g. "Cassian Vane-Asherton") read as real people |
| Diaper (prompt) | 89% | Model fires on youth content broadly; almost no FPs contain diaper-specific terms |
| Bestiality (prompt) | 65% | Anthro/Pokemon/monster-girl carve-out leaking; position names ("doggystyle") triggering |
| CSAM (text) | 75% | Same as Young — stylized art + explicit auto-flags regardless of asserted age |

Full FP-content analysis at `C:/temp/fp-analysis.txt` (operator workstation).

## Key decisions

### 1. Drop text-mode CSAM entirely

Three reasons converge:

- **Operational decomposition was planned in pass 1.** Pass 1 already established `csam = young AND sexual` client-side. That direction made the standalone csam label redundant once Young and Sexual were stable.
- **The FP analysis shows csam has the same failure mode as Young** — stylized art + explicit content auto-flagging regardless of asserted age. Fixing one wouldn't independently improve the other; they share the underlying confusion.
- **Sexual is now at 91% precision after threshold tuning.** Combining a high-precision Sexual signal with a Young signal will be cleaner than relying on a standalone csam classifier the model can't do reliably as a first-token decision.

Action: **drop CSAM from the text-mode label set** (was previously thr=0.6, Block).

Operational follow-up (civitai-side, separate work item): wire client-side `young_triggered AND sexual_triggered` into wherever the text-mode csam signal was being consumed. Audit what currently reads CSAM-text from `scanner_label_results` first.

### 2. Diaper goes Block → Scan in both modes

The model fires on "loli, cute, chibi, Sixth grader" with zero diaper-specific terms in the prompt. Blocking on that signal is operationally unsafe. Downgrade to Scan and keep collecting data — if the rewritten policy doesn't move it, deprecate next pass.

### 3. Add few-shot examples to every rewritten policy

XGuard is a small first-token classifier. Concrete examples shift its prior more than abstract rules. None of our pass-1 policies use this lever; every rewrite in this pass does. Each policy gets 3–5 `Example x:`/`Example sec:` lines.

### 4. Full prompt/text parity across all sexual-content labels

Pass 1 had Bestiality and Urine as the only labels with prompt/text parity; the other sexual-content labels were prompt-mode-only or had ad-hoc text equivalents. This pass closes the gap:

- **Text-mode Young added** (new label). Mirrors prompt-mode Young's policy adapted to text content. Enables `young AND sexual` decomposition in text mode (operational replacement for the dropped CSAM-text label).
- **Text-mode Celebrity added** (new label). Mirrors prompt-mode Celebrity adapted to text. Even if not all current consumers need it, having parity prevents the same "we need this in text mode but it doesn't exist" gap that motivated dropping CSAM-text.
- **Text-mode Diaper and Bestiality rewritten** to match the prompt-mode rewrites.

The text-mode versions paraphrase prompt-language ("the prompt asks for") to text-language ("the text describes") and drop prompt-specific concepts (negative prompt, LoRA syntax), but carve-outs, few-shot examples, and structure stay aligned so behavior is consistent.

New text-mode label defaults to **action: Scan** unless a current consumer needs Block — pass 1's principle of "don't ship Block on under-validated labels" applies.

## Final policy texts

### Prompt — Young

```
- x: Civitai Prompt Underage Subject
  - Choose x when the prompt's positive section describes, asserts, or implies a minor (under 18) through terms like child, kid, toddler, shota, loli, cub, elementary student, schoolgirl, schoolboy, aged down, or explicit ages under 18.
  - An explicit adult age in the positive prompt (18+, 21, 25, "adult", "mature", "MILF", "elderly", "old woman", "old man") OVERRIDES all implicit youth signals. If the prompt says "25 year old" or "mature woman" or similar, classify as sec even if the art style is stylized or the prompt contains petite/small/cute descriptors.
  - "Young adult", "young man", "young woman", "young [profession]" (e.g. "young actor", "young model") are adult-vocabulary phrasings — sec unless the prompt also asserts an under-18 age.
  - Anime, cartoon, stylized, chibi, or any art style is sec on its own. Stylized art is not by itself a youth signal. Explicit/sexual content in an anime style is sec for THIS label unless explicit youth terms are also present.
  - Adult body archetypes and fashion styles are sec: petite, shortstack, small frame, skindentation, cute face, gothic lolita features, lolita fashion (as a fashion descriptor), chibi proportions.
  - Size descriptors (tiny, small, shrunken) only count as youth signals when explicitly applied to age. Applied to bodies of adult-aged characters, they are sec.
  - A character's source franchise does not determine age. Judge by asserted age, not franchise audience.
  - Youth/minor terms appearing ONLY in the negative prompt are sec, regardless of positive content. Users put these in negative to AVOID youth output; treat that as a sec signal, not an x signal.
  - 1girl, 1boy, 2girls, 2boys alone are not youth signals.
  - Example x: "loli, child, schoolgirl uniform, explicit" → x (explicit youth terms)
  - Example sec: "1girl, 25 yo, mature MILF, sexy, lingerie" → sec (explicit adult age)
  - Example sec: "petite woman, 22 years old, anime style, nude" → sec (adult age stated, petite is body type)
  - Example sec: "1girl, sexy. NEGATIVE: young, child, minor, loli" → sec (youth terms only in negative)
  - Example sec: "anime girl, gothic lolita dress, adult woman" → sec (lolita as fashion)
  - For this binary check, only use x or sec.
```

### Prompt — Celebrity

```
- x: Civitai Prompt Real Person or Celebrity
  - Choose x ONLY when the prompt names a real, globally-recognizable public figure — actors, musicians, politicians, athletes, content creators with notable followings, or other recognizable public individuals. The name must be one a general audience would recognize as a specific real living/historical person.
  - Unfamiliar or unusual full names (e.g. "Cassian Vane-Asherton", "Victor Reed", "kali byte moreau") are sec by default — assume they are original/fictional characters unless the name is clearly recognizable as a real public figure.
  - Fictional characters from anime, video games, comics, movies, books, or any fiction are sec, even when named (Zelda, Rory Mercury, fukumaru koito, Carter Pewterschmidt, Lara Croft, Raiden Shogun, Pokemon characters, etc.).
  - Original characters, character LoRAs, AI-generated personas, OCs are sec.
  - Single-word or trigger-word identifiers used as LoRA tokens (e.g. "remmylevistrauss", "HelenSynthExl", "fukumaru_koito", "mxrsu", "@mxrsu") are LoRA trigger words, not real-person names — sec.
  - Artist references (e.g. "@username", "by [artist]", style references) are not real-person depiction signals — sec.
  - Stable Diffusion artifacts (score_X tags, source_X tags, LoRA syntax) are not real-person signals — sec.
  - Example x: "Taylor Swift, performing on stage" → x (real celebrity)
  - Example x: "Scarlett Johansson as Black Widow" → x (real celebrity even with character context)
  - Example sec: "Cassian Vane-Asherton, 15-year-old aristocrat swordsman" → sec (original character)
  - Example sec: "<lora:ZeldaSDXL:1>, 1girl, blonde hair" → sec (fictional character LoRA)
  - Example sec: "@mxrsu, 1girl, anime style" → sec (artist reference, not real-person depiction)
  - For this binary check, only use x or sec.
```

### Prompt — Diaper

```
- x: Civitai Prompt Diaper
  - Choose x ONLY when the prompt explicitly references diaper, diapers, pamper, pampers, ABDL, adult baby, padded underwear, or unambiguous synonyms.
  - Youth content (loli, child, chibi, schoolgirl, young, cute, pigtails) is NOT diaper content. Sec unless an explicit diaper term is also present.
  - Belly-focused content (stuffed belly, big belly, bloated belly) is NOT diaper content.
  - Body fluids or bathroom-adjacent terms (urine, scat, etc.) are NOT diaper content — those are separate labels.
  - Femboy, futanari, fetish content without explicit diaper terms is sec.
  - Example x: "1girl, diaper, blush, ABDL" → x
  - Example sec: "loli, cute, chibi, young, pigtails" → sec (no diaper term)
  - Example sec: "stuffed belly, big belly, christmas" → sec (no diaper term)
  - For this binary check, only use x or sec.
```

### Text — Young (NEW)

```
- x: Civitai Underage Subject
  - Choose x when the text describes, asserts, or implies a minor (under 18) through terms like child, kid, toddler, shota, loli, cub, elementary student, schoolgirl, schoolboy, or explicit ages under 18.
  - An explicit adult age in the text (18+, 21, 25, "adult", "mature", "MILF", "elderly", "old woman", "old man") OVERRIDES all implicit youth signals. If the text says "25 year old" or "mature woman" or similar, classify as sec even if the prose contains petite/small/cute descriptors.
  - "Young adult", "young man", "young woman", "young [profession]" (e.g. "young actor", "young model") are adult-vocabulary phrasings — sec unless the text also asserts an under-18 age.
  - Stylized, anime, cartoon, or fictional context is sec on its own. Style is not a youth signal.
  - Adult body archetypes and fashion descriptors are sec: petite, shortstack, small frame, gothic lolita features, lolita fashion (as a fashion descriptor), chibi proportions.
  - Size descriptors (tiny, small, shrunken) only count as youth signals when explicitly applied to age. Applied to adult-aged characters, they are sec.
  - A character's source franchise does not determine age. Judge by asserted age, not franchise audience.
  - Educational, news, condemnation, advocacy contexts discussing minors are sec unless the text describes sexual or exploitative content involving a minor.
  - Example x: "story about a 12-year-old child at school" → x (explicit underage)
  - Example x: "loli character in explicit situation" → x (youth + sexual)
  - Example sec: "a 25-year-old mature woman in lingerie" → sec (explicit adult age)
  - Example sec: "petite 22-year-old woman" → sec (adult age, petite is body type)
  - Example sec: "gothic lolita fashion blog post about adult fashion" → sec (lolita as fashion)
  - For this binary check, only use x or sec.
```

### Text — Celebrity (NEW)

```
- x: Civitai Real Person or Celebrity
  - Choose x ONLY when the text names a real, globally-recognizable public figure — actors, musicians, politicians, athletes, content creators with notable followings, or other recognizable public individuals. The name must be one a general audience would recognize as a specific real living/historical person.
  - Unfamiliar or unusual full names (e.g. "Cassian Vane-Asherton", "Victor Reed", "kali byte moreau") are sec by default — assume they are original/fictional characters unless the name is clearly recognizable as a real public figure.
  - Fictional characters from anime, video games, comics, movies, books, or any fiction are sec, even when named (Zelda, Rory Mercury, Lara Croft, Raiden Shogun, Pokemon characters, etc.).
  - Original characters, fan-fiction characters, AI-generated personas, OCs are sec.
  - References to a real person in a NEUTRAL or NEWSWORTHY context (news article, biography, factual reference) are sec — the label targets sexual/exploitative depictions, not all mentions.
  - Example x: "Taylor Swift in a sexual scenario" → x (real celebrity + sexual depiction)
  - Example x: "explicit fan-fiction about Scarlett Johansson" → x (real person, sexualized)
  - Example sec: "Cassian Vane-Asherton, an aristocrat swordsman, drew his blade" → sec (original character)
  - Example sec: "Zelda saved Hyrule" → sec (fictional)
  - Example sec: "Taylor Swift released a new album yesterday" → sec (neutral news context)
  - For this binary check, only use x or sec.
```

### Text — Diaper (parity)

```
- x: Civitai Diaper
  - Choose x ONLY when the text explicitly references diaper, diapers, pamper, pampers, ABDL, adult baby, padded underwear, or unambiguous synonyms.
  - Youth content (descriptions of minors, schoolchildren, "loli", "cute kid") is NOT diaper content. Sec unless an explicit diaper term is also present.
  - Belly-focused content (stuffed belly, big belly, bloated belly) is NOT diaper content.
  - Body fluids or bathroom-adjacent text (urine, scat, etc.) is NOT diaper content — those are separate labels.
  - Femboy, futanari, fetish content without explicit diaper terms is sec.
  - Example x: "wearing a diaper, ABDL roleplay" → x
  - Example sec: "cute young child playing with toys" → sec (no diaper term)
  - Example sec: "stuffed belly after eating" → sec (no diaper term)
  - For this binary check, only use x or sec.
```

### Prompt — Bestiality

```
- x: Civitai Prompt Bestiality
  - Choose x ONLY when the prompt depicts sexual activity between a real (non-anthropomorphic, non-fictional) animal and a human, where the animal is clearly a real-world animal in physical form.
  - Anthropomorphic, furry, fictional anthro, monster girl, demi-human, half-animal, slime girl, dog girl, cat girl, wolf girl, fox girl, mouse girl, horse girl, sergal, kemono — ALL sec. These are humanoid characters with animal features, not real animals.
  - Pokemon, Digimon, My Little Pony, Sonic, Zootopia, Kemono Friends, Helluva Boss, any "creature" franchise — sec. These are fictional anthro characters.
  - Specific Pokemon species mentioned by name (e.g. steenee, sylveon, lopunny, cinderace, lucario, eevee) are anthro/fictional — sec unless paired with a clearly-real, non-anthro animal AND a human.
  - Sex position names — doggystyle, doggy style, cowgirl, missionary, reverse cowgirl — refer to HUMAN sexual positions, not animal sex. Sec unless an actual animal is also depicted as a participant.
  - Generic animal mentions (dog, horse, wolf) in non-sexual contexts (pet, scenery, accessory) are sec.
  - Tags like "dog ears", "cat ears", "tail", "fur" on otherwise human characters indicate kemonomimi/anthro — sec.
  - Example x: "1girl, real golden retriever dog, sexual, on all fours" → x (real animal + sexual)
  - Example sec: "1girl, dog girl, monster girl, slime girl, sex" → sec (anthro)
  - Example sec: "doggystyle, 1girl, 1boy, bedroom" → sec (position name, no animal)
  - Example sec: "Pokemon, steenee, throat bulge" → sec (Pokemon are anthro/creature)
  - For this binary check, only use x or sec.
```

### Text — Bestiality (parity)

```
- x: Civitai Bestiality
  - Choose x ONLY when the text describes sexual activity between a real (non-anthropomorphic, non-fictional) animal and a human, where the animal is clearly a real-world animal in physical form.
  - Anthropomorphic, furry, fictional anthro, monster girl, demi-human, half-animal, slime girl, dog girl, cat girl, wolf girl, fox girl, mouse girl, horse girl, sergal, kemono — ALL sec. These are humanoid characters with animal features, not real animals.
  - Pokemon, Digimon, My Little Pony, Sonic, Zootopia, Kemono Friends, Helluva Boss, any "creature" franchise — sec. These are fictional anthro characters.
  - Sex position names — doggystyle, doggy style, cowgirl, missionary, reverse cowgirl — refer to HUMAN sexual positions, not animal sex. Sec unless an actual animal is also described as a participant.
  - Generic animal mentions (dog, horse, wolf) in non-sexual contexts (pet, scenery, companion) are sec.
  - Descriptions of characters with animal features (ears, tails, fur) on otherwise human characters indicate kemonomimi/anthro — sec.
  - Example x: "a woman engaged in sexual acts with a real dog" → x (real animal + sexual)
  - Example sec: "story about a furry character having sex with a slime girl" → sec (anthro)
  - Example sec: "couple in doggystyle position" → sec (position name, no animal)
  - For this binary check, only use x or sec.
```

## How to apply

Three categories of changes — different mechanics for each.

### A. Drop text-mode CSAM

```bash
# 1. Snapshot the current text-mode state
node .claude/skills/xguard-manager/manage.mjs get text -o C:/temp/text-pass2-pre.json

# 2. Hand-edit C:/temp/text-pass2-pre.json — remove the CSAM entry from the labels array.
#    OR run the apply script (see below) which handles this in code.

# 3. PUT the modified file
node .claude/skills/xguard-manager/manage.mjs put text -f C:/temp/text-pass2-new.json --writable

# 4. Verify it's gone
node .claude/skills/xguard-manager/manage.mjs get text -q | grep -i csam
```

### B. Rewrite prompt-mode labels (Young, Celebrity, Diaper, Bestiality)

```bash
# 1. Snapshot
node .claude/skills/xguard-manager/manage.mjs get prompt -o C:/temp/prompt-pass2-pre.json

# 2. Apply the four policy rewrites + downgrade Diaper action Block → Scan.
#    Use a `.mjs` script (see template in C:/temp/xguard-batch3.mjs from pass 1)
#    so apostrophes in policy text don't collide with shell quoting.

# 3. PUT
node .claude/skills/xguard-manager/manage.mjs put prompt -f C:/temp/prompt-pass2-new.json --writable

# 4. Verify with a JSON read-back checking each label's policy contains expected substrings.
```

### C. Update text-mode labels — add Young & Celebrity, rewrite Diaper & Bestiality, drop CSAM

Same mechanic as (B), but on the text-mode payload. Bundle everything into a single PUT to minimize churn:

1. `get text -o C:/temp/text-pass2-pre.json`
2. Mutate in-script:
   - **Add** a new label entry for `Young` (policy text from §"Text — Young (NEW)", threshold `0.35`, action `Scan`).
   - **Add** a new label entry for `Celebrity` (policy text from §"Text — Celebrity (NEW)", threshold `0.55`, action `Scan`).
   - **Replace** `Diaper.policy` and set `Diaper.action = 'Scan'`.
   - **Replace** `Bestiality.policy`.
   - **Remove** the `CSAM` label entry from the labels array.
3. `put text -f C:/temp/text-pass2-new.json --writable`
4. Verify all five mutations: Young present, Celebrity present, Diaper has new policy + action=Scan, Bestiality has new policy, CSAM absent.

Threshold note for new text-mode labels: ship at the same defaults as their prompt-mode counterparts (Young: 0.50, Celebrity: 0.55) so behavior is consistent across modes. Threshold tuning for the text-mode versions will come after they have their own verdict data.

### D. Civitai-side follow-up: replace text-mode CSAM consumption

**Before dropping text-mode CSAM in production, audit the call sites.** Grep `scanner_label_results` consumers for `label = 'CSAM'` reads against `xguard_text` content. Wherever a text-mode CSAM signal is consumed, replace with the client-side AND:

```
text_csam_triggered = young_triggered AND nsfw_triggered
  (where both come from xguard_text — Young is the new label added in this pass, NSFW is the existing sexual-content label)
```

Because this pass adds text-mode Young, the client-side decomposition is now possible in both modes — same shape as the prompt-mode `young AND sexual` decomposition agreed in pass 1. Audit + wiring is still needed: confirm consumers exist, identify them, and update them to read from `young + nsfw` instead of `csam`. If no consumers exist, just drop CSAM and skip the rewiring.

## Validation plan

Same approach as pass 1 — re-run the FP-rate query after 24–48h of new scan traffic:

```sql
SELECT label,
       count(*) FILTER (WHERE verdict = 'FalsePositive') AS fp,
       count(*) FILTER (WHERE verdict IN ('TruePositive', 'FalsePositive')) AS triggered,
       round(100.0 * count(*) FILTER (WHERE verdict = 'FalsePositive')
         / NULLIF(count(*) FILTER (WHERE verdict IN ('TruePositive', 'FalsePositive')), 0), 1) AS fp_rate_pct
FROM "ScannerLabelReview"
WHERE "reviewedAt" > '2026-05-18 22:00'  -- pass 2 ship time
GROUP BY label
ORDER BY fp_rate_pct DESC;
```

Targets (after this pass):

| Label | Pre-pass2 FP | Target |
|---|---|---|
| Young (prompt) | 58% | <30% |
| Celebrity (prompt) | 74% | <35% |
| Diaper (prompt+text) | 89% | <40% (and we'll have downgraded Block→Scan so impact is lower) |
| Bestiality (prompt+text) | 65% | <30% |
| CSAM (text) | dropped | — |

No-regression guards:

- Sexual (prompt) should stay ≤8% FP. The Young rewrite leans more permissive but doesn't touch Sexual.
- Urine/Menstruation/Scat thresholds from pass 1 should remain at their new values.

## Rollback paths

```bash
# Full restore to pre-pass-2 state
node .claude/skills/xguard-manager/manage.mjs import \
  -f C:/temp/xguard-backup-pre-pass2.json --writable

# Per-mode rollback
node .claude/skills/xguard-manager/manage.mjs put prompt \
  -f C:/temp/prompt-pass2-pre.json --writable

node .claude/skills/xguard-manager/manage.mjs put text \
  -f C:/temp/text-pass2-pre.json --writable
```

## Follow-up work after this pass

1. **Validate pass 2 against new verdict data** — primary unknown is whether few-shot examples actually move the needle on Young/Celebrity/CSAM-type confusion.
2. **Audit consumers of text-mode CSAM** before the drop fully ships — see §D above.
3. **If Diaper still over-fires post-pass2**, deprecate the label entirely. The model is poorly conditioned for this signal.
4. **Threshold-tune the new text-mode Young and Celebrity labels** once they have their own verdict data (~1 week). Same approach as pass 1's threshold tuning — pull score distributions per verdict and find the cut.
5. **Pass 1's SignalTerms removal** (orchestrator-side) — still pending, separate work track, see [scanner-signalterms-removal-plan.md](scanner-signalterms-removal-plan.md).

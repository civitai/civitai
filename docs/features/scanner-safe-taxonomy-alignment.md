# Plan: Align XGuard Policies to the SAFE/SEval Taxonomy

Rework every Civitai XGuard policy so it explicitly anchors to the built-in
SAFE/SEval taxonomy that YuFeng-XGuard was trained on, instead of being a
free-standing "Add New Category" each time. Goal: reduce hallucination FPs by
invoking the model's strong learned priors instead of relying entirely on
custom rule text.

Status: **proposal**. Not yet applied. Owner pending.

Related:
- [scanner-policy-changes-2026-05.md](scanner-policy-changes-2026-05.md) — original policy pass.
- [scanner-policy-changes-2026-05-pass2.md](scanner-policy-changes-2026-05-pass2.md) — pass 2: hierarchy + few-shot.
- [scanner-derived-labels-plan.md](scanner-derived-labels-plan.md) — synthesis + suppression layer (orthogonal).
- YuFeng-XGuard paper (arxiv 2601.15588) — §2 taxonomy, §3.1.2 dynamic policy, §B.1–B.3 case studies (Add / Expand / Narrow), Appendix C examples.

## Why this matters

The paper documents three findings that explain our current hallucination
problem:

1. **The built-in taxonomy has 28 subcategories whose standards are
   internalized during training.** The standards "are not explicitly detailed
   in the prompt; they are learned implicitly." That means the model has
   strong, calibrated priors on `pc` (Pornographic Contraband), `ma` (Minor
   Abuse and Exploitation), `ter` (Violent Terrorist Activities), etc.
2. **Dynamic policies support three operation types**: Add New Category,
   Expand Scope, Narrow Scope. The paper presents Narrow Scope as the
   high-precision pattern — Case 3 narrows `ter` and successfully filters
   the FPs the operator wanted to drop.
3. **The training pipeline explicitly mitigates "fabrication-to-justify"
   hallucinations** (§3.1.2 Stage 2). Generating policy + response in one
   pass causes the model to hallucinate matches. The same failure mode
   shows up at inference when our Dynamic Policy doesn't anchor strongly
   to a built-in prior — we saw this with NonConsent inventing "raped",
   Incest inventing "sister", Bestiality inventing "golden retriever."

Today every Civitai label is an **Add New Category** operation (single-letter
ID `x` with a freshly-defined rule), even when the concept is already a
subset of a built-in category. Switching the sexual-content, minor-abuse,
and terrorism-adjacent labels to **Narrow Scope on the built-in category**
should anchor the model to its strongest priors and dramatically reduce the
fabricate-then-fire pattern.

## Built-in SAFE/SEval taxonomy (Csys)

From the paper's Table 1 + inference template (full list of IDs the model
knows from training):

| ID | Name | Description (paraphrased) |
| --- | --- | --- |
| `sec` | Safe | Default safe classification |
| `pc` | Pornographic Contraband | Obscene materials, child pornography, illegal sexual information |
| `dc` | Drug Crimes | Manufacturing/trafficking/abuse of controlled substances |
| `dw` | Dangerous Weapons | Illegal weapons, firearms, explosives |
| `pi` | Property Infringement | Theft, fraud, embezzlement, property damage |
| `ec` | Economic Crimes | Financial fraud, money laundering |
| `ac` | Abusive Curses | Profane/vulgar attacks on individuals or groups |
| `def` | Defamation | False information harming reputation |
| `ti` | Threats and Intimidation | Threats of violence, harm, coercion |
| `cy` | Cyberbullying | Persistent online harassment |
| `ph` | Physical Health | Self-harm, dangerous challenges, unsafe medical advice |
| `mh` | Mental Health | Glorification of suicide, harmful psych practices |
| `se` | Social Ethics | Academic misconduct, extreme selfishness |
| `sci` | Science Ethics | Non-therapeutic cloning, irresponsible genetic engineering |
| `pp` | Personal Privacy | PII elicitation/exposure |
| `cs` | Commercial Secret | Trade secret leak |
| `acc` | Access Control | Bypassing security, unauthorized access |
| `mc` | Malicious Code | Viruses, ransomware, malware |
| `ha` | Hacker Attack | DDoS, SQL injection, phishing instructions |
| `ps` | Physical Security | Lock-picking, disabling surveillance |
| `ter` | Violent Terrorist Activities | Promotion/glorification of terrorism |
| `sd` | Social Disruption | Incitement to riots, illegal assemblies |
| `ext` | Extremist Ideological Trends | Radical ideologies advocating violence/hatred |
| `fin` | Finance | Unlicensed financial advice |
| `med` | Medicine | Unqualified medical diagnoses/prescriptions |
| `law` | Law | Unqualified legal advice |
| `cm` | Corruption of Minors | Encouraging minors toward harmful behavior |
| `ma` | Minor Abuse and Exploitation | Physical/psych/sexual abuse and exploitation of children |
| `md` | Minor Delinquency | Minors as perpetrators in criminal activity |

## Label → category mapping

For each Civitai label, the proposed operation type and target built-in
category. Where no built-in fits, the label stays as **Add New Category**
with a single-letter ID.

### Prompt mode (13 labels)

| Label | Operation | Built-in / new ID | Reasoning |
| --- | --- | --- | --- |
| **Sexual** | Narrow Scope | `pc` | Standard pc, with civitai's threshold for "sexual content" |
| **Suggestive** | Expand Scope | `pc` | Broaden pc to include sexually-charged-but-not-explicit content |
| **Explicit** | Narrow Scope | `pc` | Narrow pc to only visible-genitals / depicted-acts |
| **Young** | Expand Scope | `ma` | Broaden ma to "any depiction of a minor" (not only abuse framing) |
| **Bestiality** | Narrow Scope | `pc` | Only pc when real animal + human sexual context |
| **Incest** | Narrow Scope | `pc` | Only pc when sexual + family relation |
| **NonConsent** | Narrow Scope | `pc` | Only pc when explicit non-consent terms present |
| **Diaper** | Narrow Scope | `pc` | Only pc when explicit diaper terms present |
| **Urine** | Narrow Scope | `pc` | Only pc when explicit urine terms present |
| **Scat** | Narrow Scope | `pc` | Only pc when explicit scat terms present |
| **Menstruation** | Narrow Scope | `pc` | Only pc when menstruation terms present |
| **Celebrity** | Add New Category | `c` | Real-person depiction — no built-in fit |
| **Gore** | Add New Category | `g` | Graphic anatomical violence — `ti` is about threats, not depicted gore |

### Text mode (15 labels)

| Label | Operation | Built-in / new ID | Reasoning |
| --- | --- | --- | --- |
| **NSFW** | Narrow Scope | `pc` | Standard pc for general sexual content in text |
| **Sexual** | Narrow Scope | `pc` | (if kept — currently text mode has NSFW instead) |
| **Suggestive** | Expand Scope | `pc` | Mirror prompt mode |
| **Explicit** | Narrow Scope | `pc` | Mirror prompt mode |
| **Young** | Expand Scope | `ma` | Mirror prompt mode |
| **Celebrity** | Add New Category | `c` | Mirror prompt mode |
| **Bestiality** | Narrow Scope | `pc` | Mirror prompt mode |
| **Diaper** | Narrow Scope | `pc` | Mirror prompt mode |
| **Urine** | Narrow Scope | `pc` | Mirror prompt mode |
| **Scat** | Narrow Scope | `pc` | Mirror prompt mode |
| **Menstruation** | Narrow Scope | `pc` | Mirror prompt mode |
| **Grooming** | Narrow Scope | `ma` | Direct fit — grooming IS minor abuse/exploitation |
| **Sex Trafficking** | Narrow Scope | `pc` | Obscenity bucket; minor-trafficking captured by Young+SexTrafficking |
| **Exploitation** | Narrow Scope | `ti` | Sextortion/coercion fits Threats and Intimidation |
| **Extremism** | Narrow Scope | `ter` | Direct fit per Appendix B Case 3 |
| **Impersonating Civitai Staff** | Add New Category | `i` | Civitai-specific concept — no built-in fit |

## Proposed policy texts

Each policy follows the structure recommended by the paper:

```
- {ID}: {NAME}
  - [narrowing or expanding statement that anchors to the built-in prior]
  - [carve-outs]
  - [few-shot examples]
```

For **Narrow Scope** policies, the first line explicitly states the rule
narrows the built-in category and that content not qualifying as the parent
category is sec. For **Expand Scope**, the first line states the rule expands
the built-in category to additionally cover certain content. For **Add New
Category**, the policy stands alone as today.

### Prompt — Sexual (Narrow `pc`)

```
- pc: Civitai Prompt Sexual Content (narrowing of pc)
  - This rule narrows the built-in Pornographic Contraband (pc) category for civitai's image-generation use case.
  - Choose pc ONLY when the prompt would itself qualify as pc under the built-in definition AND requests nudity, visible sexual body parts, explicit sexual acts, sexual posing, or other clearly sexualized content.
  - When the prompt does NOT qualify as pc under the built-in definition, classify as sec for this label regardless of any sexual descriptors present.
  - Adult sexual content is still pc for this label.
  - Medical, anatomical, or biological descriptions without sexual framing are sec.
  - Swimwear, exposed shoulders, or partial clothing exposure without sexual framing are sec.
  - Example pc: "1girl, nude, spread legs, explicit" → pc
  - Example sec: "anatomical diagram of female reproductive system" → sec
  - Example sec: "1girl, business suit, professional portrait" → sec
```

### Prompt — Suggestive (Expand `pc`)

```
- pc: Civitai Prompt Suggestive (expansion of pc)
  - This rule expands the built-in Pornographic Contraband (pc) category to include sexually-charged content that would not normally qualify as pc.
  - Choose pc when the prompt requests suggestive posing, revealing or partial-coverage clothing in a sexualized context, sensual framing, sexual undertones, implied sex, OR any content that would qualify as pc under the built-in definition.
  - Standard pc content (nudity, visible genitals, depicted sex acts) is pc for this label.
  - Medical, anatomical, or biological descriptions without sexual framing are sec.
  - Swimwear, exposed shoulders, or partial clothing in non-sexual contexts (beach, sport, athletic wear, modest fashion) are sec.
  - Standard portraiture, fashion, or glamour photography without sexual framing is sec.
  - Example pc: "1girl, bikini, beach, sexy pose, alluring" → pc (suggestive)
  - Example pc: "1girl, lingerie, bedroom, sensual" → pc (suggestive)
  - Example pc: "1girl, nude, explicit sex acts" → pc (also covers suggestive)
  - Example sec: "1girl, business suit, professional portrait" → sec
```

### Prompt — Explicit (Narrow `pc`)

```
- pc: Civitai Prompt Explicit (narrowing of pc)
  - This rule narrows the built-in Pornographic Contraband (pc) category to only the most explicit sexual content.
  - Choose pc ONLY when the prompt requests visible genitals (pussy, penis, anus, vulva), visible nipples in sexualized framing, depicted sex acts (masturbation, intercourse, oral, anal), explicit sexual fluids (cum, ejaculation, squirting), or unambiguous nudity depicted sexually.
  - Suggestive content WITHOUT explicit elements is sec for this label.
  - Lingerie, swimwear, revealing clothing, sensual posing without visible genitals or depicted acts is sec.
  - Topless artistic nudity without sexual framing is sec.
  - Example pc: "1girl, nude, spread legs, pussy visible, masturbating" → pc
  - Example pc: "explicit sex scene, vaginal penetration, cum" → pc
  - Example sec: "1girl, lingerie, bedroom, sensual pose" → sec
  - Example sec: "1girl, bikini, beach, alluring" → sec
```

### Prompt — Young (Expand `ma`)

```
- ma: Civitai Prompt Underage Subject (expansion of ma)
  - This rule expands the built-in Minor Abuse and Exploitation (ma) category to cover ANY depiction or implication of a minor, regardless of whether explicit abuse framing is present. In the civitai image-generation context, the depiction itself is the relevant signal.
  - Choose ma when the prompt's positive section describes, asserts, or implies a minor (under 18) through terms like child, kid, toddler, shota, loli, cub, elementary student, schoolgirl, schoolboy, aged down, or explicit ages under 18.
  - An explicit adult age in the positive prompt (18+, 21, 25, "adult", "mature", "MILF", "elderly", "old woman", "old man") OVERRIDES all implicit youth signals. Classify as sec even if the art style is stylized or the prompt contains petite/small/cute descriptors.
  - "Young adult", "young man", "young woman", "young [profession]" are adult-vocabulary phrasings — sec unless the prompt also asserts an under-18 age.
  - Anime, cartoon, stylized, chibi, or any art style is sec on its own. Stylized art is not a youth signal.
  - Adult body archetypes are sec: petite, shortstack, small frame, skindentation, gothic lolita fashion, chibi proportions.
  - A character's source franchise does not determine age. Judge by asserted age.
  - 1girl, 1boy, 2girls, 2boys alone are not youth signals.
  - Example ma: "loli, child, schoolgirl uniform" → ma (explicit youth)
  - Example sec: "1girl, 25 yo, mature MILF, sexy" → sec (explicit adult age)
  - Example sec: "petite woman, 22 years old, anime style, nude" → sec
  - Example sec: "anime girl, gothic lolita dress, adult woman" → sec (lolita as fashion)
```

### Prompt — Bestiality (Narrow `pc`)

```
- pc: Civitai Prompt Bestiality (narrowing of pc)
  - This rule narrows the built-in Pornographic Contraband (pc) category to only depictions of sexual activity between a real (non-anthropomorphic) animal and a human.
  - Choose pc ONLY when the prompt would qualify as pc under the built-in definition AND depicts sexual activity between a real-world animal and a human, where the animal is clearly a real-world animal in physical form.
  - When the prompt does NOT qualify as pc under the built-in definition, classify as sec.
  - Anthropomorphic, furry, fictional anthro, monster girl, demi-human, slime girl, dog girl, cat girl, kemono, MLP, Pokemon, Digimon — ALL sec. These are humanoid characters with animal features, not real animals.
  - Sex position names — doggystyle, cowgirl, missionary — refer to human sexual positions, not animal sex. Sec unless an actual animal is also depicted as a participant.
  - Generic animal mentions in non-sexual contexts (pet, scenery) are sec.
  - Example pc: "1girl, real golden retriever, sexual, on all fours" → pc
  - Example sec: "1girl, dog girl, monster girl, sex" → sec (anthro, not real animal)
  - Example sec: "doggystyle, 1girl, 1boy" → sec (position name, no animal)
  - Example sec: "Pokemon, steenee, sexual" → sec (anthro fictional)
```

### Prompt — Incest (Narrow `pc`)

```
- pc: Civitai Prompt Incest (narrowing of pc)
  - This rule narrows the built-in Pornographic Contraband (pc) category to sexual content between depicted family members.
  - Choose pc ONLY when the prompt would qualify as pc under the built-in definition AND depicts the participants as blood relatives or close family (mother, father, son, daughter, brother, sister, sibling, aunt, uncle, cousin, grandparent, niece, nephew, OR step-relatives).
  - When the prompt does NOT qualify as pc under the built-in definition, classify as sec.
  - Non-sexual family content is sec: family portraits, mother-and-child everyday scenes, sibling interactions without sexual framing.
  - "Sister"/"brother" used as endearment, religious context ("sister of the convent"), or military context ("brother in arms") are sec.
  - Example pc: "stepmom and stepson, explicit sex, bedroom" → pc
  - Example pc: "two sisters, nude, kissing, sexual" → pc
  - Example sec: "mother and daughter, family portrait" → sec
  - Example sec: "sister of the convent, praying" → sec
```

### Prompt — NonConsent (Narrow `pc`)

```
- pc: Civitai Prompt Non-Consent (narrowing of pc)
  - This rule narrows the built-in Pornographic Contraband (pc) category to non-consensual sexual content.
  - Choose pc ONLY when the prompt would qualify as pc under the built-in definition AND contains an explicit non-consent term: "rape", "raped", "non-consensual", "noncon", "forced sex", "sexual assault", "molested", OR an unambiguous incapacitation term ("drugged", "unconscious", "asleep", "passed out") paired with sexual activity.
  - When the prompt does NOT qualify as pc under the built-in definition, classify as sec.
  - Default to sec. Sexual content alone is NOT a non-consent signal. Suggestive, explicit, BDSM, bondage, and consensual sexual activity are sec.
  - Consensual BDSM scenarios with explicit consent framing (consensual, roleplay, safe word, mutual) are sec.
  - "Forced" used in non-sexual contexts is sec (forced perspective, forced into a corner).
  - Restraints, ropes, bondage without explicit non-consent terms are sec.
  - Example pc: "1girl, raped, crying, restrained" → pc (literal non-consent term)
  - Example pc: "drugged unconscious woman, sex scene" → pc
  - Example sec: "1girl, bondage, BDSM, consensual" → sec
  - Example sec: "1girl, sexy, lingerie" → sec (sexual but consensual)
```

### Prompt — Diaper (Narrow `pc`)

```
- pc: Civitai Prompt Diaper (narrowing of pc)
  - This rule narrows the built-in Pornographic Contraband (pc) category to content explicitly referencing diapers.
  - Choose pc ONLY when the prompt would qualify as pc under the built-in definition AND explicitly references diaper, diapers, pamper, pampers, ABDL, adult baby, padded underwear, or unambiguous synonyms.
  - When the prompt does NOT qualify as pc under the built-in definition, classify as sec.
  - Youth content (loli, child, chibi, schoolgirl) without explicit diaper terms is sec.
  - Belly-focused content (stuffed belly, big belly, bloated belly) is NOT diaper content.
  - Athletic shorts, underwear, or other clothing items WITHOUT explicit diaper terms are sec.
  - Example pc: "1girl, diaper, ABDL roleplay" → pc
  - Example sec: "loli, cute, chibi, young, pigtails" → sec
  - Example sec: "athletic shorts, gym" → sec
```

### Prompt — Urine (Narrow `pc`)

```
- pc: Civitai Prompt Urine (narrowing of pc)
  - This rule narrows the built-in Pornographic Contraband (pc) category to urine/urination fetish content.
  - Choose pc ONLY when the prompt would qualify as pc under the built-in definition AND explicitly asks for urine, urination, piss, or piss play content.
  - When the prompt does NOT qualify as pc under the built-in definition, classify as sec.
  - Other bodily fluids are NOT urine: cum, semen, sweat, saliva, drool, tears, female ejaculation/squirt are sec unless urine is also explicitly requested.
  - Bathroom or toilet imagery alone is sec without an explicit urine reference.
  - Example pc: "1girl, urine, piss play, watersports" → pc
  - Example sec: "1girl, cum, explicit" → sec (different fluid)
  - Example sec: "1girl, bathroom, sitting on toilet" → sec
```

### Prompt — Scat (Narrow `pc`)

```
- pc: Civitai Prompt Scat (narrowing of pc)
  - This rule narrows the built-in Pornographic Contraband (pc) category to scat/coprophilia content.
  - Choose pc ONLY when the prompt would qualify as pc under the built-in definition AND explicitly references feces, scat, poop, defecation, coprophilia, or unambiguous synonyms.
  - When the prompt does NOT qualify as pc under the built-in definition, classify as sec.
  - Bathroom imagery without explicit scat references is sec.
  - Example pc: "1girl, scat, coprophilia" → pc
  - Example sec: "1girl, bathroom, sitting on toilet" → sec
```

### Prompt — Menstruation (Narrow `pc`)

```
- pc: Civitai Prompt Menstruation (narrowing of pc)
  - This rule narrows the built-in Pornographic Contraband (pc) category to menstruation fetish content.
  - Choose pc ONLY when the prompt would qualify as pc under the built-in definition AND explicitly references menstruation, period, period blood, menses, or menstruation-fetish content.
  - When the prompt does NOT qualify as pc under the built-in definition, classify as sec.
  - General blood imagery (bloody, blood splatter) without explicit menstruation references is sec.
  - Example pc: "1girl, menstruation, period blood, fetish" → pc
  - Example sec: "1girl, blood, horror" → sec (not menstruation)
```

### Prompt — Celebrity (Add New `c`)

```
- c: Civitai Prompt Real Person or Celebrity (new category)
  - This rule defines a new category, c, for civitai's prohibition on generating real public figures. There is no built-in match for this concept.
  - Default to sec. Most named characters in prompts are fictional.
  - Choose c ONLY when the prompt names a real, globally-recognizable public figure (actors, musicians, politicians, athletes) where a general audience would recognize the name as a specific real living or historical person.
  - Unfamiliar full names (e.g. "Cassian Vane-Asherton") are sec by default — assume fictional unless the name is clearly recognizable.
  - Any "[Name] from [franchise/series/game]" pattern indicates fiction — sec, regardless of whether you recognize the franchise.
  - Anime/cartoon/game style markers (source_anime, anime screencap, game CG) treat all names as fictional — sec.
  - LoRA trigger tokens and opaque identifiers are activation tokens, not real-person names — sec.
  - Example c: "Taylor Swift performing on stage" → c
  - Example sec: "Pitt from Kid Icarus" → sec
  - Example sec: "1girl, anime screencap, fukumaru koito" → sec
  - Example sec: "MaiSchool, 1girl, solo" → sec
```

### Prompt — Gore (Add New `g`)

```
- g: Civitai Prompt Gore (new category)
  - This rule defines a new category, g, for extreme graphic anatomical violence. There is no clean built-in match (ti covers threats/intimidation, not depicted gore).
  - Default to sec. Mild or stylized violence is not gore.
  - Choose g ONLY when the prompt requests dismemberment, mutilation, evisceration, decapitation, exposed internal organs, severed limbs, visible bone or viscera, intestines, brain matter, or ultra-violent imagery with catastrophic bodily injury detail.
  - Mild/stylized violence is sec: combat scenes, fistfights, scrapes, bruises, controlled blood splatter without anatomical exposure.
  - Horror/action/fantasy without graphic anatomical injury is sec.
  - Medical/surgical/anatomical-study contexts are sec when framed clinically.
  - SFX makeup, costume, zombie cosmetic, halloween imagery without real-injury framing is sec.
  - Blood alone is not gore.
  - Example g: "decapitated body, severed head, exposed spine" → g
  - Example g: "eviscerated corpse, intestines visible" → g
  - Example sec: "warrior with bloody sword, post-battle" → sec
  - Example sec: "horror scene, dark atmosphere, scary monster" → sec
  - Example sec: "zombie cosmetic makeup, halloween" → sec
```

### Text — same shape as prompt mode

Text-mode policies mirror prompt-mode for shared concepts (Sexual, Suggestive,
Explicit, Young, Bestiality, etc.) with prompt-language adapted to
text-content language. Two text-specific labels:

### Text — Grooming (Narrow `ma`)

```
- ma: Civitai Grooming (narrowing of ma)
  - This rule narrows the built-in Minor Abuse and Exploitation (ma) category to grooming behavior specifically.
  - Choose ma ONLY when the text would qualify as ma under the built-in definition AND describes one person grooming, manipulating, or sexually exploiting a minor or vulnerable young person.
  - When the text does NOT qualify as ma under the built-in definition, classify as sec.
  - Educational discussions, news reports, condemnation of grooming, or clearly fictional depictions are sec unless the text instructs or promotes such behavior.
  - Example ma: "[explicit grooming scenario instructions]" → ma
  - Example sec: "news article about grooming awareness" → sec
```

### Text — Sex Trafficking (Narrow `pc`)

```
- pc: Civitai Sex Trafficking (narrowing of pc)
  - This rule narrows the built-in Pornographic Contraband (pc) category to content that recruits, coerces, transports, advertises, or facilitates sexual exploitation or sex trafficking.
  - Choose pc ONLY when the text would qualify as pc under the built-in definition AND meaningfully promotes or facilitates trafficking.
  - When the text does NOT qualify as pc under the built-in definition, classify as sec.
  - Neutral reporting, condemnation, advocacy against trafficking, educational content are sec unless the text instructs or promotes such activity.
```

### Text — Exploitation (Narrow `ti`)

```
- ti: Civitai Exploitation and Blackmail (narrowing of ti)
  - This rule narrows the built-in Threats and Intimidation (ti) category to sextortion specifically.
  - Choose ti ONLY when the text would qualify as ti under the built-in definition AND attempts blackmail, coercion, or sextortion against a specific individual — extorting, threatening, or pressuring someone for sexual content or acts.
  - When the text does NOT qualify as ti under the built-in definition, classify as sec.
  - Neutral reporting, condemnation, advocacy, educational content, or clearly fictional depictions are sec unless the text instructs or promotes such behavior.
```

### Text — Extremism (Narrow `ter` per paper Case 3)

```
- ter: Civitai Extremism (narrowing of ter)
  - This rule narrows the built-in Violent Terrorist Activities (ter) category to civitai's threshold for action.
  - Choose ter ONLY when the text would qualify as ter under the built-in definition AND explicitly promotes, glorifies, or instructs acts of terrorism or violent extremism.
  - When the text does NOT qualify as ter under the built-in definition, classify as sec.
  - Educational discussion, news reporting, condemnation, advocacy against extremism are sec.
  - Discussion of historical events involving violence is sec when not promoting/glorifying.
```

### Text — Impersonating Civitai Staff (Add New `i`)

Unchanged from current (already an Add New Category in shape).

## Implementation plan

### Phase 1 — Pilot on one label (Bestiality, prompt mode)

Bestiality has the cleanest case for narrowing: a specific real-world animal
+ sexual content requirement on top of the `pc` prior. The FP rate is high
enough (~65%) that improvement should be measurable within 24h of verdict
data.

1. PUT the new prompt-mode Bestiality policy via xguard-manager. Keep
   threshold (0.60) and action (Block) identical so the only variable is
   the policy text.
2. Wait 24h. Pull verdict data for the new `policyHash`. Compare FP rate.
3. If FP rate drops meaningfully (target <40%), proceed to Phase 2.
4. If FP rate doesn't move or worsens, rollback the Bestiality policy and
   reassess the approach before touching other labels.

### Phase 2 — Full prompt-mode rollout

If pilot succeeds, ship the remaining 12 prompt-mode policies in a single
PUT. Mirror the text-mode policies for parity in a separate PUT. Keep
thresholds and actions unchanged.

### Phase 3 — Validation pass

After ~5 days of verdict data on the new policies, run the standard FP-rate
query and update [scanner-policy-changes-2026-05-pass2.md](scanner-policy-changes-2026-05-pass2.md)
(or a new pass3 doc) with the before/after numbers per label.

### Phase 4 — Threshold retuning

The new policies may shift score distributions. If the narrowing language
makes the model more confident on true positives (higher scores) and less
confident on false positives (lower scores), thresholds can be lowered
without losing precision. Re-run the threshold-tuning analysis on the new
verdict data.

## Risks and unknowns

- **The model emits the category ID, not the label name.** When a Bestiality
  scan fires, the model now returns `pc` instead of `x`. The orchestrator
  still tags the result with the label name "Bestiality" because each scan
  is per-label, but downstream consumers that parse the raw model output
  would see `pc`. Need to verify the orchestrator-side handling.
- **Suggestive (Expand `pc`) and Explicit (Narrow `pc`) both use `pc`.**
  They're separate scans so they don't conflict, but the model's behavior
  on the same prompt may now correlate more strongly across these two
  labels than before. That's probably fine — they're supposed to correlate
  (Explicit ⊂ Suggestive), and we already collapse them with the suppression
  rule in the derived-labels service.
- **Anchoring may be too strong on some labels.** If the model leans heavily
  on the `pc` prior, narrowed-pc labels might fire too aggressively on
  ANY sexual content (the parent prior dominates the narrowing language).
  Pilot results will tell us if this is a real risk.
- **The paper's training data may not cover civitai-specific concepts.**
  Anime/cartoon explicit content, anthro/furry content, and LoRA-driven
  generations are civitai-shaped distributions; the SAFE/SEval training
  data may not weight them the same way. The narrowing approach assumes
  the model's `pc` prior generalizes correctly to these distributions.

## Validation queries

After each phase, run these to compare:

```sql
-- FP rate before/after per label, last 5 days
SELECT label,
       count(*) FILTER (WHERE verdict = 'FalsePositive') AS fp,
       count(*) FILTER (WHERE verdict IN ('TruePositive', 'FalsePositive')) AS triggered,
       round(100.0 * count(*) FILTER (WHERE verdict = 'FalsePositive')
         / NULLIF(count(*) FILTER (WHERE verdict IN ('TruePositive', 'FalsePositive')), 0), 1) AS fp_rate_pct
FROM "ScannerLabelReview"
WHERE "reviewedAt" > now() - interval '5 days'
GROUP BY label
ORDER BY fp_rate_pct DESC;
```

```sql
-- Score distribution per label, separated by verdict, to inform threshold retuning
SELECT label, verdict, count() AS n, avg(score) AS avg_score,
       quantile(0.25)(score) AS p25, quantile(0.5)(score) AS p50,
       quantile(0.75)(score) AS p75, quantile(0.9)(score) AS p90
FROM scanner_label_results slr
JOIN ScannerLabelReview slr2 ON slr2.contentHash = slr.contentHash AND slr2.label = slr.label
WHERE slr.lastSeenAt > now() - INTERVAL 5 DAY
GROUP BY label, verdict
ORDER BY label, verdict;
```

## Rollback

Standard rollback path via the manager API. Snapshot before each PUT:

```bash
node .claude/skills/xguard-manager/manage.mjs export -o C:/temp/xguard-backup-pre-safe-align.json
```

Per-label rollback if one policy regresses:

```bash
node .claude/skills/xguard-manager/manage.mjs get prompt -o C:/temp/current.json
# edit C:/temp/current.json to revert just the regressing label
node .claude/skills/xguard-manager/manage.mjs put prompt -f C:/temp/current.json --writable
```

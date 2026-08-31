/**
 * The label set under development, and the content domains it can be applied to.
 *
 * These rubrics are what the AI rater judges against. They are deliberately NOT the same text as
 * the XGuard policies: XGuard policies are written to steer a small guard model with an `- x:` /
 * `sec` grammar, while these are written to be read by a strong model and, just as importantly, by
 * the moderator deciding whether they agree. If the two ever disagree, this file is the intent.
 *
 * A LABEL IS A JUDGEMENT; A DOMAIN IS WHAT IT IS READ AGAINST. "Does this text assert a minor" is
 * the same question whether the text is a generation prompt, a model listing, an article or a
 * bounty. What changes is the shape of the input and the conventions of the people writing it —
 * booru activation tags mean one thing in a listing and another in a prompt, and a negative prompt
 * exists in only one of them. Keeping those apart is what lets one rubric serve every surface
 * rather than growing a near-duplicate per surface.
 *
 * So: put the judgement in `rubric`, put "what is this text" in `DOMAINS`, and put a convention
 * that genuinely only holds on one surface in `domainNotes`. A rubric that names its surface is a
 * rubric that cannot be reused.
 *
 * Scope note: Celebrity is absent from `prompt` on purpose — POI prompts are blocked on a name
 * list, which is the right tool for an intentional block. It is present for `modelListing` because
 * nothing has produced an automated poi signal for a model since the LLM scanner died in 2025-04,
 * and measuring whether XGuard can is how we find out. Violence is deferred everywhere.
 */

/**
 * What the text IS. The preamble every rubric is read under, so no rubric has to restate it.
 */
export const DOMAINS = {
  prompt: {
    label: 'image-generation prompt',
    preamble: `You judge image-generation prompts. The text is a request for an image: someone is asking a model to produce what it describes.

The prompt may run hundreds of tokens with the deciding term buried in style boilerplate, in a non-English section, or inside a LoRA or embedding filename. Read all of it.

A term appearing ONLY in the negative prompt is an exclusion. The user is asking to avoid it, so it must never make the verdict true.`,
  },
  modelListing: {
    label: 'model listing',
    preamble: `You judge model listings. The text is an uploader's title, description, and sometimes their trigger words. Nobody is requesting an image — someone is describing an asset they built, so "the text requests X" reasoning does not apply. Judge what the listing claims the model depicts or produces.

Two conventions matter and mislead constantly. A booru-style trigger-word list ("1girl, solo, long_hair, big breasts") is an activation vocabulary the uploader types to invoke a concept, not a description of output. And naming a franchise, game, doujin or artist identifies where a subject came from, not what this model makes.

A bare model name with no description contains nothing to judge.`,
  },
  article: {
    label: 'article',
    preamble: `You judge articles. The text is an author's title followed by long-form prose they published — a guide, a review, an announcement, a tutorial. Nobody is requesting an image and nobody is describing an asset for download.

Length is the trap here. An article can discuss a subject at length, quote others, describe what a model or image contains, or argue about policy, without itself being the thing it describes. Judge what the article IS, not every topic it mentions in passing.

No label has been measured against this domain yet — no entry in \`LABELS\` claims it. Add one only alongside moderator verdicts on articles, or it will be a rubric nobody has checked.`,
  },
} as const;

export type DomainKey = keyof typeof DOMAINS;

/**
 * Where a sample came from decides which domain it is read as. Derived rather than passed, for the
 * same reason the scanner mode is: whoever kicks off a rating pass has no reason to know the
 * distinction exists, and a default is silently wrong for half the batches.
 *
 * An unknown source throws. A new sampler is one line here; a silent fallback is a corpus rated
 * against the wrong preamble with nothing to show for it.
 */
export const DOMAIN_BY_SOURCE: Record<string, DomainKey> = {
  xguardPromptResults: 'prompt',
  model: 'modelListing',
  article: 'article',
};

export function domainForSource(source: string): DomainKey {
  const domain = DOMAIN_BY_SOURCE[source];
  if (!domain)
    throw new Error(
      `sample source "${source}" has no domain mapping — add it to DOMAIN_BY_SOURCE in labels.ts`
    );
  return domain;
}

export type LabelDef = {
  description: string;
  /** The judgement, stated without reference to what kind of text it is read against. */
  rubric: string;
  /** Domains this label is meaningful for. A label absent here is not merely untested — it is out of scope. */
  domains: readonly DomainKey[];
  /** Rules that genuinely hold on one surface only. Appended after the rubric for that domain. */
  domainNotes?: Partial<Record<DomainKey, string>>;
};

/**
 * Compose what the rater is told: what the text is, then the judgement, then any convention
 * specific to this surface. One place, so a new domain never means editing every rubric.
 */
export function rubricFor(label: LabName, domain: DomainKey): string {
  // Read through `LabelDef` rather than the `as const` literal: the literal narrows `domains` to
  // its own tuple, so `includes` would reject every other domain at the type level and
  // `domainNotes` would not exist on labels that omit it.
  const def: LabelDef = LABELS[label];
  if (!def.domains.includes(domain))
    throw new Error(
      `label "${label}" is not defined for domain "${domain}" — add it to that label's \`domains\` if it should be`
    );
  const note = def.domainNotes?.[domain];
  return [DOMAINS[domain].preamble, `LABEL: ${label}`, def.rubric, note].filter(Boolean).join('\n\n');
}

export const LABELS = {
  AgeAsserted: {
    domains: ['prompt'],
    description: 'The prompt names a person under 18 in words you can quote.',
    rubric: `TRUE when the prompt names a person under 18 in words you can point at and quote.

Counts as an assertion:
- An explicit age under 18 in any format: "12yo", "16 years old", "aged 9", "age:14".
- An unambiguous minor noun: child, toddler, kid, baby, infant, preschooler, elementary student, middle schooler, little girl, little boy, loli, shota, cub, preteen, tween, teen, teenager.
- A transliterated or non-Latin minor term: imouto, otouto, youjo, shoujo, JK, JS, JC, ロリ, ショタ, 少女, 女子高生, 小学生, 妹, 여학생, 소녀, học sinh, девочка.
- A mangled tag spelling of one of the above: "sshotA", "Sh0ta", "l0li", "lo_li".
- Family child-framing in a sexual context: "mom and son", "father and daughter".
- Any of the above inside a LoRA, embedding or model filename.

FALSE for:
- Situational or stylistic youth coding on its own: school uniform, classroom, seifuku, twintails, pigtails, flat chest, petite, cute. Another label covers those.
- Art style: anime, cartoon, chibi, stylised.
- Character names from anime, games or comics, however that character is usually drawn.
- Franchise, series or doujin titles, unless the title itself contains a minor term.
- Quality and score boilerplate: masterpiece, best quality, absurdres, score_9, source_anime.
- Embedding helper tags: zPDXL3, easynegative, PonyXLV6_Scores.
- A minor term appearing only inside an unrelated word: "cub" in "incubus", "kid" in "kidney", "lolita" as a fashion style.
- Anthro, furry, feral, monster-girl or kemono subjects, unless an explicit minor term is also present.`,
  },

  AgeNegated: {
    domains: ['prompt'],
    description: 'The prompt states the subject is an adult.',
    rubric: `TRUE when the prompt states, in words, that the subject is an adult.

Counts as an adult assertion:
- A stated adult age: 18, 19, 20, 21 or above, "in her 20s", "early twenties", "middle aged".
- An explicit adult noun applied to the subject: adult, grown woman, grown man, mature, MILF, GILF, cougar, elderly, old woman, granny.
- Either of the above even when youth-coded terms are also present. "schoolgirl, 25 years old" is TRUE. That combination is the reason this label exists.

FALSE for:
- Adulthood that is merely likely. An unspecified subject is not an adult assertion.
- Sexual or explicit content. That is not an age statement.
- Body descriptions: large breasts, curves, voluptuous, thick, tall, muscular.
- Adult professions or venues on their own: nurse, teacher, office, bar, wedding.
- "young woman", "young man", "young lady". Adult vocabulary, but they state no age.
- An adult term describing someone other than the subject, or an object.`,
  },

  SexualNudity: {
    domains: ['prompt'],
    description:
      'The prompt requests nudity or exposed genitals, without necessarily requesting an act.',
    rubric: `TRUE when the prompt requests a subject who is nude, partially nude, or has genitals, breasts or buttocks exposed.

Counts:
- Explicit nudity terms: nude, naked, topless, bottomless, fully nude, no clothes.
- Named exposed anatomy: nipples, areola, genitals, penis, vulva, pussy, anus, bare breasts, exposed ass.
- Clothing described as removed or displaced to expose: shirt lift, skirt lift, clothes pulled aside, one breast exposed, no panties, no bra with exposure.

FALSE for:
- Lingerie, swimwear, or revealing clothing that still covers. Suggestive is not nudity.
- Anatomical or medical description without exposure framing.
- Bare shoulders, midriff, legs, or feet.
- Nudity requested only in the negative prompt.
- Artistic nude as a genre reference without a nude subject being requested.`,
  },

  SexualAct: {
    domains: ['prompt'],
    description: 'The prompt requests a sex act taking place.',
    rubric: `TRUE when the prompt requests a sexual act being performed, not merely a nude or posed subject.

Counts:
- Named acts: sex, intercourse, penetration, oral, blowjob, fellatio, cunnilingus, anal, handjob, footjob, masturbation, fingering, humping.
- Position names used as the requested activity: doggystyle, cowgirl, missionary, reverse cowgirl, mating press.
- Depicted aftermath or in-progress markers: creampie, cum on body, cum inside, ahegao during an act.
- Non-consent framing of an act still counts as an act.

FALSE for:
- Nudity, posing, or suggestive framing with no act. That is the nudity label.
- Sex-adjacent objects with no act: dildo on a table, condom in frame.
- Position names used to describe a pet or animal's pose rather than an act.
- Kissing, hugging, or romantic framing without sexual activity.
- An act named only in the negative prompt.`,
  },

  // Model-listing labels. Deliberately named for the live XGuard text-mode registry rather than
  // given lab-only names: a baseline evaluation sends no policy override, so the orchestrator only
  // answers for a label it already knows. A lab-only name can be evaluated against a candidate
  // policy but never against what production does today.
  //
  // The input is a model listing, not a prompt. Nobody is asking for an image here — an uploader is
  // describing an asset — so "requests X" reasoning does not transfer and each rubric restates the
  // subject explicitly.

  NSFW: {
    domains: ['modelListing'],
    description: 'Model listing: the text describes sexual content in explicit terms.',
    rubric: `TRUE when the listing describes explicit sexual content or graphic sexual description as what the model produces or depicts.

FALSE for:
- Mild romance, or attractiveness described without explicit sexual content.
- Educational, medical or anatomical discussion without explicit description.
- Metaphorical or idiomatic sexual phrasing.
- A bare model name with no description. There is nothing to judge.`,
  },

  Suggestive: {
    domains: ['modelListing'],
    description: 'Model listing: the text points at sexualised but non-explicit content.',
    rubric: `TRUE when the listing points at sexualised content that stops short of explicit: lingerie, swimwear as titillation, revealing or partially removed clothing, poses or framing whose stated purpose is sexual appeal.

FALSE for:
- Explicit sexual content. That is the Explicit label, not this one.
- A booru-style tag list on its own. Trigger words like "large breasts", "covered navel", "pleated skirt" are activation tags an uploader types to invoke a concept — they describe a training vocabulary, not a claim about the output. A listing whose only sexual signal is such a tag list is FALSE.
- Ordinary character, style or concept LoRAs whose subject merely happens to be an attractive person.
- Anatomy named neutrally as part of what the model can render.
- A bare model name with no description.`,
  },

  Explicit: {
    domains: ['modelListing'],
    description: 'Model listing: the text states the model produces explicit sexual content.',
    rubric: `TRUE when the listing states or clearly signals that the model depicts or produces nudity, exposed genitals, or sexual acts.

Counts:
- Named explicit output: nude, naked, topless, penetration, hardcore, porn, hentai, sex.
- An explicit purpose stated for the model, however briefly.
- An explicit term in the TITLE counts on its own — a title is a claim about purpose.

FALSE for:
- Suggestive-but-clothed content. That is the Suggestive label.
- A booru-style trigger-word list as the only signal (see the Suggestive rubric — same reasoning).
- Adult-adjacent style references with no explicit claim.
- A bare model name with no description.`,
  },

  Young: {
    domains: ['modelListing'],
    description: 'Model listing: the text says the subject is a minor.',
    rubric: `TRUE when the listing states in words you can quote that its subject is a person under 18.

Counts:
- An explicit age under 18 in any format.
- An unambiguous minor noun applied to the subject: child, toddler, kid, loli, shota, preteen, teen, schoolgirl used as an age claim.
- A transliterated or non-Latin minor term: youjo, shoujo, JK, JS, ロリ, 少女, 女子高生.
- A mangled tag spelling of one of the above.

FALSE for:
- Youth-CODED styling with no age claim: school uniform, twintails, petite, flat chest, cute. These describe an art convention, not an age.
- Art style: anime, chibi, cartoon, stylised. Anime characters are drawn young by convention and that is not an assertion.
- A named character from an anime, game or comic, however that character is usually drawn.
- A franchise or doujin title, unless the title itself contains a minor term.
- A minor term inside an unrelated word ("cub" in "incubus", "kid" in "kidney").
- A bare model name that merely LOOKS young to you. This label is about what the text says, not what the model probably outputs.`,
  },

  Celebrity: {
    domains: ['modelListing'],
    description: 'Model listing: the text says the model depicts a real, identifiable person.',
    rubric: `TRUE when the listing indicates the model depicts a REAL, identifiable person: a named public figure, or an explicit statement that the likeness is of a real individual.

Counts:
- A real person's name given as the subject of the model.
- An explicit real-person claim: "trained on photos of", "likeness of", "real person".
- A real person's name in the trigger words when it is the activation token for the likeness.

FALSE for:
- Fictional characters from anime, games, film or comics, however realistically rendered.
- An actor's name given only as a STYLE or resemblance reference rather than the subject.
- Real-person names that are also common words or common given names, where nothing indicates a specific individual.
- Photorealistic style with no named individual.
- A bare model name that is a plausible human name but identifies nobody in particular. This is the dominant false positive — a name alone is not a claim about a real person.`,
  },
} as const satisfies Record<string, LabelDef>;

export type LabName = keyof typeof LABELS;

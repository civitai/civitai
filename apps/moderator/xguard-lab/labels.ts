/**
 * The label set under development.
 *
 * These rubrics are what the AI rater judges against. They are deliberately NOT
 * the same text as the XGuard policies: XGuard policies are written to steer a
 * small guard model with an `- x:` / `sec` grammar, while these are written to
 * be read by a strong model and, just as importantly, by the moderator deciding
 * whether they agree. If the two ever disagree, this file is the intent.
 *
 * Scope note: age and sexual only for now. Celebrity/POI stays on the existing
 * regex list - it is an intentional block on a name list, and a list is the
 * right tool for that. Violence is deferred.
 */
export const LABELS = {
  AgeAsserted: {
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
} as const;

export type LabName = keyof typeof LABELS;

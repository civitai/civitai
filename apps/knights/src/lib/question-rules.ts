/** A rule set: a title with a bullet list (mildest first), notes, or both. */
export type QuestionRuleSet = { title: string; points: string[]; notes?: string };

/** The rules yes/no questions test, shown in the Codex rating guide and the `/play` guide window. */
export const QUESTION_RULES: { intro: string; sets: QuestionRuleSet[] } = {
  intro:
    "We're building a new moderation model. Yes/no questions are very specific on purpose: your answers help train it. These are the rules the questions test.",
  sets: [
    {
      title: 'Sexual content',
      points: [
        'Revealing clothing, cleavage, ordinary swimwear or lingerie; male nipples without sexual presentation; incidental partial buttock exposure.',
        'Pose and focus presenting covered intimate areas; identifiable genital outlines; squeezing a clothed breast/crotch; unused sex toys.',
        'Female nipples/areolas, genitals or anus exposed; buttocks outside the incidental exception; exposed male nipples with sexual presentation.',
        'Sexual activity: penetration, oral sex, genital stimulation, ejaculation or sex-toy contact with exposed genitals.',
      ],
      notes:
        'Incidental means brief, partial skin at a clothing edge during ordinary activity, not the focus of the image. Covered anatomy counts as revealing clothing unless the pose or framing makes it sexual.',
    },
    {
      title: 'Violence',
      points: [
        'Threats, attacks, fighting or weapon discharge.',
        'Bruises, cuts or bleeding without exposed internal tissue.',
        'Exposed fat, muscle, tendon or bone; a severed part; decomposition.',
        'Exposed brain or displaced organs; head/torso destruction; multiple severed major body parts.',
      ],
      notes:
        'An unused weapon alone does not count as violence. Violence is rated separately from sexual content. Explicit anatomical detail matters; illustrated or undead depictions may rate lower.',
    },
    {
      title: 'Language',
      points: [
        'Mild profanity in text shown in the image.',
        'Strong profanity in text shown in the image.',
      ],
    },
  ],
};

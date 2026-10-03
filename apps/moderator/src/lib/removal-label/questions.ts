/**
 * The four questions the removal-label pilot asks about one image, shared by the blind relabel page,
 * the eval harness's prediction rows and the report. Option ids are STORED values: renaming one
 * orphans every answer already recorded under it.
 */

export const MINOR_PRESENT = [
  'clearly_adult',
  'ambiguous_could_be_minor',
  'appears_minor',
  'no_person_or_character',
  'cannot_tell',
] as const;

export const SEXUAL_LEVEL = [
  'none',
  'suggestive_clothed',
  'partial_nudity',
  'explicit_nudity',
  'sexual_act',
  'cannot_tell',
] as const;

export const VIOLENCE = [
  'none',
  'weapon_present_no_threat',
  'threat_or_aiming',
  'injury_or_blood',
  'graphic_gore',
  'cannot_tell',
] as const;

export const SCHOOL_SETTING = [
  'school_classroom_or_campus',
  'school_uniform_only_no_school_setting',
  'other_setting',
  'cannot_tell',
] as const;

export type MinorPresent = (typeof MINOR_PRESENT)[number];
export type SexualLevel = (typeof SEXUAL_LEVEL)[number];
export type Violence = (typeof VIOLENCE)[number];
export type SchoolSetting = (typeof SCHOOL_SETTING)[number];

export type QuestionId = 'minorPresent' | 'sexualLevel' | 'violence' | 'schoolSetting';

export type Answers = {
  minorPresent: MinorPresent;
  sexualLevel: SexualLevel;
  violence: Violence;
  schoolSetting: SchoolSetting;
};

type Question<T extends string> = {
  id: QuestionId;
  prompt: string;
  options: readonly { value: T; label: string }[];
};

export const QUESTIONS = [
  {
    id: 'minorPresent',
    prompt: 'How old does the youngest person shown appear to be?',
    options: [
      { value: 'clearly_adult', label: 'Clearly adult' },
      { value: 'ambiguous_could_be_minor', label: 'Ambiguous, could be a minor' },
      { value: 'appears_minor', label: 'Appears to be a minor' },
      { value: 'no_person_or_character', label: 'No person or character' },
      { value: 'cannot_tell', label: 'Cannot tell' },
    ],
  },
  {
    id: 'sexualLevel',
    prompt: 'What is the most sexual content in the image?',
    options: [
      { value: 'none', label: 'None' },
      { value: 'suggestive_clothed', label: 'Suggestive, clothed' },
      { value: 'partial_nudity', label: 'Partial nudity' },
      { value: 'explicit_nudity', label: 'Explicit nudity' },
      { value: 'sexual_act', label: 'Sexual act' },
      { value: 'cannot_tell', label: 'Cannot tell' },
    ],
  },
  {
    id: 'violence',
    prompt: 'What is the most violent element in the image?',
    options: [
      { value: 'none', label: 'None' },
      { value: 'weapon_present_no_threat', label: 'Weapon present, no threat' },
      { value: 'threat_or_aiming', label: 'Threat or aiming' },
      { value: 'injury_or_blood', label: 'Injury or blood' },
      { value: 'graphic_gore', label: 'Graphic gore' },
      { value: 'cannot_tell', label: 'Cannot tell' },
    ],
  },
  {
    id: 'schoolSetting',
    prompt: 'Where is the scene set?',
    options: [
      { value: 'school_classroom_or_campus', label: 'School classroom or campus' },
      {
        value: 'school_uniform_only_no_school_setting',
        label: 'School uniform, but not a school setting',
      },
      { value: 'other_setting', label: 'Other setting' },
      { value: 'cannot_tell', label: 'Cannot tell' },
    ],
  },
] as const satisfies readonly [
  Question<MinorPresent>,
  Question<SexualLevel>,
  Question<Violence>,
  Question<SchoolSetting>
];

const VALUES: Record<QuestionId, readonly string[]> = {
  minorPresent: MINOR_PRESENT,
  sexualLevel: SEXUAL_LEVEL,
  violence: VIOLENCE,
  schoolSetting: SCHOOL_SETTING,
};

/** A complete answer set, or null if any question is missing or carries a value outside its options. */
export function parseAnswers(input: Partial<Record<QuestionId, unknown>>): Answers | null {
  const out: Partial<Record<QuestionId, string>> = {};
  for (const id of Object.keys(VALUES) as QuestionId[]) {
    const value = input[id];
    if (typeof value !== 'string' || !VALUES[id].includes(value)) return null;
    out[id] = value;
  }
  return out as Answers;
}

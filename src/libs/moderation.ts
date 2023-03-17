export type ModerationCategory = {
  label: string;
  value: string;
  hidden?: boolean;
  noInput?: boolean;
  children?: ModerationCategory[];
};

export const moderationCategories: ModerationCategory[] = [
  {
    label: 'Explicit Nudity',
    value: 'explicit nudity',
    children: [
      { label: 'Nudity', value: 'nudity' },
      { label: 'Graphic Male Nudity', value: 'graphic male nudity' },
      { label: 'Graphic Female Nudity', value: 'graphic female nudity' },
      { label: 'Sexual Activity', value: 'sexual activity' },
      { label: 'Illustrated Explicit Nudity', value: 'illustrated explicit nudity' },
      { label: 'Adult Toys', value: 'adult toys' },
    ],
  },
  {
    label: 'Suggestive',
    value: 'suggestive',
    children: [
      { label: 'Female Swimwear Or Underwear', value: 'female swimwear or underwear' },
      { label: 'Male Swimwear Or Underwear', value: 'male swimwear or underwear' },
      { label: 'Partial Nudity', value: 'partial nudity' },
      { label: 'Barechested Male', value: 'barechested male' },
      { label: 'Revealing Clothes', value: 'revealing clothes' },
      { label: 'Sexual Situations', value: 'sexual situations' },
    ],
  },
  {
    label: 'Violence',
    value: 'violence',
    children: [
      { label: 'Graphic Violence Or Gore', value: 'graphic violence or gore' },
      { label: 'Physical Violence', value: 'physical violence' },
      { label: 'Weapon Violence', value: 'weapon violence' },
      { label: 'Weapons', value: 'weapons' },
      { label: 'Self Injury', value: 'self injury', hidden: true },
    ],
  },
  {
    label: 'Visually Disturbing',
    value: 'visually disturbing',
    children: [
      { label: 'Emaciated Bodies', value: 'emaciated bodies' },
      { label: 'Corpses', value: 'corpses' },
      { label: 'Hanging', value: 'hanging', hidden: true },
      { label: 'Air Crash', value: 'air crash', hidden: true },
      { label: 'Explosions And Blasts', value: 'explosions and blasts' },
    ],
  },
  {
    label: 'Rude Gestures',
    value: 'rude gestures',
    children: [{ label: 'Middle Finger', value: 'middle finger' }],
  },
  {
    label: 'Drugs',
    value: 'drugs',
    hidden: true,
    noInput: true,
    children: [
      { label: 'Drug Products', value: 'drug products' },
      { label: 'Drug Use', value: 'drug use' },
      { label: 'Pills', value: 'pills' },
      { label: 'Drug Paraphernalia', value: 'drug paraphernalia' },
    ],
  },
  {
    label: 'Tobacco',
    value: 'tobacco',
    hidden: true,
    noInput: true,
    children: [
      { label: 'Tobacco Products', value: 'tobacco products' },
      { label: 'Smoking', value: 'smoking' },
    ],
  },
  {
    label: 'Alcohol',
    value: 'alcohol',
    hidden: true,
    noInput: true,
    children: [
      { label: 'Drinking', value: 'drinking' },
      { label: 'Alcoholic Beverages', value: 'alcoholic beverages' },
    ],
  },
  {
    label: 'Gambling',
    value: 'gambling',
    hidden: true,
    noInput: true,
    children: [{ label: 'Gambling', value: 'gambling' }],
  },
  {
    label: 'Hate Symbols',
    value: 'hate symbols',
    hidden: true,
    children: [
      { label: 'Nazi Party', value: 'nazi party' },
      { label: 'White Supremacy', value: 'white supremacy' },
      { label: 'Extremist', value: 'extremist' },
    ],
  },
];

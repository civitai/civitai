import { TagVotableEntityType } from '~/libs/tags';

export type ModerationCategory = {
  label: string;
  value: string;
  hidden?: boolean;
  noInput?: boolean;
  children?: ModerationCategory[];
};

export const modelModerationCategories: ModerationCategory[] = [
  {
    label: 'Explicit Adult Content',
    value: 'explicit nudity',
    children: [{ label: 'Sexual Acts', value: 'sexual activity' }],
  },
  {
    label: 'Violence',
    value: 'violence',
    children: [{ label: 'Intense Violence/Gore', value: 'graphic violence or gore' }],
  },
  {
    label: 'Visually Disturbing',
    value: 'visually disturbing',
    children: [
      { label: 'Emaciated Figures', value: 'emaciated bodies' },
      { label: 'Deceased Bodies', value: 'corpses' },
      { label: 'Hanging', value: 'hanging' },
      { label: 'Disturbing', value: 'disturbing' },
    ],
  },
  {
    label: 'Hate Symbols',
    value: 'hate symbols',
    children: [
      { label: 'Nazi-related Content', value: 'nazi party' },
      { label: 'White Supremacist Content', value: 'white supremacy' },
      { label: 'Extremist Content', value: 'extremist' },
    ],
  },
];

// Options that are hidden are content that can not be allowed.
export const moderationCategories: ModerationCategory[] = [
  {
    label: 'Explicit Adult Content',
    value: 'explicit nudity',
    children: [
      { label: 'Nudity', value: 'nudity' },
      { label: 'Explicit Male Nudity', value: 'graphic male nudity' },
      { label: 'Explicit Female Nudity', value: 'graphic female nudity' },
      { label: 'Sexual Acts', value: 'sexual activity' },
      { label: 'Illustrated Nudity', value: 'illustrated explicit nudity' },
      { label: 'Adult Products', value: 'adult toys' },
    ],
  },
  {
    label: 'Suggestive Content',
    value: 'suggestive',
    children: [
      { label: 'Female Swimwear/Underwear', value: 'female swimwear or underwear' },
      { label: 'Male Swimwear/Underwear', value: 'male swimwear or underwear' },
      { label: 'Partial Nudity', value: 'partial nudity' },
      { label: 'Sexy Attire', value: 'revealing clothes' },
      { label: 'Sexual Situations', value: 'sexual situations' },
    ],
  },
  {
    label: 'Violence',
    value: 'violence',
    children: [
      { label: 'Intense Violence/Gore', value: 'graphic violence or gore' },
      { label: 'Physical Violence', value: 'physical violence' },
      { label: 'Weapon-related Violence', value: 'weapon violence' },
      { label: 'Self-harm', value: 'self injury', hidden: true },
    ],
  },
  {
    label: 'Visually Disturbing',
    value: 'visually disturbing',
    children: [
      { label: 'Emaciated Figures', value: 'emaciated bodies' },
      { label: 'Deceased Bodies', value: 'corpses' },
      { label: 'Hanging', value: 'hanging', hidden: true },
      { label: 'Explosions', value: 'explosions and blasts' },
      { label: 'Disturbing', value: 'disturbing' },
    ],
  },
  {
    label: 'Offensive Gestures',
    value: 'rude gestures',
    children: [{ label: 'Offensive gestures', value: 'middle finger' }],
  },
  {
    label: 'Hate Symbols',
    value: 'hate symbols',
    hidden: true,
    children: [
      { label: 'Nazi-related Content', value: 'nazi party' },
      { label: 'White Supremacist Content', value: 'white supremacy' },
      { label: 'Extremist Content', value: 'extremist' },
    ],
  },
];
export const moderationDisplayNames: Record<string, string> = {};
for (const category of moderationCategories) {
  moderationDisplayNames[category.value] = category.label.toLowerCase();
  for (const child of category.children || [])
    moderationDisplayNames[child.value] = child.label.toLowerCase();
}
export const topLevelModerationCategories = moderationCategories.map((x) => x.value);

export const entityModerationCategories: Record<TagVotableEntityType, ModerationCategory[]> = {
  image: moderationCategories,
  model: modelModerationCategories,
};

// export const nsfwLevelOrder = [
//   NsfwLevel.None,
//   NsfwLevel.Soft,
//   NsfwLevel.Mature,
//   NsfwLevel.X,
//   NsfwLevel.Blocked,
// ];
// export const nsfwLevelUI = {
//   [NsfwLevel.None]: { label: '', color: 'gray', shade: 5 },
//   [NsfwLevel.Soft]: { label: '13', color: 'yellow', shade: 5 },
//   [NsfwLevel.Mature]: { label: '17', color: 'orange', shade: 7 },
//   [NsfwLevel.X]: { label: '18', color: 'red', shade: 9 },
//   [NsfwLevel.Blocked]: { label: '18', color: 'red', shade: 9 },
// };

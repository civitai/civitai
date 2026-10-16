// The views of the open account, in the order the tabs render. Shared by `load`, which parses `?tab=`,
// and the panel, which writes it — two spellings of this list is how a tab ends up loading nothing.
export const SUSPECT_TABS = ['details', 'images', 'models', 'activity'] as const;
export type SuspectTab = (typeof SUSPECT_TABS)[number];

export const SUSPECT_TAB_LABELS: Record<SuspectTab, string> = {
  details: 'User details',
  images: 'Images',
  models: 'Models',
  activity: 'Moderation activity',
};

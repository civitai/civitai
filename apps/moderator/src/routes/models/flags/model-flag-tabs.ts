import { page } from '$app/state';

export type ModelFlagTab = { label: string; href: string; countKey?: string; hint?: string };

/** The Model Flags tabs this moderator may open, from the layout's load. Read inside a `$derived`. */
export const modelFlagTabs = (): ModelFlagTab[] =>
  (page.data.modelFlagTabs ?? []) as ModelFlagTab[];

/** Their paths, for the cross-tab chips and for deciding whether Appeals can be opened from here. */
export const heldModelFlagTabs = (): string[] => modelFlagTabs().map((tab) => tab.href);

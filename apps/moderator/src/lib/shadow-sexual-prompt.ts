import { NsfwLevel, getBrowsingLevelLabel } from '@civitai/shared';
import { z } from 'zod';

export const SHADOW_SEXUAL_PROMPT_PATH = '/text-scan/shadow-sexual-prompt';

export const DAY_OPTIONS = [7, 14, 30, 90] as const;
export const DEFAULT_DAYS = 14;
export const PAGE_SIZE = 50;

export const SOURCES = [
  ['all', 'All images'],
  ['on', 'On-site generations'],
  ['off', 'Off-site uploads'],
] as const;
export type Source = (typeof SOURCES)[number][0];

/** Current-level presets for the would-raise list. Only PG, PG-13 and unrated images can be raised. */
export const CURRENT_LEVELS = [
  ['low', 'PG and PG-13', [NsfwLevel.PG, NsfwLevel.PG13]],
  ['pg', 'PG', [NsfwLevel.PG]],
  ['pg13', 'PG-13', [NsfwLevel.PG13]],
  ['unrated', 'Unrated', [0]],
  ['all', 'Any level', null],
] as const;
export type CurrentLevel = (typeof CURRENT_LEVELS)[number][0];

export const levelsFor = (preset: CurrentLevel): readonly number[] | null =>
  CURRENT_LEVELS.find(([key]) => key === preset)?.[2] ?? null;

// Query params are hand-editable: anything unrecognised degrades to the default, never a 500.
export const filtersSchema = z.object({
  days: z.coerce
    .number()
    .int()
    .refine((n) => (DAY_OPTIONS as readonly number[]).includes(n))
    .catch(DEFAULT_DAYS),
  source: z.enum(SOURCES.map(([key]) => key) as [Source, ...Source[]]).catch('all'),
  current: z
    .enum(CURRENT_LEVELS.map(([key]) => key) as [CurrentLevel, ...CurrentLevel[]])
    .catch('low'),
  page: z.coerce.number().int().min(1).max(10_000).catch(1),
});
export type Filters = z.infer<typeof filtersSchema>;

// "Unrated" rather than the shared label's "?": on this page 0 is a state worth naming, since unrated
// images are raised too.
export const levelLabel = (level: number): string =>
  level === 0 ? 'Unrated' : getBrowsingLevelLabel(level);

export type DailyCounts = {
  day: string;
  scanned: number;
  fired: number;
  raised: number;
  raisedFromPg: number;
  raisedFromPg13: number;
  raisedFromRPlus: number;
  raisedFromUnrated: number;
};
export type AgreementRow = { level: number; fired: number; notFired: number };
export type WouldRaiseRow = {
  imageId: number;
  currentNsfwLevel: number;
  wouldNsfwLevel: number;
  score: number;
  field: string;
  onSite: boolean;
  scannedAt: string;
};

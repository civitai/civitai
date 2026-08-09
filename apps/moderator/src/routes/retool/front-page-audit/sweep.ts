// Page-local: the picker renders these, and a component importing `$lib/server/*` would drag the
// database client into the client bundle.
import { NsfwLevel } from '@civitai/shared';

export const SWEEP_ORDERS = ['newest', 'reactions'] as const;
export const SWEEP_MEDIA = ['image', 'video'] as const;

export const ORDER_LABELS: Record<(typeof SWEEP_ORDERS)[number], string> = {
  newest: 'Newest first',
  reactions: 'Most reacted this week',
};

export const MEDIA_LABELS: Record<(typeof SWEEP_MEDIA)[number], string> = {
  image: 'Images',
  video: 'Videos',
};

/**
 * The ratings a sweep can target. `Blocked` is absent: it is a TOS action, not a rating, and an image
 * carrying it is not on the front page to audit.
 *
 * Confirmed against a screenshot of the live app (2026-08-09): its rating bar and filter offer exactly
 * PG / PG-13 / R / X / XXX. No re-extract needed.
 */
export const SWEEP_LEVELS = [
  { value: NsfwLevel.PG, label: 'PG' },
  { value: NsfwLevel.PG13, label: 'PG-13' },
  { value: NsfwLevel.R, label: 'R' },
  { value: NsfwLevel.X, label: 'X' },
  { value: NsfwLevel.XXX, label: 'XXX' },
];

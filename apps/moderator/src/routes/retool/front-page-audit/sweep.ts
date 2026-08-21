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
// Descriptions are Retool's `browsingLabels`, shown as tooltips on the rating buttons — the wording a
// moderator calibrates against, which a bare letter does not carry.
export const SWEEP_LEVELS = [
  { value: NsfwLevel.PG, label: 'PG', description: 'Safe for work. No naughty stuff' },
  {
    value: NsfwLevel.PG13,
    label: 'PG-13',
    description: 'Revealing clothing, violence, and light gore.',
  },
  {
    value: NsfwLevel.R,
    label: 'R',
    description: 'Adult themes and situations, partial nudity, graphic violence and death.',
  },
  { value: NsfwLevel.X, label: 'X', description: 'Graphic nudity, Adult objects and settings' },
  { value: NsfwLevel.XXX, label: 'XXX', description: 'Sexual content and activity' },
];

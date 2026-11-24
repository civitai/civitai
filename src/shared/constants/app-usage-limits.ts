import { FEEDBACK_RATE_LIMIT } from '~/shared/constants/feedback.constants';
import {
  MEDIA_UPLOAD_BATCH_DAILY_BYTES,
  MEDIA_UPLOAD_BATCH_DAILY_ITEMS,
} from '~/shared/constants/media-upload-batch.constants';
import type { UsageLimitDef, UsageLimitWindow } from '~/shared/constants/usage-limits';

/**
 * The App Platform's per-user caps, as entries of the usage-limit registry (`usage-limits.ts`,
 * which spreads this list into `usageLimitDefs`): tunable from the `usage-limits` KeyValue row,
 * and named by these ids on every 429 they answer. The numbers are the code defaults; with no
 * override they are exactly the limits the App Platform enforced before it had entries here.
 *
 * Two kinds of entry, by who counts:
 *   - `rateLimit(usageLimits(id))`: a tRPC procedure's own rolling window, counted in the caller's
 *     bucket (keyed on the procedure, so several procedures can share one entry and each keeps
 *     its own count).
 *   - an OWNER-COUNTED cap (`countedBy: 'owner'`): the enforcing service keeps its own counter (a
 *     fixed window or a UTC day) and reads only the limit from here (`resolveUserAppLimit`). Its
 *     `window` gives that counter's length (a `rolling` one is a fixed window of that many
 *     seconds); `rateLimit()` never counts it.
 *
 * `kind` (`product` / `abuse`) is the operator's split: a product limit is an allowance a user
 * plans around, and may be disabled by an override; an abuse limit is anti-flood or guards money
 * or safety, and an override may raise or lower it but never disable it. `reportsCounts` marks an
 * abuse limit whose refusal still reports its counts (`limit`, `used`, `remaining`, `resetAt`),
 * so an app can show "x of y today" while no override can switch the cap off.
 */

const HOUR = 60 * 60;
const DAY = 24 * HOUR;
const rolling = (seconds: number): UsageLimitWindow => ({ type: 'rolling', seconds });

const MARKETPLACE_READS_MESSAGE = 'Too many marketplace requests — slow down.';

export const appUsageLimitDefs = [
  // ── Money a user plans around: abuse in the registry, reporting counts ──────────────────────
  {
    // Buzz tipped from apps per UTC day, across every app. Counted by the tip endpoint.
    id: 'apps.tip-daily',
    area: 'apps',
    countedBy: 'owner',
    kind: 'abuse',
    reportsCounts: true,
    label: 'Daily Buzz tipped through apps',
    window: { type: 'utc-day' },
    base: 25_000,
  },
  {
    // Buzz spent on app goods per UTC day, across every app. Counted by the purchase endpoint.
    id: 'apps.goods-daily',
    area: 'apps',
    countedBy: 'owner',
    kind: 'abuse',
    reportsCounts: true,
    label: 'Daily Buzz spent on app goods',
    window: { type: 'utc-day' },
    base: 150_000,
  },
  // ── Owner-counted allowances ───────────────────────────────────────────────────────────────
  {
    id: 'apps.fork-starts-hourly',
    area: 'apps',
    countedBy: 'owner',
    kind: 'product',
    label: 'App forks started per hour',
    window: rolling(HOUR),
    base: 5,
  },
  {
    id: 'apps.fork-starts-daily',
    area: 'apps',
    countedBy: 'owner',
    kind: 'product',
    label: 'App forks started per day',
    window: rolling(DAY),
    base: 20,
  },
  {
    // App bundles submitted per minute, per user and per API key, on both submit routes.
    id: 'apps.version-submits',
    area: 'apps',
    countedBy: 'owner',
    kind: 'product',
    label: 'App versions submitted per minute',
    window: rolling(60),
    base: 10,
  },
  {
    id: 'apps.media-upload-daily-items',
    area: 'apps',
    countedBy: 'owner',
    kind: 'product',
    label: 'Files uploaded through app batches per day',
    window: { type: 'utc-day' },
    base: MEDIA_UPLOAD_BATCH_DAILY_ITEMS,
  },
  {
    id: 'apps.media-upload-daily-bytes',
    area: 'apps',
    countedBy: 'owner',
    kind: 'product',
    label: 'Bytes uploaded through app batches per day',
    window: { type: 'utc-day' },
    base: MEDIA_UPLOAD_BATCH_DAILY_BYTES,
  },
  {
    // Off-site listing submissions awaiting review at once. Frees when one is withdrawn or reviewed.
    id: 'apps.offsite-pending',
    area: 'apps',
    countedBy: 'owner',
    kind: 'product',
    label: 'Off-site listing submissions pending review',
    window: { type: 'standing' },
    base: 10,
  },
  // ── Owner-counted anti-flood caps ──────────────────────────────────────────────────────────
  {
    id: 'apps.dev-tunnel-starts',
    area: 'apps',
    countedBy: 'owner',
    kind: 'abuse',
    label: 'Dev tunnel starts for unsubmitted apps per hour',
    window: rolling(HOUR),
    base: 20,
  },
  {
    id: 'apps.dev-token',
    area: 'apps',
    countedBy: 'owner',
    kind: 'abuse',
    label: 'Dev tokens minted per minute',
    window: rolling(60),
    base: 30,
  },
  {
    // Pushes recorded for review: per user on the manifest editor, per app on the git push.
    id: 'apps.push-review',
    area: 'apps',
    countedBy: 'owner',
    kind: 'abuse',
    label: 'Pushes recorded for review per hour',
    window: rolling(HOUR),
    base: 20,
  },
  {
    id: 'apps.listing-submissions',
    area: 'apps',
    countedBy: 'owner',
    kind: 'abuse',
    label: 'Listing submission reads per minute',
    window: rolling(60),
    base: 60,
  },
  {
    id: 'apps.listing-withdrawals',
    area: 'apps',
    countedBy: 'owner',
    kind: 'abuse',
    label: 'Listing withdrawals per minute',
    window: rolling(60),
    base: 30,
  },
  {
    // The per-viewer generation-source bucket, shared by both save procedures' own counters.
    id: 'apps.generation-source',
    area: 'apps',
    countedBy: 'owner',
    kind: 'abuse',
    label: 'Generation sources saved per hour',
    window: rolling(HOUR),
    base: 60,
  },
  {
    // Workflows a viewer submits through apps, across every install.
    id: 'apps.submit-user',
    area: 'apps',
    countedBy: 'owner',
    kind: 'abuse',
    label: 'App workflow submissions per 10 seconds',
    window: rolling(10),
    base: 600,
  },
  // ── tRPC procedures: `rateLimit(usageLimits(id))` ─────────────────────────────────────────
  {
    id: 'apps.collaborator-invites',
    area: 'apps',
    kind: 'abuse',
    label: 'Collaborator invitations per hour',
    window: rolling(HOUR),
    base: 30,
    message: 'Too many collaborator invitations — slow down.',
  },
  {
    id: 'apps.collaborator-lookups',
    area: 'apps',
    kind: 'abuse',
    label: 'Collaborator lookups per hour',
    window: rolling(HOUR),
    base: 600,
    message: 'Too many collaborator lookups — slow down.',
  },
  {
    id: 'apps.ownership-transfers',
    area: 'apps',
    kind: 'abuse',
    label: 'App ownership transfer attempts per hour',
    window: rolling(HOUR),
    base: 10,
    message: 'Too many ownership transfer attempts — slow down.',
  },
  {
    id: 'apps.feedback',
    area: 'apps',
    kind: 'abuse',
    label: 'App feedback submissions per hour',
    window: rolling(FEEDBACK_RATE_LIMIT.periodSeconds),
    base: FEEDBACK_RATE_LIMIT.max,
    message: 'You have submitted a lot of feedback — give it a little while.',
  },
  {
    // The sleeping-apps page's wake-seed reads, and the App Assistant runner's sleeping-app routes.
    id: 'apps.sleeping-reads',
    area: 'apps',
    kind: 'abuse',
    label: 'Sleeping app reads per hour',
    window: rolling(HOUR),
    base: 60,
  },
  {
    id: 'apps.sleeping-deletes',
    area: 'apps',
    kind: 'abuse',
    label: 'Sleeping app deletions per hour',
    window: rolling(HOUR),
    base: 60,
  },
  {
    id: 'apps.storage-empties',
    area: 'apps',
    kind: 'abuse',
    label: 'App storage empties per hour',
    window: rolling(HOUR),
    base: 20,
  },
  {
    id: 'apps.storage-exports',
    area: 'apps',
    kind: 'abuse',
    label: 'App storage exports per hour',
    window: rolling(HOUR),
    base: 120,
  },
  {
    id: 'apps.listing-submits',
    area: 'apps',
    kind: 'abuse',
    label: 'Off-site listings submitted per hour',
    window: rolling(HOUR),
    base: 10,
    message: 'Too many submissions — slow down.',
  },
  {
    id: 'apps.listing-edits',
    area: 'apps',
    kind: 'abuse',
    label: 'Listing edits per hour',
    window: rolling(HOUR),
    base: 30,
    message: 'Too many edits — slow down.',
  },
  {
    id: 'apps.listing-lookups',
    area: 'apps',
    kind: 'abuse',
    label: 'Own listing lookups per minute',
    window: rolling(60),
    base: 60,
    message: 'Too many listing lookups — slow down.',
  },
  {
    id: 'apps.listing-revision-submits',
    area: 'apps',
    kind: 'abuse',
    label: 'Listing revisions submitted per hour',
    window: rolling(HOUR),
    base: 20,
    message: 'Too many revision submissions — slow down.',
  },
  {
    // Listing asset uploads, app image picker uploads, and an app's own upload persists.
    id: 'apps.image-uploads',
    area: 'apps',
    kind: 'abuse',
    label: 'App image uploads per hour',
    window: rolling(HOUR),
    base: 60,
    message: 'Too many image uploads — slow down.',
  },
  {
    id: 'apps.listing-previews',
    area: 'apps',
    kind: 'abuse',
    label: 'Listing link previews per hour',
    window: rolling(HOUR),
    base: 30,
    message: 'Too many preview lookups — slow down.',
  },
  {
    id: 'apps.image-imports',
    area: 'apps',
    kind: 'abuse',
    label: 'Listing image imports per hour',
    window: rolling(HOUR),
    base: 30,
    message: 'Too many image imports — slow down.',
  },
  {
    id: 'apps.listing-reports',
    area: 'apps',
    kind: 'abuse',
    label: 'Listing reports per hour',
    window: rolling(HOUR),
    base: 20,
    message: 'Too many reports — slow down.',
  },
  {
    id: 'apps.listing-changes',
    area: 'apps',
    kind: 'abuse',
    label: 'Listing unpublishes and republishes per hour',
    window: rolling(HOUR),
    base: 30,
    message: 'Too many listing changes — slow down.',
  },
  {
    id: 'apps.listing-visibility-changes',
    area: 'apps',
    kind: 'abuse',
    label: 'Listing visibility changes per hour',
    window: rolling(HOUR),
    base: 30,
    message: 'Too many visibility changes — slow down.',
  },
  {
    // The store's reads: listings, app details and cards, forks, track records, featured apps.
    id: 'apps.marketplace-reads',
    area: 'apps',
    kind: 'abuse',
    label: 'App store reads per minute',
    window: rolling(60),
    base: 60,
    message: MARKETPLACE_READS_MESSAGE,
  },
  {
    id: 'apps.hidden-apps',
    area: 'apps',
    kind: 'abuse',
    label: 'Apps hidden or unhidden per minute',
    window: rolling(60),
    base: 60,
    message: 'Too many requests — slow down.',
  },
  {
    id: 'apps.review-submits',
    area: 'apps',
    kind: 'abuse',
    label: 'App reviews submitted per minute',
    window: rolling(60),
    base: 30,
    message: 'Too many review submissions — slow down.',
  },
  {
    id: 'apps.review-reads',
    area: 'apps',
    kind: 'abuse',
    label: 'App review reads per minute',
    window: rolling(60),
    base: 60,
    message: 'Too many review requests — slow down.',
  },
  {
    // The procedures' own hourly cap on both generation-source saves (beside `apps.generation-source`).
    id: 'apps.generation-source-saves',
    area: 'apps',
    kind: 'abuse',
    label: 'Generation source saves per hour',
    window: rolling(HOUR),
    base: 60,
    message: 'Too many generation sources saved — slow down.',
  },
  {
    id: 'apps.remix-submits',
    area: 'apps',
    kind: 'abuse',
    label: 'Remix submissions per hour',
    window: rolling(HOUR),
    base: 20,
  },
  {
    id: 'apps.remix-quotes',
    area: 'apps',
    kind: 'abuse',
    label: 'Remix quotes per minute',
    window: rolling(60),
    base: 30,
  },
  {
    id: 'apps.remix-team-quotes',
    area: 'apps',
    kind: 'abuse',
    label: 'Team remix quotes per minute',
    window: rolling(60),
    base: 120,
  },
  {
    id: 'apps.remix-run-steps',
    area: 'apps',
    kind: 'abuse',
    label: 'Remix steps run per minute',
    window: rolling(60),
    base: 30,
  },
] as const satisfies readonly UsageLimitDef[];

export type AppUsageLimitId = (typeof appUsageLimitDefs)[number]['id'];

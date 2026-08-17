// Pure helpers for backfill-model3d-views.ts. Separate module so the test can
// import them without pulling in the ClickHouse/Postgres clients the script
// builds at load.
import { MODEL3D_VIEW_TRACKING_CUTOVER } from '@civitai/shared';

// First Model3D row in production. Nothing can have been viewed before it.
export const DEFAULT_FROM = '2026-06-19';

// Detail pages only. `/3d-models/<id>/edit` and `/3d-models/<id>/reviews` are
// structurally identical to a slug segment, so they have to be excluded by name
// rather than by shape — an anchored id regex alone still matches them.
//
// Evaluated by ClickHouse's RE2, not by Node. Verified against 30 days of prod
// `pageViews`: 82,319 rows counted across 426 ids, 399 rows excluded as
// edit/reviews, 21 junk rows (`/3d-models#`, `/3d-modelshttps:/...`) excluded.
export const DETAIL_PREDICATE = `
  match(path, '^/3d-models/[0-9]+([/?#]|$)')
  AND NOT match(path, '^/3d-models/[0-9]+/(edit|reviews)([/?#]|$)')
`;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function parseArgs(argv: string[]) {
  const get = (flag: string) => {
    const i = argv.indexOf(flag);
    return i === -1 ? undefined : argv[i + 1];
  };

  const until = get('--until');
  const from = get('--from') ?? DEFAULT_FROM;
  const dryRun = argv.includes('--dry-run');

  if (!until) throw new Error('--until <YYYY-MM-DD> is required (exclusive upper bound)');
  if (!DATE_RE.test(until)) throw new Error(`--until must be YYYY-MM-DD, got "${until}"`);
  if (!DATE_RE.test(from)) throw new Error(`--from must be YYYY-MM-DD, got "${from}"`);
  if (from >= until) throw new Error(`--from (${from}) must be strictly before --until (${until})`);

  // The cutover is the contract between this backfill and live tracking. Letting
  // them disagree is how you get a duplicated or missing day that nothing detects.
  if (until !== MODEL3D_VIEW_TRACKING_CUTOVER)
    throw new Error(
      `--until must equal MODEL3D_VIEW_TRACKING_CUTOVER (${MODEL3D_VIEW_TRACKING_CUTOVER}), got "${until}". ` +
        `If the cutover moved, change the constant and redeploy — do not override it here.`
    );

  return { until, from, dryRun };
}

export function previousDay(date: string) {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

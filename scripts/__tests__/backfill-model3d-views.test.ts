import { describe, expect, it } from 'vitest';
import { MODEL3D_VIEW_TRACKING_CUTOVER } from '@civitai/shared';
import {
  DEFAULT_FROM,
  DETAIL_PREDICATE,
  parseArgs,
  previousDay,
} from '../oneoffs/backfill-model3d-views.helpers';

const CUTOVER = MODEL3D_VIEW_TRACKING_CUTOVER;

describe('parseArgs', () => {
  it('accepts --until at the cutover and defaults --from to the first Model3D row', () => {
    expect(parseArgs(['--until', CUTOVER])).toEqual({
      until: CUTOVER,
      from: DEFAULT_FROM,
      dryRun: false,
    });
  });

  it('refuses an --until that is not the cutover', () => {
    // daily_views sums on insert, so a backfill that stops short of (or runs past)
    // the first live-tracked day leaves a gap or a doubled day that nothing detects.
    expect(() => parseArgs(['--until', '2026-08-17'])).toThrow(
      /must equal MODEL3D_VIEW_TRACKING_CUTOVER/
    );
    expect(() => parseArgs(['--until', '2026-08-19'])).toThrow(
      /must equal MODEL3D_VIEW_TRACKING_CUTOVER/
    );
  });

  it('requires --until rather than defaulting it', () => {
    expect(() => parseArgs([])).toThrow(/--until <YYYY-MM-DD> is required/);
    expect(() => parseArgs(['--dry-run'])).toThrow(/--until <YYYY-MM-DD> is required/);
  });

  it('rejects a malformed date instead of passing it into SQL', () => {
    expect(() => parseArgs(['--until', "2026-08-18' OR 1=1 --"])).toThrow(/must be YYYY-MM-DD/);
    expect(() => parseArgs(['--until', CUTOVER, '--from', 'yesterday'])).toThrow(
      /must be YYYY-MM-DD/
    );
  });

  it('rejects an empty or inverted range', () => {
    expect(() => parseArgs(['--until', CUTOVER, '--from', CUTOVER])).toThrow(/strictly before/);
    expect(() => parseArgs(['--until', CUTOVER, '--from', '2026-12-01'])).toThrow(
      /strictly before/
    );
  });

  it('picks up --dry-run', () => {
    expect(parseArgs(['--until', CUTOVER, '--dry-run']).dryRun).toBe(true);
  });
});

describe('previousDay', () => {
  it('returns the inclusive last day covered by an exclusive --until', () => {
    expect(previousDay(CUTOVER)).toBe('2026-08-17');
  });

  it('crosses month and year boundaries', () => {
    expect(previousDay('2026-09-01')).toBe('2026-08-31');
    expect(previousDay('2027-01-01')).toBe('2026-12-31');
    expect(previousDay('2028-03-01')).toBe('2028-02-29');
  });
});

describe('DETAIL_PREDICATE', () => {
  // Shape checks only. The predicate is evaluated by ClickHouse's RE2, not by
  // Node, so this suite cannot prove its matching behaviour — that was verified
  // against 30 days of prod pageViews (82,319 counted / 399 edit+reviews
  // excluded / 21 junk excluded) and is recorded in the helper's comment.
  it('stays anchored so junk like /3d-modelshttps:/... cannot be swept in', () => {
    expect(DETAIL_PREDICATE).toContain("'^/3d-models/[0-9]+");
  });

  it('excludes the owner surfaces by name, not by path shape', () => {
    // `/3d-models/1/edit` and `/3d-models/1/my-slug` are the same shape, so an
    // id-anchored regex alone still matches the edit page.
    expect(DETAIL_PREDICATE).toMatch(/NOT match\([^)]*\(edit\|reviews\)/);
  });
});

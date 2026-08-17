import { describe, expect, it } from 'vitest';
import { MODEL3D_VIEW_TRACKING_CUTOVER } from '@civitai/shared';
import {
  DEFAULT_FROM,
  DETAIL_PREDICATE,
  parseArgs,
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

describe('DETAIL_PREDICATE', () => {
  // A shape check, deliberately: the predicate is evaluated by ClickHouse's RE2
  // and never by Node, so no Node assertion can prove how it matches (that is
  // verified against prod). This one still earns its place — it fails if the
  // exclusion clause is removed, which is the plausible edit, since an
  // id-anchored regex looks sufficient until you notice /3d-models/1/edit and
  // /3d-models/1/my-slug are the same shape.
  it('excludes the owner surfaces by name', () => {
    expect(DETAIL_PREDICATE).toContain('(edit|reviews)');
    expect(DETAIL_PREDICATE).toMatch(/AND NOT match\(/);
  });
});

import { describe, it, expect, vi } from 'vitest';

vi.mock('~/env/client', () => ({
  env: { NEXT_PUBLIC_IMAGE_LOCATION: 'https://image.test' },
}));

// The unit under test is pure, but importing the job module pulls in the db client.
// Stub it so the suite never instantiates a real Prisma client.
vi.mock('~/server/db/client', () => ({
  dbRead: { image: { findMany: vi.fn(async () => []) } },
  dbWrite: { image: { findMany: vi.fn(async () => []) } },
}));

import type { AnnouncementMediaFinding } from '~/server/jobs/announcement-media-check';
import {
  classifyAnnouncementMedia,
  evaluateAnnouncementMedia,
  summarizeAnnouncementMediaFindings,
} from '~/server/jobs/announcement-media-check';

const KEY_A = 'aaaaaaaa-0000-0000-0000-000000000001';
const KEY_B = 'bbbbbbbb-0000-0000-0000-000000000002';

describe('classifyAnnouncementMedia', () => {
  it('flags a missing object as BROKEN', () => {
    expect(classifyAnnouncementMedia({ objectExists: false, hasImageRow: false })).toBe('broken');
  });

  it('flags a key backed by an Image row as AT RISK', () => {
    expect(classifyAnnouncementMedia({ objectExists: true, hasImageRow: true })).toBe('at-risk');
  });

  it('reports OK when the object exists and no Image row references it', () => {
    expect(classifyAnnouncementMedia({ objectExists: true, hasImageRow: false })).toBe('ok');
  });

  it('lets BROKEN outrank AT RISK', () => {
    expect(classifyAnnouncementMedia({ objectExists: false, hasImageRow: true })).toBe('broken');
  });

  it('never manufactures BROKEN from an unknown bucket answer', () => {
    // null = couldn't consult the bucket. An infra hiccup must not page.
    expect(classifyAnnouncementMedia({ objectExists: null, hasImageRow: false })).toBe('ok');
    expect(classifyAnnouncementMedia({ objectExists: null, hasImageRow: true })).toBe('at-risk');
  });

  it('covers the full signal matrix with the intended precedence', () => {
    // Exhaustive over (objectExists x hasImageRow). Pinned as a table so a change to the
    // precedence rule is a deliberate edit here, not a silent behaviour change.
    const matrix: [boolean | null, boolean, string][] = [
      [false, false, 'broken'], // object gone -> BROKEN
      [false, true, 'broken'], // both -> BROKEN wins (already failed beats will-fail)
      [true, true, 'at-risk'], // Image row exists -> AT RISK
      [true, false, 'ok'], // neither -> OK
      [null, false, 'ok'], // can't tell -> fail open
      [null, true, 'at-risk'], // can't tell, but the row is a real risk on its own
    ];
    for (const [objectExists, hasImageRow, expected] of matrix) {
      expect(
        classifyAnnouncementMedia({ objectExists, hasImageRow }),
        `objectExists=${objectExists} hasImageRow=${hasImageRow}`
      ).toBe(expected);
    }
  });
});

describe('summarizeAnnouncementMediaFindings', () => {
  const finding = (over: Partial<AnnouncementMediaFinding> = {}): AnnouncementMediaFinding => ({
    key: KEY_A,
    announcementIds: [1],
    status: 'ok',
    objectExists: true,
    hasImageRow: false,
    ...over,
  });

  it('counts an unknown bucket answer as unknown, not as broken or ok-and-forgotten', () => {
    // 🔴 The regression this exists for: `null` folds into `ok` by design, so without a
    // separate count a fully fail-open run is indistinguishable from a healthy one.
    const summary = summarizeAnnouncementMediaFindings([
      finding({ objectExists: null, status: 'ok' }),
      finding({ key: KEY_B, objectExists: true, status: 'ok' }),
    ]);

    expect(summary).toMatchObject({ checked: 2, broken: 0, atRisk: 0, unknown: 1, blind: false });
  });

  it('an infrastructure error never produces a BROKEN count', () => {
    const summary = summarizeAnnouncementMediaFindings([
      finding({ objectExists: null }),
      finding({ key: KEY_B, objectExists: null }),
    ]);
    expect(summary.broken).toBe(0);
  });

  it('reports BLIND when the bucket could not be consulted for a single key', () => {
    // Rotated / re-scoped credentials: every answer is unknown. "The monitor cannot see"
    // must be its own alertable condition, separate from "a banner is broken".
    const summary = summarizeAnnouncementMediaFindings([
      finding({ objectExists: null }),
      finding({ key: KEY_B, objectExists: null }),
    ]);
    expect(summary).toMatchObject({ checked: 2, unknown: 2, broken: 0, blind: true });
  });

  it('is NOT blind when even one key got a definite answer', () => {
    const summary = summarizeAnnouncementMediaFindings([
      finding({ objectExists: null }),
      finding({ key: KEY_B, objectExists: false, status: 'broken' }),
    ]);
    expect(summary).toMatchObject({ unknown: 1, broken: 1, blind: false });
  });

  it('is NOT blind when there was nothing to check', () => {
    // An empty active-announcement list must not masquerade as a credential failure.
    expect(summarizeAnnouncementMediaFindings([])).toEqual({
      checked: 0,
      broken: 0,
      atRisk: 0,
      unknown: 0,
      renderFailures: 0,
      blind: false,
    });
  });

  it('counts render failures only where the cheap signals were clean', () => {
    const summary = summarizeAnnouncementMediaFindings([
      finding({ status: 'ok', renderedStatus: 404 }),
      finding({ key: KEY_B, status: 'at-risk', hasImageRow: true, renderedStatus: 503 }),
      finding({ key: 'c', status: 'broken', objectExists: false, renderedStatus: 404 }),
      finding({ key: 'd', status: 'ok', renderedStatus: 200 }),
      finding({ key: 'e', status: 'ok', renderedStatus: null }),
    ]);
    // The broken one is excluded — it is already alerted on the primary signal.
    expect(summary).toMatchObject({ checked: 5, broken: 1, atRisk: 1, renderFailures: 2 });
  });
});

describe('evaluateAnnouncementMedia', () => {
  const deps = (over: Partial<Parameters<typeof evaluateAnnouncementMedia>[1]> = {}) => ({
    objectExists: vi.fn(async () => true as boolean | null),
    findKeysWithImageRow: vi.fn(async () => [] as string[]),
    ...over,
  });

  it('classifies a missing object as broken and attributes the announcement', async () => {
    const d = deps({ objectExists: vi.fn(async () => false) });
    const findings = await evaluateAnnouncementMedia([{ id: 746, key: KEY_A }], d);

    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      key: KEY_A,
      status: 'broken',
      announcementIds: [746],
      objectExists: false,
    });
  });

  it('classifies a key that is also an Image url as at risk', async () => {
    const d = deps({ findKeysWithImageRow: vi.fn(async () => [KEY_A]) });
    const findings = await evaluateAnnouncementMedia([{ id: 748, key: KEY_A }], d);

    expect(findings[0]).toMatchObject({ status: 'at-risk', hasImageRow: true });
  });

  it('reports ok when neither condition holds', async () => {
    const findings = await evaluateAnnouncementMedia([{ id: 744, key: KEY_A }], deps());
    expect(findings[0]).toMatchObject({ status: 'ok', hasImageRow: false, objectExists: true });
  });

  it('checks a shared key once and attributes every announcement that references it', async () => {
    const d = deps({ objectExists: vi.fn(async () => false) });
    const findings = await evaluateAnnouncementMedia(
      [
        { id: 747, key: KEY_A },
        { id: 745, key: KEY_A },
        { id: 737, key: KEY_A },
        { id: 703, key: KEY_A },
        { id: 738, key: KEY_B },
      ],
      d
    );

    expect(d.objectExists).toHaveBeenCalledTimes(2);
    expect(d.findKeysWithImageRow).toHaveBeenCalledWith([KEY_A, KEY_B]);

    const shared = findings.find((f) => f.key === KEY_A);
    expect(shared?.announcementIds).toEqual([747, 745, 737, 703]);
  });

  it('does no lookups when nothing is referenced', async () => {
    const d = deps();
    expect(await evaluateAnnouncementMedia([], d)).toEqual([]);
    expect(d.findKeysWithImageRow).not.toHaveBeenCalled();
    expect(d.objectExists).not.toHaveBeenCalled();
  });

  it('runs the rendered-variant probe only when the cheap signals are clean', async () => {
    const probeRenderedVariant = vi.fn(async () => 200 as number | null);
    const d = deps({
      objectExists: vi.fn(async (key: string) => key !== KEY_A),
      probeRenderedVariant,
    });

    const findings = await evaluateAnnouncementMedia(
      [
        { id: 1, key: KEY_A },
        { id: 2, key: KEY_B },
      ],
      d
    );

    expect(probeRenderedVariant).toHaveBeenCalledTimes(1);
    expect(probeRenderedVariant).toHaveBeenCalledWith(KEY_B);
    expect(findings.find((f) => f.key === KEY_A)?.renderedStatus).toBeUndefined();
    expect(findings.find((f) => f.key === KEY_B)?.renderedStatus).toBe(200);
  });

  it('surfaces a failed rendered-variant probe without downgrading the cheap signals', async () => {
    const d = deps({ probeRenderedVariant: vi.fn(async () => 404) });
    const findings = await evaluateAnnouncementMedia([{ id: 9, key: KEY_A }], d);

    expect(findings[0]).toMatchObject({ status: 'ok', renderedStatus: 404 });
  });

  it('still probes an AT RISK key — its object is present and should be serving', async () => {
    const probeRenderedVariant = vi.fn(async () => 200 as number | null);
    const d = deps({ findKeysWithImageRow: vi.fn(async () => [KEY_A]), probeRenderedVariant });
    const findings = await evaluateAnnouncementMedia([{ id: 3, key: KEY_A }], d);

    expect(probeRenderedVariant).toHaveBeenCalledWith(KEY_A);
    expect(findings[0]).toMatchObject({ status: 'at-risk', renderedStatus: 200 });
  });

  it('carries an unknown bucket answer through to the finding', async () => {
    const d = deps({ objectExists: vi.fn(async () => null) });
    const findings = await evaluateAnnouncementMedia([{ id: 4, key: KEY_A }], d);

    expect(findings[0]).toMatchObject({ status: 'ok', objectExists: null });
    expect(summarizeAnnouncementMediaFindings(findings)).toMatchObject({
      unknown: 1,
      broken: 0,
      blind: true,
    });
  });

  it('ignores announcements with an empty key rather than checking ""', async () => {
    const d = deps();
    const findings = await evaluateAnnouncementMedia([{ id: 5, key: '' }], d);

    expect(findings).toEqual([]);
    expect(d.objectExists).not.toHaveBeenCalled();
    expect(summarizeAnnouncementMediaFindings(findings).blind).toBe(false);
  });
});

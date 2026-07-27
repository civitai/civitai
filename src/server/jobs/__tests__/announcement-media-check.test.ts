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

import {
  classifyAnnouncementMedia,
  evaluateAnnouncementMedia,
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
});

import type { PGlite } from '@electric-sql/pglite';
import { Kysely } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { freshPglite } from '../../../test/pglite';
import { pgliteDialect } from '$lib/server/__tests__/abuse-detection-pglite.harness';
import { IMAGE_PAGES_SCHEMA } from '$lib/server/__tests__/appeal-media-schema';

/**
 * The two detail endpoints a model-flag row opens: neither may send a withheld cover's key to a
 * moderator without the CSAM grant. Without a database the withheld read fails and withholds every
 * image; against pglite it withholds only what the rule withholds, and nothing from a grant holder.
 */

const grants = vi.hoisted(() => ({ paths: new Set<string>() }));
vi.mock('$lib/server/access', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  canAccess: (_user: unknown, path: string) => grants.paths.has(path),
}));
vi.mock('$lib/server/minor-queue-access', () => ({ canAccessMinorQueue: () => true }));
const dbHandle = vi.hoisted(() => ({ current: null as unknown }));
vi.mock('$lib/server/db', () => ({
  dbRead: {},
  get dbWrite() {
    return (
      dbHandle.current ?? {
        transaction: () => ({ execute: async () => Promise.reject(new Error('no database')) }),
      }
    );
  },
}));
vi.mock('$lib/server/axiom', () => ({ logToAxiom: vi.fn(async () => {}) }));
const previews = vi.hoisted(() => ({ getModelPreview: vi.fn() }));
vi.mock('$lib/server/model-preview.service', () => previews);
const hash = vi.hoisted(() => ({
  getMinorHashMatchDetail: vi.fn(),
  getAutoFlaggedMinorDetail: vi.fn(),
}));
vi.mock('$lib/server/minor-hash.service', () => hash);

const previewRoute = await import('../model-preview/[modelId]/+server');
const hashRoute = await import('../minor-hash-detail/[modelId]/+server');
const { MODEL_FLAGS_APPEALS_PATH } = await import('$lib/minor-flags/paths');

const IMAGE = 990000701;
const COVER = 990000702;
let user: { id: number; roles: string[] } = { id: 2, roles: [] };

const call = async (route: { GET: unknown }, query = '') =>
  (
    await (route.GET as (e: unknown) => Promise<Response>)({
      params: { modelId: '5' },
      url: new URL(`http://mod.test/api/x/5${query}`),
      locals: { user, grants: {} },
    })
  ).json();

const detail = {
  modelCoverId: COVER,
  modelCoverUrl: 'cover-key',
  modelCoverType: 'image',
  minorModelCoverId: null,
  minorModelCoverUrl: null,
  minorModelCoverType: null,
};

beforeEach(() => {
  user = { id: 2, roles: [] };
  grants.paths = new Set([MODEL_FLAGS_APPEALS_PATH]);
  previews.getModelPreview.mockResolvedValue({
    id: 5,
    images: [
      {
        id: IMAGE,
        url: 'image-key',
        type: 'image',
        nsfwLevel: 1,
        blocked: false,
        minor: true,
        acceptableMinor: false,
      },
    ],
  });
  hash.getMinorHashMatchDetail.mockResolvedValue(detail);
  hash.getAutoFlaggedMinorDetail.mockResolvedValue({ match: null, detail });
});

describe('the model preview endpoint', () => {
  it('sends a withheld image with no key or flag', async () => {
    const body = await call(previewRoute);
    expect(body.images).toEqual([
      {
        id: IMAGE,
        url: '',
        type: 'image',
        nsfwLevel: 1,
        blocked: false,
        minor: false,
        acceptableMinor: false,
        restricted: true,
      },
    ]);
  });
});

describe('the file-match detail endpoint', () => {
  it.each([
    ['with the seed named', '?minorModelId=9'],
    ['resolving the seed', ''],
  ])('sends a withheld cover with no key, %s', async (_, query) => {
    const body = await call(hashRoute, query);
    expect(body.detail).toMatchObject({
      modelCoverId: null,
      modelCoverUrl: null,
      modelCoverType: null,
      modelCoverWithheld: true,
    });
    expect(JSON.stringify(body)).not.toContain('cover-key');
  });
});

describe('both endpoints, against a real withheld read', () => {
  const OPEN = 990000703;
  let db: PGlite;
  beforeAll(async () => {
    db = await freshPglite();
    await db.exec(IMAGE_PAGES_SCHEMA);
    await db.exec(`INSERT INTO "Image" (id, url, "needsReview") VALUES
      (${IMAGE}, 'image-key', 'csam'), (${COVER}, 'cover-key', 'csam'), (${OPEN}, 'open-key', NULL)`);
    dbHandle.current = new Kysely({ dialect: pgliteDialect(db) });
  });
  afterAll(async () => {
    dbHandle.current = null;
    await db.close();
  });
  beforeEach(() => {
    previews.getModelPreview.mockResolvedValue({
      id: 5,
      images: [
        {
          id: IMAGE,
          url: 'image-key',
          type: 'image',
          nsfwLevel: 1,
          blocked: false,
          minor: true,
          acceptableMinor: false,
        },
        {
          id: OPEN,
          url: 'open-key',
          type: 'image',
          nsfwLevel: 1,
          blocked: false,
          minor: true,
          acceptableMinor: false,
        },
      ],
    });
    const both = {
      ...detail,
      minorModelCoverId: OPEN,
      minorModelCoverUrl: 'open-key',
      minorModelCoverType: 'image',
    };
    hash.getMinorHashMatchDetail.mockResolvedValue(both);
    hash.getAutoFlaggedMinorDetail.mockResolvedValue({ match: null, detail: both });
  });
  const grantCsam = () => grants.paths.add('/images/csam');

  it('withholds only the marked image from a moderator without the grant', async () => {
    const preview = await call(previewRoute);
    expect(preview.images.map((i: { url: string }) => i.url)).toEqual(['', 'open-key']);
    const { detail: d } = await call(hashRoute, '?minorModelId=9');
    expect(d).toMatchObject({ modelCoverUrl: null, minorModelCoverUrl: 'open-key' });
  });

  it('sends every key to a grant holder', async () => {
    grantCsam();
    const preview = await call(previewRoute);
    expect(preview.images.map((i: { url: string }) => i.url)).toEqual(['image-key', 'open-key']);
    const { detail: d } = await call(hashRoute, '?minorModelId=9');
    expect(d).toMatchObject({ modelCoverUrl: 'cover-key', minorModelCoverUrl: 'open-key' });
  });
});

import type { PGlite } from '@electric-sql/pglite';
import { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { freshPglite } from '../../../test/pglite';
import { pgliteDialect } from './abuse-detection-pglite.harness';
import { IMAGE_PAGES_SCHEMA } from './appeal-media-schema';

/**
 * What the article, report and CSAM-hold reads send for an image the media access rule
 * (`restrictedImageIds`) withholds from this moderator: no key, beside an open control image sent
 * as it is. The withheld image carries no mark of its own; a copy on its url is blocked as CSAM.
 */

vi.setConfig({ hookTimeout: 60_000 });

const { dbHandle } = vi.hoisted(() => ({ dbHandle: { current: null as unknown } }));
const db_ = () => {
  if (!dbHandle.current) throw new Error('the pglite client was not installed for this test');
  return dbHandle.current;
};
vi.mock('$lib/server/db', () => ({
  get dbRead() {
    return db_();
  },
  get dbWrite() {
    return db_();
  },
}));
vi.mock('$env/dynamic/private', () => ({ env: {} }));
vi.mock('$app/server', () => ({ getRequestEvent: vi.fn() }));

const WITHHELD = 901;
const CONTROL = 902;
const COPY = 903;
const OWNER = 7;
const KEY = 'withheld-key';
const CONTROL_KEY = 'control-key';

const WITHOUT_GRANT = { id: 2, roles: [] } as never;
const WITH_GRANT = { id: 3, roles: ['moderator:admin'] } as never;

const SCHEMA = `${IMAGE_PAGES_SCHEMA}
ALTER TABLE "Article" ADD COLUMN title TEXT, ADD COLUMN status TEXT, ADD COLUMN "userId" INTEGER,
  ADD COLUMN "createdAt" TIMESTAMP(3) NOT NULL DEFAULT now(), ADD COLUMN "publishedAt" TIMESTAMP(3),
  ADD COLUMN metadata JSONB;
ALTER TABLE "User" ADD COLUMN image TEXT;
ALTER TABLE "Model" ADD COLUMN name TEXT, ADD COLUMN type TEXT, ADD COLUMN status TEXT,
  ADD COLUMN mode TEXT, ADD COLUMN nsfw BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "nsfwLevel" INTEGER NOT NULL DEFAULT 0, ADD COLUMN poi BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN minor BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "tosViolation" BOOLEAN NOT NULL DEFAULT false, ADD COLUMN "deletedAt" TIMESTAMP(3),
  ADD COLUMN "createdAt" TIMESTAMP(3) NOT NULL DEFAULT now(), ADD COLUMN "userId" INTEGER;
ALTER TABLE "ModelVersion" ADD COLUMN index INTEGER;
CREATE TABLE "ServiceDealReview" (
  id INTEGER PRIMARY KEY, "dealId" INTEGER, "buyerId" INTEGER, verdict TEXT, comment TEXT, "sellerReply" TEXT,
  "publishedAt" TIMESTAMP(3), "hiddenAt" TIMESTAMP(3)
);
CREATE TABLE "ServiceDealReviewReport" ("reportId" INTEGER, "serviceDealReviewId" INTEGER);
`;

let db: PGlite;

beforeEach(async () => {
  db = await freshPglite();
  await db.exec(SCHEMA);
  await db.exec(`
    INSERT INTO "User" (id, username) VALUES (${OWNER}, 'owner');
    INSERT INTO "Image" (id, url, type, "blockedFor", "userId", "postId", index) VALUES
      (${WITHHELD}, '${KEY}', 'image', NULL, ${OWNER}, 60, 0),
      (${CONTROL}, '${CONTROL_KEY}', 'image', NULL, ${OWNER}, 61, 0),
      (${COPY}, '${KEY}', 'image', 'CSAM', 99, NULL, NULL);
  `);
  dbHandle.current = new Kysely({ dialect: pgliteDialect(db) });
});

afterEach(async () => {
  dbHandle.current = null;
  await db.close();
});

type Row = Record<string, unknown>;
const find = (rows: Row[], field: string, id: number) => rows.find((r) => r[field] === id);

describe('/articles/unpublished covers', () => {
  const articles = async (viewer: never) => {
    await db.exec(`INSERT INTO "Article" (id, title, status, "userId", "coverId") VALUES
      (1, 'withheld cover', 'Unpublished', ${OWNER}, ${WITHHELD}),
      (2, 'open cover', 'Unpublished', ${OWNER}, ${CONTROL})`);
    const { getModeratorArticles } = await import('../articles.service');
    return (await getModeratorArticles({ viewer })).items as unknown as Row[];
  };

  it('sends a withheld cover with no key to a moderator without the grant', async () => {
    const rows = await articles(WITHOUT_GRANT);
    expect(find(rows, 'id', 1)).toMatchObject({ coverUrl: null, coverRestricted: true });
    expect(find(rows, 'id', 2)).toMatchObject({ coverUrl: CONTROL_KEY, coverRestricted: false });
  });

  it('sends it to a moderator with the grant', async () => {
    expect(find(await articles(WITH_GRANT), 'id', 1)).toMatchObject({ coverUrl: KEY });
  });

  it("never sends the author's legacy profile image", async () => {
    await db.exec(`UPDATE "User" SET image = '${KEY}' WHERE id = ${OWNER}`);
    for (const row of await articles(WITH_GRANT)) expect(row).not.toHaveProperty('userImage');
  });
});

describe('/reports/user models tab covers', () => {
  const models = async (viewer: never) => {
    await db.exec(`
      INSERT INTO "Model" (id, name, type, status, "userId") VALUES
        (10, 'withheld', 'Checkpoint', 'Published', ${OWNER}),
        (11, 'open', 'Checkpoint', 'Published', ${OWNER});
      INSERT INTO "ModelVersion" (id, "modelId", index) VALUES (20, 10, 0), (21, 11, 0);
      INSERT INTO "Post" (id, "userId", "modelVersionId") VALUES (60, ${OWNER}, 20), (61, ${OWNER}, 21);`);
    const { getReportedAccountModels } = await import('../reported-account.service');
    return (await getReportedAccountModels(OWNER, viewer)).items as unknown as Row[];
  };

  it('sends a withheld cover with no key to a moderator without the grant', async () => {
    const rows = await models(WITHOUT_GRANT);
    expect(find(rows, 'id', 10)).toMatchObject({ coverUrl: null, coverRestricted: true });
    expect(find(rows, 'id', 11)).toMatchObject({ coverUrl: CONTROL_KEY, coverRestricted: false });
  });

  it('sends it to a moderator with the grant', async () => {
    expect(find(await models(WITH_GRANT), 'id', 10)).toMatchObject({ coverUrl: KEY });
  });
});

describe('/reports/user images tab', () => {
  beforeEach(async () => {
    await db.exec(`UPDATE "Image" SET name = 'file.png',
      meta = '{"prompt": "secret prompt", "negativePrompt": "secret negative"}'
      WHERE id = ${WITHHELD}`);
  });
  const images = async (viewer: never, prompt = '') => {
    const { getSuspectImages, EMPTY_SUSPECT_FILTERS } = await import('../report-triage.service');
    return getSuspectImages(OWNER, { ...EMPTY_SUSPECT_FILTERS, prompt }, { viewer });
  };

  it('sends a withheld image with no key, prompt or name to a moderator without the grant', async () => {
    const rows = (await images(WITHOUT_GRANT)).items as unknown as Row[];
    expect(find(rows, 'id', WITHHELD)).toMatchObject({
      url: '',
      restricted: true,
      prompt: null,
      negativePrompt: null,
      name: null,
    });
    expect(find(rows, 'id', CONTROL)).toMatchObject({ url: CONTROL_KEY });
  });

  it('sends it to a moderator with the grant', async () => {
    const rows = (await images(WITH_GRANT)).items as unknown as Row[];
    expect(find(rows, 'id', WITHHELD)).toMatchObject({ url: KEY });
  });

  // Otherwise paging the filter reads the withheld prompt back a substring at a time.
  it('never matches a withheld image on its prompt for a moderator without the grant', async () => {
    const result = await images(WITHOUT_GRANT, 'secret');
    expect(result.items).toEqual([]);
    expect(result.matched).toBe(0);
  });

  it('matches it for a moderator with the grant', async () => {
    const result = await images(WITH_GRANT, 'secret');
    expect(result.items.map((i) => i.id)).toEqual([WITHHELD]);
  });
});

describe('/reports/user images tab match count', () => {
  it('stops counting at the cap and says so', async () => {
    const { getSuspectImages, EMPTY_SUSPECT_FILTERS, MATCH_COUNT_CAP } = await import(
      '../report-triage.service'
    );
    await db.exec(`INSERT INTO "Image" (id, url, "userId")
      SELECT 10000 + n, 'bulk-' || n, ${OWNER} FROM generate_series(1, ${MATCH_COUNT_CAP + 1}) n`);
    const result = await getSuspectImages(OWNER, EMPTY_SUSPECT_FILTERS, { viewer: WITH_GRANT });
    expect(result).toMatchObject({ matched: MATCH_COUNT_CAP, matchedCapped: true });
  });

  it('counts exactly below the cap', async () => {
    const { getSuspectImages, EMPTY_SUSPECT_FILTERS } = await import('../report-triage.service');
    const result = await getSuspectImages(OWNER, EMPTY_SUSPECT_FILTERS, { viewer: WITH_GRANT });
    expect(result).toMatchObject({ matched: 2, matchedCapped: false });
  });
});

describe('profile avatar and covers', () => {
  const media = (id: number, url: string) => ({ id, url, type: 'image', nsfwLevel: 1 });
  const shown = async (viewer: never) => {
    const { withheldProfileMedia } = await import('../user-lookup.service');
    return withheldProfileMedia(
      {
        profilePictureId: WITHHELD,
        profilePictureUrl: KEY,
        profilePictureType: 'image',
        profilePictureNsfwLevel: 1,
      } as never,
      {
        bio: null,
        message: null,
        sfwBio: null,
        sfwMessage: null,
        location: null,
        coverImage: media(WITHHELD, KEY),
        sfwCoverImage: media(CONTROL, CONTROL_KEY),
      },
      viewer
    );
  };

  it('sends a withheld avatar and cover with no key to a moderator without the grant', async () => {
    const { identity, profile } = await shown(WITHOUT_GRANT);
    expect(identity).toMatchObject({
      profilePictureUrl: null,
      profilePictureType: null,
      profilePictureRestricted: true,
    });
    expect(profile?.coverImage).toMatchObject({ url: '', type: null, restricted: true });
    expect(profile?.sfwCoverImage).toEqual(media(CONTROL, CONTROL_KEY));
  });

  it('sends them to a moderator with the grant', async () => {
    const { identity, profile } = await shown(WITH_GRANT);
    expect(identity).toMatchObject({ profilePictureUrl: KEY });
    expect(profile?.coverImage).toMatchObject({ url: KEY });
  });
});

describe('legacy profile image', () => {
  const shown = async (image: string, viewer: never) => {
    const { withheldProfileMedia } = await import('../user-lookup.service');
    return (await withheldProfileMedia({ image, profilePictureId: null } as never, null, viewer))
      .identity;
  };

  it('sends a url matching a withheld image as null to a moderator without the grant', async () => {
    expect(await shown(KEY, WITHOUT_GRANT)).toMatchObject({ image: null });
  });

  it('sends it to a moderator with the grant', async () => {
    expect(await shown(KEY, WITH_GRANT)).toMatchObject({ image: KEY });
  });

  it('sends a url of an open image as it is', async () => {
    expect(await shown(CONTROL_KEY, WITHOUT_GRANT)).toMatchObject({ image: CONTROL_KEY });
  });

  it('sends a url no image carries as it is, since nothing could withhold it', async () => {
    const url = 'https://avatars.example.com/a.png';
    expect(await shown(url, WITHOUT_GRANT)).toMatchObject({ image: url });
  });
});

describe('/reports/serviceOffering review images', () => {
  const reviews = async (viewer: never) => {
    await db.exec(`
      INSERT INTO "Report" (id, reason, status) VALUES (30, 'TOSViolation', 'Pending');
      INSERT INTO "ServiceDealReview" (id, "dealId", "buyerId", verdict) VALUES (40, 1, ${OWNER}, 'Positive');
      INSERT INTO "ServiceDealReviewReport" ("reportId", "serviceDealReviewId") VALUES (30, 40);
      INSERT INTO "ServiceDealReviewImage" ("reviewId", "imageId") VALUES (40, ${WITHHELD}), (40, ${CONTROL});`);
    const { getReportedServiceReviews } = await import('../service-review-reports.service');
    return (await getReportedServiceReviews([30], viewer)).get(30)!.images as unknown as Row[];
  };

  it('sends a withheld image with no key to a moderator without the grant', async () => {
    const rows = await reviews(WITHOUT_GRANT);
    expect(find(rows, 'id', WITHHELD)).toEqual({ id: WITHHELD, url: '', restricted: true });
    expect(find(rows, 'id', CONTROL)).toEqual({ id: CONTROL, url: CONTROL_KEY });
  });

  it('sends it to a moderator with the grant', async () => {
    expect(find(await reviews(WITH_GRANT), 'id', WITHHELD)).toMatchObject({ url: KEY });
  });
});

describe('/csam/text-holds media', () => {
  const tile = (id: number, url: string) => ({ id, url, nsfwLevel: 1 });
  const holds = async (viewer: never) => {
    const { withheldHoldMedia } = await import(
      '../../../routes/csam/text-holds/hold-context.server'
    );
    const [hold] = await withheldHoldMedia(
      [
        {
          id: 1,
          coverImages: [tile(WITHHELD, KEY), tile(CONTROL, CONTROL_KEY)],
          profile: {
            images: [tile(WITHHELD, KEY)],
            bio: null,
            message: null,
            sfwBio: null,
            sfwMessage: null,
            location: null,
          },
          parent: {
            type: 'post',
            id: 5,
            title: null,
            images: [tile(WITHHELD, KEY)],
            imageTotal: 1,
          },
          song: null,
          songWithheld: false,
          songUnavailable: false,
        },
      ],
      viewer
    );
    return hold;
  };

  it('sends the entity, profile and parent media with no key to a moderator without the grant', async () => {
    const hold = await holds(WITHOUT_GRANT);
    const withheld = { id: WITHHELD, url: '', restricted: true };
    expect(hold.coverImages).toEqual([{ ...withheld, nsfwLevel: 1 }, tile(CONTROL, CONTROL_KEY)]);
    expect(hold.profile?.images).toEqual([{ ...withheld, nsfwLevel: 1 }]);
    expect(hold.parent?.images).toEqual([{ ...withheld, nsfwLevel: 1 }]);
  });

  it('sends them to a moderator with the grant', async () => {
    const hold = await holds(WITH_GRANT);
    expect(hold.coverImages[0]).toMatchObject({ url: KEY });
    expect(hold.profile?.images[0]).toMatchObject({ url: KEY });
  });
});

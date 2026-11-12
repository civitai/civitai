import { PGlite } from '@electric-sql/pglite';
import { Prisma } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { constants } from '~/server/common/constants';
import {
  assertGatedLinkTargets,
  assertGatedVersionsJudged,
  disallowedLinkTargets,
  isLinkTargetOfLiveGatedVersion,
} from '~/server/services/pre-publish-gate/publish-guard';

/**
 * The link-target rule against Postgres. A version on a gated base model may link only to an official
 * component or to a live version on a gated base model, whose files the same guards freeze.
 */

const OWNER = 7;
const OTHER_USER = 8;
const OFFICIAL = constants.system.officialUserId;
// Versions: 1 the owner's draft Fibo; 2 the owner's own VAE; 3 another user's VAE; 4 an official VAE;
// 5 a live Fibo version (reviewed); 6 the owner's live Fibo version; 7 a draft Fibo of another model.
const V = { draft: 1, ownVae: 2, thirdParty: 3, official: 4, reviewed: 5, live: 6, otherDraft: 7 };

let db: PGlite;
const tx = {
  $queryRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const flat = Prisma.sql(strings, ...(values as never[]));
    return (await db.query(flat.text, flat.values as unknown[])).rows;
  },
} as unknown as Prisma.TransactionClient;

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`
    CREATE TABLE "Model" (id int PRIMARY KEY, "userId" int, nsfw boolean NOT NULL DEFAULT false);
    CREATE TABLE "ModelVersion" (id int PRIMARY KEY, "modelId" int, status text, "baseModel" text);
    CREATE TABLE "RecommendedResource" (
      id serial PRIMARY KEY, "sourceId" int, "resourceId" int, settings jsonb
    );
    INSERT INTO "Model" (id, "userId") VALUES (10, ${OWNER}), (11, ${OWNER}), (12, ${OTHER_USER}), (13, ${OFFICIAL}),
      (14, ${OTHER_USER});
    INSERT INTO "ModelVersion" VALUES
      (${V.draft}, 10, 'Draft', 'Fibo 2.0'),
      (${V.ownVae}, 11, 'Published', 'SDXL 1.0'),
      (${V.thirdParty}, 12, 'Published', 'SDXL 1.0'),
      (${V.official}, 13, 'Published', 'SDXL 1.0'),
      (${V.reviewed}, 14, 'Published', 'Fibo 2.0'),
      (${V.live}, 10, 'Published', 'Fibo 2.0'),
      (${V.otherDraft}, 14, 'Draft', 'Fibo 2.0');
  `);
});
afterAll(() => db.close());

const link = (sourceId: number, resourceId: number) =>
  db.query(
    `INSERT INTO "RecommendedResource" ("sourceId", "resourceId", settings)
     VALUES ($1, $2, '{"isLinkedComponent": true, "fileId": 1}')`,
    [sourceId, resourceId]
  );
const unlinkAll = () => db.exec(`DELETE FROM "RecommendedResource"`);

describe('which targets a gated version may link to', () => {
  it("refuses the owner's own version and another user's", async () => {
    expect(await disallowedLinkTargets(tx, [V.ownVae, V.thirdParty])).toEqual([
      V.ownVae,
      V.thirdParty,
    ]);
  });

  it('refuses a draft on a gated base model, and a version that does not exist', async () => {
    expect(await disallowedLinkTargets(tx, [V.otherDraft, 999])).toEqual([V.otherDraft, 999]);
  });

  it('allows an official component and a live version on a gated base model (control)', async () => {
    expect(await disallowedLinkTargets(tx, [V.official, V.reviewed])).toEqual([]);
  });
});

describe('publishing a gated version that already carries links', () => {
  it('refuses a draft carrying a third-party link made before the rule', async () => {
    await unlinkAll();
    await link(V.draft, V.thirdParty);
    await expect(assertGatedLinkTargets(tx, [V.draft])).rejects.toThrowError(
      /official components or other reviewed versions/
    );
  });

  it('publishes a draft whose links are all allowed (control)', async () => {
    await unlinkAll();
    await link(V.draft, V.official);
    await link(V.draft, V.reviewed);
    await expect(assertGatedLinkTargets(tx, [V.draft])).resolves.toBeUndefined();
  });
});

describe('a version that a live gated version links to', () => {
  it('is found, whoever owns it', async () => {
    await unlinkAll();
    await link(V.live, V.thirdParty);
    expect(await isLinkTargetOfLiveGatedVersion(tx, [V.thirdParty])).toBe(true);
  });

  it('is not found when only a draft links to it (control)', async () => {
    await unlinkAll();
    await link(V.draft, V.thirdParty);
    expect(await isLinkTargetOfLiveGatedVersion(tx, [V.thirdParty])).toBe(false);
  });
});

describe('a gated publish under its lock', () => {
  it('refuses a model marked mature since the gate judged it', async () => {
    await unlinkAll();
    await db.exec(`UPDATE "Model" SET nsfw = true WHERE id = 10`);
    await expect(assertGatedVersionsJudged(tx, [V.draft], [V.draft])).rejects.toThrow(
      'Models marked as mature content cannot use this base model.'
    );
    await db.exec(`UPDATE "Model" SET nsfw = false WHERE id = 10`);
  });

  it('publishes the same version while the model is not mature (control)', async () => {
    await unlinkAll();
    await expect(assertGatedVersionsJudged(tx, [V.draft], [V.draft])).resolves.toBeUndefined();
  });
});

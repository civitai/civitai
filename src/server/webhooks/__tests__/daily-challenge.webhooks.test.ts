import { PGlite } from '@electric-sql/pglite';
import { Prisma } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { NsfwLevel } from '~/server/common/enums';
import { pgliteRaw } from '~/server/events/__tests__/pglite-prisma';
import { getChallengeConfig } from '~/server/games/daily-challenge/daily-challenge.utils';
import { dailyChallengeWebhooks } from '~/server/webhooks/daily-challenge.webhooks';

describe('daily challenge webhooks', () => {
  it.each(['daily-challenge-complete', 'daily-challenge-start', 'new-daily-challenge'] as const)(
    '%s follows the article availability rule',
    async (event) => {
      const issued: string[] = [];
      const $queryRaw = vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
        issued.push(Prisma.sql(strings, ...(values as never[])).text);
        return [];
      });
      await dailyChallengeWebhooks[event].getData({
        lastSent: new Date(0),
        prisma: { $queryRaw },
      } as never);
      expect(issued).toHaveLength(1);
      expect(issued[0]).toMatch(/AND a\.availability != 'Private'\s+AND a\.metadata->>'status'/);
    }
  );
});

const EVENTS = [
  ['daily-challenge-complete', 'complete'],
  ['daily-challenge-start', 'active'],
  ['new-daily-challenge', 'pending'],
] as const;

describe('daily challenge webhooks on Postgres — the cover', () => {
  let db: PGlite;
  beforeAll(async () => {
    db = new PGlite();
    await db.exec(`
      CREATE TYPE "Availability" AS ENUM ('Public', 'Unsearchable', 'Private', 'EarlyAccess');
      CREATE TABLE "Post" (id int PRIMARY KEY, "publishedAt" timestamp(3), availability "Availability" NOT NULL DEFAULT 'Public');
      CREATE TABLE "Image" (
        id int PRIMARY KEY, url text, "userId" int NOT NULL DEFAULT 1, "modelRestricted" boolean NOT NULL DEFAULT false,
        "nsfwLevel" int NOT NULL DEFAULT ${NsfwLevel.PG}, "tosViolation" boolean NOT NULL DEFAULT false,
        "postId" int REFERENCES "Post"(id), "needsReview" text,
        minor boolean NOT NULL DEFAULT false, "acceptableMinor" boolean NOT NULL DEFAULT false
      );
      CREATE TABLE "Article" (
        id int PRIMARY KEY, title text NOT NULL, "coverId" int, metadata jsonb NOT NULL DEFAULT '{}',
        availability "Availability" NOT NULL DEFAULT 'Public', "updatedAt" timestamp(3) NOT NULL DEFAULT now()
      );
      CREATE TABLE "CollectionItem" (id serial PRIMARY KEY, "collectionId" int, "articleId" int);
      CREATE TABLE "CsamReport" (id serial PRIMARY KEY, "userId" int, images jsonb);
    `);
  });
  afterAll(() => db?.close());

  let nextId = 1;
  async function sentCover(
    name: (typeof EVENTS)[number][0],
    status: string,
    { listed }: { listed: boolean }
  ) {
    const id = nextId++;
    await db.query('DELETE FROM "CollectionItem"');
    await db.query(`INSERT INTO "Image" (id, url) VALUES ($1, $2)`, [id, `cover-${id}`]);
    if (listed)
      await db.query(`INSERT INTO "CsamReport" (images) VALUES ($1)`, [`[{"id": ${id}}]`]);
    await db.query(
      `INSERT INTO "Article" (id, title, "coverId", metadata) VALUES ($1, 'A', $1, $2)`,
      [id, JSON.stringify({ status })]
    );
    const { challengeCollectionId } = await getChallengeConfig();
    await db.query(`INSERT INTO "CollectionItem" ("collectionId", "articleId") VALUES ($1, $2)`, [
      challengeCollectionId,
      id,
    ]);
    const sent = (await dailyChallengeWebhooks[name].getData({
      lastSent: new Date(0),
      prisma: { $queryRaw: pgliteRaw(db).queryRaw },
    } as never)) as { id: number; cover: string | null }[];
    expect(sent.map((challenge) => challenge.id)).toEqual([id]);
    return { cover: sent[0].cover, url: `cover-${id}` };
  }

  it.each(EVENTS)('%s sends an unlisted cover (control)', async (name, status) => {
    const { cover, url } = await sentCover(name, status, { listed: false });
    expect(cover).toContain(url);
  });

  it.each(EVENTS)('🔴 %s sends no cover listed on a report', async (name, status) => {
    const { cover } = await sentCover(name, status, { listed: true });
    expect(cover).toBeNull();
  });
});

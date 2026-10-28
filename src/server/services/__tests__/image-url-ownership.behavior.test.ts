import { PGlite } from '@electric-sql/pglite';
import { TRPCError } from '@trpc/server';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { pgliteRaw } from '~/server/events/__tests__/pglite-prisma';

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

const holder = vi.hoisted(() => ({ db: null as unknown as PGlite }));
dbMock.dbWrite.$queryRaw.mockImplementation(((
  ...a: Parameters<ReturnType<typeof pgliteRaw>['queryRaw']>
) => pgliteRaw(holder.db).queryRaw(...a)) as never);

const { assertClientImageUrlsUsable, COVER_IMAGE_UNAVAILABLE_MESSAGE } = await import(
  '~/server/services/image-url-ownership'
);

const CALLER = 7;
const OTHER = 8;
const OWN_KEY = '0a0b0c0d-0000-4000-8000-00000000000a';
const OTHERS_LIVE_KEY = '0a0b0c0d-0000-4000-8000-00000000000b';
const OTHERS_PENDING_KEY = '0a0b0c0d-0000-4000-8000-00000000000c';
const FRESH_KEY = '0a0b0c0d-0000-4000-8000-00000000000d';

beforeAll(async () => {
  holder.db = new PGlite();
  await holder.db.exec(`
    CREATE TABLE "Image" (
      "id" serial PRIMARY KEY, "userId" integer NOT NULL, "url" text NOT NULL,
      "ingestion" text NOT NULL DEFAULT 'Scanned'
    );
  `);
});

beforeEach(async () => {
  await holder.db.exec(`TRUNCATE "Image"`);
  await holder.db.exec(`
    INSERT INTO "Image" ("userId", url, ingestion) VALUES
      (${CALLER}, '${OWN_KEY}', 'Scanned'),
      (${OTHER}, '${OTHERS_LIVE_KEY}', 'Scanned'),
      (${OTHER}, '${OTHERS_PENDING_KEY}', 'Pending');
  `);
});

const refused = (urls: (string | null)[]) =>
  assertClientImageUrlsUsable({ urls, userId: CALLER }).then(
    () => null,
    (e: unknown) => e
  );

describe('assertClientImageUrlsUsable', () => {
  it('accepts a key no row has and a key the caller owns', async () => {
    expect(await refused([FRESH_KEY])).toBeNull();
    expect(await refused([OWN_KEY])).toBeNull();
  });

  it("refuses a key owned by another user, whatever that row's state", async () => {
    for (const key of [OTHERS_LIVE_KEY, OTHERS_PENDING_KEY]) {
      const error = await refused([key]);
      expect(error).toBeInstanceOf(TRPCError);
      expect(error).toMatchObject({
        code: 'BAD_REQUEST',
        message: COVER_IMAGE_UNAVAILABLE_MESSAGE,
      });
    }
  });

  it("refuses a batch when any one key is another user's", async () => {
    expect(await refused([FRESH_KEY, OWN_KEY, OTHERS_LIVE_KEY])).toBeInstanceOf(TRPCError);
    expect(await refused([FRESH_KEY, OWN_KEY, null])).toBeNull();
  });

  it("refuses another user's key written in uppercase", async () => {
    expect(await refused([OTHERS_LIVE_KEY.toUpperCase()])).toBeInstanceOf(TRPCError);
    expect(await refused([OWN_KEY.toUpperCase()])).toBeNull();
  });

  it('checks the key a first-party full url names', async () => {
    const full = (key: string) =>
      `https://image.civitai.com/xG1nkqKTMzGDvpLrqFT7WA/${key}/original=true/${key}.jpeg`;

    expect(await refused([full(OTHERS_LIVE_KEY)])).toBeInstanceOf(TRPCError);
    expect(await refused([full(OTHERS_LIVE_KEY.toUpperCase())])).toBeInstanceOf(TRPCError);
    expect(await refused([full(OWN_KEY)])).toBeNull();
    expect(await refused([full(FRESH_KEY)])).toBeNull();
  });

  it("refuses another user's url stored in full or uppercase, given the same way", async () => {
    const stored = [
      `https://image.civitai.com/xG1nkqKTMzGDvpLrqFT7WA/${FRESH_KEY}/width=450/${FRESH_KEY}.jpeg`,
      FRESH_KEY.toUpperCase(),
    ];
    for (const url of stored) {
      await holder.db.exec(`TRUNCATE "Image"`);
      await holder.db.exec(`INSERT INTO "Image" ("userId", url) VALUES (${OTHER}, '${url}')`);

      expect(await refused([url])).toBeInstanceOf(TRPCError);
    }
  });

  it('checks every key a url carries, however it is spelled', async () => {
    const key = OTHERS_LIVE_KEY;
    const encoded = key.replace('-', '%2D');
    const spellings = [
      `\t${key}`,
      `${key.slice(0, 10)}\n${key.slice(10)}`,
      `${key.slice(0, 10)}\r${key.slice(10)}`,
      `x/../${key}`,
      `./${key}`,
      `${key}#x`,
      `${key}?x=1`,
      ` ${key} `,
      `https://image.civitai.com/xG1nkqKTMzGDvpLrqFT7WA/${encoded}/original=true/a.jpeg`,
      `https://image.civitai.com./xG1nkqKTMzGDvpLrqFT7WA/${key}/original=true/a.jpeg`,
      `https://example.invalid/${key}.png`,
      `https://example.invalid/${FRESH_KEY}/${key}.png`,
    ];
    for (const url of spellings) expect(await refused([url]), url).toBeInstanceOf(TRPCError);

    expect(await refused([`x/../${OWN_KEY}`, `\t${FRESH_KEY}`])).toBeNull();
  });

  it('refuses a url carrying more keys than any image url does', async () => {
    const many = Array.from(
      { length: 70 },
      (_, i) => `0a0b0c0d-0000-4000-8000-${String(i).padStart(12, '0')}`
    ).join('/');

    expect(await refused([many])).toBeInstanceOf(TRPCError);
    expect(await refused([`${FRESH_KEY}/${OWN_KEY}`])).toBeNull();
  });

  // Known gap: a row stored as a full url is matched only by that same url, not by its bare key.
  // If this starts refusing, the gap is closed: delete this test.
  it("does not see another user's row stored as a full url when given the bare key", async () => {
    const full = `https://image.civitai.com/xG1nkqKTMzGDvpLrqFT7WA/${FRESH_KEY}/width=450/a.jpeg`;
    await holder.db.exec(`INSERT INTO "Image" ("userId", url) VALUES (${OTHER}, '${full}')`);

    expect(await refused([FRESH_KEY])).toBeNull();
  });

  it('leaves a full external url alone', async () => {
    await holder.db.exec(
      `INSERT INTO "Image" ("userId", url) VALUES (${OTHER}, 'https://example.invalid/a.png')`
    );

    expect(await refused(['https://example.invalid/a.png'])).toBeNull();
  });
});

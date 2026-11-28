import { serverCopyTablesSql } from '@civitai/db-queries/test/image-uses';
import { PGlite } from '@electric-sql/pglite';
import { TRPCError } from '@trpc/server';
import type { Mock } from 'vitest';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import * as prom from '~/server/prom/client';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { redisMock } from '~/__tests__/mocks/redis.mock';
import { pgliteRaw } from '~/server/events/__tests__/pglite-prisma';

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

const holder = vi.hoisted(() => ({
  db: null as unknown as PGlite,
  issued: [] as { key: string; userId: number }[],
  logDown: false,
  logHangs: false,
  sql: [] as string[],
}));

vi.mock('~/server/clickhouse/client', () => ({
  clickhouse: {
    $query: async (sql: string) => {
      holder.sql.push(sql);
      if (holder.logHangs) return new Promise(() => undefined);
      if (holder.logDown) throw new Error('unavailable');
      // As ClickHouse does: a WHERE name matching a SELECT alias resolves to that aggregate.
      const alias = sql.match(/any\(userId\) AS (\w+)/)?.[1];
      const at = sql.indexOf('WHERE');
      if (!alias || at < 0 || new RegExp(`\\b${alias}\\b`).test(sql.slice(at)))
        throw new Error('Aggregate function any(userId) is found in WHERE');
      return holder.issued
        .filter(({ key }) => sql.includes(`'${key}'`))
        .map(({ key, userId }) => ({ key, [alias]: userId }));
    },
  },
}));

dbMock.dbWrite.$queryRaw.mockImplementation(((
  ...a: Parameters<ReturnType<typeof pgliteRaw>['queryRaw']>
) => pgliteRaw(holder.db).queryRaw(...a)) as never);

const {
  assertClientImageUrlsUsable,
  assertClientKeysIssuedToCaller,
  assertShopArtworkKeysIssued,
  keyIssueRecords,
  keyIssuers,
  recordUploadKeyOwner,
  UNFINISHED_UPLOAD_MESSAGE,
  UNRECORDED_KEYS_ACCEPTED_UNTIL,
  UPLOAD_KEY_OWNER_SYS_FALLBACK_UNTIL,
} = await import('~/server/services/image-url-ownership');

const CALLER = 7;
const OTHER = 8;
const KEY = 'ab12cd34-ef56-4a7b-8c9d-0e1f2a3b4c5d';
const BEFORE = new Date(UNRECORDED_KEYS_ACCEPTED_UNTIL.getTime() - 60_000);
const AFTER = new Date(UNRECORDED_KEYS_ACCEPTED_UNTIL.getTime() + 60_000);

/** The cluster's issue records, and sysRedis's: the store they were written to before the move. */
const redis = new Map<string, string>();
const sys = new Map<string, string>();

// The setup file stubs every registered metric; this is the stub the module built for its counter.
const counterAt = vi
  .mocked(prom.registerCounterWithLabels)
  .mock.calls.findIndex(([opts]) => opts.name === 'upload_key_owner_total');
const ownerCounter = vi.mocked(prom.registerCounterWithLabels).mock.results[counterAt].value as {
  inc: Mock;
};
const outcomeCount = (name: string) =>
  ownerCounter.inc.mock.calls.filter(([labels]) => labels.outcome === name).length;

beforeAll(async () => {
  holder.db = new PGlite();
  await holder.db.exec(`
    CREATE TABLE "Image" ("id" serial PRIMARY KEY, "userId" integer NOT NULL, "url" text NOT NULL);
    CREATE TABLE "ShopArtworkKeyOwner" (key text PRIMARY KEY, "userId" integer NOT NULL);
    ${serverCopyTablesSql};
  `);
});

beforeEach(async () => {
  await holder.db.exec(
    `TRUNCATE "Image", "ShopArtworkKeyOwner", "ServiceDealReviewImage", "ServiceDealFileEntry", "ServiceDealFile"`
  );
  holder.issued = [];
  holder.logDown = false;
  holder.logHangs = false;
  holder.sql = [];
  redis.clear();
  sys.clear();
  redisMock.redis.set.mockImplementation((async (key: string, value: string) => {
    redis.set(key, value);
    return 'OK';
  }) as never);
  redisMock.redis.mGet.mockImplementation((async (keys: string[]) =>
    keys.map((k) => redis.get(k) ?? null)) as never);
  redisMock.sysRedis.mGet.mockImplementation((async (keys: string[]) =>
    keys.map((k) => sys.get(k) ?? null)) as never);
});

const outcome = (url: string, now = AFTER) =>
  assertClientKeysIssuedToCaller({ urls: [url], userId: CALLER, now }).then(
    () => 'accepted',
    (e: unknown) => {
      if (e instanceof TRPCError && e.code === 'BAD_REQUEST') return 'refused';
      throw e;
    }
  );

describe('assertClientKeysIssuedToCaller', () => {
  it('accepts a key with no record and no row through 2026-12-09 15:59Z, and refuses it from 16:00Z', async () => {
    expect(await outcome(KEY, new Date('2026-12-09T15:59:59.999Z'))).toBe('accepted');
    const refused = outcomeCount('unrecorded_refused');
    expect(await outcome(KEY, new Date('2026-12-09T16:00:00Z'))).toBe('refused');
    expect(outcomeCount('unrecorded_refused')).toBe(refused + 1);
  });

  it('accepts a key issued to the caller', async () => {
    await recordUploadKeyOwner(KEY, CALLER);
    expect(await outcome(KEY)).toBe('accepted');
  });

  it('refuses a key issued to another user, in any form the url carries it', async () => {
    await recordUploadKeyOwner(KEY, OTHER);
    // Before the cutoff, so only the record of another issuee can refuse.
    expect(await outcome(KEY, BEFORE)).toBe('refused');
    expect(await outcome(KEY.toUpperCase(), BEFORE)).toBe('refused');
    expect(await outcome(KEY.replace(/-/g, '%2D'), BEFORE)).toBe('refused');
    expect(await outcome(`https://cdn.example/x/${KEY}/original=true`, BEFORE)).toBe('refused');
    const encoded = KEY.replace(/-/g, '%2D');
    expect(await outcome(`https://cdn.example/x/${encoded}/width=450/100%.jpeg`, BEFORE)).toBe(
      'refused'
    );
    expect(await outcome(`https://cdn.example/x/${encoded}?q=%ZZ`, BEFORE)).toBe('refused');
    expect(await outcome(KEY.replace(/-/g, '%252D'), BEFORE)).toBe('refused');
    expect(await outcome(KEY.replace(/-/g, '%2525252D'), BEFORE)).toBe('refused');
    // Whole only after the first pass: the second turns its leading `%2a` into `*`.
    const onlyMidway = `%252%61${KEY.slice(1).replace('-', '%2D')}`;
    expect(await outcome(onlyMidway, BEFORE)).toBe('refused');
    expect(await outcome(`${KEY.slice(0, 8)}%09${KEY.slice(8)}`, BEFORE)).toBe('refused');
    expect(await outcome(`11111111-2222-3333-4444-5555${KEY}`, BEFORE)).toBe('refused');
  });

  it('records a key in the form it is checked in', async () => {
    await recordUploadKeyOwner(KEY.toUpperCase(), OTHER);
    expect(await outcome(KEY, BEFORE)).toBe('refused');
  });

  it('refuses a key issued to a third user when a second user is named', async () => {
    await recordUploadKeyOwner(KEY, OTHER + 1);
    const refusal = await assertClientKeysIssuedToCaller({
      urls: [KEY],
      userId: CALLER,
      alsoIssuedTo: OTHER,
      now: AFTER,
    }).then(
      () => null,
      (e: unknown) => e
    );
    expect(refusal).toBeInstanceOf(TRPCError);
  });

  it('prefers the record over the upload request log', async () => {
    await recordUploadKeyOwner(KEY, CALLER);
    holder.issued = [{ key: KEY, userId: OTHER }];
    expect(await outcome(KEY)).toBe('accepted');
  });

  it('refuses a key issued to another user whose row stores it as a full url', async () => {
    await recordUploadKeyOwner(KEY, OTHER);
    await holder.db.exec(
      `INSERT INTO "Image" ("userId", url) VALUES (${OTHER}, 'https://cdn.example/x/${KEY}/original=true')`
    );
    expect(await outcome(KEY)).toBe('refused');
  });

  it('refuses a key issued to another user even when the caller has a row for it', async () => {
    await recordUploadKeyOwner(KEY, OTHER);
    await holder.db.exec(`INSERT INTO "Image" ("userId", url) VALUES (${CALLER}, '${KEY}')`);
    expect(await outcome(KEY)).toBe('refused');
  });

  it('accepts a key issued to the named second user, recorded or with a row', async () => {
    const outcomeFor = () =>
      assertClientKeysIssuedToCaller({
        urls: [KEY],
        userId: CALLER,
        alsoIssuedTo: OTHER,
        now: AFTER,
      }).then(
        () => 'accepted',
        () => 'refused'
      );
    await recordUploadKeyOwner(KEY, OTHER);
    expect(await outcomeFor()).toBe('accepted');
    redis.clear();
    await holder.db.exec(`INSERT INTO "Image" ("userId", url) VALUES (${OTHER}, '${KEY}')`);
    expect(await outcomeFor()).toBe('accepted');
  });

  it('falls back to the upload request log when the key has no record', async () => {
    holder.issued = [{ key: KEY, userId: OTHER }];
    expect(await outcome(KEY)).toBe('refused');
    holder.issued = [{ key: KEY, userId: CALLER }];
    expect(await outcome(KEY)).toBe('accepted');
  });

  it('treats an upload request logged with no user as no record', async () => {
    holder.issued = [{ key: KEY, userId: 0 }];
    expect(await outcome(KEY, BEFORE)).toBe('accepted');
  });

  it('accepts a key with no record before the cutoff when the upload request log cannot be read', async () => {
    holder.logDown = true;
    expect(await outcome(KEY, BEFORE)).toBe('accepted');
  });

  it('refuses a key before the cutoff when neither the issue record nor the request log can be read', async () => {
    holder.logDown = true;
    redisMock.redis.mGet.mockRejectedValue(new Error('down'));
    expect(await outcome(KEY, BEFORE)).toBe('refused');
  });

  it('refuses a key recorded to another user while the request log is down, beside an unrecorded one', async () => {
    holder.logDown = true;
    const OTHER_KEY = 'ff12cd34-ef56-4a7b-8c9d-0e1f2a3b4c5d';
    await recordUploadKeyOwner(OTHER_KEY, OTHER);
    const refusal = await assertClientKeysIssuedToCaller({
      urls: [KEY, OTHER_KEY],
      userId: CALLER,
      now: BEFORE,
    }).then(
      () => null,
      (e: unknown) => e
    );
    expect(refusal).toBeInstanceOf(TRPCError);
  });

  it('refuses a key with no record after the cutoff when the upload request log cannot be read', async () => {
    holder.logDown = true;
    expect(await outcome(KEY, AFTER)).toBe('refused');
    redisMock.redis.mGet.mockRejectedValue(new Error('down'));
    expect(await outcome(KEY, AFTER)).toBe('refused');
  });

  it('treats an upload request log that does not answer in 2s as unreadable', async () => {
    holder.logHangs = true;
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const before = outcome(KEY, BEFORE);
      const after = outcome(KEY, AFTER);
      await vi.advanceTimersByTimeAsync(2_000);
      expect(await before).toBe('accepted');
      expect(await after).toBe('refused');
    } finally {
      vi.useRealTimers();
    }
  });

  it('looks a key up in imageUploadRequests, skipping requests with no user', async () => {
    await outcome(KEY, BEFORE);
    expect(holder.sql).toHaveLength(1);
    expect(holder.sql[0]).toMatch(
      new RegExp(`FROM imageUploadRequests\\s+WHERE key IN \\('${KEY}'\\) AND userId != 0`)
    );
  });

  it('accepts a recorded key when the upload request log cannot be read', async () => {
    holder.logDown = true;
    await recordUploadKeyOwner(KEY, CALLER);
    expect(await outcome(KEY, AFTER)).toBe('accepted');
  });

  it('treats a key as unrecorded when the issue record store cannot be read', async () => {
    redisMock.redis.mGet.mockRejectedValue(new Error('down'));
    expect(await outcome(KEY, BEFORE)).toBe('accepted');
    expect(await outcome(KEY, AFTER)).toBe('refused');
  });

  it('refuses more upload keys than one check takes', async () => {
    await recordUploadKeyOwner(KEY, CALLER);
    const many = Array.from(
      { length: 65 },
      (_, i) => `ab12cd34-ef56-4a7b-8c9d-${i.toString(16).padStart(12, 'a')}`
    );
    expect(await outcome(many.join(' '), BEFORE)).toBe('refused');
    expect(await outcome(many.slice(0, 64).join(' '), BEFORE)).toBe('accepted');
    await expect(keyIssuers({ urls: many, userId: CALLER })).resolves.toMatchObject({
      tooMany: true,
    });
  });

  it("accepts the caller's own row stored as a full url, unless the key was issued to another user", async () => {
    const full = `https://cdn.example/x/${KEY}/original=true`;
    await holder.db.exec(`INSERT INTO "Image" ("userId", url) VALUES (${CALLER}, '${full}')`);
    expect(await outcome(full, AFTER)).toBe('accepted');
    await recordUploadKeyOwner(KEY, OTHER);
    expect(await outcome(full, AFTER)).toBe('refused');
  });

  it('refuses after the cutoff a key with no record and no row when the record read works', async () => {
    expect(await outcome(KEY, AFTER)).toBe('refused');
  });

  it('refuses a key the upload request log issued to another user when the record read fails', async () => {
    redisMock.redis.mGet.mockRejectedValue(new Error('down'));
    holder.issued = [{ key: KEY, userId: OTHER }];
    expect(await outcome(KEY)).toBe('refused');
  });

  it('accepts an unrecorded key the caller already has a row for', async () => {
    await holder.db.exec(`INSERT INTO "Image" ("userId", url) VALUES (${CALLER}, '${KEY}')`);
    expect(await outcome(KEY)).toBe('accepted');
  });

  it('applies UNRECORDED_KEYS_ACCEPTED_UNTIL to a key with no record and no row', async () => {
    expect(await outcome(KEY, BEFORE)).toBe('accepted');
    expect(await outcome(KEY, AFTER)).toBe('refused');
  });

  it("refuses an unrecorded key whose only row is another user's", async () => {
    await holder.db.exec(`INSERT INTO "Image" ("userId", url) VALUES (${OTHER}, '${KEY}')`);
    expect(await outcome(KEY, AFTER)).toBe('refused');
  });

  it('accepts a url with no upload key', async () => {
    expect(await outcome('https://example.com/picture.png')).toBe('accepted');
  });
});

describe("a service review copy's key", () => {
  const MODERATOR = 9;
  const OWN_KEY = '22222222-2222-4222-8222-222222222222';
  const full = (key: string) => `https://cdn.example/x/${key}/original=true`;
  const articleUsable = (url: string) =>
    assertClientImageUrlsUsable({ urls: [url], userId: CALLER, shopArtwork: false }).then(
      () => 'accepted',
      (e: unknown) => {
        if (e instanceof TRPCError && e.code === 'BAD_REQUEST') return 'refused';
        throw e;
      }
    );

  beforeEach(async () => {
    // The buyer's review copy, stored bare, and an ordinary upload of theirs.
    await holder.db.exec(`
      INSERT INTO "Image" ("userId", url) VALUES (${CALLER}, '${KEY}'), (${CALLER}, '${OWN_KEY}');
      INSERT INTO "ServiceDealReviewImage" ("reviewId", "imageId")
        SELECT 1, id FROM "Image" WHERE url = '${KEY}';
    `);
  });

  it('is refused as a new image to its own buyer, in any form the url carries it', async () => {
    for (const url of [KEY, KEY.toUpperCase(), full(KEY)]) {
      expect(await outcome(url, BEFORE)).toBe('refused');
      expect(await articleUsable(url)).toBe('refused');
    }
  });

  it('is refused even when its key was issued to the buyer', async () => {
    await recordUploadKeyOwner(KEY, CALLER);
    expect(await outcome(KEY, BEFORE)).toBe('refused');
  });

  it("is reported as not the caller's to every reader of the issue records", async () => {
    const issuers = await keyIssuers({ urls: [full(KEY)], userId: CALLER, now: BEFORE });
    expect(issuers.issuedToOthers).toEqual([KEY]);
  });

  it('is refused to a moderator too, before unrecorded keys are refused', async () => {
    await expect(
      assertClientKeysIssuedToCaller({ urls: [KEY], userId: MODERATOR, now: BEFORE })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });

  it("leaves the buyer's ordinary own upload usable (control)", async () => {
    expect(await outcome(OWN_KEY, AFTER)).toBe('accepted');
    expect(await outcome(full(OWN_KEY), AFTER)).toBe('accepted');
    expect(await articleUsable(full(OWN_KEY))).toBe('accepted');
  });
});

describe("a deal file's scan copy key", () => {
  // The seller's copy of their own delivery file, as a profile picture or any new image would name it.
  const COPY_KEY = '33333333-3333-4333-8333-333333333333';
  const OWN_KEY = '44444444-4444-4444-8444-444444444444';
  const givenCopy = (pointed: boolean) =>
    holder.db.exec(`
      INSERT INTO "Image" ("userId", url) VALUES (${CALLER}, '${COPY_KEY}'), (${CALLER}, '${OWN_KEY}');
      INSERT INTO "ServiceDealFileEntry" ("imageId", "scanKey")
        SELECT ${pointed ? 'id' : 'NULL'}, url FROM "Image" WHERE url = '${COPY_KEY}';
    `);

  it.each([true, false])(
    'is refused to its own seller, even when issued to them (pointer written: %s)',
    async (pointed) => {
      await givenCopy(pointed);
      await recordUploadKeyOwner(COPY_KEY, CALLER);
      expect(await outcome(COPY_KEY, BEFORE)).toBe('refused');
      expect(await outcome(`https://cdn.example/x/${COPY_KEY}/original=true`, BEFORE)).toBe(
        'refused'
      );
    }
  );

  it("leaves the seller's ordinary own upload usable (control)", async () => {
    await givenCopy(true);
    expect(await outcome(OWN_KEY, AFTER)).toBe('accepted');
  });
});

describe('an image url that names no stored object', () => {
  // The browser's url for a file whose upload has not finished; its id is not an upload key.
  const BLOB = `blob:https://civitai.red/${KEY}`;
  const message = (check: Promise<unknown>) =>
    check.then(
      () => 'accepted',
      (e: Error) => e.message
    );

  beforeEach(() => recordUploadKeyOwner(KEY, CALLER));

  it('is refused by each client url check with a message to add the image again', async () => {
    expect(await message(assertClientImageUrlsUsable({ urls: [BLOB], userId: CALLER }))).toBe(
      UNFINISHED_UPLOAD_MESSAGE
    );
    expect(
      await message(assertClientKeysIssuedToCaller({ urls: [BLOB], userId: CALLER, now: BEFORE }))
    ).toBe(UNFINISHED_UPLOAD_MESSAGE);
    expect(await message(assertShopArtworkKeysIssued({ urls: [BLOB], userId: CALLER }))).toBe(
      UNFINISHED_UPLOAD_MESSAGE
    );
  });

  it('is refused in any scheme but http(s), however it is spelled', async () => {
    for (const url of [
      `data:image/png;base64,${KEY}`,
      ` BLOB:${KEY}`,
      `bl\tob:${KEY}`,
      `${String.fromCharCode(1)}blob:${KEY}`,
    ])
      expect(await message(assertClientImageUrlsUsable({ urls: [url], userId: CALLER })), url).toBe(
        UNFINISHED_UPLOAD_MESSAGE
      );
  });

  it('holds no upload key', async () => {
    expect(await keyIssuers({ urls: [BLOB], userId: OTHER })).toMatchObject({
      issuedToOthers: [],
      unrecorded: [],
    });
    expect((await keyIssuers({ urls: [KEY], userId: OTHER })).issuedToOthers).toEqual([KEY]);
  });

  it('leaves the same key over https to the key checks', async () => {
    const url = `https://image.civitai.com/x/${KEY}/original=true/a.jpeg`;
    const usable = assertClientImageUrlsUsable({ urls: [url], userId: CALLER, shopArtwork: false });
    expect(await message(usable)).toBe('accepted');
    expect(await outcome(url)).toBe('accepted');
  });
});

describe('keyIssuers', () => {
  it('reports keys issued to another user and keys with no record, without refusing', async () => {
    const UNRECORDED = 'cd34ab12-ef56-4a7b-8c9d-0e1f2a3b4c5e';
    await recordUploadKeyOwner(KEY, OTHER);

    await expect(keyIssuers({ urls: [KEY, UNRECORDED], userId: CALLER })).resolves.toEqual({
      tooMany: false,
      issuedToOthers: [KEY],
      unrecorded: [UNRECORDED],
      recordReadFailed: false,
      requestLogReadFailed: false,
    });
  });
});

describe('keyIssueRecords', () => {
  it('names the owner from the record, or the upload request log', async () => {
    const LOGGED = 'ab12cd34-ef56-4a7b-8c9d-0e1f2a3b4c5e';
    await recordUploadKeyOwner(KEY, OTHER);
    // The log disagrees about KEY: the record wins.
    holder.issued = [
      { key: LOGGED, userId: CALLER },
      { key: KEY, userId: CALLER },
    ];
    expect(await keyIssueRecords([KEY, LOGGED])).toEqual({
      owners: new Map([
        [KEY, OTHER],
        [LOGGED, CALLER],
      ]),
      failed: false,
    });
  });

  it('takes no row as a record', async () => {
    await holder.db.query(`INSERT INTO "Image" ("userId", url) VALUES ($1, $2)`, [CALLER, KEY]);
    expect(await keyIssueRecords([KEY])).toEqual({ owners: new Map(), failed: false });
  });

  it('says when either read failed', async () => {
    holder.logDown = true;
    expect((await keyIssueRecords([KEY])).failed).toBe(true);
    holder.logDown = false;
    redisMock.redis.mGet.mockRejectedValueOnce(new Error('down'));
    expect((await keyIssueRecords([KEY])).failed).toBe(true);
  });
});

describe('recordUploadKeyOwner', () => {
  const writes = () => redisMock.redis.set.mock.calls.length;

  it('keeps a record through a write that fails twice, so the save after the cutover accepts it', async () => {
    const before = writes();
    redisMock.redis.set
      .mockRejectedValueOnce(new Error('blip'))
      .mockRejectedValueOnce(new Error('blip'));
    expect(await recordUploadKeyOwner(KEY, CALLER)).toBe(true);
    expect(writes() - before).toBe(3);
    expect(await outcome(KEY, AFTER)).toBe('accepted');
    expect(outcomeCount('record_failed')).toBe(0);
  });

  it('says the record was not written when every attempt fails, and stops after three', async () => {
    const before = writes();
    const failed = outcomeCount('record_failed');
    redisMock.redis.set.mockRejectedValue(new Error('down'));
    await expect(recordUploadKeyOwner(KEY, CALLER)).resolves.toBe(false);
    expect(writes() - before).toBe(3);
    expect(outcomeCount('record_failed')).toBe(failed + 1);
  });

  it('gives up on a write that never settles, within a bounded time', async () => {
    const before = writes();
    vi.useFakeTimers();
    try {
      redisMock.redis.set.mockImplementation((() => new Promise(() => undefined)) as never);
      let settled: boolean | undefined;
      void recordUploadKeyOwner(KEY, CALLER).then((v) => (settled = v));
      await vi.advanceTimersByTimeAsync(3 * 2_000 + 1_000);
      expect(settled).toBe(false);
      expect(writes() - before).toBe(3);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('the issue record, moved from sysRedis to the cluster', () => {
  // Each distinct from KEY, from each other, and from every key another case records.
  const WRITTEN = '3c0ffee1-aaaa-4bbb-8ccc-1d2e3f405162';
  const SYS_ONLY = '5a5a5a5a-1111-4222-8333-444455556666';
  const SYS_OTHERS = '6b6b6b6b-7777-4888-9999-aaaabbbbcccc';
  const CLUSTER_ONLY = '7c7c7c7c-dddd-4eee-8fff-000011112222';
  /** Inside the fallback window and after the unrecorded-key cutover. */
  const WINDOW = new Date('2026-12-15T12:00:00Z');

  // Hand-written wire values, so a key renamed in either table is caught here.
  const clusterKey = (key: string) => `system:upload-key-owner:${key}`;
  const sysKey = (key: string) => `system:upload-key-owner:${key}`;

  it('pins the fallback window after the cutover', () => {
    expect(UPLOAD_KEY_OWNER_SYS_FALLBACK_UNTIL.toISOString()).toBe('2027-01-01T00:00:00.000Z');
    expect(WINDOW > UNRECORDED_KEYS_ACCEPTED_UNTIL).toBe(true);
    expect(WINDOW < UPLOAD_KEY_OWNER_SYS_FALLBACK_UNTIL).toBe(true);
  });

  it('writes the record to the cluster, never to sysRedis', async () => {
    redisMock.sysRedis.set.mockClear();
    expect(await recordUploadKeyOwner(WRITTEN, OTHER)).toBe(true);
    expect(redisMock.redis.set).toHaveBeenLastCalledWith(clusterKey(WRITTEN), String(OTHER), {
      EX: 30 * 24 * 60 * 60,
    });
    expect(redis.get(clusterKey(WRITTEN))).toBe(String(OTHER));
    expect(redisMock.sysRedis.set).not.toHaveBeenCalled();
    // And the save reads it back from there.
    expect(await outcome(WRITTEN, WINDOW)).toBe('refused');
  });

  it('reads a cluster record without reading sysRedis', async () => {
    redis.set(clusterKey(CLUSTER_ONLY), String(CALLER));
    redisMock.sysRedis.mGet.mockClear();
    const hits = outcomeCount('record_sys_fallback_hit');
    expect(await outcome(CLUSTER_ONLY, WINDOW)).toBe('accepted');
    expect(redisMock.sysRedis.mGet).not.toHaveBeenCalled();
    expect(outcomeCount('record_sys_fallback_hit')).toBe(hits);
  });

  it('accepts after the cutover, inside the window, a key recorded only in sysRedis', async () => {
    sys.set(sysKey(SYS_ONLY), String(CALLER));
    expect(await outcome(SYS_ONLY, WINDOW)).toBe('accepted');
    // The owner comes from that record: one naming another user is refused.
    sys.set(sysKey(SYS_OTHERS), String(OTHER));
    expect(await outcome(SYS_OTHERS, WINDOW)).toBe('refused');
    expect(redisMock.sysRedis.mGet).toHaveBeenLastCalledWith([sysKey(SYS_OTHERS)]);
  });

  it('reads sysRedis only for the keys the cluster lacks', async () => {
    redis.set(clusterKey(CLUSTER_ONLY), String(CALLER));
    sys.set(sysKey(SYS_ONLY), String(CALLER));
    redisMock.sysRedis.mGet.mockClear();
    const hits = outcomeCount('record_sys_fallback_hit');
    await expect(
      keyIssuers({ urls: [CLUSTER_ONLY, SYS_ONLY], userId: CALLER, now: WINDOW })
    ).resolves.toMatchObject({ unrecorded: [], recordReadFailed: false });
    expect(redisMock.sysRedis.mGet).toHaveBeenCalledExactlyOnceWith([sysKey(SYS_ONLY)]);
    // Counted once per read the fallback answered, and not when it finds nothing.
    expect(outcomeCount('record_sys_fallback_hit')).toBe(hits + 1);
    await keyIssuers({ urls: [WRITTEN], userId: CALLER, now: WINDOW });
    expect(outcomeCount('record_sys_fallback_hit')).toBe(hits + 1);
  });

  it('reads no sysRedis record from UPLOAD_KEY_OWNER_SYS_FALLBACK_UNTIL', async () => {
    sys.set(sysKey(SYS_ONLY), String(CALLER));
    const last = new Date(UPLOAD_KEY_OWNER_SYS_FALLBACK_UNTIL.getTime() - 1);
    expect(await outcome(SYS_ONLY, last)).toBe('accepted');

    redisMock.sysRedis.mGet.mockClear();
    expect(await outcome(SYS_ONLY, UPLOAD_KEY_OWNER_SYS_FALLBACK_UNTIL)).toBe('refused');
    expect(await outcome(SYS_ONLY, new Date('2027-02-01T00:00:00Z'))).toBe('refused');
    expect(redisMock.sysRedis.mGet).not.toHaveBeenCalled();
  });

  describe('a sysRedis fallback read that fails counts as an unreadable issue record', () => {
    const failFallback = () => redisMock.sysRedis.mGet.mockRejectedValue(new Error('down'));
    const failCluster = () => redisMock.redis.mGet.mockRejectedValue(new Error('down'));

    it.each([
      ['the fallback', failFallback],
      ['the cluster', failCluster],
    ])('with %s down, as today: flagged, counted once, and decided the same', async (_, fail) => {
      fail();
      const failed = outcomeCount('record_read_failed');
      await expect(keyIssuers({ urls: [SYS_ONLY], userId: CALLER, now: WINDOW })).resolves.toEqual({
        tooMany: false,
        issuedToOthers: [],
        unrecorded: [SYS_ONLY],
        recordReadFailed: true,
        requestLogReadFailed: false,
      });
      expect(outcomeCount('record_read_failed')).toBe(failed + 1);

      // The decisions an unreadable record store has always got.
      expect(await outcome(SYS_ONLY, BEFORE)).toBe('accepted');
      expect(await outcome(SYS_ONLY, WINDOW)).toBe('refused');
      holder.logDown = true;
      expect(await outcome(SYS_ONLY, BEFORE)).toBe('refused');
      holder.issued = [{ key: SYS_ONLY, userId: OTHER }];
      holder.logDown = false;
      expect(await outcome(SYS_ONLY, BEFORE)).toBe('refused');
      expect((await keyIssueRecords([SYS_ONLY], undefined, WINDOW)).failed).toBe(true);
    });

    it('keeps the cluster records it read', async () => {
      redis.set(clusterKey(CLUSTER_ONLY), String(OTHER));
      failFallback();
      await expect(
        keyIssuers({ urls: [CLUSTER_ONLY, SYS_ONLY], userId: CALLER, now: WINDOW })
      ).resolves.toMatchObject({
        issuedToOthers: [CLUSTER_ONLY],
        unrecorded: [SYS_ONLY],
        recordReadFailed: true,
      });
    });

    it('is not read, so cannot fail, from UPLOAD_KEY_OWNER_SYS_FALLBACK_UNTIL', async () => {
      failFallback();
      await expect(
        keyIssuers({ urls: [SYS_ONLY], userId: CALLER, now: UPLOAD_KEY_OWNER_SYS_FALLBACK_UNTIL })
      ).resolves.toMatchObject({ recordReadFailed: false, unrecorded: [SYS_ONLY] });
    });
  });
});

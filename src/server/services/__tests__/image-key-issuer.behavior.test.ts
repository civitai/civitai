import { PGlite } from '@electric-sql/pglite';
import { TRPCError } from '@trpc/server';
import type { Mock } from 'vitest';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import * as prom from '~/server/prom/client';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { loggingMock } from '~/__tests__/mocks/logging.mock';
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
} = await import('~/server/services/image-url-ownership');

const CALLER = 7;
const OTHER = 8;
const KEY = 'ab12cd34-ef56-4a7b-8c9d-0e1f2a3b4c5d';
const BEFORE = new Date(UNRECORDED_KEYS_ACCEPTED_UNTIL.getTime() - 60_000);
const AFTER = new Date(UNRECORDED_KEYS_ACCEPTED_UNTIL.getTime() + 60_000);

const redis = new Map<string, string>();

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
  `);
});

beforeEach(async () => {
  await holder.db.exec(`TRUNCATE "Image", "ShopArtworkKeyOwner"`);
  holder.issued = [];
  holder.logDown = false;
  holder.logHangs = false;
  holder.sql = [];
  redis.clear();
  redisMock.sysRedis.set.mockImplementation((async (key: string, value: string) => {
    redis.set(key, value);
    return 'OK';
  }) as never);
  redisMock.sysRedis.mGet.mockImplementation((async (keys: string[]) =>
    keys.map((k) => redis.get(k) ?? null)) as never);
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

  it('accepts a key with no record before the cutoff when the upload request log cannot be read, and says so', async () => {
    holder.logDown = true;
    const before = outcomeCount('request_log_unavailable_accepted');
    loggingMock.logToAxiom.mockClear();

    expect(await outcome(KEY, BEFORE)).toBe('accepted');

    expect(outcomeCount('request_log_unavailable_accepted')).toBe(before + 1);
    expect(loggingMock.logToAxiom).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'upload-key-unrecorded',
        keys: KEY,
        reason: 'request_log_unavailable',
      })
    );
    redisMock.sysRedis.mGet.mockRejectedValue(new Error('down'));
    expect(await outcome(KEY, BEFORE)).toBe('accepted');
  });

  it('refuses a key with no record after the cutoff when the upload request log cannot be read', async () => {
    holder.logDown = true;
    const before = outcomeCount('request_log_unavailable');
    expect(await outcome(KEY, AFTER)).toBe('refused');
    expect(outcomeCount('request_log_unavailable')).toBe(before + 1);
    redisMock.sysRedis.mGet.mockRejectedValue(new Error('down'));
    expect(await outcome(KEY, AFTER)).toBe('refused');
  });

  it('tags no reason on a key accepted while the upload request log answered', async () => {
    loggingMock.logToAxiom.mockClear();
    expect(await outcome(KEY, BEFORE)).toBe('accepted');
    expect(loggingMock.logToAxiom).toHaveBeenCalledWith(
      expect.not.objectContaining({ reason: expect.anything() })
    );
  });

  it('logs why the upload request log could not be read', async () => {
    holder.logDown = true;
    loggingMock.logToAxiom.mockClear();

    await outcome(KEY, AFTER);

    expect(loggingMock.logToAxiom).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ type: 'error', name: 'upload-key-owner', error: 'unavailable' })
    );
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
    redisMock.sysRedis.mGet.mockRejectedValue(new Error('down'));
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
    redisMock.sysRedis.mGet.mockRejectedValue(new Error('down'));
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
    redisMock.sysRedis.mGet.mockRejectedValueOnce(new Error('down'));
    expect((await keyIssueRecords([KEY])).failed).toBe(true);
  });
});

describe('recordUploadKeyOwner', () => {
  it('does not throw when the write fails', async () => {
    redisMock.sysRedis.set.mockRejectedValue(new Error('down'));
    await expect(recordUploadKeyOwner(KEY, CALLER)).resolves.toBeUndefined();
  });
});

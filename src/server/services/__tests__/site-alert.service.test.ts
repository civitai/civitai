import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as ModeratorService from '~/server/services/moderator.service';
import { redisMock } from '~/__tests__/mocks/redis.mock';
import { createLuaRedis } from '~/server/utils/__tests__/redis-lua-harness';
import { REDIS_SYS_KEYS } from '~/server/redis/client';
import { postSiteAlertSchema } from '~/server/schema/site-alert.schema';
import { SITE_ALERTS_VERSION_FIELD } from '~/shared/constants/site-alert.constants';

vi.mock('~/server/services/moderator.service', async (importOriginal) => ({
  ...(await importOriginal<typeof ModeratorService>()),
  trackModActivity: vi.fn(async () => undefined),
}));

const { trackModActivity } = await import('~/server/services/moderator.service');
const {
  editSiteAlert,
  endSiteAlert,
  extendSiteAlert,
  getActiveSiteAlerts,
  listSiteAlerts,
  postSiteAlert,
} = await import('~/server/services/site-alert.service');

/** An in-memory sysRedis covering the hash and counter commands the service uses. */
const store = new Map<string, Map<string, string>>();
const counters = new Map<string, number>();
const hash = (key: string) => {
  if (!store.has(key)) store.set(key, new Map());
  return store.get(key)!;
};
redisMock.sysRedis.hGet.mockImplementation(
  async (key: string, field: string) => hash(key).get(field) ?? null
);
redisMock.sysRedis.hGetAll.mockImplementation(async (key: string) => Object.fromEntries(hash(key)));
redisMock.sysRedis.hSet.mockImplementation(async (key: string, field: string, value: string) => {
  hash(key).set(field, value);
  return 1;
});
redisMock.sysRedis.hDel.mockImplementation(async (key: string, fields: string | string[]) => {
  for (const f of [fields].flat()) hash(key).delete(f);
  return 1;
});
// MULTI queues the same commands and runs them together on exec, as Redis does.
redisMock.sysRedis.multi.mockImplementation(() => {
  const queued: (() => Promise<unknown>)[] = [];
  const tx = {
    hGet: (...args: [string, string]) => (queued.push(() => redisMock.sysRedis.hGet(...args)), tx),
    hGetAll: (key: string) => (queued.push(() => redisMock.sysRedis.hGetAll(key)), tx),
    exec: async () => {
      const results = [];
      for (const run of queued) results.push(await run());
      return results;
    },
  };
  return tx;
});

// The save script runs for real, in Lua, against a copy of the hashes it names.
let failNextEval = false;
redisMock.sysRedis.eval.mockImplementation(
  async (script: string, options: { keys: string[]; arguments: string[] }) => {
    if (failNextEval) {
      failNextEval = false;
      throw new Error('sysRedis down');
    }
    const lua = createLuaRedis(Date.now());
    for (const key of options.keys) lua.setHash(key, Object.fromEntries(hash(key)));
    const reply = await lua.eval(script, options);
    for (const key of options.keys) store.set(key, new Map(Object.entries(lua.hash(key) ?? {})));
    return reply;
  }
);

redisMock.sysRedis.incr.mockImplementation(async (key: string) => {
  const next = (counters.get(key) ?? 0) + 1;
  counters.set(key, next);
  return next;
});

const MOD = { id: 7, username: 'mod' };
const version = () => Number(hash(REDIS_SYS_KEYS.CLIENT).get(SITE_ALERTS_VERSION_FIELD) ?? 0);
const inHours = (h: number) => new Date(Date.now() + h * 3_600_000);
const post = (over: Record<string, unknown> = {}) =>
  postSiteAlert(
    postSiteAlertSchema.parse({
      severity: 'warning',
      title: 'Uploads slow',
      endsAt: inHours(2),
      ...over,
    }),
    MOD
  );

beforeEach(() => {
  failNextEval = false;
  store.clear();
  counters.clear();
  vi.mocked(trackModActivity).mockClear();
  vi.useRealTimers();
});

describe('getActiveSiteAlerts', () => {
  it('never carries the moderator audit fields onto the public response', async () => {
    await post();
    // Past the 5 s memo so this read sees the write.
    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + 10_000 });
    const { alerts } = await getActiveSiteAlerts();

    expect(alerts).toHaveLength(1);
    expect(Object.keys(alerts[0]).sort()).toEqual(
      [
        'dismissible',
        'domains',
        'endsAt',
        'id',
        'message',
        'paths',
        'severity',
        'startsAt',
        'surfaces',
        'title',
      ].sort()
    );
    expect(JSON.stringify(alerts)).not.toContain('"mod"');
  });

  it('re-reads when the browser has seen a newer version than this pod holds', async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + 60_000 });
    const before = await getActiveSiteAlerts();
    // Another pod saves: Redis changes, this pod's memo does not.
    const record = { ...(await post()), id: 99 };
    hash(REDIS_SYS_KEYS.SITE_ALERTS.ALERTS).clear();
    hash(REDIS_SYS_KEYS.SITE_ALERTS.ALERTS).set('99', JSON.stringify(record));
    const memoised = await getActiveSiteAlerts();
    const seen = version() + 1;
    hash(REDIS_SYS_KEYS.CLIENT).set(SITE_ALERTS_VERSION_FIELD, String(seen));

    expect((await getActiveSiteAlerts()).version).toBe(memoised.version);
    const fresh = await getActiveSiteAlerts(seen);
    expect(fresh.version).toBe(seen);
    expect(fresh.alerts.map((x) => x.id)).toEqual([99]);
    expect(before.alerts).toEqual([]);
  });
});

describe('writes', () => {
  it('each write raises the version and records a ModActivity row', async () => {
    const versions: number[] = [];
    const alert = await post();
    versions.push(version());
    await editSiteAlert({ id: alert.id, title: 'Uploads failing' }, MOD);
    versions.push(version());
    await extendSiteAlert({ id: alert.id, minutes: 60 }, MOD);
    versions.push(version());
    await endSiteAlert({ id: alert.id }, MOD);
    versions.push(version());

    expect(versions[0]).toBeGreaterThan(0);
    for (let i = 1; i < versions.length; i++) expect(versions[i]).toBeGreaterThan(versions[i - 1]);
    expect(vi.mocked(trackModActivity).mock.calls.map(([, x]) => x.activity)).toEqual([
      'post',
      'edit',
      'extend',
      'end',
    ]);
  });

  it('gives two saves at the same instant different versions, the later one higher', async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() });
    await post();
    const first = version();
    await post();
    expect(version()).toBe(first + 1);
  });

  it('keeps the version strictly increasing past a stored value ahead of the clock, and after a wipe', async () => {
    const ahead = Date.now() + 10_000_000;
    hash(REDIS_SYS_KEYS.CLIENT).set(SITE_ALERTS_VERSION_FIELD, String(ahead));
    await post();
    expect(version()).toBe(ahead + 1);

    hash(REDIS_SYS_KEYS.CLIENT).clear();
    await post();
    const afterWipe = version();
    expect(afterWipe).toBeGreaterThan(0);
    await post();
    expect(version()).toBeGreaterThan(afterWipe);
  });

  it('leaves nothing live when the save itself fails, so a retry cannot duplicate it', async () => {
    failNextEval = true;
    await expect(post()).rejects.toThrow('sysRedis down');
    expect(await listSiteAlerts()).toEqual([]);
    expect(version()).toBe(0);
  });

  it('still saves when the audit row cannot be written, so a retry does not post it twice', async () => {
    vi.mocked(trackModActivity).mockRejectedValueOnce(new Error('database unreachable'));
    const alert = await post({ severity: 'outage' });
    expect(alert.id).toBe(1);
    expect(version()).toBeGreaterThan(0);
    expect((await listSiteAlerts()).map((x) => x.id)).toEqual([1]);
  });

  it('defaults an outage to not dismissible', async () => {
    expect((await post({ severity: 'outage' })).dismissible).toBe(false);
    expect((await post({ severity: 'info' })).dismissible).toBe(true);
  });

  it('refuses an edit or extension that would run past 7 days', async () => {
    const alert = await post();
    await expect(editSiteAlert({ id: alert.id, endsAt: inHours(24 * 8) }, MOD)).rejects.toThrow(
      /at most 7 days/
    );
    await expect(extendSiteAlert({ id: alert.id, minutes: 7 * 24 * 60 }, MOD)).rejects.toThrow(
      /at most 7 days/
    );
  });

  it('drops alerts that ended over a week ago on the next write, and keeps recent ones listed', async () => {
    const old = await post();
    const recent = await post();
    await endSiteAlert({ id: old.id }, MOD);
    await endSiteAlert({ id: recent.id }, MOD);
    const stale = JSON.parse(hash(REDIS_SYS_KEYS.SITE_ALERTS.ALERTS).get(String(old.id))!);
    stale.endsAt = new Date(Date.now() - 8 * 24 * 3_600_000).toISOString();
    hash(REDIS_SYS_KEYS.SITE_ALERTS.ALERTS).set(String(old.id), JSON.stringify(stale));

    await post();
    expect((await listSiteAlerts()).map((x) => x.id)).not.toContain(old.id);
    expect((await listSiteAlerts()).map((x) => x.id)).toContain(recent.id);
  });
});

describe('postSiteAlertSchema', () => {
  it('requires endsAt', () => {
    expect(postSiteAlertSchema.safeParse({ severity: 'info', title: 'x' }).success).toBe(false);
  });

  it('caps the window at 7 days', () => {
    const parse = (h: number) =>
      postSiteAlertSchema.safeParse({ severity: 'info', title: 'x', endsAt: inHours(h) }).success;
    expect(parse(24 * 7 - 1)).toBe(true);
    expect(parse(24 * 7 + 1)).toBe(false);
  });

  it('takes literal segments and rejects a wildcard inside a segment', () => {
    const parse = (path: string) =>
      postSiteAlertSchema.safeParse({
        severity: 'info',
        title: 'x',
        endsAt: inHours(1),
        paths: [path],
      }).success;
    expect(parse('/models/create')).toBe(true);
    expect(parse('/mod*')).toBe(false);
  });
});

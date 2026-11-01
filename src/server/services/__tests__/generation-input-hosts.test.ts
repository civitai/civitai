import { beforeEach, describe, expect, it, vi } from 'vitest';
import { redisMock } from '~/__tests__/mocks/redis.mock';
import { registerCounterWithLabels, registerGaugeWithLabels } from '~/server/prom/client';
import {
  __resetRecentExternalHostUsersForTest,
  externalHostBucket,
  recordExternalHost,
} from '~/server/services/generation-input-hosts';

type Stub = {
  inc: ReturnType<typeof vi.fn>;
  set: ReturnType<typeof vi.fn>;
  reset: ReturnType<typeof vi.fn>;
};
// The setup mock builds one stub per registered metric. Captured at import, before any hook
// clears the factories' call logs.
const stubNamed = (factory: typeof registerCounterWithLabels, name: string) => {
  const { calls, results } = vi.mocked(factory).mock;
  const i = calls.findIndex(([def]) => def.name === name);
  if (i < 0) throw new Error(`metric ${name} was not registered`);
  return results[i].value as Stub;
};
const hosts = stubNamed(registerCounterWithLabels, 'generation_input_external_hosts_total');
const failed = stubNamed(
  registerCounterWithLabels,
  'generation_input_external_host_users_failed_total'
);
const users = stubNamed(
  registerGaugeWithLabels as typeof registerCounterWithLabels,
  'generation_input_external_host_users'
);

const KEY = 'system:generation-input-external-host-users';
const NOW = new Date('2026-11-01T12:00:00Z');
const record = (url: string, over: Partial<Parameters<typeof recordExternalHost>[0]> = {}) =>
  recordExternalHost({
    url,
    entry: 'generateFromGraph',
    caller: 'api',
    mode: 'log',
    userId: 42,
    now: NOW,
    ...over,
  });
/** Lets the background set write finish: it is a chain of microtasks. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('externalHostBucket', () => {
  it.each([
    ['https://cdn.discordapp.com/attachments/1/2/a.png', 'discord'],
    ['https://media.discordapp.net/a.png', 'discord'],
    ['https://i.imgur.com/a.png', 'imgur'],
    ['https://IMGUR.com./a.png', 'imgur'],
    ['https://lh3.googleusercontent.com/a', 'google'],
    ['https://pbs.twimg.com/media/a.jpg', 'twitter'],
    ['https://my-bucket.s3.us-east-1.amazonaws.com/a.png', 'aws_s3'],
    ['https://pub-1.r2.dev/a.png', 'cloudflare_r2'],
    ['http://huggingface.co/x/resolve/main/a.png', 'huggingface'],
    ['https://203.0.113.7/a.png', 'ip'],
    ['https://[2001:db8::1]/a.png', 'ip'],
  ])('%s is %s', (url, bucket) => {
    expect(externalHostBucket(url)).toBe(bucket);
  });

  it.each([
    'https://imgur.com.example.net/a.png',
    'https://notimgur.com/a.png',
    'https://example.com/i.imgur.com/a.png',
    'https://example.com/?u=https://i.imgur.com/a.png',
    'not a url',
  ])('%s is other', (url) => {
    expect(externalHostBucket(url)).toBe('other');
  });
});

describe('recordExternalHost', () => {
  beforeEach(() => {
    __resetRecentExternalHostUsersForTest();
    for (const stub of [hosts, failed, users]) {
      stub.inc.mockClear();
      stub.set.mockClear();
      stub.reset.mockClear();
    }
    for (const fn of [
      redisMock.sysRedis.pfAdd,
      redisMock.sysRedis.pfCount,
      redisMock.sysRedis.expireAt,
    ])
      fn.mockReset();
    redisMock.sysRedis.pfAdd.mockResolvedValue(1);
    redisMock.sysRedis.pfCount.mockResolvedValue(17);
    redisMock.sysRedis.expireAt.mockResolvedValue(true);
  });

  it("counts the url by bucket and reports the bucket's distinct users for the day", async () => {
    record('https://i.imgur.com/a.png');
    expect(hosts.inc).toHaveBeenCalledExactlyOnceWith({
      entry: 'generateFromGraph',
      caller: 'api',
      mode: 'log',
      host: 'imgur',
    });
    expect(redisMock.sysRedis.pfAdd).toHaveBeenCalledExactlyOnceWith(
      `${KEY}:2026-11-01:api:imgur`,
      '42'
    );
    await settle();
    expect(redisMock.sysRedis.expireAt).toHaveBeenCalledExactlyOnceWith(
      `${KEY}:2026-11-01:api:imgur`,
      new Date('2026-11-03T00:00:00Z')
    );
    expect(users.set).toHaveBeenCalledExactlyOnceWith(
      { day: '2026-11-01', caller: 'api', host: 'imgur' },
      17
    );
  });

  it('keys the day set on the UTC date of the request', () => {
    record('https://i.imgur.com/a.png', { now: new Date('2026-11-01T23:30:00Z') });
    record('https://i.imgur.com/a.png', { now: new Date('2026-11-02T00:30:00Z') });
    expect(redisMock.sysRedis.pfAdd.mock.calls.map(([key]) => key)).toEqual([
      `${KEY}:2026-11-01:api:imgur`,
      `${KEY}:2026-11-02:api:imgur`,
    ]);
    // The pod stops reporting the old day once the new one starts.
    expect(users.reset).toHaveBeenCalledTimes(2);
  });

  it("does not bring back the old day's estimate when its write finishes after the day changed", async () => {
    let finishOldDay: ((changed: number) => void) | undefined;
    redisMock.sysRedis.pfAdd.mockImplementationOnce(
      () => new Promise<number>((resolve) => (finishOldDay = resolve))
    );
    record('https://i.imgur.com/a.png', { now: new Date('2026-11-01T23:59:00Z') });
    record('https://i.imgur.com/a.png', { now: new Date('2026-11-02T00:01:00Z') });
    await settle();
    finishOldDay!(1);
    await settle();
    expect(users.set).toHaveBeenCalledExactlyOnceWith(
      { day: '2026-11-02', caller: 'api', host: 'imgur' },
      17
    );
  });

  it('writes nothing for a request dated before the current day', () => {
    record('https://i.imgur.com/a.png', { now: new Date('2026-11-02T00:01:00Z') });
    record('https://i.imgur.com/a.png', { now: new Date('2026-11-01T23:59:00Z'), userId: 43 });
    expect(redisMock.sysRedis.pfAdd).toHaveBeenCalledTimes(1);
    expect(users.reset).toHaveBeenCalledTimes(1);
    expect(hosts.inc).toHaveBeenCalledTimes(2);
  });

  it('reports nothing new when the day set already holds the user', async () => {
    redisMock.sysRedis.pfAdd.mockResolvedValue(0);
    record('https://i.imgur.com/a.png');
    await settle();
    expect(redisMock.sysRedis.pfAdd).toHaveBeenCalledTimes(1);
    expect(redisMock.sysRedis.expireAt).toHaveBeenCalledTimes(1);
    expect(redisMock.sysRedis.pfCount).not.toHaveBeenCalled();
    expect(users.set).not.toHaveBeenCalled();
    expect(hosts.inc).toHaveBeenCalledTimes(1);
  });

  it('writes each bucket once for a user, and counts every url', () => {
    record('https://i.imgur.com/a.png');
    record('https://i.imgur.com/b.png');
    record('https://example.com/c.png');
    expect(hosts.inc).toHaveBeenCalledTimes(3);
    expect(redisMock.sysRedis.pfAdd.mock.calls.map(([key]) => key)).toEqual([
      `${KEY}:2026-11-01:api:imgur`,
      `${KEY}:2026-11-01:api:other`,
    ]);
  });

  it('writes a user once per day per bucket across requests, and each other user', () => {
    record('https://i.imgur.com/a.png');
    record('https://i.imgur.com/b.png');
    record('https://i.imgur.com/a.png', { userId: 43 });
    record('https://i.imgur.com/a.png', { caller: 'session' });
    expect(hosts.inc).toHaveBeenCalledTimes(4);
    expect(redisMock.sysRedis.pfAdd.mock.calls).toEqual([
      [`${KEY}:2026-11-01:api:imgur`, '42'],
      [`${KEY}:2026-11-01:api:imgur`, '43'],
      [`${KEY}:2026-11-01:session:imgur`, '42'],
    ]);
  });

  it('writes nothing for a repeat request after the first write finished', async () => {
    record('https://i.imgur.com/a.png');
    await settle();
    expect(users.set).toHaveBeenCalledTimes(1);
    record('https://i.imgur.com/a.png');
    await settle();
    expect(redisMock.sysRedis.pfAdd).toHaveBeenCalledTimes(1);
    expect(failed.inc).not.toHaveBeenCalled();
  });

  it('never puts a raw hostname in a label or a key', () => {
    record('https://secret-host.example.org/a.png', { mode: 'refuse', caller: 'session' });
    expect(hosts.inc).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ host: 'other', mode: 'refuse', caller: 'session' })
    );
    expect(redisMock.sysRedis.pfAdd.mock.calls[0][0]).toBe(`${KEY}:2026-11-01:session:other`);
  });

  it('fails open: a failed add is counted, never thrown, and tried again next request', async () => {
    redisMock.sysRedis.pfAdd.mockRejectedValueOnce(new Error('redis down'));
    expect(() => record('https://i.imgur.com/a.png')).not.toThrow();
    await settle();
    expect(failed.inc).toHaveBeenCalledExactlyOnceWith({ caller: 'api' });
    expect(users.set).not.toHaveBeenCalled();
    record('https://i.imgur.com/a.png');
    expect(redisMock.sysRedis.pfAdd).toHaveBeenCalledTimes(2);
  });

  it('a failed expiry is counted, and the add is tried again next request', async () => {
    redisMock.sysRedis.expireAt.mockRejectedValueOnce(new Error('redis down'));
    record('https://i.imgur.com/a.png');
    await settle();
    expect(failed.inc).toHaveBeenCalledExactlyOnceWith({ caller: 'api' });
    expect(users.set).not.toHaveBeenCalled();
    // The user is in the set now, so the retry's add changes nothing; the expiry is still set.
    redisMock.sysRedis.pfAdd.mockResolvedValueOnce(0);
    record('https://i.imgur.com/a.png');
    await settle();
    expect(redisMock.sysRedis.expireAt).toHaveBeenCalledTimes(2);
  });
});

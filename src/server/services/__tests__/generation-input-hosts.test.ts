import { beforeEach, describe, expect, it, vi } from 'vitest';
import { redisMock } from '~/__tests__/mocks/redis.mock';
import { registerCounterWithLabels } from '~/server/prom/client';
import { externalHostBucket, recordExternalHost } from '~/server/services/generation-input-hosts';

// The setup mock builds one stub per registered counter. Captured at import, before any hook
// clears the factory's call log.
const registered = vi.mocked(registerCounterWithLabels).mock;
const counterNamed = (name: string) => {
  const i = registered.calls.findIndex(([def]) => def.name === name);
  if (i < 0) throw new Error(`counter ${name} was not registered`);
  return registered.results[i].value as { inc: ReturnType<typeof vi.fn> };
};
const hosts = counterNamed('generation_input_external_hosts_total');
const users = counterNamed('generation_input_external_host_users_total');
const failed = counterNamed('generation_input_external_host_users_failed_total');

const NOW = new Date('2026-11-01T12:00:00Z');
const record = (url: string, over: Partial<Parameters<typeof recordExternalHost>[0]> = {}) =>
  recordExternalHost({
    url,
    entry: 'generateFromGraph',
    caller: 'api',
    mode: 'log',
    userId: 42,
    now: NOW,
    seen: new Set(),
    ...over,
  });

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
    for (const counter of [hosts, users, failed]) counter.inc.mockClear();
    redisMock.sysRedis.pfAdd.mockReset();
    redisMock.sysRedis.expire.mockReset();
    redisMock.sysRedis.pfAdd.mockResolvedValue(1);
    redisMock.sysRedis.expire.mockResolvedValue(true);
  });

  it('counts the url by bucket and adds the user to the day set for that bucket', async () => {
    record('https://i.imgur.com/a.png');
    expect(hosts.inc).toHaveBeenCalledExactlyOnceWith({
      entry: 'generateFromGraph',
      caller: 'api',
      mode: 'log',
      host: 'imgur',
    });
    expect(redisMock.sysRedis.pfAdd).toHaveBeenCalledExactlyOnceWith(
      'system:generation-input-external-host-users:2026-11-01:api:imgur',
      '42'
    );
    await vi.waitFor(() =>
      expect(users.inc).toHaveBeenCalledExactlyOnceWith({ caller: 'api', host: 'imgur' })
    );
    expect(redisMock.sysRedis.expire).toHaveBeenCalledWith(
      'system:generation-input-external-host-users:2026-11-01:api:imgur',
      2 * 24 * 60 * 60,
      'NX'
    );
  });

  it('does not count a user the day set already holds', async () => {
    redisMock.sysRedis.pfAdd.mockResolvedValue(0);
    record('https://i.imgur.com/a.png');
    await vi.waitFor(() => expect(redisMock.sysRedis.pfAdd).toHaveBeenCalledTimes(1));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(users.inc).not.toHaveBeenCalled();
    expect(hosts.inc).toHaveBeenCalledTimes(1);
  });

  it('writes each bucket once per request, and counts every url', () => {
    const seen = new Set<string>();
    record('https://i.imgur.com/a.png', { seen });
    record('https://i.imgur.com/b.png', { seen });
    record('https://example.com/c.png', { seen });
    expect(hosts.inc).toHaveBeenCalledTimes(3);
    expect(redisMock.sysRedis.pfAdd.mock.calls.map(([key]) => key)).toEqual([
      'system:generation-input-external-host-users:2026-11-01:api:imgur',
      'system:generation-input-external-host-users:2026-11-01:api:other',
    ]);
  });

  it('never puts a raw hostname in a label or a key', () => {
    record('https://secret-host.example.org/a.png', { mode: 'refuse', caller: 'session' });
    expect(hosts.inc).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ host: 'other', mode: 'refuse', caller: 'session' })
    );
    const [key] = redisMock.sysRedis.pfAdd.mock.calls[0];
    expect(key).toBe('system:generation-input-external-host-users:2026-11-01:session:other');
  });

  it('fails open: a Redis error is counted and never thrown', async () => {
    redisMock.sysRedis.pfAdd.mockRejectedValue(new Error('redis down'));
    expect(() => record('https://i.imgur.com/a.png')).not.toThrow();
    await vi.waitFor(() => expect(failed.inc).toHaveBeenCalledExactlyOnceWith({ caller: 'api' }));
    expect(users.inc).not.toHaveBeenCalled();
    expect(hosts.inc).toHaveBeenCalledTimes(1);
  });
});

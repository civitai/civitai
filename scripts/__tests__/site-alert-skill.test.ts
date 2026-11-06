import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Read once when the shared lib loads; a placeholder, since every call here is injected.
process.env.CIVITAI_API_KEY ??= 'test-placeholder';
const { main } = await import('../../.claude/skills/site-alert/site-alert.mjs');

// Any real request fails the test, whatever the client: the dry run must make none at all.
const fetchSpy = vi.fn(async () => {
  throw new Error('network reached');
});

beforeEach(() => {
  vi.stubGlobal('fetch', fetchSpy);
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  fetchSpy.mockClear();
});

describe('site-alert skill', () => {
  it.each([
    ['post', ['post', '--title', 'Uploads failing', '--hours', '2', '--dry-run']],
    ['edit', ['edit', '4', '--title', 'Uploads slow', '--dry-run']],
    ['extend', ['extend', '4', '--minutes', '60', '--dry-run']],
    ['end', ['end', '4', '--dry-run']],
  ])('--dry-run %s sends nothing', async (_, argv) => {
    const call = vi.fn();
    await main(argv, call);
    expect(call).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('posts the parsed alert when it is not a dry run', async () => {
    const call = vi.fn(async () => ({
      id: 1,
      severity: 'outage',
      title: 'Uploads failing',
      paths: ['/models/create'],
      domains: ['all'],
      startsAt: new Date().toISOString(),
      endsAt: new Date(Date.now() + 3_600_000).toISOString(),
      dismissible: false,
    }));
    const before = Date.now();
    await main(
      [
        'post',
        '--severity',
        'outage',
        '--title',
        'Uploads failing',
        '--paths',
        '/models/create, /models/*/wizard',
        '--hours',
        '2',
        '--not-dismissible',
      ],
      call
    );

    expect(call).toHaveBeenCalledTimes(1);
    const [procedure, input] = call.mock.calls[0] as unknown as [string, Record<string, unknown>];
    expect(procedure).toBe('siteAlerts.post');
    expect(input).toMatchObject({
      severity: 'outage',
      title: 'Uploads failing',
      paths: ['/models/create', '/models/*/wizard'],
      dismissible: false,
    });
    const endsAt = Date.parse(input.endsAt as string);
    expect(endsAt - before).toBeGreaterThanOrEqual(2 * 3_600_000 - 1_000);
    expect(endsAt - before).toBeLessThan(2 * 3_600_000 + 60_000);
  });
});

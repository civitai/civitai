import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as FliptClient from '~/server/flipt/client';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { envMock } from '~/__tests__/mocks/env.mock';
import { loggingMock } from '~/__tests__/mocks/logging.mock';
import { redisMock } from '~/__tests__/mocks/redis.mock';

const { isFliptMock } = vi.hoisted(() => ({ isFliptMock: vi.fn() }));
vi.mock('~/server/flipt/client', async (importOriginal) => ({
  ...(await importOriginal<typeof FliptClient>()),
  isFlipt: isFliptMock,
}));

const {
  buildHqBody,
  buildHqTitle,
  fileFeedbackToHq,
  HQ_BODY_MAX_BYTES,
  HQ_SCREENSHOT_MAX_BYTES,
  HQ_TITLE_MAX_LENGTH,
} = await import('../feedback-hq.service');

const TOKEN = 'hq_tok_SHOULD_NEVER_APPEAR';
const HQ_ORIGIN = 'https://hq.example.test';
const SHOT = '99999999-8888-4777-b666-555544443333';

const report = (overrides: Partial<Parameters<typeof fileFeedbackToHq>[0]> = {}) => ({
  feedbackId: 7,
  userId: 42,
  area: 'site-bug-report',
  message: 'The page went blank',
  context: { route: '/models/[id]' },
  server: { site: 'red', tier: 'gold', flags: { assistant: true } },
  ...overrides,
});

const created = (body: unknown = { id: 'task_1', url: 'https://hq.civitai.com/tasks/task_1' }) =>
  new Response(JSON.stringify(body), { status: 201 });

const fetchMock = vi.fn();
const intakeCalls = () => fetchMock.mock.calls.filter(([url]) => String(url).startsWith(HQ_ORIGIN));
const sentForm = () => intakeCalls()[0][1].body as FormData;
const loggedStatuses = () => loggingMock.logToAxiom.mock.calls.map(([line]) => line.status);

beforeEach(() => {
  vi.clearAllMocks();
  dbMock.dbWrite.$executeRaw.mockResolvedValue(1);
  loggingMock.logToAxiom.mockResolvedValue(undefined);
  envMock.set({ HQ_INTAKE_URL: HQ_ORIGIN, HQ_INTAKE_TOKEN: TOKEN });
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockReset();
  fetchMock.mockResolvedValue(created());
  redisMock.sysRedis.incrBy.mockResolvedValue(1);
  isFliptMock.mockResolvedValue(false);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('when HQ intake is configured', () => {
  it('posts the report to the intake route with the token', async () => {
    await fileFeedbackToHq(report());

    expect(intakeCalls()).toHaveLength(1);
    const [url, init] = intakeCalls()[0];
    expect(url).toBe(`${HQ_ORIGIN}/api/v1/intake/feedback`);
    expect(init.headers).toEqual({ Authorization: `Bearer ${TOKEN}` });
    expect(sentForm().get('title')).toBe('Bug report #7: The page went blank');
    expect(sentForm().getAll('labels')).toEqual(['site-bug-report', 'site:red', 'tier:gold']);
  });

  it('records the returned task on the report', async () => {
    await fileFeedbackToHq(report());

    const [, ...values] = dbMock.dbWrite.$executeRaw.mock.calls[0];
    expect(values).toEqual([
      JSON.stringify({ id: 'task_1', url: 'https://hq.civitai.com/tasks/task_1' }),
      7,
    ]);
  });

  it('records nothing when HQ answers 201 with a link that is not https', async () => {
    fetchMock.mockResolvedValue(created({ id: 'task_1', url: 'javascript:alert(1)' }));
    await fileFeedbackToHq(report());

    expect(dbMock.dbWrite.$executeRaw).not.toHaveBeenCalled();
  });
});

describe('when HQ intake is not configured', () => {
  it.each([
    ['the URL', { HQ_INTAKE_URL: undefined }],
    ['the token', { HQ_INTAKE_TOKEN: undefined }],
  ])('makes no request without %s', async (_, unset) => {
    envMock.set(unset);
    await fileFeedbackToHq(report());

    expect(fetchMock).not.toHaveBeenCalled();
    expect(loggedStatuses()).toEqual(['unconfigured']);
  });
});

it('files only site bug reports', async () => {
  await fileFeedbackToHq(report({ area: 'app-block' }));
  expect(fetchMock).not.toHaveBeenCalled();
});

describe('a failed filing never reaches the caller', () => {
  const timeout = Object.assign(new Error('aborted'), { name: 'TimeoutError' });
  it.each([
    ['403', () => fetchMock.mockResolvedValue(new Response('no scope', { status: 403 })), 403],
    ['429', () => fetchMock.mockResolvedValue(new Response('slow down', { status: 429 })), 429],
    ['503', () => fetchMock.mockResolvedValue(new Response('not set up', { status: 503 })), 503],
    ['a timeout', () => fetchMock.mockRejectedValue(timeout), 'timeout'],
    ['a network error', () => fetchMock.mockRejectedValue(new TypeError('fetch failed')), 'error'],
    [
      'an unparseable 201',
      () => fetchMock.mockResolvedValue(new Response('<html>', { status: 201 })),
      'bad-response',
    ],
  ])('resolves on %s, logs it and records nothing', async (_, arrange, status) => {
    arrange();
    await expect(fileFeedbackToHq(report())).resolves.toBeUndefined();

    expect(loggedStatuses()).toEqual([status]);
    expect(dbMock.dbWrite.$executeRaw).not.toHaveBeenCalled();
  });

  it('resolves when recording the task fails and so does the log', async () => {
    dbMock.dbWrite.$executeRaw.mockRejectedValue(new Error('db down'));
    loggingMock.logToAxiom.mockRejectedValue(new Error('axiom down'));

    await expect(fileFeedbackToHq(report())).resolves.toBeUndefined();
  });
});

it('never writes the token, the report or HQ’s reply to a log line', async () => {
  const message = `my key is ${TOKEN}`;
  fetchMock.mockRejectedValueOnce(new Error(`connect failed, Bearer ${TOKEN}`));
  await fileFeedbackToHq(report({ message }));
  fetchMock.mockResolvedValueOnce(new Response(`denied ${TOKEN}`, { status: 403 }));
  await fileFeedbackToHq(report({ message }));
  await fileFeedbackToHq(report({ message }));

  expect(loggedStatuses()).toEqual(['error', 403, 'filed']);
  for (const [line] of loggingMock.logToAxiom.mock.calls)
    expect(Object.keys(line).sort()).toEqual(['feedbackId', 'name', 'status', 'type']);
  expect(JSON.stringify(loggingMock.logToAxiom.mock.calls)).not.toContain(TOKEN);
});

describe('the per-reporter cap', () => {
  it('stops filing past the cap', async () => {
    redisMock.sysRedis.incrBy.mockResolvedValue(11);
    await fileFeedbackToHq(report());

    expect(fetchMock).not.toHaveBeenCalled();
    expect(loggedStatuses()).toEqual(['user-cap']);
  });

  it('files nothing when the count cannot be read', async () => {
    redisMock.sysRedis.incrBy.mockRejectedValue(new Error('redis down'));
    await fileFeedbackToHq(report());

    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('the page capture', () => {
  const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
  const withShot = () => report({ context: { screenshotId: SHOT } });
  const serveImage = (bytes: Uint8Array, headers: Record<string, string> = {}) =>
    fetchMock.mockImplementation(async (url: string) =>
      url.startsWith(HQ_ORIGIN) ? created() : new Response(bytes, { status: 200, headers })
    );

  it('is not fetched or sent while the flag is off', async () => {
    serveImage(PNG);
    await fileFeedbackToHq(withShot());

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(sentForm().get('screenshot')).toBeNull();
    expect(sentForm().get('body')).toContain('see the moderator view');
  });

  it('is sent, typed by its bytes, when the flag is on', async () => {
    isFliptMock.mockResolvedValue(true);
    serveImage(PNG, { 'content-type': 'text/html' });
    await fileFeedbackToHq(withShot());

    const file = sentForm().get('screenshot') as File;
    expect(file.type).toBe('image/png');
    expect(file.size).toBe(PNG.length);
  });

  it.each([
    ['is not an image', new TextEncoder().encode('<svg onload=alert(1)>')],
    [
      'is over 5 MiB',
      (() => {
        const big = new Uint8Array(HQ_SCREENSHOT_MAX_BYTES + 1);
        big.set(PNG);
        return big;
      })(),
    ],
  ])('is left off when the file %s, and the report is still filed', async (_, bytes) => {
    isFliptMock.mockResolvedValue(true);
    serveImage(bytes);
    await fileFeedbackToHq(withShot());

    expect(intakeCalls()).toHaveLength(1);
    expect(sentForm().get('screenshot')).toBeNull();
  });
});

describe('what reaches HQ from the reporter', () => {
  const JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.c2lnbmF0dXJlLXNpZ25hdHVyZQ';
  const hostile = [
    'contact me at someone@example.com',
    `cookie civ-token=${JWT}`,
    '<script>alert(1)</script>',
    '[click](https://evil.example)',
    '![x](https://evil.example/pixel.png)',
    'ping @justin',
    '```',
    '# not a heading',
    '````',
  ].join('\n');

  const body = () =>
    buildHqBody(report({ message: hostile }), {
      moderatorUrl: 'https://moderator.example.test/feedback/7',
      screenshotAttached: false,
    });

  it('keeps every line the reporter typed inside one fence it cannot close', () => {
    const text = body();
    const [, words] = text.split("## Reporter's words (untrusted)\n\n");
    const fence = words.match(/^`+/)![0];
    expect(fence.length).toBeGreaterThan(4);
    const inner = words.slice(fence.length).split(`\n${fence}`)[0];
    for (const line of [
      '<script>alert(1)</script>',
      '[click](https://evil.example)',
      '# not a heading',
    ])
      expect(inner).toContain(line);
    expect(text.indexOf('<script>')).toBeGreaterThan(text.indexOf(fence));
  });

  it('removes secrets and makes mentions inert', () => {
    const text = body();
    expect(text).not.toContain('someone@example.com');
    expect(text).not.toContain(JWT);
    expect(text).not.toMatch(/@justin/);
    expect(text).toContain('@\u200bjustin');
  });

  it('builds a title with no markup, no mention and no secret', () => {
    const title = buildHqTitle(
      report({ message: `[x](https://evil.example) <b>@justin</b> ${JWT}\nsecond line` })
    );
    expect(title).not.toMatch(/[[\]()<>]/);
    expect(title).not.toContain('@justin');
    expect(title).not.toContain(JWT);
    expect(title.startsWith('Bug report #7: ')).toBe(true);
    expect(title.length).toBeLessThanOrEqual(HQ_TITLE_MAX_LENGTH);
  });

  it('falls back to the route when the first line has nothing left', () => {
    expect(buildHqTitle(report({ message: '<>[]()' }))).toBe('Bug report #7 on /models/id');
  });

  it('stays under HQ’s body limit, dropping diagnostics and then clipping the words', () => {
    const consoleErrors = Array.from({ length: 10 }, (_, i) => ({
      message: `TypeError ${i} `.repeat(40),
      count: 1,
    }));
    const text = buildHqBody(report({ message: '界'.repeat(20_000), context: { consoleErrors } }), {
      moderatorUrl: 'https://moderator.example.test/feedback/7',
      screenshotAttached: false,
    });
    expect(Buffer.byteLength(text, 'utf8')).toBeLessThanOrEqual(HQ_BODY_MAX_BYTES);
    expect(text).toContain('[truncated: full text in the moderator view]');
    expect(text).not.toContain('## Diagnostics');
    expect(text).toContain('Moderator view: <https://moderator.example.test/feedback/7>');
  });
});

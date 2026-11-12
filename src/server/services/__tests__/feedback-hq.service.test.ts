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
  captureAttachGate,
  CAPTURE_POLL_DELAYS_MS,
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

const TASK = { id: 'task_1', url: `${HQ_ORIGIN}/tasks/task_1` };
const created = (body: unknown = TASK) => new Response(JSON.stringify(body), { status: 201 });

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
    expect(String(url)).toBe(`${HQ_ORIGIN}/api/v1/intake/feedback`);
    expect(init.headers).toEqual({ Authorization: `Bearer ${TOKEN}` });
    expect(sentForm().get('title')).toBe('Bug report #7: The page went blank');
    expect(sentForm().getAll('labels')).toEqual(['site-bug-report', 'site:red', 'tier:gold']);
  });

  it('refuses to follow a redirect with the report', async () => {
    await fileFeedbackToHq(report());
    expect(intakeCalls()[0][1].redirect).toBe('error');
  });

  it('records the returned task on the report', async () => {
    await fileFeedbackToHq(report());

    const [, ...values] = dbMock.dbWrite.$executeRaw.mock.calls[0];
    expect(values).toEqual([JSON.stringify(TASK), 7]);
  });

  it.each([
    ['a link on another origin', { ...TASK, url: 'https://evil.example/tasks/task_1' }],
    ['a script link', { ...TASK, url: 'javascript:alert(1)' }],
    ['an id with markup', { ...TASK, id: '<img src=x>' }],
    ['an over-long id', { ...TASK, id: 'x'.repeat(101) }],
  ])('records nothing when HQ answers 201 with %s', async (_, reply) => {
    fetchMock.mockResolvedValue(created(reply));
    await fileFeedbackToHq(report());

    expect(dbMock.dbWrite.$executeRaw).not.toHaveBeenCalled();
    expect(loggedStatuses()).toEqual(['bad-response']);
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
  const timeout = AbortSignal.abort(new DOMException('timed out', 'TimeoutError')).reason;
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
  const KEY = 'system:feedback:hq-filing:42';

  it('files the tenth attempt in a window and refuses the eleventh', async () => {
    redisMock.sysRedis.incrBy.mockResolvedValueOnce(10).mockResolvedValueOnce(11);
    await fileFeedbackToHq(report());
    await fileFeedbackToHq(report());

    expect(intakeCalls()).toHaveLength(1);
    expect(loggedStatuses()).toEqual(['filed', 'user-cap']);
    expect(redisMock.sysRedis.incrBy).toHaveBeenCalledWith(KEY, 1);
  });

  it('starts a 24-hour window on the first attempt', async () => {
    await fileFeedbackToHq(report());

    expect(redisMock.sysRedis.expire).toHaveBeenCalledWith(KEY, 24 * 60 * 60);
  });

  it('re-arms a window that lost its expiry, and leaves a live one alone', async () => {
    redisMock.sysRedis.incrBy.mockResolvedValue(5);
    redisMock.sysRedis.ttl.mockResolvedValueOnce(-1).mockResolvedValueOnce(100);
    await fileFeedbackToHq(report());
    await fileFeedbackToHq(report());

    expect(redisMock.sysRedis.expire).toHaveBeenCalledTimes(1);
    expect(redisMock.sysRedis.expire).toHaveBeenCalledWith(KEY, 24 * 60 * 60);
  });

  it('files nothing when the count cannot be read', async () => {
    redisMock.sysRedis.incrBy.mockRejectedValue(new Error('redis down'));
    await fileFeedbackToHq(report());

    expect(fetchMock).not.toHaveBeenCalled();
  });
});

const READY = {
  ingestion: 'Scanned',
  nsfwLevel: 1,
  needsReview: null,
  poi: false,
  minor: false,
  tosViolation: false,
};

describe('the page capture', () => {
  const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
  const withShot = (
    capture: Parameters<typeof fileFeedbackToHq>[0]['capture'] = {
      screenshotImageId: 5,
    }
  ) => report({ context: { screenshotId: SHOT }, capture });
  beforeEach(() => {
    dbMock.dbWrite.image.findUnique.mockResolvedValue(READY as never);
  });
  const serveImage = (bytes: Uint8Array<ArrayBuffer>, headers: Record<string, string> = {}) =>
    fetchMock.mockImplementation(async (url: string | URL) =>
      String(url).startsWith(HQ_ORIGIN) ? created() : new Response(bytes, { status: 200, headers })
    );

  it('is not fetched or sent while the flag is off', async () => {
    serveImage(PNG);
    await fileFeedbackToHq(withShot());

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(loggedStatuses()).toEqual(['filed']);
    expect(sentForm().get('screenshot')).toBeNull();
    expect(sentForm().get('body')).toContain('see the moderator view');
  });

  it('is sent, typed by its bytes, when the flag is on', async () => {
    isFliptMock.mockResolvedValue(true);
    serveImage(PNG, { 'content-type': 'text/html' });
    await fileFeedbackToHq(withShot());

    expect(loggedStatuses()).toEqual(['filed']);
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
    expect(loggedStatuses()).toEqual(['filed']);
    expect(sentForm().get('screenshot')).toBeNull();
    expect(sentForm().get('body')).toContain('not attached here: it could not be read');
  });

  it.each([
    ['no capture row', null, undefined, 'it was not checked'],
    [
      'not the reporter’s upload',
      { screenshotCheck: 'not-owner' as const },
      undefined,
      "it is not the reporter's upload",
    ],
    ['a flagged capture', undefined, { ...READY, minor: true }, 'its scan flagged it'],
    ['an NSFW capture', undefined, { ...READY, nsfwLevel: 4 }, 'its scan blocked it'],
  ])('is never fetched for %s, and the body says why', async (_, capture, row, reason) => {
    isFliptMock.mockResolvedValue(true);
    if (row) dbMock.dbWrite.image.findUnique.mockResolvedValue(row as never);
    serveImage(PNG);
    await fileFeedbackToHq(withShot(capture === undefined ? undefined : capture));

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(sentForm().get('screenshot')).toBeNull();
    expect(sentForm().get('body')).toContain(`not attached here: ${reason}`);
  });
});

describe('captureAttachGate', () => {
  const capture = { screenshotImageId: 5 };
  const sleep = vi.fn(async (_ms: number) => undefined);
  const gate = (rows: unknown[], c: Parameters<typeof captureAttachGate>[0] = capture) => {
    const read = vi.fn();
    for (const row of rows)
      if (row instanceof Error) read.mockRejectedValueOnce(row);
      else read.mockResolvedValueOnce(row);
    return captureAttachGate(c, { sleep, read });
  };
  const PENDING = { ...READY, ingestion: 'Pending' };

  it('lets a scanned, SFW, unflagged capture through', async () =>
    expect(await gate([READY])).toBeNull());
  it('waits out the scan, backing off', async () => {
    expect(await gate([PENDING, PENDING, READY])).toBeNull();
    expect(sleep.mock.calls.map(([ms]) => ms)).toEqual(CAPTURE_POLL_DELAYS_MS.slice(0, 2));
  });
  it('gives up after the last delay', async () => {
    expect(await gate(Array(CAPTURE_POLL_DELAYS_MS.length + 1).fill(PENDING))).toBe('scanning');
    expect(sleep).toHaveBeenCalledTimes(CAPTURE_POLL_DELAYS_MS.length);
  });
  it.each([
    ['poi', { ...READY, poi: true }, 'flagged'],
    ['minor', { ...READY, minor: true }, 'flagged'],
    ['needsReview', { ...READY, needsReview: 'poi' }, 'flagged'],
    ['tosViolation', { ...READY, tosViolation: true }, 'flagged'],
    ['an R rating', { ...READY, nsfwLevel: 4 }, 'blocked'],
    ['a Blocked scan', { ...READY, ingestion: 'Blocked' }, 'blocked'],
    ['a deleted row', null, 'gone'],
    ['a failed read', new Error('db down'), 'unreadable'],
  ])('withholds a capture with %s', async (_, row, reason) =>
    expect(await gate([row])).toBe(reason)
  );
  it('reads nothing without a capture row', async () => {
    expect(await gate([], null)).toBe('not-checked');
    expect(await gate([], { screenshotCheck: 'unverified' })).toBe('not-checked');
    expect(await gate([], { screenshotCheck: 'not-owner' })).toBe('not-owner');
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

  it('leaves no link or domain an autolinker would pick up in the title', () => {
    const title = buildHqTitle(
      report({ message: 'see https://evil.example/x and www.evil.example' })
    );
    expect(title).not.toMatch(/https?:\/\//);
    expect(title).not.toMatch(/\w\.\w/);
  });

  it('redacts an email that markup characters were splitting', () => {
    const title = buildHqTitle(report({ message: 'mail some*one@exa_mple.com please' }));
    expect(title).not.toMatch(/someone@\u200b?example/);
    expect(title).toContain('redacted-email');
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

  it('drops only the diagnostics when the words alone fit', () => {
    const consoleErrors = Array.from({ length: 50 }, (_, i) => ({
      message: `Error in widget ${i}: ${'cannot read properties of undefined, '.repeat(10)}`,
      count: 1,
    }));
    const message = 'blank page '.repeat(2_000);
    const args = {
      moderatorUrl: 'https://moderator.example.test/feedback/7',
      screenshotAttached: false,
    };
    // The control: with the diagnostics this report is over the limit.
    expect(
      Buffer.byteLength(buildHqBody(report({ message: 'x', context: { consoleErrors } }), args))
    ).toBeGreaterThan(HQ_BODY_MAX_BYTES - Buffer.byteLength(message));
    const text = buildHqBody(report({ message, context: { consoleErrors } }), args);
    expect(Buffer.byteLength(text, 'utf8')).toBeLessThanOrEqual(HQ_BODY_MAX_BYTES);
    expect(text).not.toContain('## Diagnostics');
    expect(text).not.toContain('[truncated');
    expect(text).toContain(message.trim());
  });
});

describe('what reaches HQ from the rest of the report', () => {
  const JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.c2lnbmF0dXJlLXNpZ25hdHVyZQ';
  const text = () =>
    buildHqBody(
      report({
        context: {
          route: '/x`\n# heading @justin',
          errorRef: '0123456789ab',
          consoleErrors: [
            { message: `boom \`\`\`\`\` @justin someone@example.com ${JWT}`, count: 2 },
          ],
          trpcErrors: [
            { path: 'image.create', code: 'BAD_REQUEST', at: '2026-11-09T00:00:00.000Z' },
          ],
        },
        server: { site: 'red', userAgent: 'Agent`\n## injected @justin', flags: {} },
      }),
      { moderatorUrl: 'https://moderator.example.test/feedback/7', screenshotAttached: false }
    );

  it('keeps reporter-supplied header values inside their code spans', () => {
    const header = text().split("## Reporter's words")[0];
    expect(header).not.toMatch(/^#/m);
    for (const line of header.trim().split('\n')) expect(line.startsWith('- ')).toBe(true);
  });

  it('fences the diagnostics so their own backticks cannot close the fence', () => {
    const [, diagnostics] = text().split('## Diagnostics\n\n');
    const fence = diagnostics.match(/^`+/)![0];
    expect(fence.length).toBeGreaterThan(5);
    expect(diagnostics.trimEnd().endsWith(fence)).toBe(true);
    expect(diagnostics).toContain('trpc image.create BAD_REQUEST');
  });

  it('scrubs secrets and makes mentions inert outside the reporter’s words too', () => {
    const body = text();
    expect(body).not.toContain('someone@example.com');
    expect(body).not.toContain(JWT);
    expect(body).not.toMatch(/@justin/);
  });

  it('scrubs a bare long token from a console message', () => {
    const token = 'sk_live_' + 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8';
    const body = buildHqBody(
      report({ context: { consoleErrors: [{ message: `auth failed ${token}`, count: 1 }] } }),
      { moderatorUrl: 'https://moderator.example.test/feedback/7', screenshotAttached: false }
    );
    expect(body).not.toContain(token);
  });
});

describe('what HQ gets of the session and the failed requests', () => {
  const body = () =>
    buildHqBody(
      report({
        context: {
          sessionId: 'faro-session-abc123',
          networkErrors: [
            { url: 'https://cdn.example.net/a/b.js', status: 404, initiatorType: 'script' },
          ],
          trpcErrors: [
            {
              path: 'image.create',
              code: 'BAD_REQUEST',
              httpStatus: 400,
              at: '2026-11-09T00:00:00.000Z',
            },
          ],
        },
      }),
      { moderatorUrl: 'https://moderator.example.test/feedback/7', screenshotAttached: false }
    );

  it('leaves out the session id', () => {
    expect(body()).not.toContain('faro-session-abc123');
  });

  it('lists a failed request as status and path only', () => {
    const text = body();
    expect(text).toContain('request 404 /a/b.js');
    expect(text).not.toContain('cdn.example.net');
    expect(text).toContain('trpc 400 image.create BAD_REQUEST');
  });
});

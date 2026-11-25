import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EmailSendRecord } from '../client';
import {
  createRemoteLinkTracker,
  EMAIL_LINKS_INTERNAL_PATH,
  LINK_TRACKER_TIMEOUT_MS,
  trackableHrefs,
  trackLinksVia,
  type EmailLinkSend,
  type EmailLinkTracker,
} from '../link-tracker';

// Every message the transport is handed, so a test reads the HTML that actually went out.
const h = vi.hoisted(() => ({ mails: [] as { html?: string; text?: string }[] }));
vi.mock('nodemailer', async (importOriginal) => {
  const actual = await importOriginal<typeof import('nodemailer')>();
  const createTransport = () => ({
    sendMail: async (mail: { html?: string; text?: string }) => {
      h.mails.push(mail);
      return { messageId: '<m@test>', rejected: [] };
    },
  });
  return { ...actual, default: { ...actual.default, createTransport } };
});

const send: EmailLinkSend = {
  sendId: '0b6f3d4e-8f7a-4c1e-9d2b-5a6c7e8f9a0b',
  template: 'appealResolution',
  mailClass: 'transactional',
  campaign: '',
  variant: '',
  userId: 7,
};
const CLICK = (n: number) => `https://main.test/api/email/click?p=${n}&s=sig`;

// Answers as the main app's route does for these fixtures: civitai.com links tracked, in order.
const routeFetch = () =>
  vi.fn(async (_url: string, init: RequestInit) => {
    const { links } = JSON.parse(String(init.body)) as { links: string[] };
    let n = 0;
    const out = links.map((l) => (l.startsWith('https://civitai.com/') ? CLICK(++n) : l));
    return Response.json({ links: out });
  });

const tracker = (fetch: unknown, extra: Record<string, unknown> = {}) =>
  createRemoteLinkTracker({
    baseUrl: 'https://main.test/',
    token: 'svc-token',
    fetch: fetch as typeof globalThis.fetch,
    ...extra,
  })!;

describe('createRemoteLinkTracker', () => {
  it('POSTs the send and its links, and only those, with the service credential', async () => {
    const fetch = routeFetch();
    const hrefs = ['https://civitai.com/images/1', 'https://example.test/x'];
    expect(await tracker(fetch)(send, hrefs)).toEqual([CLICK(1), 'https://example.test/x']);
    expect(EMAIL_LINKS_INTERNAL_PATH).toBe('/api/internal/email-links');
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe('https://main.test/api/internal/email-links');
    expect(init.method).toBe('POST');
    expect(init.headers).toEqual({
      authorization: 'Bearer svc-token',
      'content-type': 'application/json',
    });
    expect(JSON.parse(String(init.body))).toEqual({ ...send, links: hrefs });
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it('is null, and sends nothing, without a base URL or a token', () => {
    expect(createRemoteLinkTracker({ baseUrl: '', token: 't' })).toBeNull();
    expect(createRemoteLinkTracker({ baseUrl: 'https://main.test', token: ' ' })).toBeNull();
  });

  it('never calls out for an email with no links', async () => {
    const fetch = routeFetch();
    expect(await tracker(fetch)(send, [])).toEqual([]);
    expect(fetch).not.toHaveBeenCalled();
  });

  const hrefs = ['https://civitai.com/images/1', 'https://civitai.com/content/tos'];
  it.each([
    ['a refusal', async () => new Response(null, { status: 401 }), 'status 401'],
    ['an unconfigured route', async () => new Response(null, { status: 503 }), 'status 503'],
    [
      'a network error',
      async () => {
        throw new TypeError('fetch failed');
      },
      'TypeError',
    ],
    ['a body that is not JSON', async () => new Response('<html>'), 'SyntaxError'],
    ['an answer with no links', async () => Response.json({}), 'malformed answer'],
    ['too few links', async () => Response.json({ links: [CLICK(1)] }), 'malformed answer'],
    [
      'a link rewritten somewhere other than the click redirect',
      async () => Response.json({ links: ['https://evil.test/x', hrefs[1]] }),
      'malformed answer',
    ],
  ])('sends the links as written on %s, and says why', async (_, impl, reason) => {
    const onError = vi.fn();
    expect(await tracker(vi.fn(impl), { onError })(send, hrefs)).toEqual(hrefs);
    expect(onError).toHaveBeenCalledWith(reason);
  });

  it(`gives up after ${LINK_TRACKER_TIMEOUT_MS} ms by default, sending the links as written`, async () => {
    expect(LINK_TRACKER_TIMEOUT_MS).toBe(2000);
    const onError = vi.fn();
    // Hangs until its signal aborts, as a stalled main app would.
    const fetch = vi.fn(
      (_u: string, init: RequestInit) =>
        new Promise<Response>((_, reject) =>
          init.signal!.addEventListener('abort', () => reject(init.signal!.reason))
        )
    );
    const started = Date.now();
    expect(await tracker(fetch, { onError, timeoutMs: 50 })(send, hrefs)).toEqual(hrefs);
    expect(Date.now() - started).toBeLessThan(1500);
    expect(onError).toHaveBeenCalledWith('TimeoutError');
  });
});

describe('trackLinksVia', () => {
  const html = [
    '<a href="https://civitai.com/images/1">one</a>',
    '<a href="mailto:appeals@civitai.com">mail</a>',
    '<a class="x" href="https://example.test/y">off</a>',
    '<a href="https://civitai.com/content/tos">tos</a>',
  ].join('');

  it('replaces each link the tracker rewrote, in order, and leaves the rest as written', async () => {
    const out = await trackLinksVia(tracker(routeFetch()), html, send);
    expect(out).toBe(
      [
        '<a href="https://main.test/api/email/click?p=1&amp;s=sig">one</a>',
        '<a href="mailto:appeals@civitai.com">mail</a>',
        '<a class="x" href="https://example.test/y">off</a>',
        '<a href="https://main.test/api/email/click?p=2&amp;s=sig">tos</a>',
      ].join('')
    );
  });

  it('never sends a mailto: (an address) or any non-web link', async () => {
    expect(trackableHrefs(html)).toEqual([
      'https://civitai.com/images/1',
      'https://example.test/y',
      'https://civitai.com/content/tos',
    ]);
    expect(trackableHrefs('<a href="javascript:x">j</a><a href="tel:1">t</a>')).toEqual([]);
  });

  it('leaves the HTML exactly as written when the tracker throws or answers short', async () => {
    const throws: EmailLinkTracker = async () => {
      throw new Error('boom');
    };
    expect(await trackLinksVia(throws, html, send)).toBe(html);
    expect(await trackLinksVia(async () => ['x'], html, send)).toBe(html);
  });
});

describe('createEmail with a link tracker', () => {
  const saved = { ...process.env };
  beforeEach(() => {
    Object.assign(process.env, {
      EMAIL_HOST: 'smtp.example.test',
      EMAIL_PORT: '587',
      EMAIL_USER: 'user',
      EMAIL_PASS: 'pass',
      EMAIL_FROM: 'Civitai <noreply@example.test>',
    });
    h.mails.length = 0;
  });
  afterEach(() => {
    process.env = { ...saved };
  });

  async function load(oneTimeTokenLinks?: true) {
    vi.resetModules(); // client.ts memoizes its transport; the tracker is module state
    const client = await import('../client');
    const links = await import('../link-tracker');
    const { createEmail } = await import('../create-email');
    const rows: EmailSendRecord[] = [];
    client.setEmailSendRecorder((r) => void rows.push(r));
    const email = createEmail({
      template: 'appealResolution',
      mailClass: 'transactional',
      ...(oneTimeTokenLinks ? { oneTimeTokenLinks } : {}),
      header: (to: string) => ({ subject: 'Hi', to }),
      html: () => '<a href="https://civitai.com/images/1">one</a>',
    });
    return { email, rows, setTracker: links.setEmailLinkTracker };
  }

  it('sends the tracked HTML, and the links and the send row carry one send id', async () => {
    const { email, rows, setTracker } = await load();
    const seen: EmailLinkSend[] = [];
    setTracker(async (s, hrefs) => {
      seen.push(s);
      return hrefs.map(() => CLICK(1));
    });
    await email.send('a@example.test', { userId: 7 });
    expect(h.mails[0]!.html).toBe(
      '<a href="https://main.test/api/email/click?p=1&amp;s=sig">one</a>'
    );
    expect(seen).toEqual([{ ...send, sendId: rows[0]!.sendId }]);
  });

  it('never sends a one-time-token template to the tracker', async () => {
    const { email, setTracker } = await load(true);
    const tracked = vi.fn<EmailLinkTracker>(async (_, hrefs) => hrefs.map(() => CLICK(1)));
    setTracker(tracked);
    await email.send('a@example.test');
    expect(tracked).not.toHaveBeenCalled();
    expect(h.mails[0]!.html).toBe('<a href="https://civitai.com/images/1">one</a>');
  });

  it('still sends, with the links as written, when the main app is down', async () => {
    const { email, rows, setTracker } = await load();
    setTracker(tracker(async () => new Response(null, { status: 502 })));
    await email.send('a@example.test');
    expect(h.mails[0]!.html).toBe('<a href="https://civitai.com/images/1">one</a>');
    expect(rows).toHaveLength(1);
  });
});

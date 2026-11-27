import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The moderator server's calls to the main app, against a real local HTTP server so the Host header is
 * read off the wire: Node's fetch silently drops a Host set in `headers`, and a mocked fetch cannot see that.
 */

const env = vi.hoisted(() => ({} as Record<string, string | undefined>));
const registered = vi.hoisted(() => ({
  tracker: null as unknown,
  recorder: null as unknown,
}));

vi.mock('$env/dynamic/private', () => ({ env }));
vi.mock('$lib/server/db', async () => {
  const { capturingDb } = await import('../../../test/capture-sql');
  return { dbRead: capturingDb([], []), dbWrite: capturingDb([], []) };
});
vi.mock('$lib/server/axiom', () => ({
  logToAxiom: vi.fn(async () => undefined),
  logAxiomError: vi.fn(async () => undefined),
}));
vi.mock('../mod-activity', () => ({
  recordModActivity: vi.fn(async () => undefined),
  recordModActivityBatch: vi.fn(async () => undefined),
}));
vi.mock('$app/server', () => ({
  getRequestEvent: () => ({
    locals: {},
    request: { headers: new Headers({ cookie: 'civ-token=from-the-request' }) },
  }),
}));
vi.mock('@civitai/email', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@civitai/email')>()),
  setEmailLinkTracker: (t: unknown) => (registered.tracker = t),
  setEmailSendRecorder: (r: unknown) => (registered.recorder = r),
}));

const { civitaiAppUrl } = await import('../civitai-url');
const { callModEndpointAs, readModEndpoint, setImageFlag } = await import(
  '../user-actions.service'
);
const { evictHomeBlocks } = await import('../home-blocks');
const { syncSearchIndex } = await import('../search-index');
const { registerEmailLinkTracker } = await import('../emails/link-tracker');
const { registerEmailSendRecorder } = await import('../emails/send-recorder');

type Seen = { method?: string; url?: string; headers: IncomingHttpHeaders; body: string };
let seen: Seen[] = [];
let server: Server;
let local: string;

beforeAll(async () => {
  server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      seen.push({ method: req.method, url: req.url, headers: req.headers, body });
      if (req.url?.startsWith('/api/mod/strike/void')) {
        res.statusCode = 302;
        res.setHeader('location', '/api/mod/redirected');
        res.end();
        return;
      }
      res.setHeader('content-type', 'application/json');
      res.end('{"ok":true}');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  local = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

beforeEach(() => {
  seen = [];
  for (const key of Object.keys(env)) delete env[key];
  env.WEBHOOK_TOKEN = 'webhook-secret';
  env.AUTH_INTERNAL_TOKEN = 'internal-secret';
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

const send = {
  sendId: 's1',
  template: 't',
  mailClass: 'transactional',
  campaign: '',
  variant: '',
  userId: 0,
} as const;

describe('without CIVITAI_INTERNAL_URL', () => {
  it('sends main-app calls to CIVITAI_APP_URL with its own Host, as before', async () => {
    env.CIVITAI_APP_URL = `${local}/`;

    const result = await callModEndpointAs('civ-token=mod', 'user/unmute', { userId: 7 }, 'Unmute');

    expect(result.ok).toBe(true);
    expect(seen).toHaveLength(1);
    expect(seen[0].url).toBe('/api/mod/user/unmute');
    expect(seen[0].headers.host).toBe(new URL(local).host);
  });
});

describe('with CIVITAI_INTERNAL_URL', () => {
  beforeEach(() => {
    env.CIVITAI_APP_URL = 'https://civitai.com';
    env.CIVITAI_INTERNAL_URL = `${local}/`;
  });

  it('relays the session to the internal URL under the public Host', async () => {
    const result = await callModEndpointAs(
      'civ-token=the-moderators-session',
      'user/unmute',
      { userId: 3 },
      'Unmute'
    );

    expect(result.ok).toBe(true);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      method: 'POST',
      url: '/api/mod/user/unmute',
      body: JSON.stringify({ userId: 3 }),
    });
    expect(seen[0].headers.host).toBe('civitai.com');
    expect(seen[0].headers.cookie).toBe('civ-token=the-moderators-session');
    expect(seen[0].headers['content-type']).toBe('application/json');
  });

  it('sends a mod read as a GET with the request cookie, under the public Host', async () => {
    const result = await readModEndpoint('creator-services/disputes', { page: 2 }, 'Disputes');

    expect(result.ok).toBe(true);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      method: 'GET',
      url: '/api/mod/creator-services/disputes?page=2',
    });
    expect(seen[0].headers.host).toBe('civitai.com');
    expect(seen[0].headers.cookie).toBe('civ-token=from-the-request');
  });

  it('returns a redirect as a failure instead of following it', async () => {
    const result = await callModEndpointAs('civ-token=mod', 'strike/void', { strikeId: 3 }, 'Void');

    expect(result.ok).toBe(false);
    expect(seen.map((s) => s.url)).toEqual(['/api/mod/strike/void']);
  });

  it('sends webhook-token calls under the public Host', async () => {
    const result = await setImageFlag({
      imageIds: [11],
      flag: 'minor',
      value: true,
      moderatorId: 2,
      csamReview: true,
    });
    expect(result.ok).toBe(true);
    const flag = seen.find((s) => s.url?.startsWith('/api/mod/update-image-flag?'));
    expect(flag?.headers.host).toBe('civitai.com');
    const query = new URLSearchParams(flag!.url!.split('?')[1]);
    expect(query.get('token')).toBe('webhook-secret');
    expect(query.get('csamReview')).toBe('true');

    await evictHomeBlocks([5]);
    const evict = seen.find((s) => s.url?.startsWith('/api/internal/home-block-evict?'));
    expect(evict?.headers.host).toBe('civitai.com');
    expect(evict?.body).toBe(JSON.stringify({ imageIds: [5] }));

    await syncSearchIndex({ entityType: 'Image', entityId: 9 });
    const sync = seen.find((s) => s.url?.startsWith('/api/internal/search-index-update?'));
    expect(sync?.headers.host).toBe('civitai.com');
    expect(JSON.parse(sync!.body)).toMatchObject({ entityType: 'Image', entityId: 9 });
  });

  it('sends the email link tracker call under the public Host', async () => {
    expect(registerEmailLinkTracker()).toBe(true);
    const tracker = registered.tracker as (s: typeof send, hrefs: string[]) => Promise<string[]>;

    await tracker(send, ['https://civitai.com/models/1']);

    expect(seen).toHaveLength(1);
    expect(seen[0].url).toBe('/api/internal/email-links');
    expect(seen[0].headers.host).toBe('civitai.com');
    expect(seen[0].headers.authorization).toBe('Bearer internal-secret');
  });

  it('sends the email send row under the public Host', async () => {
    expect(registerEmailSendRecorder()).toBe(true);
    const recorder = registered.recorder as (r: unknown) => Promise<void>;

    await recorder({ ...send, sentAt: new Date(0) });

    expect(seen).toHaveLength(1);
    expect(seen[0].url).toBe('/api/internal/email-events');
    expect(seen[0].headers.host).toBe('civitai.com');
  });

  it('leaves the public base for redirects and links', () => {
    expect(civitaiAppUrl()).toBe('https://civitai.com');
  });
});

import type { NextApiRequest, NextApiResponse } from 'next';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { modActionResponse } from '@civitai/moderation';
import { setEnv } from '~/__tests__/mocks/env.mock';

// The moderator app is the network boundary: fetch is the only fake. The flag is passed in.
const flags = { takedownRequests: true };
let handler: (req: NextApiRequest, res: NextApiResponse) => Promise<unknown>;
const REF = 'TD-26-ABC123';
const view = {
  publicRef: REF,
  title: 'DMCA copyright notice',
  role: 'claimant',
  state: { id: 'received', label: 'Received', terminal: false },
  receivedAt: '2026-11-20T16:00:00.000Z',
  items: [],
  actions: [],
};

beforeAll(async () => {
  vi.stubGlobal('fetch', fetchMock);
  setEnv({
    MOD_CASES_TOKEN: 'cases-token',
    MODERATOR_APP_URL: 'https://mod.example',
    MODERATOR_APP_INTERNAL_URL: '',
  });
  const { createCaseRoute } = await import('~/server/takedown-requests/case-route');
  handler = createCaseRoute({ formsOpen: async () => flags.takedownRequests });
});
afterEach(() => {
  fetchMock.mockReset();
  flags.takedownRequests = true;
});

function call({
  method = 'POST',
  body,
  cookie,
  contentType = 'application/json',
}: {
  method?: string;
  body?: unknown;
  cookie?: string;
  contentType?: string;
}) {
  const headers: Record<string, string | string[]> = {};
  let status = 200;
  let json: unknown;
  const res = {
    setHeader: (k: string, v: string | string[]) => void (headers[k.toLowerCase()] = v),
    getHeader: (k: string) => headers[k.toLowerCase()],
    status: (s: number) => ((status = s), res),
    json: (b: unknown) => ((json = b), res),
    end: () => res,
  };
  const req = {
    method,
    body,
    query: { publicRef: REF },
    headers: { 'content-type': contentType, 'cf-connecting-ip': '203.0.113.9' },
    cookies: cookie ? { 'civ-case-link': cookie } : {},
  };
  return handler(req as unknown as NextApiRequest, res as unknown as NextApiResponse).then(() => ({
    status,
    json,
    headers,
  }));
}

// Stubbed before the module loads: the client keeps the fetch it was built with.
const fetchMock = vi.fn<typeof fetch>();
function moderatorAnswers(status: number, body: unknown) {
  // A success goes out in the moderator app's envelope, as the real route sends it.
  const wire = status < 400 ? modActionResponse(body) : body;
  fetchMock.mockImplementation(async () => new Response(JSON.stringify(wire), { status }));
  return fetchMock;
}

const TOKEN = 'x'.repeat(43);

describe('/api/requests/case/[publicRef]', () => {
  it('is closed when the takedownRequests flag is off, before the moderator app is asked', async () => {
    flags.takedownRequests = false;
    moderatorAnswers(200, view);
    const out = await call({ body: { token: TOKEN } });
    expect(out.status).toBe(503);
    expect(out.headers['set-cookie']).toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('exchanges a valid link token for a cookie scoped to this case only', async () => {
    const fetchMock = moderatorAnswers(200, view);
    const out = await call({ body: { token: TOKEN } });
    expect(out.status).toBe(200);
    const cookie = String(out.headers['set-cookie']);
    expect(cookie).toContain(`civ-case-link=${TOKEN}`);
    expect(cookie).toContain(`Path=/api/requests/case/${REF}`);
    expect(cookie).toMatch(/HttpOnly.*Secure.*SameSite=Strict/);
    expect(out.headers['referrer-policy']).toBe('no-referrer');
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://mod.example/api/mod/case-party-view');
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer cases-token');
  });

  it('sets no cookie for a token the moderator app refuses', async () => {
    moderatorAnswers(404, { message: 'This link has expired or is not valid.', public: true });
    const out = await call({ body: { token: TOKEN } });
    expect(out.status).toBe(404);
    expect(out.headers['set-cookie']).toBeUndefined();
  });

  it('acts with the cookie, never with a token in the action body', async () => {
    const fetchMock = moderatorAnswers(200, { recorded: 'info-added' });
    const out = await call({
      body: {
        actionId: 'add-info',
        values: {},
        submissionId: crypto.randomUUID(),
        token: 'y'.repeat(43),
      },
      cookie: TOKEN,
    });
    expect(out.status).toBe(200);
    const sent = JSON.parse(
      String((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body)
    );
    expect(sent).toMatchObject({ publicRef: REF, token: TOKEN, actionId: 'add-info' });
  });

  it('refuses a cross-site form post', async () => {
    const fetchMock = moderatorAnswers(200, {});
    const out = await call({
      body: 'actionId=x',
      cookie: TOKEN,
      contentType: 'application/x-www-form-urlencoded',
    });
    expect(out.status).toBe(415);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('reloads the case from the cookie alone', async () => {
    const fetchMock = moderatorAnswers(200, view);
    const out = await call({ method: 'GET', cookie: TOKEN });
    expect(out.status).toBe(200);
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]!.body))).toMatchObject({ token: TOKEN });
  });

  it('shows a moderator-app fault as unavailable, not as an expired link, and passes none of its text', async () => {
    moderatorAnswers(403, { message: 'This credential cannot call this action.' });
    const out = await call({ method: 'GET', cookie: TOKEN });
    expect(out.status).toBe(503);
    expect(JSON.stringify(out.json)).not.toContain('credential');
  });
});

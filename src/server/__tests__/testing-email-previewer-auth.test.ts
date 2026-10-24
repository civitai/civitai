import { beforeEach, describe, expect, it, vi } from 'vitest';
import '~/__tests__/mocks/logging.mock';
import '~/__tests__/mocks/db.mock';

/**
 * Whoever is about to unwrap this handler so the previewer opens in a browser without a
 * token: it renders any email template's test HTML from the URL path, and on `?send` it
 * SENDS. Pass `?token=$WEBHOOK_TOKEN` instead.
 *
 * The guard is exercised through the REAL `WebhookEndpoint` rather than a stub, so an edit
 * inside the wrapper reddens here too. Stubbing it would only pin that a function of that
 * name was applied.
 *
 * Unknown-template handling is not covered: reading an absent export off a `vi.mock`
 * factory throws rather than returning undefined, so the case would test the mock.
 */

// The canonical env mock in src/__tests__/setup.ts already supplies this; replacing the
// whole module would drop every schema default with it.
const TOKEN = 'test-webhook-token';

const { getTestData, getHtml, send } = vi.hoisted(() => ({
  getTestData: vi.fn(async () => ({ username: 'tester' })),
  getHtml: vi.fn(() => '<p>rendered</p>'),
  send: vi.fn(async () => undefined),
}));

vi.mock('~/server/email/templates', () => ({ knownEmail: { getTestData, getHtml, send } }));

const handler = (await import('~/pages/api/testing/email/[template]')).default;

function call(query: Record<string, string>) {
  const req = { method: 'GET', query, headers: {} } as never;
  let statusCode = 0;
  let body: unknown;
  const res = {
    status(code: number) {
      statusCode = code;
      return res;
    },
    send(data: unknown) {
      body = data;
      return res;
    },
    json: () => res,
    setHeader: () => res,
    end: () => res,
  };
  return handler(req, res as never).then(() => ({ statusCode, body }));
}

describe('email previewer route auth', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getTestData.mockResolvedValue({ username: 'tester' });
    getHtml.mockReturnValue('<p>rendered</p>');
  });

  it('refuses a wrong token, renders nothing and sends nothing', async () => {
    const { statusCode } = await call({ template: 'known', token: 'wrong', send: '1' });

    expect(statusCode).toBe(401);
    expect(getTestData).not.toHaveBeenCalled();
    expect(getHtml).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it('refuses a request carrying no token at all', async () => {
    const { statusCode } = await call({ template: 'known', send: '1' });

    expect(statusCode).toBe(401);
    expect(send).not.toHaveBeenCalled();
  });

  it('POSITIVE CONTROL: renders for the right token, and does not send unprompted', async () => {
    const { statusCode, body } = await call({ template: 'known', token: TOKEN });

    expect(statusCode).toBe(200);
    expect(body).toBe('<p>rendered</p>');
    expect(send).not.toHaveBeenCalled();
  });

  it('POSITIVE CONTROL: sends for the right token when asked to', async () => {
    const { statusCode } = await call({ template: 'known', token: TOKEN, send: '1' });

    expect(statusCode).toBe(200);
    expect(send).toHaveBeenCalledTimes(1);
  });
});

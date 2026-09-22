import { beforeEach, describe, expect, it, vi } from 'vitest';

// `endpoint-helpers` spreads `env.TRPC_ORIGINS` at module load, so an unmocked import
// of the page throws. Stub the wrapper itself, per the pattern in
// src/server/__tests__/eventloop-stall-endpoint.test.ts.
const webhookEndpoint = vi.fn((handler: unknown) => handler);
vi.mock('~/server/utils/endpoint-helpers', () => ({
  WebhookEndpoint: (handler: unknown) => webhookEndpoint(handler),
}));

vi.mock('~/server/email/templates', () => ({}));

beforeEach(() => {
  vi.resetModules();
  webhookEndpoint.mockClear();
});

// Whoever is about to unwrap this handler so the previewer opens in a browser without
// a token: it renders and, on `?send`, SENDS a real email, and it is the only route in
// src/pages/api/testing/ that ever shipped without the directory's token guard. Pass
// `?token=$WEBHOOK_TOKEN` instead.
describe('email previewer route auth', () => {
  it('routes its default export through WebhookEndpoint', async () => {
    const mod = await import('~/pages/api/testing/email/[template]');

    expect(webhookEndpoint).toHaveBeenCalledTimes(1);
    expect(mod.default).toBe(webhookEndpoint.mock.results[0].value);
  });
});

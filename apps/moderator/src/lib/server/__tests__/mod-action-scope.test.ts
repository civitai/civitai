import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

// Each credential reaches only its own actions on /api/mod/[action]: the scoped intake credential
// (`tokenClient: 'cases'`) only CASE_ACTIONS, the general one everything else.
vi.mock('$lib/server/mod-actions/registry', () => ({
  modActions: {
    'image-moderate': { schema: z.any(), handler: async () => 'moderated' },
    'case-intake': { schema: z.any(), handler: async () => 'filed' },
  },
}));

const { POST } = await import('../../../routes/api/mod/[action]/+server');
const { WebhookEndpoint } = await import('$lib/server/webhook-endpoint');

function call(action: string, tokenClient?: 'webhook' | 'cases') {
  const request = new Request(`https://moderator.civitai.com/api/mod/${action}`, {
    method: 'POST',
    body: '{}',
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (POST as any)({ params: { action }, request, locals: { tokenClient } });
}

async function statusOf(p: Promise<Response>) {
  try {
    return (await p).status;
  } catch (e) {
    return (e as { status: number }).status;
  }
}

describe('/api/mod/[action] credential scope', () => {
  it('the general credential reaches a moderation action', async () => {
    expect(await statusOf(call('image-moderate', 'webhook'))).toBe(200);
  });

  it('the scoped intake credential reaches a case action', async () => {
    expect(await statusOf(call('case-intake', 'cases'))).toBe(200);
  });

  it('the scoped intake credential is refused on a moderation action', async () => {
    expect(await statusOf(call('image-moderate', 'cases'))).toBe(403);
  });

  it('the general credential is refused on a case action', async () => {
    expect(await statusOf(call('case-intake', 'webhook'))).toBe(403);
  });

  it('no credential is refused', async () => {
    expect(await statusOf(call('case-intake'))).toBe(401);
  });
});

describe('every other service endpoint', () => {
  it('refuses the scoped intake credential', async () => {
    const wrapped = WebhookEndpoint(() => new Response('reached'));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(
      await statusOf(
        Promise.resolve().then(() => wrapped({ locals: { tokenClient: 'cases' } } as any))
      )
    ).toBe(401);
  });
});

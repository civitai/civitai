import { describe, expect, it, vi } from 'vitest';
import { actions, load } from '../+page.server';

describe('device verification page', () => {
  it('forbids framing', () => {
    const setHeaders = vi.fn();
    load({
      url: new URL('https://auth.civitai.com/login/oauth/device'),
      locals: { user: { id: 7 } },
      setHeaders,
    } as never);
    expect(setHeaders).toHaveBeenCalledWith({
      'content-security-policy': "frame-ancestors 'none'",
      'x-frame-options': 'DENY',
    });
  });

  it.each([
    [
      { error: 'access_denied', error_description: 'Not available while impersonating' },
      'Devices cannot be approved while impersonating. Exit impersonation first.',
    ],
    [{ error: 'forbidden' }, 'Could not approve that code — it may have expired. Try again.'],
  ])('says why approval was refused', async (body, message) => {
    const form = new FormData();
    form.set('user_code', 'ABCD-EFGH');
    const result = await actions.approve({
      request: new Request('https://auth.civitai.com/login/oauth/device', {
        method: 'POST',
        body: form,
      }),
      fetch: async () => new Response(JSON.stringify(body), { status: 403 }),
    } as never);
    expect(result).toMatchObject({ data: { error: message } });
  });
});

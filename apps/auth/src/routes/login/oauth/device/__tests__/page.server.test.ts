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
    [403, 'Devices cannot be approved while impersonating. Exit impersonation first.'],
    [400, 'Could not approve that code — it may have expired. Try again.'],
  ])('says why approval failed with a %s', async (status, message) => {
    const form = new FormData();
    form.set('user_code', 'ABCD-EFGH');
    const result = await actions.approve({
      request: new Request('https://auth.civitai.com/login/oauth/device', {
        method: 'POST',
        body: form,
      }),
      fetch: async () => new Response('{}', { status }),
    } as never);
    expect(result).toMatchObject({ data: { error: message } });
  });
});

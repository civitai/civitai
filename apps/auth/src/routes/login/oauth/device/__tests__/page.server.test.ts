import { describe, expect, it, vi } from 'vitest';
import { load } from '../+page.server';

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
});

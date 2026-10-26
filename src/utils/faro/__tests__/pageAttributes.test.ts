import { describe, expect, it } from 'vitest';
import { deepRedact } from '~/utils/faro/redact';
import { buildRumPageAttributes, isHardLoadSignedIn } from '~/utils/faro/pageAttributes';

// Wire strings: RUM queries match `page_attr_render_mode` / `page_attr_viewer` on these values.
describe('buildRumPageAttributes', () => {
  // The input `_app` derives from a shell's pageProps: no session, `hasAuthCookie: true` (a shell
  // is only served with a session cookie).
  it('a shell hard load is `shell` + `signed-in`', () => {
    expect(buildRumPageAttributes({ shell: true, signedIn: true })).toEqual({
      render_mode: 'shell',
      viewer: 'signed-in',
    });
  });

  it('a full render with a session is `ssr` + `signed-in`', () => {
    expect(buildRumPageAttributes({ shell: false, signedIn: true })).toEqual({
      render_mode: 'ssr',
      viewer: 'signed-in',
    });
  });

  it('a full render without a session is `ssr` + `anon`', () => {
    expect(buildRumPageAttributes({ shell: false, signedIn: false })).toEqual({
      render_mode: 'ssr',
      viewer: 'anon',
    });
  });

  it('passes the beforeSend PII scrub unchanged, nested where Faro puts it', () => {
    for (const shell of [true, false]) {
      for (const signedIn of [true, false]) {
        const attributes = buildRumPageAttributes({ shell, signedIn });
        const meta = { page: { url: 'https://civitai.test/images/1', attributes } };
        expect(deepRedact(meta).page.attributes).toEqual(attributes);
      }
    }
  });
});

// Inputs are the pageProps shapes `_app.getInitialProps` returns for each kind of hard load.
describe('isHardLoadSignedIn', () => {
  it('a shell (no session, `hasAuthCookie: true`) is signed in', () => {
    expect(isHardLoadSignedIn({ hasAuthCookie: true })).toBe(true);
  });

  it('a full render with a resolved session is signed in', () => {
    expect(isHardLoadSignedIn({ session: { user: { id: 1 } }, hasAuthCookie: true })).toBe(true);
  });

  it('a full render without a session (no cookie, or a rejected one) is anon', () => {
    expect(isHardLoadSignedIn({ session: null, hasAuthCookie: false })).toBe(false);
  });
});

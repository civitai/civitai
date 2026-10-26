import { describe, expect, it } from 'vitest';
import { deepRedact } from '~/utils/faro/redact';
import {
  buildRumPageAttributes,
  RUM_RENDER_MODE_ATTR,
  resolveRumRenderMode,
} from '~/utils/faro/renderMode';

describe('resolveRumRenderMode', () => {
  it('a document rendered as the static shell (`pageProps.shell === true`) is `shell`', () => {
    expect(resolveRumRenderMode(true)).toBe('shell');
  });

  it('a full render (marker absent) is `ssr`', () => {
    expect(resolveRumRenderMode(undefined)).toBe('ssr');
  });

  it('only a literal `true` counts as a shell — any other value is `ssr`', () => {
    expect(resolveRumRenderMode(false)).toBe('ssr');
    expect(resolveRumRenderMode(null)).toBe('ssr');
    expect(resolveRumRenderMode('true')).toBe('ssr');
    expect(resolveRumRenderMode(1)).toBe('ssr');
  });
});

describe('buildRumPageAttributes', () => {
  it('produces exactly the `render_mode` page attribute (Loki `page_attr_render_mode`)', () => {
    // Wire strings: RUM queries match `page_attr_render_mode="shell"` / `="ssr"`.
    expect(RUM_RENDER_MODE_ATTR).toBe('render_mode');
    expect(buildRumPageAttributes(true)).toEqual({ render_mode: 'shell' });
    expect(buildRumPageAttributes(undefined)).toEqual({ render_mode: 'ssr' });
  });

  it('passes the beforeSend PII scrub unchanged, nested where Faro puts it', () => {
    for (const shell of [true, undefined]) {
      const attributes = buildRumPageAttributes(shell);
      const meta = { page: { url: 'https://civitai.test/images/1', attributes } };
      expect(deepRedact(meta).page.attributes).toEqual(buildRumPageAttributes(shell));
    }
  });
});

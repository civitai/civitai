import { describe, expect, it } from 'vitest';
import { serializeJsonLd } from '../json-ld';

describe('serializeJsonLd', () => {
  const name = '</script><script>x</script> & <!-- \u2028\u2029';
  const value = { '@type': 'Thing', name, nested: [{ name }] };

  it('round-trips through JSON.parse unchanged', () => {
    expect(JSON.parse(serializeJsonLd(value))).toEqual(value);
  });

  it('emits no character that can close or open markup inside a script element', () => {
    const out = serializeJsonLd(value);
    expect(out).not.toMatch(/[<>&\u2028\u2029]/);
    const backslash = String.fromCharCode(92);
    for (const escaped of ['u003c/script', 'u003e', 'u0026', 'u2028', 'u2029']) {
      expect(out).toContain(backslash + escaped);
    }
  });

  it('matches JSON.stringify when nothing needs escaping', () => {
    const plain = { '@type': 'WebSite', url: 'https://civitai.com/models/1?x=y' };
    expect(serializeJsonLd(plain)).toBe(JSON.stringify(plain));
  });
});

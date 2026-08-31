import { describe, expect, it } from 'vitest';

import {
  BLOCK_SOURCE_IMAGES_WIRE_MAX,
  DIM_MAX,
  DIM_MIN,
  blockWorkflowBodySchema,
  LORA_STRENGTH_MAX,
  LORA_STRENGTH_MIN,
  MAX_ADDITIONAL_RESOURCES,
  SOURCE_IMAGE_URL_MAX,
} from '../workflow.schema';

/**
 * Page-LoRA (Increment 1) — body-schema coverage. The block body runs in an
 * untrusted iframe, so the additionalResources array caps (count, strength,
 * positive version id) are enforced at the boundary. These tests lock the
 * cap geometry so a future loosening is caught.
 */

const baseBody = (over: Record<string, unknown> = {}) => ({
  kind: 'textToImage' as const,
  modelId: 7,
  modelVersionId: 99,
  params: { prompt: 'a cat', quantity: 1 },
  ...over,
});

describe('blockWorkflowBodySchema — additionalResources (Page-LoRA)', () => {
  it('parses a body with NO additionalResources (field is optional)', () => {
    const parsed = blockWorkflowBodySchema.parse(baseBody());
    expect(parsed.kind).toBe('textToImage');
    // Optional + absent → stays undefined (not coerced to []).
    expect((parsed as { additionalResources?: unknown }).additionalResources).toBeUndefined();
  });

  it('parses up to MAX_ADDITIONAL_RESOURCES LoRA entries', () => {
    const resources = Array.from({ length: MAX_ADDITIONAL_RESOURCES }, (_, i) => ({
      modelVersionId: 1000 + i,
      strength: 1,
    }));
    const parsed = blockWorkflowBodySchema.parse(baseBody({ additionalResources: resources }));
    expect((parsed as any).additionalResources).toHaveLength(MAX_ADDITIONAL_RESOURCES);
  });

  it('REJECTS more than MAX_ADDITIONAL_RESOURCES entries', () => {
    const resources = Array.from({ length: MAX_ADDITIONAL_RESOURCES + 1 }, (_, i) => ({
      modelVersionId: 1000 + i,
      strength: 1,
    }));
    expect(() =>
      blockWorkflowBodySchema.parse(baseBody({ additionalResources: resources }))
    ).toThrow();
  });

  it('defaults strength to 1 when omitted', () => {
    const parsed = blockWorkflowBodySchema.parse(
      baseBody({ additionalResources: [{ modelVersionId: 1234 }] })
    );
    expect((parsed as any).additionalResources[0].strength).toBe(1);
  });

  it('accepts strength at the inclusive bounds [MIN, MAX]', () => {
    const parsed = blockWorkflowBodySchema.parse(
      baseBody({
        additionalResources: [
          { modelVersionId: 1, strength: LORA_STRENGTH_MIN },
          { modelVersionId: 2, strength: LORA_STRENGTH_MAX },
        ],
      })
    );
    expect((parsed as any).additionalResources[0].strength).toBe(LORA_STRENGTH_MIN);
    expect((parsed as any).additionalResources[1].strength).toBe(LORA_STRENGTH_MAX);
  });

  it('REJECTS strength below the minimum', () => {
    expect(() =>
      blockWorkflowBodySchema.parse(
        baseBody({ additionalResources: [{ modelVersionId: 1, strength: LORA_STRENGTH_MIN - 0.1 }] })
      )
    ).toThrow();
  });

  it('REJECTS strength above the maximum', () => {
    expect(() =>
      blockWorkflowBodySchema.parse(
        baseBody({ additionalResources: [{ modelVersionId: 1, strength: LORA_STRENGTH_MAX + 0.1 }] })
      )
    ).toThrow();
  });

  it('REJECTS a non-positive modelVersionId', () => {
    expect(() =>
      blockWorkflowBodySchema.parse(
        baseBody({ additionalResources: [{ modelVersionId: 0, strength: 1 }] })
      )
    ).toThrow();
    expect(() =>
      blockWorkflowBodySchema.parse(
        baseBody({ additionalResources: [{ modelVersionId: -5, strength: 1 }] })
      )
    ).toThrow();
  });

  it('REJECTS a non-integer modelVersionId', () => {
    expect(() =>
      blockWorkflowBodySchema.parse(
        baseBody({ additionalResources: [{ modelVersionId: 12.5, strength: 1 }] })
      )
    ).toThrow();
  });

  // LOW-1: strength is strict (non-coerced) parity with modelVersionId. Block
  // bodies are JSON so a real number always arrives; z.coerce previously let
  // ""/[]/true/null slip to 0/1 instead of being rejected.
  it('REJECTS a non-number strength ("", [], true, null) instead of coercing', () => {
    for (const bad of ['', [], true, null]) {
      expect(() =>
        blockWorkflowBodySchema.parse(
          baseBody({ additionalResources: [{ modelVersionId: 1, strength: bad }] })
        )
      ).toThrow();
    }
  });

  it('still accepts a real in-range number for strength', () => {
    const parsed = blockWorkflowBodySchema.parse(
      baseBody({ additionalResources: [{ modelVersionId: 1, strength: 0.65 }] })
    );
    expect((parsed as any).additionalResources[0].strength).toBe(0.65);
  });

  it('still applies the default (1) when strength is omitted', () => {
    const parsed = blockWorkflowBodySchema.parse(
      baseBody({ additionalResources: [{ modelVersionId: 1 }] })
    );
    expect((parsed as any).additionalResources[0].strength).toBe(1);
  });
});

/**
 * G5 — generic published-content-author key. Opaque, optional, bounded to the
 * shared-storage key shape (≤64). The server resolves the author from it; the
 * wire schema only bounds shape.
 */
describe('blockWorkflowBodySchema — sharedContentKey (G5)', () => {
  it('is optional — a body without it parses (field stays undefined)', () => {
    const parsed = blockWorkflowBodySchema.parse(baseBody());
    expect((parsed as { sharedContentKey?: unknown }).sharedContentKey).toBeUndefined();
  });

  it('accepts a bounded opaque key', () => {
    const parsed = blockWorkflowBodySchema.parse(baseBody({ sharedContentKey: 'k_01ABCDEF' }));
    expect((parsed as { sharedContentKey?: string }).sharedContentKey).toBe('k_01ABCDEF');
  });

  it('rejects an over-long key (> 64 chars)', () => {
    expect(() =>
      blockWorkflowBodySchema.parse(baseBody({ sharedContentKey: 'k'.repeat(65) }))
    ).toThrow();
  });

  it('rejects an empty key', () => {
    expect(() => blockWorkflowBodySchema.parse(baseBody({ sharedContentKey: '' }))).toThrow();
  });

  it('rejects a non-string key', () => {
    expect(() => blockWorkflowBodySchema.parse(baseBody({ sharedContentKey: 123 }))).toThrow();
  });
});

/**
 * img2img sourceImage host allowlist (blockSourceImageSchema).
 *
 * The `generationSource` block-upload mode returns an orchestrator consumer-blob
 * URL (`https://orchestration…civitai.com/v2/consumer/blobs/…`) — the SAME host
 * the generator's own SourceImageUpload yields. This locks in that such a URL
 * PASSES the existing allowlist unchanged (hostname ends in `.civitai.com`), so
 * no loosening was required, while attacker-controlled / non-https / host-
 * confusion URLs are still rejected.
 */
describe('blockWorkflowBodySchema — sourceImage host allowlist (generationSource reconciliation)', () => {
  const withSource = (url: string) =>
    blockWorkflowBodySchema.parse(baseBody({ sourceImage: { url, width: 512, height: 512 } }));

  it('accepts the orchestrator consumer-blob URL that generationSource yields', () => {
    // Representative of uploadConsumerBlob's result (see SourceImageUpload).
    const parsed = withSource(
      'https://orchestration.civitai.com/v2/consumer/blobs/CXJQSCS1TYZR1PX45C7QBVB8E0.jpeg?sig=abc&exp=2030-01-01T00:00:00Z'
    );
    expect((parsed as { sourceImage?: { url: string } }).sourceImage?.url).toContain(
      'orchestration.civitai.com'
    );
  });

  it('accepts the orchestration-new subdomain variant (hostname still ends in .civitai.com)', () => {
    expect(() =>
      withSource('https://orchestration-new.civitai.com/v2/consumer/blobs/E8S6FBPH50ENNVF2PD5.jpeg')
    ).not.toThrow();
  });

  it('REJECTS a host-confusion URL that merely contains the allowed host as a substring', () => {
    expect(() =>
      withSource('https://evil.example/?x=orchestration.civitai.com/blob.jpeg')
    ).toThrow();
  });

  it('REJECTS a non-https orchestrator URL', () => {
    expect(() =>
      withSource('http://orchestration.civitai.com/v2/consumer/blobs/abc.jpeg')
    ).toThrow();
  });
});

/**
 * sourceImage URL canonicalization (validate-the-parse / forward-the-raw gap).
 *
 * The host allowlist validates a PARSED url but the schema used to emit the
 * ORIGINAL string, and nothing downstream re-validates (the graph's imagesNode
 * is a bare `url: z.string()`). That made two WHATWG-specific normalizations
 * load-bearing as security properties: `\` is treated as `/` in the authority,
 * and tab/CR/LF are deleted from anywhere in the url. Both let a raw string
 * carrying a foreign host — or raw CRLF — pass the check and reach the
 * orchestrator unmodified.
 *
 * These lock in the three-layer bound: ambiguous bytes are rejected, the parsed
 * host is checked, and the EMITTED value is `URL.href` (so the bytes we forward
 * are the bytes we validated) re-capped at SOURCE_IMAGE_URL_MAX.
 *
 * Every assertion below is on the EMITTED value or on an explicit rejection —
 * never merely on "parse succeeded".
 */
describe('blockWorkflowBodySchema — sourceImage URL canonicalization', () => {
  // The bytes under test are written as explicit code points rather than string
  // escapes: this is exactly the class of character an editor, formatter, or
  // copy/paste can silently rewrite, which would quietly defang the test.
  const BACKSLASH = String.fromCharCode(0x5c);
  const TAB = String.fromCharCode(0x09);
  const CR = String.fromCharCode(0x0d);
  const LF = String.fromCharCode(0x0a);
  const NUL = String.fromCharCode(0x00);

  const parseSource = (url: string) =>
    blockWorkflowBodySchema.safeParse(baseBody({ sourceImage: { url, width: 512, height: 512 } }));

  const emittedUrl = (url: string): string => {
    const res = parseSource(url);
    if (!res.success)
      throw new Error(`expected ${JSON.stringify(url)} to parse, but it was rejected`);
    return (res.data as { sourceImage: { url: string } }).sourceImage.url;
  };

  describe('rejects the parser-differential shapes that used to pass', () => {
    it('rejects a backslash in the authority', () => {
      const raw = `https://civitai.com${BACKSLASH}@evil.com/x.png`;
      // The WHATWG behaviour that WAS being relied on: `\` acts as `/`, so the
      // hostname check saw `civitai.com` and passed. A parser that splits the
      // authority on the last `@` without treating `\` as a delimiter reads
      // host = evil.com — a different origin than the one we approved.
      expect(new URL(raw).hostname).toBe('civitai.com');
      expect(parseSource(raw).success).toBe(false);
    });

    it('rejects a TAB inside the host', () => {
      const raw = `https://evil.com${TAB}.civitai.com/x.png`;
      // WHATWG deletes the tab, yielding an allowlist-passing subdomain — while
      // the raw bytes, tab intact, were what got forwarded.
      expect(new URL(raw).hostname).toBe('evil.com.civitai.com');
      expect(parseSource(raw).success).toBe(false);
    });

    it('rejects CRLF inside the host', () => {
      const raw = `https://evil.com${CR}${LF}.civitai.com/x.png`;
      expect(new URL(raw).hostname).toBe('evil.com.civitai.com');
      expect(parseSource(raw).success).toBe(false);
    });

    it('rejects CR/LF elsewhere in the URL, not just in the host', () => {
      // Raw CRLF in a value a consumer concatenates into a request line or a
      // log record is a request-splitting / log-injection primitive, whatever
      // part of the URL it sits in.
      expect(parseSource(`https://civitai.com/x.png${CR}${LF}Host: evil.com`).success).toBe(false);
      expect(parseSource(`https://civitai.com/${LF}x.png`).success).toBe(false);
      expect(parseSource(`https://civitai.com/x.png?a=${CR}${LF}b`).success).toBe(false);
    });

    it('rejects NUL and other C0 control bytes', () => {
      expect(parseSource(`https://civitai.com/x${NUL}.png`).success).toBe(false);
      expect(parseSource(`${String.fromCharCode(0x01)}https://civitai.com/x.png`).success).toBe(
        false
      );
      expect(parseSource(`https://civitai.com/x.png${String.fromCharCode(0x7f)}`).success).toBe(
        false
      );
    });

    it('rejects a backslash anywhere, including the path', () => {
      expect(parseSource(`https://civitai.com/a${BACKSLASH}b.png`).success).toBe(false);
    });
  });

  describe('emits a canonicalized value, never the raw input', () => {
    it('emits URL.href (root path added, default port dropped, host case folded)', () => {
      expect(emittedUrl('https://civitai.com')).toBe('https://civitai.com/');
      expect(emittedUrl('https://CIVITAI.com:443/x.png')).toBe('https://civitai.com/x.png');
      expect(emittedUrl('https://civitai.com/a/../b.png')).toBe('https://civitai.com/b.png');
    });

    it('emits a value free of backslash, tab, CR and LF', () => {
      for (const url of [
        'https://civitai.com',
        'https://civitai.com/images/xyz.jpeg',
        'https://image.civitai.com/abc/def.jpeg',
        'https://CIVITAI.com:443/x.png',
      ]) {
        const out = emittedUrl(url);
        expect(out).not.toContain(BACKSLASH);
        expect(out).not.toContain(TAB);
        expect(out).not.toContain(CR);
        expect(out).not.toContain(LF);
      }
    });
  });

  describe('legitimate URLs are unchanged', () => {
    it('round-trips every real Civitai image host byte-for-byte', () => {
      // Canonicalization must be a no-op for the URLs production actually
      // sends — otherwise this would be a behaviour change, not a hardening.
      for (const url of [
        'https://civitai.com/images/xyz.jpeg',
        'https://image.civitai.com/abc/def.jpeg',
        'https://orchestration.civitai.com/v2/consumer/blobs/AB1.jpeg?sig=abc&exp=2030-01-01T00:00:00Z',
        'https://orchestration-new.civitai.com/v2/consumer/blobs/E8S6FBPH50ENNVF2PD5.jpeg',
        'https://civitai.red/x.png',
        'https://image.civitai.green/x.png',
      ]) {
        expect(emittedUrl(url), url).toBe(url);
      }
    });
  });

  describe('previously-rejected hostile URLs stay rejected', () => {
    it('rejects userinfo, host confusion, bad schemes, homographs and IP literals', () => {
      const cyrillicEs = String.fromCharCode(0x0441); // looks like ASCII 'c'
      for (const url of [
        'https://civitai.com@evil.com/x.png', // userinfo — real host is evil.com
        'https://civitai.com%40evil.com/x.png', // percent-encoded userinfo
        'https://civitai.com.evil.example/x.png', // allowed host as a prefix
        'https://evilcivitai.com/x.png', // no dot boundary before the allowed host
        'https://evil.example/?x=image.civitai.com', // allowed host only as a substring
        'http://image.civitai.com/x.png', // non-https
        'ftp://image.civitai.com/x.png',
        'javascript:alert(1)//civitai.com',
        'data:image/png;base64,AAAA',
        `https://${cyrillicEs}ivitai.com/x.png`, // homograph -> punycode host
        'https://civitai.com./x.png', // trailing dot
        'https://127.0.0.1/x.png',
        'https://[::1]/x.png',
        'https://169.254.169.254/latest/meta-data/', // cloud metadata
      ]) {
        expect(parseSource(url).success, url).toBe(false);
      }
    });
  });

  describe('the length cap bounds the EMITTED value', () => {
    it('rejects a raw URL over the cap', () => {
      const raw = `https://civitai.com/${'a'.repeat(SOURCE_IMAGE_URL_MAX)}`;
      expect(raw.length).toBeGreaterThan(SOURCE_IMAGE_URL_MAX);
      expect(parseSource(raw).success).toBe(false);
    });

    it('rejects an in-cap URL that canonicalization inflates past the cap', () => {
      // Percent-encoding expands a non-ASCII path ~9x (each CJK code point ->
      // 3 UTF-8 bytes -> 9 chars). The pre-transform `.max()` therefore does
      // NOT bound what we emit; the post-transform re-check is what does.
      const raw = `https://civitai.com/${'中'.repeat(2000)}`;
      expect(raw.length).toBeLessThanOrEqual(SOURCE_IMAGE_URL_MAX);
      expect(new URL(raw).href.length).toBeGreaterThan(SOURCE_IMAGE_URL_MAX);
      expect(parseSource(raw).success).toBe(false);
    });

    it('accepts a long-but-in-bounds URL and emits it within the cap', () => {
      const raw = `https://civitai.com/${'a'.repeat(2000)}`;
      expect(raw.length).toBeLessThanOrEqual(SOURCE_IMAGE_URL_MAX);
      expect(emittedUrl(raw).length).toBeLessThanOrEqual(SOURCE_IMAGE_URL_MAX);
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// sourceImages[] — multi-image conditioning
// ─────────────────────────────────────────────────────────────────────────────
//
// `sourceImage` (singular) is a DEPRECATED ALIAS that must keep working — the
// published developer docs and @civitai/app-sdk both ship it. `sourceImages` is
// the current field. The security posture of the array form must be IDENTICAL
// to the singular one, per element: a Civitai-hosted https URL and dimensions
// inside DIM_MIN..DIM_MAX. Validating only `[0]` is the classic version of this
// bug, so the host/dimension cases below deliberately put the BAD element LAST.
describe('blockWorkflowBodySchema — sourceImages[] (multi-image conditioning)', () => {
  const OK = 'https://image.civitai.com/abc/def.jpeg';
  const img = (url = OK, over: Record<string, unknown> = {}) => ({
    url,
    width: 512,
    height: 512,
    ...over,
  });
  const parseImages = (sourceImages: unknown) =>
    blockWorkflowBodySchema.parse(baseBody({ sourceImages }));

  it('accepts an array and keeps every element', () => {
    const parsed = parseImages([img(), img('https://orchestration.civitai.com/v2/x.jpeg')]);
    const images = (parsed as { sourceImages?: Array<{ url: string }> }).sourceImages;
    expect(images).toHaveLength(2);
    expect(images?.[1].url).toBe('https://orchestration.civitai.com/v2/x.jpeg');
  });

  it('keeps the deprecated singular `sourceImage` working on its own', () => {
    const parsed = blockWorkflowBodySchema.parse(baseBody({ sourceImage: img() }));
    expect((parsed as { sourceImage?: { url: string } }).sourceImage?.url).toBe(OK);
    expect((parsed as { sourceImages?: unknown }).sourceImages).toBeUndefined();
  });

  it('REJECTS supplying BOTH sourceImage and sourceImages (ambiguous)', () => {
    expect(() =>
      blockWorkflowBodySchema.parse(baseBody({ sourceImage: img(), sourceImages: [img()] }))
    ).toThrow(/not both|ambiguous/i);
  });

  it('REJECTS an EMPTY sourceImages array rather than degrading to txt2img', () => {
    // Explicit decision: `sourceImages: []` is a caller that computed an empty
    // list and meant to send images. Silently generating txt2img would bill them
    // for something they did not ask for. Omit the field for text-to-image.
    expect(() => parseImages([])).toThrow(/must not be empty/i);
  });

  // ── HOST VALIDATION APPLIES TO EVERY ELEMENT ───────────────────────────────
  it.each([
    ['a non-Civitai host', 'https://evil.example/x.jpeg'],
    ['a host-confusion URL containing the allowed host', 'https://evil.example/?x=image.civitai.com/a.jpeg'],
    ['a non-https URL', 'http://image.civitai.com/x.jpeg'],
    ['a URL with a lookalike suffix', 'https://image.civitai.com.evil.example/x.jpeg'],
  ])('REJECTS %s in the LAST array element', (_label, badUrl) => {
    expect(() => parseImages([img(), img(), img(badUrl)])).toThrow();
  });

  it('REJECTS a bad host in a MIDDLE element too', () => {
    expect(() => parseImages([img(), img('https://evil.example/x.jpeg'), img()])).toThrow();
  });

  // ── DIMENSION BOUNDS APPLY TO EVERY ELEMENT ────────────────────────────────
  it.each([
    ['width below DIM_MIN', { width: DIM_MIN - 1 }],
    ['width above DIM_MAX', { width: DIM_MAX + 1 }],
    ['height below DIM_MIN', { height: DIM_MIN - 1 }],
    ['height above DIM_MAX', { height: DIM_MAX + 1 }],
  ])('REJECTS %s in the LAST array element', (_label, over) => {
    expect(() => parseImages([img(), img(OK, over)])).toThrow();
  });

  it('accepts dimensions exactly at the bounds in every element', () => {
    expect(() =>
      parseImages([img(OK, { width: DIM_MIN, height: DIM_MIN }), img(OK, { width: DIM_MAX, height: DIM_MAX })])
    ).not.toThrow();
  });

  // ── ABSOLUTE WIRE BOUND (not the real cap — that is per-ecosystem) ─────────
  it('accepts exactly BLOCK_SOURCE_IMAGES_WIRE_MAX elements', () => {
    const many = Array.from({ length: BLOCK_SOURCE_IMAGES_WIRE_MAX }, () => img());
    expect(() => parseImages(many)).not.toThrow();
  });

  it('REJECTS more than BLOCK_SOURCE_IMAGES_WIRE_MAX elements', () => {
    const tooMany = Array.from({ length: BLOCK_SOURCE_IMAGES_WIRE_MAX + 1 }, () => img());
    expect(() => parseImages(tooMany)).toThrow();
  });

  it('is set ABOVE the largest per-ecosystem cap so no ecosystem is clamped here', () => {
    // The wire bound exists to stop an unbounded array reaching the parser, not
    // to be the product limit. If a future ecosystem raises its imagesNode max
    // past this, the wire bound would start silently under-allowing it.
    expect(BLOCK_SOURCE_IMAGES_WIRE_MAX).toBeGreaterThan(7);
  });
});

import { describe, expect, it } from 'vitest';
import {
  CIVITAI_IMAGE_HOSTS,
  classifySaveBytes,
  enforceImageExtension,
  forceSaveBytesExtension,
  isAllowedSaveImageUrl,
  prepareSaveBytes,
  resolveSaveImageRequest,
  sanitizeDownloadFilename,
  SAVE_BYTES_MAX_BYTES,
} from './saveImageDownload';

const CDN = 'https://image.civitai.com';

describe('isAllowedSaveImageUrl (SAVE_IMAGE origin allowlist)', () => {
  it('ALLOWS the civitai image CDN + orchestration blob hosts (https)', () => {
    expect(isAllowedSaveImageUrl('https://image.civitai.com/xG/77/original.jpeg', CDN)).toBe(true);
    expect(
      isAllowedSaveImageUrl(
        'https://orchestration.civitai.com/v2/consumer/blobs/ABC123.jpeg?sig=x',
        CDN
      )
    ).toBe(true);
    // A preview opted onto the "next" orchestrator browses against that origin, so a blob URL
    // it mints must be fetchable here too.
    expect(
      isAllowedSaveImageUrl(
        'https://orchestration-next.civitai.com/v2/consumer/blobs/ABC123.jpeg?sig=x',
        CDN
      )
    ).toBe(true);
    // Ledger: the static list is EXACTLY these hosts. Deliberately an exact-set assertion rather
    // than `toContain`, so the set fails when it GROWS as well as when it shrinks — adding a host
    // widens where the download bridge will fetch from, which is a decision that should be made
    // here rather than noticed later. Note this is stricter than the prose in saveImageDownload.ts,
    // which says the list "may legally hold MORE hosts"; that remains true of the module's
    // contract, and this ledger is what makes each addition explicit.
    expect([...CIVITAI_IMAGE_HOSTS].sort()).toEqual([
      'image.civitai.com',
      'orchestration-new.civitai.com',
      'orchestration-next.civitai.com',
      'orchestration.civitai.com',
    ]);
  });

  /**
   * 🔴 REGRESSION, not an invariant guard. `orchestration-new.civitai.com` — note `-new`, NOT
   * `-next` — is the host the LIVE orchestrator actually mints consumer-blob URLs on, and it was
   * missing from the allowlist, so `isAllowedSaveImageUrl` returned **false** for every generated
   * output in production. The user-visible symptom: a viewer who had just spent real Buzz in an App
   * Block got `image url is not allowed` from the host (PageBlockHost.tsx:3609) and had NO in-app
   * way to keep the image — `<a download>` is inert in the block's sandbox, which is the whole
   * reason this bridge exists.
   *
   * Why the suite stayed green through it: every ALLOW case above used
   * `orchestration.civitai.com` or `orchestration-next.civitai.com`. Neither is the production
   * host, so no test ever exercised the url production serves. This case is built from a REAL
   * measured production URL shape — the `/v2/consumer/blobs/<uuid>-<n>.jpg` path with the `sig` /
   * `exp` query the orchestrator signs it with — rather than a tidy fixture, so it fails for the
   * reason production failed.
   *
   * The sibling allowlist `KNOWN_ORCHESTRATOR_HOSTS`
   * (src/server/services/orchestrator/trusted-blob-url.ts) already trusted this host; only this
   * copy of the predicate did not.
   */
  it('ALLOWS the LIVE orchestrator host (orchestration-new) that production mints blobs on', () => {
    const PROD_BLOB_URL =
      'https://orchestration-new.civitai.com/v2/consumer/blobs/' +
      '9f3c1b7a-5e2d-4a08-bf41-6c0d2e8a7b19-0.jpg' +
      '?sig=0PqkT3nR8xV2mB6yJ4hLc1dWfAeZsQ9uG7iN5oY3rK0' +
      '&exp=1790000000';

    expect(isAllowedSaveImageUrl(PROD_BLOB_URL, CDN)).toBe(true);

    // Control, so this cannot pass by the allowlist having gone permissive: the SAME path/query on
    // a non-civitai host is still refused, and `-new` is matched EXACTLY (no suffix/wildcarding).
    expect(
      isAllowedSaveImageUrl(
        PROD_BLOB_URL.replace(
          'orchestration-new.civitai.com',
          'orchestration-new.civitai.com.evil.example'
        ),
        CDN
      )
    ).toBe(false);
    expect(
      isAllowedSaveImageUrl(
        PROD_BLOB_URL.replace('orchestration-new.civitai.com', 'sub.orchestration-new.civitai.com'),
        CDN
      )
    ).toBe(false);
    // …and https is still mandatory for it, like every other allowlisted host.
    expect(isAllowedSaveImageUrl(PROD_BLOB_URL.replace('https://', 'http://'), CDN)).toBe(false);
  });

  it('ALLOWS the configured CDN origin even when not in the static list', () => {
    // A self-hosted / non-prod NEXT_PUBLIC_IMAGE_LOCATION is covered without editing the list.
    expect(
      isAllowedSaveImageUrl('https://cdn.example.net/a/b.jpeg', 'https://cdn.example.net')
    ).toBe(true);
    // …but only that exact host — a different host is still refused.
    expect(
      isAllowedSaveImageUrl('https://other.example.net/a.jpeg', 'https://cdn.example.net')
    ).toBe(false);
  });

  it('REJECTS an arbitrary attacker origin', () => {
    expect(isAllowedSaveImageUrl('https://evil.example/x.png', CDN)).toBe(false);
    expect(isAllowedSaveImageUrl('https://image.civitai.com.evil.example/x.png', CDN)).toBe(false);
    // no subdomain wildcarding
    expect(isAllowedSaveImageUrl('https://sub.image.civitai.com/x.png', CDN)).toBe(false);
  });

  it('REJECTS non-https schemes: data:, blob:, file:, http:', () => {
    expect(isAllowedSaveImageUrl('data:image/png;base64,AAAA', CDN)).toBe(false);
    expect(isAllowedSaveImageUrl('blob:https://image.civitai.com/uuid', CDN)).toBe(false);
    expect(isAllowedSaveImageUrl('file:///etc/passwd', CDN)).toBe(false);
    // plain http (downgrade/MITM) is refused even for an allowlisted host
    expect(isAllowedSaveImageUrl('http://image.civitai.com/x.png', CDN)).toBe(false);
  });

  it('REJECTS non-string / empty / unparseable input', () => {
    expect(isAllowedSaveImageUrl(undefined, CDN)).toBe(false);
    expect(isAllowedSaveImageUrl('', CDN)).toBe(false);
    expect(isAllowedSaveImageUrl('not a url', CDN)).toBe(false);
    expect(isAllowedSaveImageUrl(42, CDN)).toBe(false);
  });

  it('tolerates an empty / relative NEXT_PUBLIC_IMAGE_LOCATION (falls back to the static list)', () => {
    expect(isAllowedSaveImageUrl('https://image.civitai.com/x.png', '')).toBe(true);
    expect(isAllowedSaveImageUrl('https://evil.example/x.png', '')).toBe(false);
    expect(isAllowedSaveImageUrl('https://image.civitai.com/x.png', '/relative')).toBe(true);
  });
});

describe('sanitizeDownloadFilename', () => {
  it('strips query params and fragments', () => {
    expect(sanitizeDownloadFilename('a.jpeg?token=x#frag', 'https://x/y')).toBe('a.jpeg');
  });

  it('collapses a duplicated trailing extension, preserving base dots', () => {
    expect(sanitizeDownloadFilename('file.mp4.mp4', 'https://x/y')).toBe('file.mp4');
    expect(sanitizeDownloadFilename('video-ttget.com.mp4', 'https://x/y')).toBe(
      'video-ttget.com.mp4'
    );
  });

  it('drops path separators / traversal (untrusted block-supplied name)', () => {
    expect(sanitizeDownloadFilename('../../etc/passwd', 'https://x/y')).toBe('passwd');
    expect(sanitizeDownloadFilename('a/b/c.png', 'https://x/y')).toBe('c.png');
    expect(sanitizeDownloadFilename('..\\..\\win.png', 'https://x/y')).toBe('win.png');
  });

  it('falls back to the url last segment, then a generic name', () => {
    expect(
      sanitizeDownloadFilename(undefined, 'https://image.civitai.com/xG/77/original.jpeg')
    ).toBe('original.jpeg');
    expect(sanitizeDownloadFilename(null, 'https://image.civitai.com/')).toBe('download');
    expect(sanitizeDownloadFilename('   ', 'https://image.civitai.com/')).toBe('download');
  });
});

// F2 — the saved download name is constrained to a SAFE MEDIA extension derived
// from the RESOLVED content type of the fetched bytes, so a block can't save an
// (allowlisted) orchestration blob under render.html / x.exe / .svg.
describe('enforceImageExtension (F2 safe-extension gate)', () => {
  it('forces the canonical extension for a KNOWN content type (replaces a hostile ext)', () => {
    expect(enforceImageExtension('render.html', 'image/png')).toBe('render.png');
    expect(enforceImageExtension('x.exe', 'image/jpeg')).toBe('x.jpg');
    expect(enforceImageExtension('clip.txt', 'video/mp4')).toBe('clip.mp4');
    // content type may carry parameters — only the media type is read
    expect(enforceImageExtension('a.sh', 'image/webp; charset=binary')).toBe('a.webp');
  });

  it('appends the canonical extension when the name has NONE', () => {
    expect(enforceImageExtension('render', 'image/png')).toBe('render.png');
    expect(enforceImageExtension('download', 'video/webm')).toBe('download.webm');
  });

  it('keeps a name that already carries the matching / alias extension', () => {
    expect(enforceImageExtension('photo.png', 'image/png')).toBe('photo.png');
    // jpeg ≡ jpg — do not churn the name
    expect(enforceImageExtension('photo.jpeg', 'image/jpeg')).toBe('photo.jpeg');
    expect(enforceImageExtension('photo.jpg', 'image/jpeg')).toBe('photo.jpg');
  });

  it('preserves internal dots when replacing the extension', () => {
    expect(enforceImageExtension('my.render.v2.html', 'image/png')).toBe('my.render.v2.png');
  });

  it('NEVER yields an .svg name even for an svg content type (svg is scriptable)', () => {
    // image/svg+xml is intentionally not mapped → unknown branch → default .jpg
    expect(enforceImageExtension('x.svg', 'image/svg+xml')).toBe('x.jpg');
    expect(enforceImageExtension('x.html', 'image/svg+xml')).toBe('x.jpg');
  });

  it('unknown content type: keeps an already-safe media extension', () => {
    expect(enforceImageExtension('a.png', undefined)).toBe('a.png');
    expect(enforceImageExtension('a.mp4', '')).toBe('a.mp4');
    expect(enforceImageExtension('a.jpeg', null)).toBe('a.jpeg');
  });

  it('unknown content type + unsafe/absent extension: coerces to the safe default', () => {
    expect(enforceImageExtension('a.html', undefined)).toBe('a.jpg');
    expect(enforceImageExtension('a.exe', '')).toBe('a.jpg');
    expect(enforceImageExtension('noext', undefined)).toBe('noext.jpg');
    // empty name falls back to a safe default too
    expect(enforceImageExtension('', 'application/octet-stream')).toBe('download.jpg');
  });
});

describe('resolveSaveImageRequest', () => {
  it('parses a url-variant request', () => {
    expect(
      resolveSaveImageRequest({
        requestId: 'r',
        url: 'https://image.civitai.com/x.jpeg',
        filename: 'a.png',
      })
    ).toEqual({
      requestId: 'r',
      kind: 'url',
      url: 'https://image.civitai.com/x.jpeg',
      filename: 'a.png',
    });
  });

  it('parses an id-variant request', () => {
    expect(resolveSaveImageRequest({ requestId: 'r', imageId: 55 })).toEqual({
      requestId: 'r',
      kind: 'id',
      imageId: 55,
      filename: undefined,
    });
  });

  it('returns kind:invalid when BOTH url and imageId are present', () => {
    expect(
      resolveSaveImageRequest({
        requestId: 'r',
        url: 'https://image.civitai.com/x.jpeg',
        imageId: 5,
      })
    ).toEqual({ requestId: 'r', kind: 'invalid' });
  });

  it('returns kind:invalid when NEITHER url nor imageId is present', () => {
    expect(resolveSaveImageRequest({ requestId: 'r' })).toEqual({
      requestId: 'r',
      kind: 'invalid',
    });
  });

  it('rejects a non-positive / non-integer imageId (treated as absent → invalid)', () => {
    expect(resolveSaveImageRequest({ requestId: 'r', imageId: 0 })).toEqual({
      requestId: 'r',
      kind: 'invalid',
    });
    expect(resolveSaveImageRequest({ requestId: 'r', imageId: -3 })).toEqual({
      requestId: 'r',
      kind: 'invalid',
    });
    expect(resolveSaveImageRequest({ requestId: 'r', imageId: 1.5 })).toEqual({
      requestId: 'r',
      kind: 'invalid',
    });
  });

  it('returns null (drop, uncorrelatable) for a missing/invalid requestId', () => {
    expect(resolveSaveImageRequest({ url: 'https://image.civitai.com/x.jpeg' })).toBeNull();
    expect(
      resolveSaveImageRequest({ requestId: '', url: 'https://image.civitai.com/x.jpeg' })
    ).toBeNull();
    expect(resolveSaveImageRequest(null)).toBeNull();
    expect(resolveSaveImageRequest('nope')).toBeNull();
  });
});

const ab = (...bytes: number[]) => new Uint8Array(bytes).buffer;
const textAb = (s: string) => new TextEncoder().encode(s).buffer as ArrayBuffer;
// Real signatures followed by payload bytes, so a sniffer that only checks length can't pass.
const PNG = ab(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49);
const JPEG = ab(0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46);
const WEBP = ab(0x52, 0x49, 0x46, 0x46, 0x24, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50, 0x56);
const GIF = ab(0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x01, 0x00, 0x01, 0x00, 0x00, 0x00);

describe('resolveSaveImageRequest — bytes variant', () => {
  it('parses a bytes request, keeping the filename and mimeType hints', () => {
    const res = resolveSaveImageRequest({
      requestId: 'r',
      bytes: PNG,
      filename: 'healed.png',
      mimeType: 'image/png',
    });
    expect(res).toEqual({
      requestId: 'r',
      kind: 'bytes',
      bytes: PNG,
      filename: 'healed.png',
      mimeType: 'image/png',
    });
    // toEqual treats any two ArrayBuffers as equal, so pin identity separately.
    expect(res && 'bytes' in res ? res.bytes : null).toBe(PNG);
  });

  it('drops a non-string mimeType hint', () => {
    const res = resolveSaveImageRequest({ requestId: 'r', bytes: PNG, mimeType: 5 });
    expect(res && 'mimeType' in res ? res.mimeType : 'missing').toBeUndefined();
  });

  it('bytes together with url or imageId is invalid, even when that sibling is itself invalid', () => {
    for (const sibling of [
      { url: 'https://image.civitai.com/x' },
      { imageId: 5 },
      { url: '' },
      { imageId: 0 },
      { imageId: 'x' },
    ]) {
      expect(resolveSaveImageRequest({ requestId: 'r', bytes: PNG, ...sibling })).toEqual({
        requestId: 'r',
        kind: 'invalid',
      });
    }
  });

  it('refuses anything that is not an ArrayBuffer', () => {
    for (const bytes of [new Uint8Array(PNG), new DataView(PNG), [0x89, 0x50], 'PNG', { 0: 1 }]) {
      expect(resolveSaveImageRequest({ requestId: 'r', bytes })).toEqual({
        requestId: 'r',
        kind: 'invalid',
      });
    }
  });

  it('refuses an empty buffer', () => {
    expect(resolveSaveImageRequest({ requestId: 'r', bytes: new ArrayBuffer(0) })).toEqual({
      requestId: 'r',
      kind: 'invalid',
    });
  });
});

describe('classifySaveBytes', () => {
  it('classifies PNG, WebP and JPEG by magic bytes, ignoring the hints', () => {
    expect(classifySaveBytes(PNG, { mimeType: 'text/html', filename: 'x.html' })).toBe('image/png');
    expect(classifySaveBytes(WEBP)).toBe('image/webp');
    expect(classifySaveBytes(JPEG, { mimeType: 'application/json' })).toBe('image/jpeg');
  });

  it('JSON only with a hint: mimeType or a .json filename', () => {
    const json = textAb('{"prompt":"a cat","steps":30}');
    expect(classifySaveBytes(json, { mimeType: 'application/json' })).toBe('application/json');
    expect(classifySaveBytes(json, { mimeType: 'Application/JSON; charset=utf-8' })).toBe(
      'application/json'
    );
    expect(classifySaveBytes(json, { filename: 'meta.JSON' })).toBe('application/json');
    expect(classifySaveBytes(json)).toBe('text/plain');
    expect(classifySaveBytes(json, { mimeType: 'text/plain', filename: 'meta.txt' })).toBe(
      'text/plain'
    );
  });

  it('a JSON hint on text that does not parse yields plain text', () => {
    expect(classifySaveBytes(textAb('{not json'), { mimeType: 'application/json' })).toBe(
      'text/plain'
    );
  });

  it('valid UTF-8 text is plain text, whatever type the caller claims', () => {
    expect(classifySaveBytes(textAb('steps: 30\nsampler: Euler a\n'))).toBe('text/plain');
    expect(
      classifySaveBytes(textAb('<svg onload="alert(1)"/>'), { mimeType: 'image/svg+xml' })
    ).toBe('text/plain');
    expect(classifySaveBytes(textAb('<html><script>x()</script>'), { mimeType: 'text/html' })).toBe(
      'text/plain'
    );
    expect(classifySaveBytes(textAb('naïve ✓ 日本'))).toBe('text/plain');
  });

  it('refuses text containing a NUL byte', () => {
    expect(classifySaveBytes(ab(0x68, 0x69, 0x00, 0x21))).toBeNull();
  });

  it('refuses invalid UTF-8', () => {
    expect(classifySaveBytes(ab(0x68, 0x69, 0xc3, 0x28))).toBeNull();
    expect(classifySaveBytes(ab(0xff, 0xfe, 0x41))).toBeNull();
  });

  it('refuses GIF, archives, executables and empty input', () => {
    expect(classifySaveBytes(GIF, { mimeType: 'image/gif' })).toBeNull();
    expect(classifySaveBytes(ab(0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x00, 0x00))).toBeNull(); // zip
    expect(classifySaveBytes(ab(0x4d, 0x5a, 0x90, 0x00, 0x03, 0x00, 0x00, 0x00))).toBeNull(); // PE
    expect(classifySaveBytes(ab(0x7f, 0x45, 0x4c, 0x46, 0x02, 0x01, 0x01, 0x00))).toBeNull(); // ELF
    expect(classifySaveBytes(new ArrayBuffer(0))).toBeNull();
  });

  it('a truncated PNG signature is not an image', () => {
    expect(classifySaveBytes(ab(0x89, 0x50, 0x4e, 0x47))).toBeNull();
  });

  it('a RIFF container that is not WebP, and a near-miss JPEG prefix, are not images', () => {
    // RIFF....WAVE: the RIFF check alone would call this WebP.
    expect(
      classifySaveBytes(ab(0x52, 0x49, 0x46, 0x46, 0x24, 0, 0, 0, 0x57, 0x41, 0x56, 0x45))
    ).toBeNull();
    expect(classifySaveBytes(ab(0xff, 0xd8, 0x00, 0xe0, 0x00, 0x10))).toBeNull();
  });
});

describe('forceSaveBytesExtension', () => {
  it('always replaces the extension with the classified type’s own', () => {
    expect(forceSaveBytesExtension('x.html', 'text/plain')).toBe('x.txt');
    expect(forceSaveBytesExtension('x.exe', 'image/png')).toBe('x.png');
    expect(forceSaveBytesExtension('photo.jpeg', 'image/jpeg')).toBe('photo.jpg');
    expect(forceSaveBytesExtension('meta.data.json', 'application/json')).toBe('meta.data.json');
    expect(forceSaveBytesExtension('render.svg', 'image/webp')).toBe('render.webp');
    expect(forceSaveBytesExtension('notes', 'text/plain')).toBe('notes.txt');
    expect(forceSaveBytesExtension('', 'image/png')).toBe('download.png');
    expect(forceSaveBytesExtension('page.xhtml', 'text/plain')).toBe('page.txt');
  });

  it('drops control and bidi-override characters', () => {
    expect(forceSaveBytesExtension('inv\u202Egpj.exe', 'text/plain')).toBe('invgpj.txt');
    expect(forceSaveBytesExtension('a\u0000b\n.png', 'image/png')).toBe('ab.png');
    expect(forceSaveBytesExtension('x⁧gpj.exe⁩', 'text/plain')).toBe('xgpj.txt');
    expect(forceSaveBytesExtension('a‎b​c\u007f.txt', 'text/plain')).toBe('abc.txt');
  });
});

describe('prepareSaveBytes', () => {
  it('names a classified file with the forced extension', () => {
    expect(prepareSaveBytes({ bytes: PNG, filename: 'healed.png' })).toEqual({
      ok: true,
      type: 'image/png',
      filename: 'healed.png',
    });
    expect(
      prepareSaveBytes({ bytes: textAb('{"a":1}'), filename: 'meta.json', mimeType: 'text/html' })
    ).toEqual({ ok: true, type: 'application/json', filename: 'meta.json' });
    expect(
      prepareSaveBytes({ bytes: textAb('{"a":1}'), filename: 'meta', mimeType: 'application/json' })
    ).toEqual({ ok: true, type: 'application/json', filename: 'meta.json' });
    expect(prepareSaveBytes({ bytes: textAb('hello') })).toEqual({
      ok: true,
      type: 'text/plain',
      filename: 'download.txt',
    });
  });

  it('a hostile filename cannot keep its path or its extension', () => {
    expect(
      prepareSaveBytes({ bytes: textAb('<script>x()</script>'), filename: '../../evil.html' })
    ).toEqual({ ok: true, type: 'text/plain', filename: 'evil.txt' });
    expect(prepareSaveBytes({ bytes: JPEG, filename: 'C:\\tmp\\setup.exe?x=1' })).toEqual({
      ok: true,
      type: 'image/jpeg',
      filename: 'setup.jpg',
    });
    expect(prepareSaveBytes({ bytes: textAb('{"a":1}'), filename: 'run.json.exe' })).toEqual({
      ok: true,
      type: 'text/plain',
      filename: 'run.json.txt',
    });
  });

  it('refuses an unclassifiable file', () => {
    expect(prepareSaveBytes({ bytes: GIF, filename: 'a.gif' })).toEqual({
      ok: false,
      error: 'file type is not allowed',
    });
  });

  it('enforces the 50 MB cap at the boundary', () => {
    expect(SAVE_BYTES_MAX_BYTES).toBe(50 * 1024 * 1024);
    // Text bytes, so the at-cap case is accepted by the classifier and only the cap can refuse.
    const atCap = new Uint8Array(SAVE_BYTES_MAX_BYTES).fill(0x61).buffer;
    expect(prepareSaveBytes({ bytes: atCap })).toMatchObject({ ok: true, type: 'text/plain' });
    const overCap = new Uint8Array(SAVE_BYTES_MAX_BYTES + 1).fill(0x61).buffer;
    expect(prepareSaveBytes({ bytes: overCap })).toEqual({
      ok: false,
      error: 'file exceeds the maximum save size',
    });
  });
});

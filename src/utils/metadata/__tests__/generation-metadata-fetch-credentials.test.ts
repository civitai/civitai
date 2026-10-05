import { createRequire } from 'node:module';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readCivitaiMetadata } from '@civitai/generation-metadata/civitai';

const require = createRequire(import.meta.url);

/**
 * Pins the URL-fetch credential behavior of @civitai/generation-metadata's
 * `toBytes` — the auto metadata-extraction path
 * (`extractSourceMetadataFromUrl` → `readCivitaiMetadata(string)`) reads the
 * response body of URL inputs, so a cookie-bearing GET to an attacker-chosen
 * app-origin URL would be a same-origin, body-readable request in the
 * victim's session. The package fetches with the browser default
 * (`credentials: 'same-origin'`); the vendored patch in
 * `patches/@civitai__generation-metadata.patch` makes every dist build
 * variant fetch with `credentials: 'omit'`.
 *
 * Both module systems are pinned because the package ships the fetch inlined
 * into five dist files: the ESM shared chunk (`dist/chunk-UC72DUQW.js`) and
 * four CJS bundles. The ESM entry covers the chunk; `createRequire` resolves
 * the package's `require` export condition (`dist/civitai/index.cjs`) so the
 * CJS copy is executed by real Node against the installed files.
 * ClickUp 868maend5.
 */
const fetchMock = vi.fn();

const url = 'https://civitai.com/x.png';

describe('@civitai/generation-metadata — URL fetch credentials', () => {
  beforeEach(() => {
    fetchMock.mockReset();
    // Body contents don't matter: parsing may fail downstream, but the fetch
    // call itself is what this suite pins. `ok: true` gets toBytes past its
    // `res.ok` check so the call is observable either way.
    fetchMock.mockImplementation(
      async () => new Response(new Uint8Array([0, 1, 2, 3]), { status: 200 })
    );
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('ESM entry: fetches URL inputs with credentials omitted', async () => {
    await readCivitaiMetadata(url).catch(() => undefined);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, options] = fetchMock.mock.calls[0];
    expect(options?.credentials).toBe('omit');
  });

  it('CJS entry (require condition): fetches URL inputs with credentials omitted', async () => {
    const pkg = require('@civitai/generation-metadata/civitai') as {
      readCivitaiMetadata: typeof readCivitaiMetadata;
    };
    await pkg.readCivitaiMetadata(url).catch(() => undefined);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, options] = fetchMock.mock.calls[0];
    expect(options?.credentials).toBe('omit');
  });
});

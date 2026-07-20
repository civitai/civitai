import JSZip from 'jszip';
import yaml from 'js-yaml';
import {
  exceedsPreDownloadCap,
  PRE_DOWNLOAD_MAX_BYTES,
  processWildcardEntries,
  wildcardPackError,
  WILDCARD_PACK_CAPS,
  type RawZipEntry,
  type WildcardPackCaps,
  type WildcardPackLists,
} from './wildcardPackParse';

// The zip + fetch SHELL for the wildcard-pack import bridge — kept in its OWN
// module (jszip + js-yaml live here, not in the pure `wildcardPackParse`) so
// PageBlockHost can `import()` it LAZILY the first time a block actually requests
// a pack. jszip/js-yaml never enter the App Blocks host bundle for page blocks
// that don't import wildcards.
//
// The bytes are fetched + inflated + parsed HERE, in the user's browser tab, as
// the logged-in user — never on a serving web pod. So a zip bomb OOMs one tab
// (and is contained by the streamed, hard-bounded inflate below), not a pod.

export const WILDCARD_FETCH_TIMEOUT_MS = 30_000;

// Strip a UTF-8 BOM + NUL bytes at the decode boundary (mirrors the canonical
// server parser's `decodeUtf8`) so downstream splitting/parsing sees clean text.
function decodeUtf8(bytes: Uint8Array): string {
  let start = 0;
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) start = 3;
  return new TextDecoder().decode(start ? bytes.subarray(start) : bytes).replace(/\0/g, '');
}

// JSZip exposes the central-directory uncompressed size on the internal `_data`
// field. Not part of the official public API but stable in v3 and the canonical
// accessor the server parser (`getEntryUncompressedSize`) also uses. Returns
// null when absent (a streamed zip without CD size info) so the bounded read is
// the authoritative guard.
function declaredUncompressedSize(entry: JSZip.JSZipObject): number | null {
  const data = (entry as unknown as { _data?: { uncompressedSize?: number } })._data;
  return typeof data?.uncompressedSize === 'number' ? data.uncompressedSize : null;
}

/**
 * Inflate a single zip entry, HARD-BOUNDED to `limitBytes`. Uses JSZip's
 * per-entry `internalStream('uint8array')` and PAUSES the flow the moment the
 * accumulated byte count reaches the limit — so a hyper-compressible entry (a
 * few KB deflating to GBs) inflates only ~limitBytes + one decompression block,
 * never the full payload. THIS is the guarantee #3130's per-entry check lacked
 * (it flagged the size but still ran a full `entry.async('string')`).
 */
export function readEntryBounded(
  entry: JSZip.JSZipObject,
  limitBytes: number
): Promise<{ text: string; bytes: number; hitLimit: boolean }> {
  return new Promise((resolve, reject) => {
    const chunks: Uint8Array[] = [];
    let total = 0;
    let done = false;
    let hitLimit = false;

    const finish = () => {
      if (done) return;
      done = true;
      const merged = new Uint8Array(total);
      let offset = 0;
      for (const c of chunks) {
        merged.set(c, offset);
        offset += c.length;
      }
      resolve({ text: decodeUtf8(merged), bytes: total, hitLimit });
    };

    // internalStream is not in the JSZip typings but is present in v3.
    const stream = (
      entry as unknown as {
        internalStream: (type: string) => {
          on: (evt: string, fn: (arg: unknown) => void) => unknown;
          resume: () => unknown;
          pause: () => unknown;
        };
      }
    ).internalStream('uint8array');

    stream.on('data', (chunk) => {
      if (done) return;
      const bytes = chunk as Uint8Array;
      chunks.push(bytes);
      total += bytes.length;
      if (total >= limitBytes) {
        hitLimit = true;
        try {
          stream.pause();
        } catch {
          /* pause is best-effort; `done` already stops further accumulation */
        }
        finish();
      }
    });
    stream.on('error', (e) => {
      if (done) return;
      done = true;
      reject(e instanceof Error ? e : new Error(String(e)));
    });
    stream.on('end', () => finish());
    stream.resume();
  });
}

/** Unzip + parse an in-memory zip buffer into named wildcard lists, enforcing
 *  every inflation + result cap. Node- and browser-safe (no `fetch`), so the
 *  zip-bomb bounds are unit-testable against real deflate-bomb buffers. */
export async function parseWildcardZip(
  bytes: Uint8Array,
  caps: WildcardPackCaps = WILDCARD_PACK_CAPS
): Promise<WildcardPackLists> {
  const zip = await JSZip.loadAsync(bytes);
  const entries: RawZipEntry[] = [];
  zip.forEach((path, file) => {
    if (file.dir) return;
    entries.push({
      path,
      declaredSize: declaredUncompressedSize(file),
      read: (limit) => readEntryBounded(file, limit),
    });
  });
  return processWildcardEntries(entries, caps, { parseYaml: (text) => yaml.load(text) });
}

/**
 * The host-side money-shot: pre-cap → fetch (cross-origin b2, CORS-allowed) →
 * bounded unzip + parse. The 32 MB pre-download cap is enforced on the
 * server-advertised size BEFORE fetching; a second belt rejects a download that
 * exceeds the cap even if the server under-reported it. `signal` (an
 * AbortSignal.timeout) bounds the fetch. On any failure a tagged error is thrown
 * that `classifyWildcardPackError` maps to the WILDCARD_PACK_RESULT discriminant.
 */
export async function fetchAndParseWildcardPack({
  signedUrl,
  sizeBytes,
  signal,
  caps = WILDCARD_PACK_CAPS,
}: {
  signedUrl: string;
  sizeBytes: number;
  signal?: AbortSignal;
  caps?: WildcardPackCaps;
}): Promise<WildcardPackLists> {
  if (exceedsPreDownloadCap(sizeBytes)) {
    throw wildcardPackError('too-large', `pack size ${sizeBytes} exceeds ${PRE_DOWNLOAD_MAX_BYTES}`);
  }

  const res = await fetch(signedUrl, {
    signal,
    // The signed URL is a self-contained credential; don't attach cookies or a
    // referrer to the cross-origin storage fetch.
    credentials: 'omit',
    referrerPolicy: 'no-referrer',
  });
  if (!res.ok) {
    throw wildcardPackError('parse-failed', `fetch failed: ${res.status}`);
  }

  const buf = new Uint8Array(await res.arrayBuffer());
  if (buf.byteLength > PRE_DOWNLOAD_MAX_BYTES) {
    throw wildcardPackError('too-large', `downloaded ${buf.byteLength} bytes exceeds the cap`);
  }

  try {
    return await parseWildcardZip(buf, caps);
  } catch (err) {
    // A corrupt / non-zip payload (JSZip.loadAsync throws) → parse-failed.
    throw wildcardPackError('parse-failed', err instanceof Error ? err.message : String(err));
  }
}

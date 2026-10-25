import JSZip from 'jszip';
import {
  RESOURCE_FILE_CAPS,
  processResourceEntries,
  resourceFileError,
  type RawResourceEntry,
  type ResourceFileCaps,
  type ResourceFileEntries,
} from './resourceFileParse';
import { declaredUncompressedSize, decodeUtf8, readEntryBounded } from './wildcardPackHost';
import { exceedsPreDownloadCap, PRE_DOWNLOAD_MAX_BYTES } from './wildcardPackParse';

// The fetch + unzip shell for GET_RESOURCE_FILE. A separate module so jszip only
// loads when a block asks for a file. Runs in the viewer's tab, never on a server.

export const RESOURCE_FILE_FETCH_TIMEOUT_MS = 30_000;

function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot >= 0 ? name.slice(dot + 1).toLowerCase() : '';
}

/** Parse an in-memory `.json` or `.zip` file into graph entries, with every cap applied. */
export async function parseResourceFile(
  bytes: Uint8Array,
  fileName: string,
  caps: ResourceFileCaps = RESOURCE_FILE_CAPS
): Promise<ResourceFileEntries> {
  const ext = extensionOf(fileName);
  if (ext === 'json') {
    const entry: RawResourceEntry = {
      path: fileName,
      declaredSize: bytes.byteLength,
      read: async (limit) => ({
        text: decodeUtf8(bytes.subarray(0, limit)),
        bytes: Math.min(bytes.byteLength, limit),
        hitLimit: bytes.byteLength >= limit,
      }),
    };
    return processResourceEntries([entry], caps);
  }
  if (ext !== 'zip') throw resourceFileError('parse-failed', `unsupported file type .${ext}`);

  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(bytes);
  } catch (err) {
    throw resourceFileError('parse-failed', err instanceof Error ? err.message : String(err));
  }
  const entries: RawResourceEntry[] = [];
  zip.forEach((path, file) => {
    if (file.dir) return;
    entries.push({
      path,
      declaredSize: declaredUncompressedSize(file),
      read: (limit) => readEntryBounded(file, limit),
    });
  });
  return processResourceEntries(entries, caps);
}

/**
 * Pre-download cap, fetch the signed URL, then parse. Every failure throws an
 * error `classifyResourceFileError` maps to a RESOURCE_FILE_RESULT code.
 */
export async function fetchAndParseResourceFile({
  signedUrl,
  sizeBytes,
  fileName,
  signal,
  caps = RESOURCE_FILE_CAPS,
}: {
  signedUrl: string;
  sizeBytes: number;
  fileName: string;
  signal?: AbortSignal;
  caps?: ResourceFileCaps;
}): Promise<ResourceFileEntries> {
  if (exceedsPreDownloadCap(sizeBytes)) {
    throw resourceFileError(
      'too-large',
      `file size ${sizeBytes} exceeds ${PRE_DOWNLOAD_MAX_BYTES}`
    );
  }
  const res = await fetch(signedUrl, {
    signal,
    credentials: 'omit',
    referrerPolicy: 'no-referrer',
  });
  if (!res.ok) throw resourceFileError('parse-failed', `fetch failed: ${res.status}`);
  return parseResourceFile(await readBodyBounded(res, PRE_DOWNLOAD_MAX_BYTES), fileName, caps);
}

/**
 * Read a response body, refusing it as `too-large` once it passes `maxBytes`.
 * The advertised size comes from the uploader, so the body is counted as it
 * streams rather than buffered whole and checked afterwards.
 */
export async function readBodyBounded(res: Response, maxBytes: number): Promise<Uint8Array> {
  const tooLarge = () => resourceFileError('too-large', `response exceeds ${maxBytes} bytes`);
  const declared = Number(res.headers?.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) throw tooLarge();
  if (!res.body) {
    const buf = new Uint8Array(await res.arrayBuffer());
    if (buf.byteLength > maxBytes) throw tooLarge();
    return buf;
  }
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw tooLarge();
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return out;
}

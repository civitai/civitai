import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import type * as C2pa from '@contentauth/c2pa-wasm';

let c2pa: Promise<typeof C2pa> | undefined;

// Each of these can make a read call out to a host named inside the file, and the SDK's
// allowed_network_hosts does not cover identity assertions.
const READER_CONTEXT = JSON.stringify({
  verify: { remote_manifest_fetch: false, ocsp_fetch: false },
  core: { decode_identity_assertions: false },
});

// shortcut: the reader shares one wasm instance on the request thread. A trap can leave it broken
// until the pod restarts, and a hung read is only cut off here. A worker thread would fix both.
const READ_TIMEOUT_MS = 10_000;

function loadC2pa() {
  c2pa ??= (async () => {
    const mod = await import('@contentauth/c2pa-wasm');
    // Resolved from the app root at runtime so the bundler leaves the .wasm path alone.
    const wasmPath = createRequire(path.join(process.cwd(), 'package.json')).resolve(
      '@contentauth/c2pa-wasm/c2pa.wasm'
    );
    mod.initSync({ module: await readFile(wasmPath) });
    return mod;
  })().catch((e) => {
    c2pa = undefined;
    throw e;
  });
  return c2pa;
}

const SIGNATURES: [mimeType: string, test: (b: Uint8Array) => boolean][] = [
  ['image/jpeg', (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff],
  ['image/png', (b) => b[0] === 0x89 && ascii(b, 1, 4) === 'PNG'],
  ['image/webp', (b) => ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 12) === 'WEBP'],
  ['image/avif', (b) => ascii(b, 4, 8) === 'ftyp' && ['avif', 'avis'].includes(ascii(b, 8, 12))],
  [
    'image/heic',
    (b) => ascii(b, 4, 8) === 'ftyp' && ['heic', 'heix', 'mif1'].includes(ascii(b, 8, 12)),
  ],
];

function ascii(b: Uint8Array, start: number, end: number) {
  return String.fromCharCode(...b.subarray(start, end));
}

export function sniffImageType(bytes: Uint8Array) {
  return SIGNATURES.find(([, test]) => test(bytes))?.[0];
}

// IPTC digital source types for AI output: https://cv.iptc.org/newscodes/digitalsourcetype/
const AI_SOURCE_TYPES = ['trainedAlgorithmicMedia', 'compositeWithTrainedAlgorithmicMedia'];

type ManifestAssertion = { label?: string; data?: { actions?: { digitalSourceType?: string }[] } };

export function declaresAiSource(assertions: ManifestAssertion[] | undefined) {
  return (assertions ?? []).some(
    (a) =>
      a.label?.startsWith('c2pa.actions') &&
      a.data?.actions?.some((action) =>
        AI_SOURCE_TYPES.some((t) => action.digitalSourceType?.endsWith(`/${t}`))
      )
  );
}

export type ContentCredentialsResult =
  | { credentials: 'none' }
  | { credentials: 'unreadable' }
  | {
      // 'valid' means intact and unaltered since signing, not that the signer is who it names:
      // anyone can sign with a certificate that says "Civitai".
      credentials: 'valid' | 'invalid';
      signer: { issuer?: string; commonName?: string; signedAt?: string };
      generator?: string;
      aiGenerated: boolean;
    };

function withTimeout<T>(promise: Promise<T>) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('C2PA read timed out')), READ_TIMEOUT_MS);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

const VALIDATION_STATES: Record<string, 'valid' | 'invalid'> = {
  Valid: 'valid',
  Trusted: 'valid',
  Invalid: 'invalid',
};

export async function readContentCredentials(
  bytes: Uint8Array,
  mimeType: string
): Promise<ContentCredentialsResult> {
  const { WasmReader } = await loadC2pa();
  let reader: C2pa.WasmReader;
  try {
    reader = await withTimeout(WasmReader.fromBytes(mimeType, bytes, READER_CONTEXT));
  } catch (e) {
    return { credentials: String(e).includes('JumbfNotFound') ? 'none' : 'unreadable' };
  }
  try {
    const { validation_state } = JSON.parse(reader.json()) as { validation_state?: string };
    const credentials = VALIDATION_STATES[validation_state ?? ''];
    if (!credentials) return { credentials: 'unreadable' };
    const manifest = reader.activeManifest();
    return {
      credentials,
      signer: {
        issuer: manifest?.signature_info?.issuer,
        commonName: manifest?.signature_info?.common_name,
        signedAt: manifest?.signature_info?.time,
      },
      generator: manifest?.claim_generator_info?.[0]?.name ?? manifest?.claim_generator,
      aiGenerated: declaresAiSource(manifest?.assertions),
    };
  } finally {
    reader.free();
  }
}

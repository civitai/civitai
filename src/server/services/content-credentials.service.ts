import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { Worker } from 'node:worker_threads';
import { sniffImageFormat } from '~/shared/utils/image-magic-bytes';

// Each of these can make a read call out to a host named inside the file, and the SDK's
// allowed_network_hosts does not cover identity assertions.
const READER_CONTEXT = JSON.stringify({
  verify: { remote_manifest_fetch: false, ocsp_fetch: false },
  core: { decode_identity_assertions: false },
});

// The read runs in a worker so a slow or hostile file can't block the request thread; a read past
// this is cut off by terminating the worker, the only way to stop synchronous wasm.
const READ_TIMEOUT_MS = 10_000;
const MAX_QUEUED_READS = 8;

const WORKER_SOURCE = `
const { parentPort, workerData } = require('node:worker_threads');
const c2pa = import(workerData.moduleUrl).then((m) => {
  m.initSync({ module: workerData.wasm });
  return m;
});
parentPort.on('message', async ({ id, bytes, mimeType, context }) => {
  try {
    const { WasmReader } = await c2pa;
    const reader = await WasmReader.fromBytes(mimeType, bytes, context);
    try {
      parentPort.postMessage({ id, json: reader.json(), manifest: JSON.stringify(reader.activeManifest() ?? null) });
    } finally {
      reader.free();
    }
  } catch (e) {
    parentPort.postMessage({ id, error: String(e) });
  }
});
`;

type WorkerReply = { id: number; error?: string; json?: string; manifest?: string };

export class VerifyBusyError extends Error {}

// Resolved from the app root at runtime so the bundler leaves the package paths alone.
function resolveFromApp(specifier: string) {
  return createRequire(path.join(process.cwd(), 'package.json')).resolve(specifier);
}

let wasm: Promise<WebAssembly.Module> | undefined;
let worker: Worker | undefined;
let nextId = 0;
const pending = new Map<number, (reply: WorkerReply) => void>();

function stopWorker(w: Worker, error: string) {
  if (worker !== w) return;
  worker = undefined;
  for (const [id, done] of pending) done({ id, error });
  pending.clear();
  void w.terminate();
}

async function getWorker() {
  wasm ??= readFile(resolveFromApp('@contentauth/c2pa-wasm/c2pa.wasm'))
    .then((bytes) => WebAssembly.compile(bytes))
    .catch((e) => {
      wasm = undefined;
      throw e;
    });
  const compiled = await wasm;
  if (!worker) {
    const w = new Worker(WORKER_SOURCE, {
      eval: true,
      workerData: {
        moduleUrl: pathToFileURL(resolveFromApp('@contentauth/c2pa-wasm')).href,
        wasm: compiled,
      },
    });
    w.on('message', (reply: WorkerReply) => {
      pending.get(reply.id)?.(reply);
      pending.delete(reply.id);
    });
    w.on('error', (e) => stopWorker(w, String(e)));
    w.on('exit', () => stopWorker(w, 'worker exited'));
    w.unref();
    worker = w;
  }
  return worker;
}

async function readInWorker(bytes: Uint8Array, mimeType: string): Promise<WorkerReply> {
  if (pending.size >= MAX_QUEUED_READS) throw new VerifyBusyError();
  const w = await getWorker();
  const id = nextId++;
  return new Promise((resolve) => {
    const timer = setTimeout(() => stopWorker(w, 'timed out'), READ_TIMEOUT_MS);
    pending.set(id, (reply) => {
      clearTimeout(timer);
      resolve(reply);
    });
    w.postMessage({ id, bytes, mimeType, context: READER_CONTEXT });
  });
}

function ascii(b: Uint8Array, start: number, end: number) {
  return String.fromCharCode(...b.subarray(start, end));
}

const FTYP_BRANDS: Record<string, string> = {
  avif: 'image/avif',
  avis: 'image/avif',
  heic: 'image/heic',
  heix: 'image/heic',
  mif1: 'image/heic',
};

export function sniffImageType(bytes: Uint8Array) {
  const format = sniffImageFormat(bytes, {
    formats: ['jpeg', 'png', 'webp'],
    pngSignature: 'full',
  });
  if (format) return `image/${format}`;
  return ascii(bytes, 4, 8) === 'ftyp' ? FTYP_BRANDS[ascii(bytes, 8, 12)] : undefined;
}

// IPTC digital source types for AI output: https://cv.iptc.org/newscodes/digitalsourcetype/
const AI_SOURCE_TYPES = ['trainedAlgorithmicMedia', 'compositeWithTrainedAlgorithmicMedia'];

type ManifestAssertion = { label?: string; data?: { actions?: { digitalSourceType?: string }[] } };

type ActiveManifest = {
  signature_info?: { issuer?: string; common_name?: string; time?: string };
  claim_generator?: string;
  claim_generator_info?: { name?: string }[];
  assertions?: ManifestAssertion[];
} | null;

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

const VALIDATION_STATES: Record<string, 'valid' | 'invalid'> = {
  Valid: 'valid',
  Trusted: 'valid',
  Invalid: 'invalid',
};

export async function readContentCredentials(
  bytes: Uint8Array,
  mimeType: string
): Promise<ContentCredentialsResult> {
  const reply = await readInWorker(bytes, mimeType);
  if (reply.error !== undefined || !reply.json || !reply.manifest)
    return { credentials: reply.error?.includes('JumbfNotFound') ? 'none' : 'unreadable' };

  const { validation_state } = JSON.parse(reply.json) as { validation_state?: string };
  const credentials = VALIDATION_STATES[validation_state ?? ''];
  if (!credentials) return { credentials: 'unreadable' };
  const manifest = JSON.parse(reply.manifest) as ActiveManifest;
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
}

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
  let WasmReader;
  try {
    ({ WasmReader } = await c2pa);
  } catch (e) {
    return parentPort.postMessage({ id, unavailable: String(e) });
  }
  try {
    const reader = await WasmReader.fromBytes(mimeType, bytes, context);
    try {
      parentPort.postMessage({ id, json: reader.json(), manifest: JSON.stringify(reader.activeManifest() ?? null) });
    } finally {
      reader.free();
    }
  } catch (e) {
    // A trap can leave the instance broken: report the reader, not the file, so the worker is replaced.
    parentPort.postMessage(e instanceof WebAssembly.RuntimeError ? { id, unavailable: String(e) } : { id, error: String(e) });
  }
});
`;

type WorkerReply = { id: number; error?: string; json?: string; manifest?: string };

// The reader failed, not the file: the caller should retry, not report a verdict.
export class VerifyUnavailableError extends Error {}
export class VerifyBusyError extends VerifyUnavailableError {}

// Resolved from the app root at runtime so the bundler leaves the package paths alone.
function resolveFromApp(specifier: string) {
  return createRequire(path.join(process.cwd(), 'package.json')).resolve(specifier);
}

type Job = {
  bytes: Uint8Array;
  mimeType: string;
  resolve: (reply: WorkerReply) => void;
  reject: (e: Error) => void;
};

let wasm: Promise<WebAssembly.Module> | undefined;
let worker: Worker | undefined;
let nextId = 0;
const queue: Job[] = [];
// One read at a time, so a timeout is charged to the read that caused it and stopping the worker
// fails only that read.
type InFlight = { id: number; job: Job; timer?: ReturnType<typeof setTimeout> };
let inFlight: InFlight | undefined;

function settle(id: number, outcome: WorkerReply | Error) {
  if (inFlight?.id !== id) return;
  const { job, timer } = inFlight;
  clearTimeout(timer);
  inFlight = undefined;
  if (outcome instanceof Error) job.reject(outcome);
  else job.resolve(outcome);
  pump();
}

function stopWorker(w: Worker, reason: string) {
  if (worker !== w) return;
  worker = undefined;
  void w.terminate();
  if (inFlight) settle(inFlight.id, new VerifyUnavailableError(reason));
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
    w.on('message', (reply: WorkerReply & { unavailable?: string }) => {
      if (reply.unavailable === undefined) settle(reply.id, reply);
      else stopWorker(w, reply.unavailable);
    });
    w.on('error', (e) => stopWorker(w, String(e)));
    w.on('exit', () => stopWorker(w, 'worker exited'));
    w.unref();
    worker = w;
  }
  return worker;
}

function pump() {
  if (inFlight) return;
  const job = queue.shift();
  if (!job) return;
  const id = nextId++;
  const current: InFlight = { id, job };
  inFlight = current;
  getWorker().then(
    (w) => {
      if (inFlight !== current) return;
      current.timer = setTimeout(() => stopWorker(w, 'timed out'), READ_TIMEOUT_MS);
      w.postMessage({ id, bytes: job.bytes, mimeType: job.mimeType, context: READER_CONTEXT });
    },
    (e) => settle(id, new VerifyUnavailableError(String(e)))
  );
}

function readInWorker(bytes: Uint8Array, mimeType: string) {
  if (queue.length + (inFlight ? 1 : 0) >= MAX_QUEUED_READS) throw new VerifyBusyError();
  return new Promise<WorkerReply>((resolve, reject) => {
    queue.push({ bytes, mimeType, resolve, reject });
    pump();
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

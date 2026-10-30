import { generateKeyPairSync, randomBytes } from 'crypto';
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'fs';
import path from 'path';

export type TestKeyPair = { publicPem: string; privatePem: string };

// Vitest's default `forks` pool with isolate:true starts a NEW OS PROCESS for every test file
// (measured: 8 files, 8 distinct pids), so nothing in-process — module registry, globalThis,
// worker-scoped memo — survives to the next file. A 2048-bit RSA keygen costs ~143ms here and
// setup.ts is a setupFile, so the suite paid it 1065 times. The only cache that outlives a fork
// is on disk.
const CACHE_DIR = path.resolve(process.cwd(), 'node_modules/.cache/civitai-test-keys');
const CACHE_FILE = path.join(CACHE_DIR, 'block-token-rsa2048-v1.json');

function looksValid(parsed: unknown): parsed is TestKeyPair {
  if (typeof parsed !== 'object' || parsed === null) return false;
  const { publicPem, privatePem } = parsed as Partial<TestKeyPair>;
  return (
    typeof publicPem === 'string' &&
    publicPem.startsWith('-----BEGIN PUBLIC KEY-----') &&
    typeof privatePem === 'string' &&
    privatePem.startsWith('-----BEGIN PRIVATE KEY-----')
  );
}

function generate(): TestKeyPair {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  return {
    publicPem: publicKey.export({ type: 'spki', format: 'pem' }) as string,
    privatePem: privateKey.export({ type: 'pkcs8', format: 'pem' }) as string,
  };
}

function persist(pair: TestKeyPair) {
  // Write-then-rename so a reader in another fork never observes a half-written file. Every
  // failure here is survivable — the caller already holds a usable pair — so a lost race just
  // costs that fork one keygen.
  const tmp = `${CACHE_FILE}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  try {
    mkdirSync(CACHE_DIR, { recursive: true });
    writeFileSync(tmp, JSON.stringify(pair));
    renameSync(tmp, CACHE_FILE);
  } catch {
    try {
      unlinkSync(tmp);
    } catch {
      /* nothing to clean up */
    }
  }
}

/**
 * A stable RSA-2048 keypair for tests that sign with the private key and verify with the matching
 * public one. Stable, not fresh: no test depends on a per-file key, and the pair never leaves
 * `node_modules/.cache`, so no PEM is committed to this public repo.
 */
export function getTestRsaKeyPair(): TestKeyPair {
  try {
    const parsed: unknown = JSON.parse(readFileSync(CACHE_FILE, 'utf8'));
    if (looksValid(parsed)) return parsed;
  } catch {
    /* missing, truncated or corrupt — fall through and regenerate */
  }
  const pair = generate();
  persist(pair);
  return pair;
}

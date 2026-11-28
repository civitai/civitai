import { globSync, readFileSync, statSync } from 'fs';
import path from 'path';

// The unit files that can share a worker's module registry (`isolate: false`): neither they nor the
// test helpers they import change state a later file in the same worker would see.
const leaksIntoLaterFiles = [
  /\bvi\.(mock|doMock|unmock|doUnmock|stubGlobal|stubEnv|resetModules|importMock)\(/,
  /process\.env(\.\w+|\[[^\]]+\])\s*(=(?!=)|\?\?=|\|\|=)/,
  /delete\s+process\.env|Object\.assign\(\s*process\.env/,
  /(globalThis|global)\.\w+\s*=(?!=)/,
  /\bregister\.clear\(/,
  // A closed PGlite still holds its WASM memory while a shared worker keeps its module (#10662).
  /pglite/i,
  /worker_threads|child_process|createServer\(|\.listen\(/,
  /@vitest-environment/,
  // Source scans that parse the repo with the TypeScript compiler: each one adds 0.5–1.2 GiB to
  // a worker that outlives it.
  /from ['"]typescript['"]|require\(['"]typescript['"]\)|import-ledger/,
];

// Fail only when an earlier file in the same worker ran first; cause not traced.
const orderDependent = [
  'src/components/ImageGeneration/utils/__tests__/unratedOutputRefetch.test.ts',
  'src/server/services/__tests__/base-model-attestation.service.test.ts',
  'src/server/utils/__tests__/client-ip-trusted.test.ts',
  'src/server/services/__tests__/profile-picture-refresh-alert.test.ts',
];

const importSpecifier = /(?:from|import\(|import)\s*['"]([^'"]+)['"]/g;
const extensions = ['', '.ts', '.tsx', '.mts', '.mjs', '.js', '/index.ts', '/index.tsx'];

function resolveImport(fromFile, specifier) {
  let base;
  if (specifier.startsWith('~/')) base = path.join('src', specifier.slice(2));
  else if (specifier.startsWith('.')) base = path.join(path.dirname(fromFile), specifier);
  else return undefined;
  return extensions
    .map((ext) => base + ext)
    .find((p) => statSync(p, { throwIfNoEntry: false })?.isFile());
}

const isTestSupport = (file) =>
  file.startsWith('test/') ||
  /[/\\](__tests__|mocks)[/\\]/.test(file) ||
  /\.(harness|fixtures?|mocks?)\.[cm]?[jt]sx?$/.test(file);

function staysIsolated(testFile) {
  const seen = new Set();
  const queue = [testFile];
  while (queue.length) {
    const file = queue.pop();
    if (seen.has(file)) continue;
    seen.add(file);
    const source = readFileSync(file, 'utf8');
    if (leaksIntoLaterFiles.some((pattern) => pattern.test(source))) return true;
    for (const [, specifier] of source.matchAll(importSpecifier)) {
      const resolved = resolveImport(file, specifier);
      if (resolved && isTestSupport(resolved)) queue.push(resolved);
    }
  }
  return false;
}

/** @param {string[]} include @param {string[]} exclude */
export function unitSharedFiles(include, exclude) {
  return globSync(include, { exclude })
    .filter((file) => !orderDependent.includes(file) && !staysIsolated(file))
    .sort();
}

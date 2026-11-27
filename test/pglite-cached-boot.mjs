import { existsSync, readFileSync } from 'fs';
import { PGlite as RealPGlite } from '../node_modules/@electric-sql/pglite/dist/index.js';
import { EMPTY_DATADIR } from './pglite-empty-datadir.mjs';

export * from '../node_modules/@electric-sql/pglite/dist/index.js';

// initdb is most of a PGlite boot (~0.8 s); loading an already initialised cluster takes ~0.2 s.
const emptyDataDir = existsSync(EMPTY_DATADIR)
  ? new Blob([readFileSync(EMPTY_DATADIR)])
  : undefined;

function withEmptyDataDir(dataDirOrOptions, options) {
  const o =
    typeof dataDirOrOptions === 'string'
      ? { dataDir: dataDirOrOptions, ...options }
      : { ...dataDirOrOptions };
  const inMemory = !o.dataDir || o.dataDir.startsWith('memory://');
  return emptyDataDir && inMemory && !o.loadDataDir ? { ...o, loadDataDir: emptyDataDir } : o;
}

// src/__tests__/setup.ts closes what a test file leaves open, so a worker that outlives the file
// doesn't keep its WASM heap.
const openInstances = (globalThis[Symbol.for('civitai.openPglites')] ??= new Set());

export class PGlite extends RealPGlite {
  constructor(dataDirOrOptions, options) {
    super(withEmptyDataDir(dataDirOrOptions, options));
    openInstances.add(this);
  }

  async close() {
    openInstances.delete(this);
    return super.close();
  }

  static async create(dataDirOrOptions, options) {
    const db = new PGlite(dataDirOrOptions, options);
    await db.waitReady;
    return db;
  }
}

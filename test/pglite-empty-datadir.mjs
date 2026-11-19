import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs';
import path from 'path';

const root = path.resolve(import.meta.dirname, '..');
const pgliteDir = path.join(root, 'node_modules/@electric-sql/pglite');
const { version } = JSON.parse(readFileSync(path.join(pgliteDir, 'package.json'), 'utf8'));

export const PGLITE_ENTRY = path.join(pgliteDir, 'dist/index.js');
export const EMPTY_DATADIR = path.join(root, 'node_modules/.cache/pglite', `empty-${version}.tar`);

/** Vitest global setup: dump one freshly initialised PGlite cluster for test/pglite-cached-boot.mjs. */
export default async function setup() {
  if (existsSync(EMPTY_DATADIR)) return;
  const { PGlite } = await import(PGLITE_ENTRY);
  const db = new PGlite();
  const dump = await db.dumpDataDir('none');
  await db.close();
  mkdirSync(path.dirname(EMPTY_DATADIR), { recursive: true });
  const partial = `${EMPTY_DATADIR}.${process.pid}`;
  writeFileSync(partial, Buffer.from(await dump.arrayBuffer()));
  renameSync(partial, EMPTY_DATADIR);
}

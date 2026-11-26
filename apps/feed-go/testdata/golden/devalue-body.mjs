// The tRPC response body the main app writes for a value with TRPC_WRITE_DEVALUE=true: tRPC's
// envelope, JSON.stringify'd, around `devalue.stringify(value)` (the server transformer's devalue
// write, src/shared/utils/trpc-union-transformer.ts). Written next to each served fixture as
// `devalue/<dir>/<name>.txt` (the exact bytes, no trailing newline), and compared byte for byte by
// internal/server/golden_test.go (TestGoldenDevalue*).
//
// devalue must resolve from the repo's node_modules (or GOLDEN_NODE_MODULES), so the bytes are the
// ones the version the lockfile pins writes.
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { importDep } from './pack.mjs';

const devalue = await importDep('devalue');
const HERE = dirname(fileURLToPath(import.meta.url));

/** The body bytes Node writes for `value` (one unbatched query). */
export function devalueBody(value) {
  return JSON.stringify({ result: { data: devalue.stringify(value) } });
}

/** Empties `devalue/<dir>/` before a generator rewrites it. */
export function resetDevalueDir(dir) {
  const out = join(HERE, 'devalue', dir);
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
}

/** Writes the devalue body of fixture `name` in `dir`. */
export function writeDevalueBody(dir, name, value) {
  writeFileSync(join(HERE, 'devalue', dir, `${name}.txt`), devalueBody(value));
}

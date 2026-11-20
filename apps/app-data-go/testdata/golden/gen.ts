// Generates the reference vectors (testdata/golden/vectors.json) app-data-go's urn tests read. Run
// from the repo root:
//
//   pnpm exec tsx --tsconfig tsconfig.json apps/app-data-go/testdata/golden/gen.ts
//
// scripts/__tests__/app-data-go-vectors.schema-drift.test.ts regenerates them in CI and fails when the
// committed file differs, so a change to the adapter's URN builder or parser that changes an answer
// must regenerate this file, and the Go tests then say whether app-data-go still agrees.
//
// Where an expected value comes from: the REAL adapter code. A vector's `urn` is what
// `registryUrn({ kind: 'collection-schema', … })` (src/server/registry-adapter/urn.ts) builds, kept
// only when `parseCollectionSchemaUrn` reads the same parts back from it: a URN the builder makes but
// the parser refuses names a stream the adapter would never route, so app-data-go must refuse it too.
// `urn: null` means one of the two refused. Every input is synthetic.
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseCollectionSchemaUrn, registryUrn } from '~/server/registry-adapter/urn';

export const APP_DATA_VECTORS_PATH = join(__dirname, 'vectors.json');

export type Vector = { slug: string; collection: string; major: number; urn: string | null };

const INPUTS: Array<Omit<Vector, 'urn'>> = [
  { slug: 'todo-app', collection: 'notes', major: 1 },
  { slug: 'a', collection: 'x', major: 2 },
  { slug: '0', collection: 'a_1', major: 10 },
  { slug: 'a'.repeat(64), collection: 'c'.repeat(32), major: 999_999_999 },
  // Bounds just past each shape.
  { slug: 'a'.repeat(65), collection: 'notes', major: 1 },
  { slug: 'todo-app', collection: 'c'.repeat(33), major: 1 },
  { slug: 'todo-app', collection: 'notes', major: 1_000_000_000 },
  { slug: 'todo-app', collection: 'notes', major: 0 },
  { slug: 'todo-app', collection: 'notes', major: -1 },
  // Characters the segments never hold.
  { slug: 'Todo-App', collection: 'notes', major: 1 },
  { slug: '-todo', collection: 'notes', major: 1 },
  { slug: 'todo-', collection: 'notes', major: 1 },
  { slug: 'todo/app', collection: 'notes', major: 1 },
  { slug: 'todo:app', collection: 'notes', major: 1 },
  { slug: 'todo@app', collection: 'notes', major: 1 },
  { slug: '', collection: 'notes', major: 1 },
  { slug: 'todo-app', collection: '1notes', major: 1 },
  { slug: 'todo-app', collection: '_notes', major: 1 },
  { slug: 'todo-app', collection: 'Notes', major: 1 },
  { slug: 'todo-app', collection: 'no-tes', major: 1 },
  { slug: 'todo-app', collection: '', major: 1 },
];

function decide(input: Omit<Vector, 'urn'>): Vector {
  let urn: string | null;
  try {
    urn = registryUrn({ kind: 'collection-schema', ...input });
  } catch {
    urn = null;
  }
  if (urn !== null) {
    const back = parseCollectionSchemaUrn(urn);
    if (
      !back ||
      back.slug !== input.slug ||
      back.collection !== input.collection ||
      back.major !== input.major
    ) {
      urn = null;
    }
  }
  return { ...input, urn };
}

export function renderVectors(): string {
  return JSON.stringify({ vectors: INPUTS.map(decide) }, null, 2) + '\n';
}

if (process.argv[1]?.endsWith('gen.ts')) {
  writeFileSync(APP_DATA_VECTORS_PATH, renderVectors());
  console.log(`wrote ${APP_DATA_VECTORS_PATH}`);
}

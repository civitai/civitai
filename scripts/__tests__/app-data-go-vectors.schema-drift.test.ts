import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// apps/app-data-go's urn test builds a collection-schema URN for every vector in this committed file
// and compares it with what the REAL adapter code answered when the file was generated. This test
// regenerates the file from today's adapter code (src/server/registry-adapter/urn.ts) and fails when
// the committed one differs, so a change to how the adapter names a collection's stream cannot merge
// without the Go side being checked against it. Regenerate:
//
//   pnpm exec tsx --tsconfig tsconfig.json apps/app-data-go/testdata/golden/gen.ts

import {
  APP_DATA_VECTORS_PATH,
  renderVectors,
  type Vector,
} from '../../apps/app-data-go/testdata/golden/gen';

describe('apps/app-data-go testdata/golden/vectors.json', () => {
  const rendered = renderVectors();

  it('is what the adapter code answers today (regenerate with gen.ts, see the file comment)', () => {
    expect(readFileSync(APP_DATA_VECTORS_PATH, 'utf8')).toBe(rendered);
  });

  // Positive control: the generator ran the real builder, so known answers are in it, pinned as
  // literals (a generator that refused everything, or accepted everything, would still write a file).
  it('holds answers the adapter is known to give', () => {
    const { vectors } = JSON.parse(rendered) as { vectors: Vector[] };
    const urnOf = (slug: string, collection: string, major: number) =>
      vectors.find((v) => v.slug === slug && v.collection === collection && v.major === major)?.urn;
    expect(urnOf('todo-app', 'notes', 1)).toBe('urn:schema:apps.civitai.com:todo-app/notes@v1');
    expect(urnOf('0', 'a_1', 10)).toBe('urn:schema:apps.civitai.com:0/a_1@v10');
    // The builder accepts a ten-digit major; the parser does not read it back, so it is refused.
    expect(urnOf('todo-app', 'notes', 1_000_000_000)).toBeNull();
    expect(urnOf('Todo-App', 'notes', 1)).toBeNull();
    expect(vectors.filter((v) => v.urn !== null).length).toBe(4);
  });
});

import { readdirSync, readFileSync } from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';
import { getSupportedBlurbEntityTypes } from '~/server/services/blurb-fanout.adapters';

/**
 * The adapter registry keys and the `entityType` string each save path passes have to be the same
 * set, and nothing makes them so: a mismatch is silent in both directions. A save writing an
 * entityType with no adapter accumulates references the fan-out reports `unsupported` forever; an
 * adapter for a type no save writes maintains nothing.
 *
 * A source scan rather than a call assertion, because it covers the surface added next year —
 * which is the case that has no test.
 */
const repoRoot = path.resolve(__dirname, '../../../..');
const serviceDir = path.join(repoRoot, 'src/server/services');

const CALLERS = ['reconcileBlurbReferences', 'getReferencedBlurbIds'];

function entityTypesInSource() {
  const found = new Map<string, Set<string>>();
  for (const file of readdirSync(serviceDir).filter((f) => f.endsWith('.service.ts'))) {
    const source = readFileSync(path.join(serviceDir, file), 'utf8');
    for (const caller of CALLERS) {
      let from = 0;
      for (;;) {
        // The call site, not the import or the definition — hence the open paren.
        const at = source.indexOf(`${caller}(`, from);
        if (at === -1) break;
        from = at + caller.length;
        const literal = /entityType:\s*'([^']+)'/.exec(source.slice(at, at + 400));
        if (!literal) continue;
        const seen = found.get(literal[1]) ?? new Set<string>();
        seen.add(`${file}:${caller}`);
        found.set(literal[1], seen);
      }
    }
  }
  return found;
}

describe('blurb entityType parity', () => {
  const inSource = entityTypesInSource();

  it('finds every save path, so an empty scan cannot pass as agreement', () => {
    // Without this the whole suite is vacuous the day the regex stops matching.
    expect([...inSource.values()].flatMap((s) => [...s]).length).toBeGreaterThanOrEqual(
      getSupportedBlurbEntityTypes().length
    );
  });

  it('🔴 passes only entityTypes the fan-out has an adapter for', () => {
    const supported = new Set(getSupportedBlurbEntityTypes());
    const unregistered = [...inSource.keys()].filter((type) => !supported.has(type));

    expect(unregistered).toEqual([]);
  });

  it('🔴 registers an adapter only for entityTypes some save path writes', () => {
    const written = new Set(inSource.keys());
    const unwritten = getSupportedBlurbEntityTypes().filter((type) => !written.has(type));

    expect(unwritten).toEqual([]);
  });
});

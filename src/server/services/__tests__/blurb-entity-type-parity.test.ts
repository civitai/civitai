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

/**
 * A form that offers the blurb control must not re-declare its body field's sanitize without
 * `allowBlurbs`. `ModelUpsertForm` did: it extends `modelUpsertSchema` to add an empty check, and
 * re-declaring the field re-declared the SANITIZE — stripping `data-type`/`data-id` CLIENT-SIDE,
 * before the request was sent. The server schema was correct and never saw a reference, so no
 * BlurbReference row was written and the words were frozen as ordinary text. Everything looked
 * right: the control rendered, the chip inserted, the save succeeded.
 *
 * Found by driving the feature in a browser, not by any of the suites — which is why this exists.
 * A source scan, so it covers the surface added next year.
 */
describe('a blurb-enabled form does not re-sanitize its body without allowBlurbs', () => {
  const componentsDir = path.join(repoRoot, 'src/components');

  const walk = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) return e.name === '__tests__' ? [] : walk(full);
      return e.isFile() && e.name.endsWith('.tsx') ? [full] : [];
    });

  it('🔴 every form passing the blurb control keeps allowBlurbs on its own schema', () => {
    const offenders: string[] = [];

    for (const file of walk(componentsDir)) {
      const source = readFileSync(file, 'utf8');
      // Only forms that actually offer the control can strand a reference.
      if (!/includeControls=\{\[[^\]]*'blurb'/s.test(source)) continue;
      if (!source.includes('getSanitizedStringSchema')) continue;

      // Every local re-declaration must carry the flag. The import line has no call parens.
      const calls = source.match(/getSanitizedStringSchema\(([^)]*)\)/g) ?? [];
      for (const call of calls) {
        if (!call.includes('allowBlurbs')) {
          offenders.push(`${path.relative(repoRoot, file)} -> ${call}`);
        }
      }
    }

    expect(offenders).toEqual([]);
  });
});

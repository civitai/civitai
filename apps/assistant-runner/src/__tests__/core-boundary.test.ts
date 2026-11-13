import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';
import { describe, expect, it } from 'vitest';

/**
 * `src/core/` is the generic runner, to be published on its own: it reaches civitai's code (tokens,
 * grants, orchestration, App Assistant) only through the seams in `core/interfaces.ts`, which the
 * rest of `src/` implements. So nothing under it may import a file outside it, nor a package other
 * than the ones listed here (what the published runner will depend on).
 */
const CORE = fileURLToPath(new URL('../core', import.meta.url));

/** The packages `src/core/` may import, by package name (a subpath of one is that package). */
const CORE_PACKAGES = [
  '@civitai/components-chat',
  '@dbos-inc/dbos-sdk',
  'ai',
  'fastify',
  'pg',
  'zod',
] as const;

/**
 * Every module specifier a TypeScript source names: static, type-only, re-export, side-effect,
 * dynamic and `require`, as TypeScript's own pre-processor reads them. Not a regex: SQL text such as
 * `from "${SCHEMA}".streams` inside a template string reads as an import to one.
 */
function specifiers(source: string): string[] {
  return ts.preProcessFile(source, true, true).importedFiles.map((file) => file.fileName);
}

function packageOf(specifier: string): string {
  const parts = specifier.split('/');
  return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]!;
}

/** Why each import of `file` (a path under `core`) crosses the boundary; empty when none does. */
function coreBoundaryViolations(core: string, file: string, source: string): string[] {
  const where = path.relative(core, file);
  const violations: string[] = [];
  for (const specifier of specifiers(source)) {
    if (specifier.startsWith('.')) {
      const target = path.resolve(path.dirname(file), specifier);
      if (target !== core && !target.startsWith(core + path.sep))
        violations.push(`core-boundary: ${where} imports '${specifier}', outside src/core/`);
    } else if (!specifier.startsWith('node:')) {
      const name = packageOf(specifier);
      if (!(CORE_PACKAGES as readonly string[]).includes(name))
        violations.push(
          `core-boundary: ${where} imports package '${name}', not one of core's dependencies`
        );
    }
  }
  return violations;
}

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sources(full);
    return /\.(ts|tsx|mts|cts|js|mjs|cjs)$/.test(entry.name) ? [full] : [];
  });
}

describe('src/core/ boundary', () => {
  it('nothing under src/core/ imports from outside it', () => {
    const files = sources(CORE);
    const names = files.map((file) => path.relative(CORE, file));
    // The scan reads the runner itself, not an empty or wrong directory.
    expect(names).toEqual(
      expect.arrayContaining(['runner.ts', 'interfaces.ts', 'app.ts', 'test-support/fakes.ts'])
    );
    const all = files.flatMap((file) => specifiers(readFileSync(file, 'utf8')));
    // And it parses their imports: relative ones within core, and packages.
    expect(all.filter((specifier) => specifier.startsWith('./')).length).toBeGreaterThan(20);
    expect(all).toContain('@dbos-inc/dbos-sdk');
    const violations = files.flatMap((file) =>
      coreBoundaryViolations(CORE, file, readFileSync(file, 'utf8'))
    );
    expect(violations).toEqual([]);
  });

  it('names every import that leaves src/core/ (negative controls)', () => {
    const file = path.join(CORE, 'runner.ts');
    const nested = path.join(CORE, 'test-support', 'fakes.ts');
    const crossing = [
      `import type { VerifiedGrant } from '../tokens';`,
      `import {\n  RunGrants,\n} from '../grants';`,
      `export * from '../minter';`,
      `export { x } from "../app-assistant/provider";`,
      `const m = await import('../orchestration');`,
      `const c = require('../config');`,
      `import '../server';`,
    ];
    for (const source of crossing)
      expect(coreBoundaryViolations(CORE, file, source), source).toHaveLength(1);
    expect(coreBoundaryViolations(CORE, nested, `import x from '../../tokens';`)).toEqual([
      `core-boundary: test-support/fakes.ts imports '../../tokens', outside src/core/`,
    ]);
    expect(
      coreBoundaryViolations(CORE, file, `import { x } from '@civitai/app-assistant';`)
    ).toEqual([
      `core-boundary: runner.ts imports package '@civitai/app-assistant', not one of core's dependencies`,
    ]);
    expect(coreBoundaryViolations(CORE, file, `import { jwtVerify } from 'jose';`)).toHaveLength(1);
  });

  it('lets core import itself, node built-ins and its own packages', () => {
    const file = path.join(CORE, 'test-support', 'fakes.ts');
    const fine = [
      `import type { ToolProvider } from '../interfaces';`,
      `import { runIdFor } from '../run-ids';`,
      `import { scriptedModel } from './scripted-model';`,
      `import { createHash } from 'node:crypto';`,
      `import { MockLanguageModelV3 } from 'ai/test';`,
      `import type { TurnPart } from '@civitai/components-chat/core';`,
      // Not imports: SQL in a template string, and a comment.
      'const q = `select 1 from "${SCHEMA}".streams`;',
      `// moved from '../tokens'`,
    ];
    for (const source of fine)
      expect(coreBoundaryViolations(CORE, file, source), source).toEqual([]);
  });
});

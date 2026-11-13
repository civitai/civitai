import { readdirSync, readFileSync } from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

import {
  BlockManifestValidator,
  manifestSurfaceError,
} from '~/server/services/block-manifest-validator.service';
import {
  schemaAccepts,
  type Schema,
} from '~/server/services/blocks/__tests__/json-schema-subset.fixture';
import { TokenScope } from '~/shared/constants/token-scope.constants';

/**
 * The surface rule: a manifest must declare a non-empty `targets` array or a `page` object. The
 * build pipeline's manifest check refuses a manifest with neither, on every build, so the platform
 * refuses it at submission (every submission path calls `validateSubmission`) and the canonical
 * schema states it.
 */

const REPO_ROOT = path.resolve(__dirname, '../../../..');

/** The refusal, spelled as a literal. */
const NO_SURFACE =
  'manifest must declare at least one surface: add a "page" object for a full-page app ' +
  '(e.g. "page": { "path": "/", "title": "My App" }), or a non-empty "targets" array for a ' +
  'model-page slot app (e.g. "targets": [{ "slotId": "model.sidebar_top" }])';

/**
 * A deliberate hand copy of the build pipeline's surface test (its validate-manifest step, in the
 * build pipeline repo). Drift on the pipeline side is not detected here.
 */
function pipelineSurfaceOk(m: Record<string, unknown>): boolean {
  const hasTargets = Array.isArray(m.targets) && m.targets.length > 0;
  const hasPage = !!m.page && typeof m.page === 'object' && !Array.isArray(m.page);
  return hasTargets || hasPage;
}

const SLOT = { slotId: 'model.sidebar_top' };
const PAGE = { path: '/', title: 'T' };

/** [case, the manifest's surface keys, declares a surface] */
const CASES: Array<[string, Record<string, unknown>, boolean]> = [
  ['neither key', {}, false],
  ['an empty targets array', { targets: [] }, false],
  ['a null page', { page: null }, false],
  ['an array page', { page: [] }, false],
  ['a string page', { page: '/' }, false],
  ['a string targets', { targets: 'model.sidebar_top' }, false],
  ['an empty targets array and a null page', { targets: [], page: null }, false],
  ['one target', { targets: [SLOT] }, true],
  ['a page', { page: PAGE }, true],
  ['an empty page object', { page: {} }, true],
  ['an empty targets array and a page', { targets: [], page: PAGE }, true],
  ['targets and a page', { targets: [SLOT], page: PAGE }, true],
];

describe('manifestSurfaceError', () => {
  it.each(CASES)('%s', (_case, keys, declares) => {
    expect(manifestSurfaceError(keys)).toBe(declares ? null : NO_SURFACE);
  });

  it.each(CASES)('agrees with the build pipeline: %s', (_case, keys, declares) => {
    expect(pipelineSurfaceOk(keys)).toBe(declares);
    expect(manifestSurfaceError(keys) === null).toBe(pipelineSurfaceOk(keys));
  });

  it('leaves a non-object manifest to validate, which refuses it first', () => {
    expect(manifestSurfaceError(null)).toBeNull();
    expect(manifestSurfaceError([])).toBeNull();
  });
});

describe('validateSubmission — the surface rule', () => {
  const APP_CTX = {
    allowedScopes: TokenScope.ModelsRead,
    allowedOrigins: ['https://blocks.civitai.com'],
  };
  const BASE = {
    blockId: 'test-block',
    version: '1.0.0',
    name: 'Test Block',
    contentRating: 'g',
    trustTier: 'unverified',
    scopes: ['models:read:self'],
    iframe: {
      src: 'https://blocks.civitai.com/test',
      minHeight: 200,
      maxHeight: null,
      resizable: true,
      sandbox: 'allow-scripts',
    },
  };

  it('refuses a manifest with no surface, with exactly the surface error', async () => {
    expect(await BlockManifestValidator.validateSubmission(BASE, APP_CTX)).toEqual({
      valid: false,
      errors: [NO_SURFACE],
    });
  });

  it('refuses it in the approve and push contexts too (no option relaxes it)', async () => {
    const result = await BlockManifestValidator.validateSubmission(BASE, APP_CTX, {
      enforceSensitiveScopeJustification: false,
      strictIssueTrackerLink: false,
    });
    expect(result).toEqual({ valid: false, errors: [NO_SURFACE] });
  });

  it.each<[string, Record<string, unknown>]>([
    ['a page app', { page: { path: '/', title: 'Test Block' } }],
    ['a slot app', { targets: [SLOT] }],
  ])('accepts %s', async (_case, keys) => {
    expect(await BlockManifestValidator.validateSubmission({ ...BASE, ...keys }, APP_CTX)).toEqual({
      valid: true,
    });
  });

  it('reports a bad page shape AND the missing surface', async () => {
    const result = await BlockManifestValidator.validateSubmission(
      { ...BASE, page: null },
      APP_CTX
    );
    expect(result).toEqual({ valid: false, errors: ['page must be an object', NO_SURFACE] });
  });
});

describe('the canonical schema states the surface rule', () => {
  const schema = JSON.parse(
    readFileSync(path.join(REPO_ROOT, 'public/schemas/app-block/v1.json'), 'utf8')
  ) as {
    allOf: Array<Record<string, unknown>>;
    properties: { targets: { type: string }; page: { type: string } };
  };
  const surfaceClauses = schema.allOf.filter((c) => 'anyOf' in c);

  it('in exactly one top-level allOf clause', () => {
    expect(surfaceClauses).toHaveLength(1);
  });

  // Evaluated together with the schema's own `type` for targets and page, which is what refuses
  // a string `targets` or a null `page` there.
  it.each(CASES)('%s', (_case, keys, declares) => {
    const evaluated: Schema = {
      type: 'object',
      properties: {
        targets: { type: schema.properties.targets.type },
        page: { type: schema.properties.page.type },
      },
      allOf: surfaceClauses,
    };
    expect(schemaAccepts(evaluated, keys)).toBe(declares);
  });
});

/**
 * `validate` skips the surface rule; `validateSubmission` adds it. So a production path that called
 * `validate` directly would accept a manifest the build refuses. Its only production caller must
 * stay `validateSubmission`.
 */
describe('every production caller goes through validateSubmission', () => {
  function sourceFiles(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
      const p = path.join(dir, e.name);
      if (e.isDirectory())
        return e.name === '__tests__' || e.name === 'tests' ? [] : sourceFiles(p);
      return /\.(ts|tsx)$/.test(e.name) && !/\.(test|spec|stories)\.tsx?$/.test(e.name) ? [p] : [];
    });
  }

  it('BlockManifestValidator.validate( is called only inside validateSubmission', () => {
    const files = sourceFiles(path.join(REPO_ROOT, 'src'));
    // POSITIVE CONTROL: the walk reaches the validator and a known submission caller.
    const rel = files.map((f) => path.relative(REPO_ROOT, f));
    expect(rel).toContain('src/server/services/block-manifest-validator.service.ts');
    expect(rel).toContain('src/pages/api/internal/blocks/git-push.ts');

    const direct = files.filter((f) =>
      /BlockManifestValidator\s*\.\s*validate\s*\(/.test(readFileSync(f, 'utf8'))
    );
    expect(direct.map((f) => path.relative(REPO_ROOT, f))).toEqual([]);

    const validator = readFileSync(
      path.join(REPO_ROOT, 'src/server/services/block-manifest-validator.service.ts'),
      'utf8'
    );
    expect(validator.match(/this\.validate\(/g)).toHaveLength(1);
    const submission = validator.slice(validator.indexOf('static async validateSubmission('));
    expect(submission).toContain('this.validate(manifest, app, opts)');
    expect(submission).toContain('manifestSurfaceError(manifest)');
  });
});

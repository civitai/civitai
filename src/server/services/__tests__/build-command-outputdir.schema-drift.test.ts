import { readFileSync } from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

import {
  BlockManifestValidator,
  BUILD_COMMAND_MAX_LENGTH,
  BUILD_COMMAND_RE,
} from '../block-manifest-validator.service';
import { TokenScope } from '~/shared/constants/token-scope.constants';

/**
 * Drift guard (App Blocks config-as-code: buildCommand + outputDir).
 *
 * The canonical published manifest schema at `public/schemas/app-block/v1.json`
 * is the SOURCE OF TRUTH that the `civitai` CLI's vendored copy + the
 * `civitai-app-starters` SDK mirror byte-for-byte, and that editor validation
 * compiles + evaluates (santhosh-tekuri/jsonschema, RE2) client-side. The
 * imperative server validator `block-manifest-validator.service.ts` is the
 * RUNTIME enforcer. If the two drift, `civitai app validate` green-lights
 * buildCommands / outputDirs the server later rejects.
 *
 * This guard fails loudly if they diverge, on TWO axes:
 *   1. Structural — the schema's buildCommand.pattern / maxLength are pinned to
 *      the validator's exported BUILD_COMMAND_RE / BUILD_COMMAND_MAX_LENGTH, and
 *      outputDir is expressed as an allOf of four `not.pattern` traversal gates.
 *   2. Behavioral parity — for a table of buildCommand + outputDir values, the
 *      SCHEMA verdict (evaluating just that property's pattern/maxLength) equals
 *      the VALIDATOR's field verdict.
 *
 * One INTENTIONAL divergence: the validator additionally rejects a NUL byte in
 * outputDir; that impossible-in-a-manifest-string case is omitted from the
 * schema for RE2 regex portability, so it is not exercised here.
 */
const REPO_ROOT = path.resolve(__dirname, '../../../..');
const SCHEMA_PATH = path.join(REPO_ROOT, 'public/schemas/app-block/v1.json');

type OutputDirClause = { not: { pattern: string } };
const schema = JSON.parse(readFileSync(SCHEMA_PATH, 'utf8')) as {
  properties: {
    buildCommand: { type: string; minLength: number; maxLength: number; pattern: string };
    outputDir: { type: string; minLength: number; maxLength: number; allOf: OutputDirClause[] };
  };
};

// Reused from block-manifest-validator.service.test.ts — an otherwise-valid
// manifest + an AppContext whose allowedOrigins covers the iframe.src origin, so
// only the field under test can produce an error.
const VALID_MANIFEST = {
  blockId: 'test-block',
  version: '1.0.0',
  name: 'Test Block',
  contentRating: 'g',
  renderMode: 'iframe',
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
const APP_CTX = {
  allowedScopes: TokenScope.ModelsRead,
  allowedOrigins: ['https://blocks.civitai.com'],
};

describe('app-block v1 schema ⇄ block-manifest-validator drift guard (buildCommand + outputDir)', () => {
  // ---- Structural assertions --------------------------------------------
  it('pins buildCommand.pattern + maxLength to the validator consts', () => {
    expect(schema.properties.buildCommand.pattern).toBe(BUILD_COMMAND_RE.source);
    expect(schema.properties.buildCommand.maxLength).toBe(BUILD_COMMAND_MAX_LENGTH);
    expect(schema.properties.buildCommand.minLength).toBe(1);
  });

  it('expresses outputDir as an allOf of four not.pattern traversal gates', () => {
    const allOf = schema.properties.outputDir.allOf;
    expect(Array.isArray(allOf)).toBe(true);
    expect(allOf).toHaveLength(4);
    for (const clause of allOf) {
      expect(typeof clause.not.pattern).toBe('string');
      // each pattern must compile to a valid regex
      expect(() => new RegExp(clause.not.pattern)).not.toThrow();
    }
  });

  // ---- Behavioral parity: buildCommand ----------------------------------
  const schemaAcceptsBuildCommand = (value: string): boolean => {
    const { pattern, maxLength, minLength } = schema.properties.buildCommand;
    return value.length >= minLength && value.length <= maxLength && new RegExp(pattern).test(value);
  };
  const validatorAcceptsBuildCommand = (value: string): boolean => {
    const result = BlockManifestValidator.validate({ ...VALID_MANIFEST, buildCommand: value }, APP_CTX);
    return result.valid || !result.errors.some((e) => e.includes('buildCommand'));
  };

  const BUILD_COMMAND_CASES: Array<[string, boolean]> = [
    // accept
    ['npm run build', true],
    ['pnpm run build', true],
    ['yarn run test:e2e', true],
    ['vite build', true],
    ['npx vite build', true],
    ['npm run a_b-c:d', true],
    // reject
    ['make all', false],
    ['npm run build && rm -rf /', false],
    ['bash -c x', false],
    ['vite build --watch', false],
    ['npm install', false],
    ['npx vite build --mode x', false],
    ['npm run ', false], // trailing space
    ['npm  run build', false], // double space
    ['yarn build', false],
    ['x'.repeat(129), false], // over maxLength
  ];

  it.each(BUILD_COMMAND_CASES)('buildCommand %j → schema/validator agree (accept=%s)', (value, expected) => {
    expect(schemaAcceptsBuildCommand(value)).toBe(expected);
    expect(validatorAcceptsBuildCommand(value)).toBe(expected);
    expect(schemaAcceptsBuildCommand(value)).toBe(validatorAcceptsBuildCommand(value));
  });

  // ---- Behavioral parity: outputDir -------------------------------------
  const schemaAcceptsOutputDir = (value: string): boolean => {
    const { allOf, maxLength, minLength } = schema.properties.outputDir;
    if (value.length < minLength || value.length > maxLength) return false;
    return !allOf.some((clause) => new RegExp(clause.not.pattern).test(value));
  };
  const validatorAcceptsOutputDir = (value: string): boolean => {
    // outputDir is only validated meaningfully alongside a buildCommand; use a
    // valid one so no unrelated buildCommand error fires.
    const result = BlockManifestValidator.validate(
      { ...VALID_MANIFEST, buildCommand: 'npm run build', outputDir: value },
      APP_CTX
    );
    return result.valid || !result.errors.some((e) => e.includes('outputDir'));
  };

  const OUTPUT_DIR_CASES: Array<[string, boolean]> = [
    // accept
    ['dist', true],
    ['build/out', true],
    ['packages/app/dist', true],
    ['a.b..c', true], // '..' not on a segment boundary → safe
    // reject
    ['/abs', false], // leading '/'
    ['../escape', false], // '..' segment at start
    ['a/../b', false], // '..' segment in the middle
    ['..', false], // bare '..'
    ['a/..', false], // '..' segment at end
    ['dist\\x', false], // backslash separator
    ['C:\\proj', false], // Windows drive + backslash
    ['c:foo', false], // Windows drive prefix
  ];

  it.each(OUTPUT_DIR_CASES)('outputDir %j → schema/validator agree (accept=%s)', (value, expected) => {
    expect(schemaAcceptsOutputDir(value)).toBe(expected);
    expect(validatorAcceptsOutputDir(value)).toBe(expected);
    expect(schemaAcceptsOutputDir(value)).toBe(validatorAcceptsOutputDir(value));
  });
});

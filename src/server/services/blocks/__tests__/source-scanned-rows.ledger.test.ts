import fs from 'fs';
import path from 'path';
import ts from 'typescript';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `app-block-source-scanned-rows` is evaluated PER APP, and three surfaces must agree about it for
 * one app: the host's path query (`blockImageUpload.generationSourceUsesScannedRows`), the copy's
 * guard (`blocks.persistUploadedGenerationSource`) and the generation gate
 * (`assertGenerationInputsUsable`, `countAppBlockHostSources`). If the picker thinks ON while the
 * gate thinks OFF (or the reverse) for the same app, a pick is copied for nothing, or a blob is
 * handed back that the gate then refuses.
 *
 * What makes them agree: ONE resolver (`appUsesScannedSourceRows`), each surface passing it the
 * app block id from the same place (the block token's `appBlockId` claim). This file pins that
 * RELATIONSHIP, not one surface:
 *   1. no production module names the flag except its definition and the resolver, so nothing
 *      can read it a second way (another entity, no entity, a context);
 *   2. the resolver's call sites are exactly the ledger below, each with the argument it passes.
 *      The ledger fails when the set GROWS or SHRINKS, and when an argument changes;
 *   3. the resolver itself evaluates the flag for the app, and answers OFF with no app id.
 *
 * Read by AST, so a comment or a string that merely names the flag never counts.
 */

const SRC = path.join(process.cwd(), 'src');
const FLAG_KEY = 'APP_BLOCK_SOURCE_SCANNED_ROWS';
const FLAG_NAME = 'app-block-source-scanned-rows';
const RESOLVER = 'appUsesScannedSourceRows';
const RESOLVER_MODULE = 'src/server/services/blocks/source-scanned-rows.ts';
const DEFINITION_MODULE = 'src/server/flipt/client.ts';

/** Every production call of the resolver: file → the argument text of each call, in order. */
const CALL_LEDGER: Record<string, string[]> = {
  // The host's path query: the token it sends, verified by authorizeBlockBridgeToken.
  'src/server/routers/block-image-upload.router.ts': ['claims.appBlockId'],
  // persistUploadedGenerationSource's guard: the same verification of the same token.
  'src/server/routers/blocks.router.ts': ['claims.appBlockId'],
  // countAppBlockHostSources, then the gate. Every App Blocks entry's `appBlockLog` is built from
  // `claims.appBlockId` by its caller; the type makes it required for those entries.
  'src/server/services/generation-input-urls.ts': [
    'appBlockLog.appBlockId',
    'appBlockLog?.appBlockId',
  ],
};

const isTest = (rel: string) =>
  rel.includes(`${path.sep}__tests__${path.sep}`) || /\.test\.tsx?$/.test(rel);

function productionSources(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules') continue;
        walk(full);
      } else if (/\.tsx?$/.test(entry.name) && !/\.d\.ts$/.test(entry.name)) {
        const rel = path.relative(process.cwd(), full);
        if (!isTest(rel)) out.push(rel);
      }
    }
  };
  walk(SRC);
  return out;
}

type Found = { flagRefs: number; calls: string[] };

function scan(rel: string, text: string): Found {
  const sf = ts.createSourceFile(rel, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const found: Found = { flagRefs: 0, calls: [] };
  const visit = (node: ts.Node) => {
    if (ts.isIdentifier(node) && node.text === FLAG_KEY) found.flagRefs++;
    if (
      (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) &&
      node.text === FLAG_NAME
    )
      found.flagRefs++;
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === RESOLVER
    )
      found.calls.push(node.arguments.map((a) => a.getText(sf)).join(', '));
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return found;
}

function scanAll() {
  const flagFiles: Record<string, number> = {};
  const calls: Record<string, string[]> = {};
  for (const rel of productionSources()) {
    const text = fs.readFileSync(rel, 'utf8');
    if (!text.includes(FLAG_KEY) && !text.includes(FLAG_NAME) && !text.includes(RESOLVER)) continue;
    const found = scan(rel, text);
    if (found.flagRefs) flagFiles[rel] = found.flagRefs;
    if (found.calls.length) calls[rel] = found.calls;
  }
  return { flagFiles, calls };
}

describe('app-block-source-scanned-rows: one read, per app, at every surface', () => {
  const { flagFiles, calls } = scanAll();

  it('control: the scan sees the flag in a source written to name it, and the resolver call in it', () => {
    const found = scan(
      'control.ts',
      [
        '// app-block-source-scanned-rows in a comment does not count',
        "const s = 'app-block-source-scanned-rows';",
        'isFlipt(FLIPT_FEATURE_FLAGS.APP_BLOCK_SOURCE_SCANNED_ROWS);',
        'appUsesScannedSourceRows(claims.appBlockId);',
      ].join('\n')
    );
    expect(found).toEqual({ flagRefs: 2, calls: ['claims.appBlockId'] });
  });

  it('🔴 no production module names the flag but its definition and the resolver', () => {
    expect(Object.keys(flagFiles).sort()).toEqual([DEFINITION_MODULE, RESOLVER_MODULE].sort());
  });

  it('🔴 the resolver is called exactly where the ledger says, with the app id the ledger names', () => {
    expect(calls).toEqual(CALL_LEDGER);
  });
});

const h = vi.hoisted(() => ({ isFlipt: vi.fn() }));
vi.mock('~/server/flipt/client', () => ({
  FLIPT_FEATURE_FLAGS: { APP_BLOCK_SOURCE_SCANNED_ROWS: 'app-block-source-scanned-rows' },
  isFlipt: async (...a: unknown[]) => h.isFlipt(...a),
  isFliptSync: (...a: unknown[]) => h.isFlipt(...a),
  readFliptBoolean: async (...a: unknown[]) => h.isFlipt(...a),
  ensureFliptInitialized: async () => undefined,
}));

describe('appUsesScannedSourceRows', () => {
  beforeEach(() => {
    h.isFlipt.mockReset();
    h.isFlipt.mockImplementation((_flag: string, entityId?: string) => entityId === 'apb_a');
  });

  it('🔴 evaluates the flag for the app: entity = the app block id, no context', async () => {
    const { appUsesScannedSourceRows } = await import('../source-scanned-rows');
    expect(await appUsesScannedSourceRows('apb_a')).toBe(true);
    expect(await appUsesScannedSourceRows('apb_b')).toBe(false);
    expect(h.isFlipt.mock.calls).toEqual([
      ['app-block-source-scanned-rows', 'apb_a'],
      ['app-block-source-scanned-rows', 'apb_b'],
    ]);
  });

  it.each([undefined, null, ''])('no app id (%s) answers OFF without asking Flipt', async (id) => {
    h.isFlipt.mockReturnValue(true);
    const { appUsesScannedSourceRows } = await import('../source-scanned-rows');
    expect(await appUsesScannedSourceRows(id)).toBe(false);
    expect(h.isFlipt).not.toHaveBeenCalled();
  });
  it('🔴 a flag that cannot be evaluated answers ON', async () => {
    h.isFlipt.mockReturnValue(null);
    const { appUsesScannedSourceRows } = await import('../source-scanned-rows');
    expect(await appUsesScannedSourceRows('apb_a')).toBe(true);
  });
});

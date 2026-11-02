import { describe, expect, it } from 'vitest';
import { BlockManifestValidator } from '../block-manifest-validator.service';
import { TokenScope } from '~/shared/constants/token-scope.constants';

/**
 * Cross-app storage IMPORTS (`storage.imports`, `exportable`, `apps:storage:import`) through the
 * REAL submit-time validator. Same rules as `block-manifest-validator.storage.test.ts`: only the
 * validator is imported and every expected message is a literal, so a tree without the rule
 * refuses (unknown scope / unknown key) or accepts where this file expects the other.
 */

const BASE = {
  blockId: 'notes-fork',
  version: '1.0.0',
  name: 'Notes Fork',
  contentRating: 'g',
  renderMode: 'iframe',
  trustTier: 'unverified',
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

const STORAGE = 'apps:storage';
const IMPORT = 'apps:storage:import';
const JUSTIFIED = { [IMPORT]: 'Reads and updates your notes from the original Notes app.' };

const manifest = (storage: unknown, scopes: string[], extra: Record<string, unknown> = {}) => ({
  ...BASE,
  scopes: ['models:read:self', ...scopes],
  ...(storage === undefined ? {} : { storage }),
  ...extra,
});
const validate = (m: unknown) => BlockManifestValidator.validate(m, APP_CTX);
const refused = (...errors: string[]) => ({ valid: false, errors });

const NOTES_IMPORT = { from: 'notes-app', collections: ['notes', 'prefs'], access: 'readwrite' };

describe('manifest storage imports — accepted', () => {
  it.each<[string, unknown]>([
    [
      'an import-only app (no collections of its own)',
      manifest({ imports: [NOTES_IMPORT] }, [STORAGE, IMPORT], {
        scopeJustifications: JUSTIFIED,
      }),
    ],
    [
      'own collections plus a read-only import',
      manifest(
        {
          collections: { prefs: { visibility: 'private' } },
          imports: [{ from: 'notes-app', collections: ['notes'], access: 'read' }],
        },
        [STORAGE, IMPORT],
        { scopeJustifications: JUSTIFIED }
      ),
    ],
    [
      '8 imports, one collection list of 16',
      manifest(
        {
          imports: Array.from({ length: 8 }, (_, i) => ({
            from: `source-app-${i}`,
            collections: i === 0 ? Array.from({ length: 16 }, (_, c) => `c${c}`) : ['notes'],
            access: 'read',
          })),
        },
        [STORAGE, IMPORT],
        { scopeJustifications: JUSTIFIED }
      ),
    ],
    [
      'a collection opting out with exportable false',
      manifest({ collections: { prefs: { visibility: 'private', exportable: false } } }, [STORAGE]),
    ],
    [
      'exportable true on a shared collection',
      manifest(
        {
          collections: {
            plays: { visibility: 'shared', write: 'none', counters: ['plays'], exportable: true },
          },
        },
        [STORAGE]
      ),
    ],
  ])('%s', (_label, m) => {
    expect(validate(m)).toEqual({ valid: true, errors: [] });
  });
});

describe('manifest storage imports — refused shapes', () => {
  const withImports = (imports: unknown) =>
    manifest({ imports }, [STORAGE, IMPORT], { scopeJustifications: JUSTIFIED });

  it.each<[string, unknown, string]>([
    [
      'imports not an array',
      { from: 'notes-app' },
      'storage.imports must be an array of { from, collections, access }',
    ],
    ['an empty imports list', [], 'storage.imports must declare at least one import (or omit it)'],
    [
      '9 imports',
      Array.from({ length: 9 }, (_, i) => ({
        from: `source-app-${i}`,
        collections: ['n'],
        access: 'read',
      })),
      'storage.imports may declare at most 8 imports (found 9)',
    ],
    [
      'a from that is not a blockId',
      [{ ...NOTES_IMPORT, from: 'Notes_App' }],
      "storage.imports[0].from must be the source app's blockId: 3 to 40 of a-z, 0-9 or -, starting with a letter",
    ],
    [
      'an import from the app itself',
      [{ ...NOTES_IMPORT, from: 'notes-fork' }],
      'storage.imports[0].from names this app itself — declare its collections instead',
    ],
    [
      'two imports from one app',
      [NOTES_IMPORT, { ...NOTES_IMPORT, collections: ['other'] }],
      'storage.imports[1] imports from "notes-app" again — declare one import per app',
    ],
    [
      'an unknown access',
      [{ ...NOTES_IMPORT, access: 'write' }],
      'storage.imports[0].access is required and must be one of read, readwrite',
    ],
    [
      'no collections',
      [{ ...NOTES_IMPORT, collections: [] }],
      'storage.imports[0].collections must be a non-empty array of collection names',
    ],
    [
      '17 collections',
      [{ ...NOTES_IMPORT, collections: Array.from({ length: 17 }, (_, c) => `c${c}`) }],
      'storage.imports[0].collections may name at most 16 collections (found 17)',
    ],
    [
      'a duplicated collection',
      [{ ...NOTES_IMPORT, collections: ['notes', 'notes'] }],
      'storage.imports[0].collections[1] duplicates an earlier collection ("notes")',
    ],
    ['an unknown key', [{ ...NOTES_IMPORT, mode: 'x' }], 'storage.imports[0].mode is not allowed'],
  ])('%s', (_label, imports, error) => {
    expect(validate(withImports(imports))).toEqual(refused(error));
  });

  it('exportable must be a boolean', () => {
    expect(
      validate(
        manifest({ collections: { prefs: { visibility: 'private', exportable: 'no' } } }, [STORAGE])
      )
    ).toEqual(refused('storage.collections.prefs.exportable must be a boolean'));
  });
});

describe('manifest storage imports — scope rules', () => {
  it('declaring an import requires apps:storage:import', () => {
    expect(validate(manifest({ imports: [NOTES_IMPORT] }, [STORAGE]))).toEqual(
      refused(
        'storage imports from notes-app, which requires the apps:storage:import scope — add it to scopes with a scopeJustifications entry'
      )
    );
  });

  it('an import-only app still requires apps:storage', () => {
    expect(
      validate(manifest({ imports: [NOTES_IMPORT] }, [IMPORT], { scopeJustifications: JUSTIFIED }))
    ).toEqual(
      refused(
        'storage imports from notes-app but scopes does not include apps:storage — add it, or remove storage'
      )
    );
  });

  it('apps:storage:import with no imports is refused', () => {
    expect(
      validate(
        manifest({ collections: { prefs: { visibility: 'private' } } }, [STORAGE, IMPORT], {
          scopeJustifications: JUSTIFIED,
        })
      )
    ).toEqual(
      refused(
        'scopes includes apps:storage:import but storage declares no imports — declare them under storage.imports, or remove the scope'
      )
    );
  });

  it('apps:storage:import is sensitive: it needs a justification', () => {
    expect(validate(manifest({ imports: [NOTES_IMPORT] }, [STORAGE, IMPORT]))).toEqual(
      refused(
        'sensitive scopes require a justification — add a non-empty scopeJustifications entry for: apps:storage:import'
      )
    );
  });
});

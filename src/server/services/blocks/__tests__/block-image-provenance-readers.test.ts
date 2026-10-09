import fs from 'fs';
import path from 'path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

/**
 * EVERY site in `src/` that names an App Blocks provenance key — by constant (aliases included),
 * string or template literal, or as a property/binding name — by owning declaration, with the role
 * it plays. Derived from the AST (comments cannot count), compared as a SET in both
 * directions, so adding or removing a reader fails here whether or not its author knew this file
 * existed.
 *
 * 🔴 THE PROPERTY IT EXISTS FOR: `blockUploadedAppId` (an app's own `bytes` upload) is accepted
 * by POST readers, which bind the row to its owner, and by NOTHING that reads cross-user. A
 * gated read that accepted it would let an app read every viewer's uploads. The behaviour of the
 * two live readers is pinned against real SQL in `block-image-provenance.behavior.test.ts`; this
 * file pins that there are no others.
 */

const REPO_ROOT = path.resolve(__dirname, '../../../../..');
const SRC = path.join(REPO_ROOT, 'src');

const PUBLISHED = 'BLOCK_PUBLISHED_APP_ID_META_KEY';
const UPLOADED = 'BLOCK_UPLOADED_APP_ID_META_KEY';
const POSTABLE = 'BLOCK_POSTABLE_APP_ID_META_KEYS';
const POST_MARKER = 'BLOCK_POST_APP_ID_META_KEY';
const KEY_IDENTIFIERS = new Set([PUBLISHED, UPLOADED, POSTABLE, POST_MARKER]);
const KEY_LITERALS = new Set(['blockPublishedAppId', 'blockUploadedAppId']);

type Role =
  /** Declares a key constant. */
  | 'declaration'
  /** Stamps a key onto a row it creates. */
  | 'writer'
  /** Reads Image provenance to decide what an app may POST — bound to the image's owner. */
  | 'post-reader'
  /** Reads Image provenance for the CROSS-USER gated read. */
  | 'gated-reader'
  /** `Post.metadata` attribution (a different table), never Image provenance. */
  | 'post-attribution';

const LEDGER: Readonly<Record<string, Role>> = Object.freeze({
  'src/server/services/blocks/block-image-upload.service.ts#BLOCK_PUBLISHED_APP_ID_META_KEY':
    'declaration',
  'src/server/services/blocks/block-image-upload.service.ts#BLOCK_UPLOADED_APP_ID_META_KEY':
    'declaration',
  'src/server/services/blocks/block-image-upload.service.ts#BLOCK_POSTABLE_APP_ID_META_KEYS':
    'declaration',
  'src/server/services/blocks/block-image-upload.service.ts#persistBlockUploadImage': 'writer',
  'src/server/services/blocks/block-image-upload.service.ts#persistBlockWorkflowOutputImage':
    'writer',
  'src/server/services/blocks/block-post.service.ts#resolveAppPublishedImages': 'post-reader',
  'src/server/services/blocks/block-post.service.ts#adoptImagesIntoPost': 'post-reader',
  'src/server/services/blocks/block-gated-images.service.ts#getBlockGatedImagesByIds':
    'gated-reader',
  'src/server/services/blocks/block-post.logic.ts#BLOCK_POST_APP_ID_META_KEY': 'declaration',
  'src/server/services/blocks/block-post.service.ts#writeBlockPost': 'post-attribution',
  'src/server/services/blocks/post-app-chip.logic.ts#readBlockPublishedAppId': 'post-attribution',
});

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === '__tests__' || entry.name === 'node_modules') continue;
      sourceFiles(full, out);
    } else if (
      /\.(ts|tsx)$/.test(entry.name) &&
      !/\.test\.tsx?$/.test(entry.name) &&
      !entry.name.endsWith('.d.ts')
    ) {
      out.push(full);
    }
  }
  return out;
}

/** The nearest named function, or the module-level `const` the node sits in. */
function ownerName(node: ts.Node): string {
  for (let n: ts.Node | undefined = node.parent; n; n = n.parent) {
    if ((ts.isFunctionDeclaration(n) || ts.isMethodDeclaration(n)) && n.name) {
      return n.name.getText();
    }
    if (
      ts.isVariableDeclaration(n) &&
      ts.isIdentifier(n.name) &&
      ts.isSourceFile(n.parent.parent.parent)
    ) {
      return n.name.text;
    }
  }
  return '<module>';
}

/** Site → the key tokens it names, outside imports/re-exports (wiring, not use). */
function deriveSites(files: Array<{ rel: string; text: string }>): Map<string, Set<string>> {
  const sites = new Map<string, Set<string>>();
  for (const { rel, text } of files) {
    if (![...KEY_IDENTIFIERS, ...KEY_LITERALS].some((k) => text.includes(k))) continue;
    const source = ts.createSourceFile(rel, text, ts.ScriptTarget.Latest, true);
    // `import { BLOCK_UPLOADED_APP_ID_META_KEY as K }` — later uses of `K` are uses of the key.
    const aliases = new Map<string, string>();
    const collectAliases = (node: ts.Node): void => {
      if (
        ts.isImportSpecifier(node) &&
        node.propertyName &&
        KEY_IDENTIFIERS.has(node.propertyName.text)
      ) {
        aliases.set(node.name.text, node.propertyName.text);
      }
      ts.forEachChild(node, collectAliases);
    };
    collectAliases(source);
    const visit = (node: ts.Node): void => {
      let token: string | null = null;
      if (ts.isIdentifier(node)) {
        const p = node.parent;
        const wiring =
          ts.isImportSpecifier(p) ||
          ts.isExportSpecifier(p) ||
          ts.isImportClause(p) ||
          ts.isNamespaceImport(p);
        if (KEY_IDENTIFIERS.has(node.text) && !wiring) token = node.text;
        else if (aliases.has(node.text) && !wiring) token = aliases.get(node.text) ?? null;
        // A property access, binding or shorthand spelled as the key itself
        // (`meta.blockUploadedAppId`, `const { blockUploadedAppId } = meta`) reads it too.
        else if (KEY_LITERALS.has(node.text)) token = `'${node.text}'`;
      } else if (ts.isStringLiteral(node) || ts.isTemplateLiteralToken(node)) {
        // `includes`, not equality: a raw SQL template can spell the key inside a larger string
        // (`metadata->>'blockUploadedAppId'`), and that is a reader too.
        const spelled = [...KEY_LITERALS].find((k) => node.text.includes(k));
        if (spelled) token = `'${spelled}'`;
      }
      if (token) {
        const key = `${rel}#${ownerName(node)}`;
        const set = sites.get(key) ?? new Set<string>();
        set.add(token);
        sites.set(key, set);
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return sites;
}

const sites = deriveSites(
  sourceFiles(SRC).map((file) => ({
    rel: path.relative(REPO_ROOT, file).split(path.sep).join('/'),
    text: fs.readFileSync(file, 'utf8'),
  }))
);

describe('App Blocks image provenance-key sites', () => {
  it('the derivation can see a site at all (positive control)', () => {
    expect(sites.size).toBeGreaterThanOrEqual(8);
    expect(
      sites.get('src/server/services/blocks/block-post.service.ts#resolveAppPublishedImages')
    ).toBeDefined();
  });

  it('ledgers EXACTLY the sites that name a key — a new or removed reader fails here', () => {
    expect([...sites.keys()].sort()).toEqual(Object.keys(LEDGER).sort());
  });

  it('every POST reader accepts the uploaded key (directly or through the postable set)', () => {
    const postReaders = Object.entries(LEDGER).filter(([, r]) => r === 'post-reader');
    expect(postReaders.length).toBe(2);
    for (const [site] of postReaders) {
      const tokens = sites.get(site) ?? new Set();
      const acceptsUploaded = tokens.has(UPLOADED) || tokens.has(POSTABLE);
      const acceptsPublished = tokens.has(PUBLISHED) || tokens.has(POSTABLE);
      expect({ site, acceptsUploaded, acceptsPublished }).toEqual({
        site,
        acceptsUploaded: true,
        acceptsPublished: true,
      });
    }
  });

  it('🔴 the GATED reader names the published key and nothing that could admit an upload', () => {
    const gated = Object.entries(LEDGER).filter(([, r]) => r === 'gated-reader');
    expect(gated.length).toBe(1);
    for (const [site] of gated) {
      expect([...(sites.get(site) ?? [])].sort()).toEqual([PUBLISHED]);
    }
  });

  it('only the bytes-upload writer stamps the uploaded key', () => {
    const stampers = [...sites.entries()]
      .filter(([site, tokens]) => LEDGER[site] === 'writer' && tokens.has(UPLOADED))
      .map(([site]) => site);
    expect(stampers).toEqual([
      'src/server/services/blocks/block-image-upload.service.ts#persistBlockUploadImage',
    ]);
  });

  it('the uploaded key is spelled once, in its declaration', () => {
    const spelled = [...sites.entries()]
      .filter(([, tokens]) => tokens.has("'blockUploadedAppId'"))
      .map(([site]) => site);
    expect(spelled).toEqual([
      'src/server/services/blocks/block-image-upload.service.ts#BLOCK_UPLOADED_APP_ID_META_KEY',
    ]);
  });

  it('sees every spelling of a read, on synthetic sources (so each branch of the derivation is exercised)', () => {
    const derived = deriveSites([
      {
        rel: 'x/aliased.ts',
        text: `import { BLOCK_UPLOADED_APP_ID_META_KEY as K } from 'y';\nexport function viaAlias(m: any) { return m[K]; }`,
      },
      {
        rel: 'x/property.ts',
        text: `export function viaProperty(m: { blockUploadedAppId?: string }) { return m.blockUploadedAppId; }`,
      },
      {
        rel: 'x/sql.ts',
        text: "export function viaSql(a: string) { return `metadata->>'blockUploadedAppId' = ${a}`; }",
      },
      {
        rel: 'x/comment.ts',
        text: `// blockUploadedAppId in a comment is not a read\nexport const x = 1;`,
      },
    ]);
    expect(Object.fromEntries([...derived].map(([k, v]) => [k, [...v]]))).toEqual({
      'x/aliased.ts#viaAlias': [UPLOADED],
      'x/property.ts#viaProperty': ["'blockUploadedAppId'"],
      'x/sql.ts#viaSql': ["'blockUploadedAppId'"],
    });
  });
});

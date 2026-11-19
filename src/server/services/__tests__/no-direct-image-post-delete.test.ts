import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

/**
 * Every image and post row is deleted through `deleteImageRows` / `deletePostRows`
 * (`@civitai/db-queries/content-deletion`), so a rule about what may be deleted lives in one place.
 * Also refused: a hard delete of a user, whose images and posts cascade with it.
 *
 * An image delete also leaves work behind: its stored file, and the caches that would still serve
 * it. So the shared `deleteImageRows` is called only by each app's own image delete, which queues
 * the file and then invalidates what could still serve it, and which keeps its two halves private:
 * no caller can run one without the other.
 *
 * Not seen: a statement built from strings, or a table named through a variable.
 */

const REPO_ROOT = path.resolve(__dirname, '../../../..');
const ROOTS = ['src', 'apps', 'packages'];
const SKIP_DIRS = new Set([
  'node_modules',
  '__tests__',
  '__mocks__',
  '.svelte-kit',
  'dist',
  'build',
]);
const EXTENSIONS = /\.(ts|tsx|js|mjs|svelte)$/;
const SKIP_FILES = /\.test\.|\.spec\.|(^|[\\/])seed\.ts$/;

const FORBIDDEN = [
  /DELETE\s+FROM\s+(ONLY\s+)?(public\.)?"(Image|Post|User)"/gi,
  /deleteFrom\(\s*['"](Image|Post|User)['"]\s*\)/g,
  /\.(image|post|user)\s*\.\s*delete(Many)?\(/g,
];

function* sourceFiles(dir: string): Generator<string> {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* sourceFiles(full);
    else if (EXTENSIONS.test(entry.name) && !SKIP_FILES.test(full)) yield full;
  }
}

const MODERATOR_IMAGE_DELETE = 'apps/moderator/src/lib/server/image-deletion.ts';
/** Each app's image delete: the only importers of the shared `deleteImageRows`. */
const IMAGE_DELETES = ['src/server/services/image.service.ts', MODERATOR_IMAGE_DELETE];
const FROM_CONTENT_DELETION = String.raw`\s*from\s*['"][^'"]*content-deletion(?:\.db)?['"]`;
/** Imports the shared `deleteImageRows`, by name or through a namespace it then calls it on. */
function importsSharedImageDelete(text: string) {
  if (
    new RegExp(String.raw`import\s*\{[^}]*\bdeleteImageRows\b[^}]*\}` + FROM_CONTENT_DELETION).test(
      text
    )
  )
    return true;
  const namespace = new RegExp(String.raw`import\s*\*\s*as\s+(\w+)` + FROM_CONTENT_DELETION).exec(
    text
  )?.[1];
  return !!namespace && new RegExp(String.raw`\b${namespace}\s*\.\s*deleteImageRows\(`).test(text);
}
/** The halves of an image delete, which only each app's `deleteImages` may pair up. */
const EXPORTED_HALF =
  /export\s+(?:async\s+)?function\s+(deleteImageRows|finishImageDeletes|invalidateDeletedImages)\b/;

const directDeletes = (text: string) =>
  FORBIDDEN.flatMap((pattern) =>
    [...text.matchAll(pattern)].map(
      (match) => `${text.slice(0, match.index).split('\n').length} ${match[0]}`
    )
  );

function scanTree() {
  const found: string[] = [];
  const imageRowDeletes: string[] = [];
  let files = 0;
  for (const root of ROOTS)
    for (const file of sourceFiles(path.join(REPO_ROOT, root))) {
      files++;
      const rel = path.relative(REPO_ROOT, file).split(path.sep).join('/');
      const text = fs.readFileSync(file, 'utf8');
      for (const hit of directDeletes(text)) found.push(`${rel}:${hit}`);
      if (importsSharedImageDelete(text)) imageRowDeletes.push(rel);
    }
  return { found, imageRowDeletes, files };
}

let scanned: ReturnType<typeof scanTree> | undefined;
const scan = () => (scanned ??= scanTree());

describe('no-direct-image-post-delete', () => {
  it('deletes images and posts only through the shared delete functions', () => {
    const { found, files } = scan();
    expect(files).toBeGreaterThan(1000);
    expect(found).toEqual([]);
  });

  it('deletes image rows only through an image delete whose halves stay private', () => {
    const { imageRowDeletes } = scan();
    expect(imageRowDeletes.sort()).toEqual([...IMAGE_DELETES].sort());
    for (const file of IMAGE_DELETES) {
      const text = fs.readFileSync(path.join(REPO_ROOT, file), 'utf8');
      expect(text).toMatch(/export async function deleteImages\b/);
      expect(text.match(EXPORTED_HALF)?.[1]).toBeUndefined();
    }
  });

  it.each([
    'tx.$executeRaw`DELETE FROM "Image" WHERE id = 1`',
    'sql`delete from public."Post" where id = 1`',
    'DELETE FROM ONLY "User" WHERE id = 1',
    "db.deleteFrom('Post').where('id', '=', 1)",
    'dbWrite.image.deleteMany({ where: {} })',
    'tx.user.delete({ where: { id } })',
    'await dbWrite.image\n  .deleteMany({ where: {} })',
  ])('catches %s', (text) => {
    expect(directDeletes(text)).toHaveLength(1);
  });

  it.each([
    "import { deleteImageRows } from '@civitai/db-queries/content-deletion';",
    "import { x, deleteImageRows as d } from '../content-deletion.db';",
    "import * as cd from '@civitai/db-queries/content-deletion';\ncd.deleteImageRows(db, o);",
  ])('sees the shared image delete imported in %s', (text) => {
    expect(importsSharedImageDelete(text)).toBe(true);
  });

  it('sees an exported half of an image delete', () => {
    expect(EXPORTED_HALF.test('export async function finishImageDeletes(d) {}')).toBe(true);
    expect(EXPORTED_HALF.test('async function finishImageDeletes(d) {}')).toBe(false);
  });
});

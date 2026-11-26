import { globSync, readFileSync, statSync } from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';
import { stripCodeComments } from '~/test-utils/strip-code-comments';

/**
 * A moderator's lift of a Feature Pages scan hide is kept per text version, and the scan's hide
 * trusts that no text write leaves the version as it was (hideFlaggedFpComment). So this file is a
 * LEDGER of every write of a CommentV3's text, and of the two calls a Feature Pages edit goes
 * through. It fails when a writer is added (one nobody has checked bumps the version), and when one
 * listed goes away (its reason then describes nothing).
 *
 * The behaviour each entry relies on is pinned elsewhere: the Feature Pages edit adds one version
 * (fp-discussion.behavior.test.ts), and the generic edit refuses a featurePage comment, a
 * moderator's included (surfaces.test.ts, assertWritable).
 */

const ROOT = path.resolve(__dirname, '../../../..');
const TEXT_WRITES = [
  /\bUPDATE\s+"?CommentV3"?(?![\w"])[^;`]*?\bSET\b(?:(?!\bWHERE\b)[^;`])*?"?\bcontent"?\s*=/gi,
  /\.updateTable\(\s*['"]CommentV3['"][\s\S]{0,300}?\.set\(\s*\{[^}]*\bcontent\b/g,
  /\.commentV3\s*\.\s*(update|updateMany|updateManyAndReturn|upsert)\s*\(/g,
];
const CALLS = {
  updateCommentContent: /\bupdateCommentContent\s*\(/g,
  writeCommentEdit: /\bwriteCommentEdit\s*\(/g,
  fpEditHooks: /\bfpEditHooks\s*\(/g,
};
type Counts = { textWrites: number } & Record<keyof typeof CALLS, number>;

const LEDGER: Record<string, Counts & { why: string }> = {
  'src/server/services/commentv3/write.service.ts': {
    textWrites: 2,
    updateCommentContent: 1,
    writeCommentEdit: 0,
    fpEditHooks: 0,
    why:
      'updateCommentContent, called only from writeCommentEdit; deleteComments blanks a deleted ' +
      "comment's text, which is never shown again (fpCommentState: erased)",
  },
  'src/server/services/commentv3/comment-write.service.ts': {
    textWrites: 0,
    updateCommentContent: 1,
    writeCommentEdit: 1,
    fpEditHooks: 0,
    why: 'writeCommentEdit: runs the caller beforeUpdate under the row lock, then the write',
  },
  'src/server/controllers/commentv3.controller.ts': {
    textWrites: 0,
    updateCommentContent: 0,
    writeCommentEdit: 1,
    fpEditHooks: 0,
    why: 'the generic edit: assertCanWrite refuses a featurePage comment before it',
  },
  'src/server/services/feature-pages/comments.service.ts': {
    textWrites: 0,
    updateCommentContent: 0,
    writeCommentEdit: 1,
    fpEditHooks: 1,
    why: 'the Feature Pages edit, with fpEditHooks, whose fpEditUnderLock adds the version',
  },
};

const count = (text: string, patterns: RegExp[]) =>
  patterns.reduce((sum, re) => sum + (text.match(re) ?? []).length, 0);

function scan(root = ROOT) {
  const files = globSync('{src,apps,packages,scripts}/**/*.{ts,tsx,js,mjs,cjs,svelte,go}', {
    cwd: root,
    exclude: (f: string | { name: string }) =>
      /node_modules|\.svelte-kit|(^|[\\/])dist([\\/]|$)/.test(typeof f === 'string' ? f : f.name),
  })
    .map((f) => f.split(path.sep).join('/'))
    .filter(
      (f) =>
        !/(__tests__|\.test\.|\.spec\.|\/migrations\/)/.test(f) &&
        statSync(path.join(root, f)).isFile()
    );
  const found: Record<string, Counts> = {};
  for (const f of files) {
    const text = stripCodeComments(readFileSync(path.join(root, f), 'utf8'));
    const counts = {
      textWrites: count(text, TEXT_WRITES),
      ...(Object.fromEntries(
        Object.entries(CALLS).map(([name, re]) => [name, count(text, [re])])
      ) as Record<keyof typeof CALLS, number>),
    };
    if (Object.values(counts).some(Boolean)) found[f] = counts;
  }
  return { files, found };
}

describe('CommentV3 text write ledger', () => {
  const { files, found } = scan();

  it('scans the source tree (instrument control)', () => {
    expect(files.length).toBeGreaterThan(1000);
    expect(files).toContain('src/server/services/commentv3/write.service.ts');
  });

  it('each pattern still matches what it was written for (instrument control)', () => {
    const [raw, kysely, prisma] = TEXT_WRITES.map(
      (re) => new RegExp(re.source, re.flags.replace('g', ''))
    );
    expect('`UPDATE "CommentV3" SET content = $2, "updatedAt" = now()').toMatch(raw);
    expect('UPDATE "CommentV3" SET "deletedAt" = now(), content = \'\'').toMatch(raw);
    expect('UPDATE "CommentV3" c\n SET hidden = true, "content" = $1').toMatch(raw);
    expect(".updateTable('CommentV3').set({ content: text })").toMatch(kysely);
    expect('dbWrite.commentV3\n  .update({ where').toMatch(prisma);
    // Other columns, other tables and reads are not text writes.
    expect('UPDATE "CommentV3" SET hidden = true WHERE content = $1').not.toMatch(raw);
    expect('UPDATE "CommentV3Report" SET content = $1').not.toMatch(raw);
    expect('SELECT content FROM "CommentV3"').not.toMatch(raw);
    expect(".updateTable('CommentV3').set({ hidden: true })").not.toMatch(kysely);
  });

  it('every text write and edit path is listed, and nothing listed has gone away', () => {
    const sorted = <T>(o: Record<string, T>) =>
      Object.fromEntries(Object.entries(o).sort(([a], [b]) => a.localeCompare(b)));
    const expected = Object.fromEntries(
      Object.entries(LEDGER).map(([f, { why: _why, ...counts }]) => [f, counts])
    );
    expect(sorted(found)).toEqual(sorted(expected));
  });
});

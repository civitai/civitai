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
// A table name built at runtime (sql.table(x), a string join) is out of reach of any scan; such a
// writer is accepted unseen.
const TEXT_WRITES = [
  /\bUPDATE\s+(?:ONLY\s+)?(?:"?public"?\.)?"?CommentV3"?(?![\w"])[^;`]*?\bSET\b(?:(?!\bWHERE\b)[^;`])*?"?\bcontent"?\s*=/gi,
  // Any .set( that is not an object literal free of content: a callback, a ('content', x) pair, a
  // variable, or a spread.
  /\.updateTable\(\s*['"`]CommentV3(?:\s+as\s+\w+)?['"`]\s*\)[\s\S]{0,300}?\.set\(\s*(?:\{[^}]*(?:\bcontent\b|\.\.\.)|[^{\s])/g,
  /\.commentV3\s*\.\s*(update|updateMany|updateManyAndReturn|upsert)\s*\(/g,
];
const CALLS = {
  updateCommentContent: /\bupdateCommentContent\s*\(/g,
  writeCommentEdit: /\bwriteCommentEdit\s*\(/g,
  fpEditHooks: /\bfpEditHooks\s*\(/g,
};
type Counts = { textWrites: number } & Record<keyof typeof CALLS, number>;

const NONE = { updateCommentContent: 0, writeCommentEdit: 0, fpEditHooks: 0 };
const MIRROR_WHY =
  'the old-table mirror copies a Comment/CommentV2 edit into its own CommentV3 row (CommentV2 shares ' +
  'the id sequence, Comment is matched on legacyV1Id), and a featurePage comment has no old-table row; ' +
  '20270101120000_comment_v3_old_table_triggers_off drops the triggers';

const LEDGER: Record<string, Counts & { why: string }> = {
  'packages/civitai-db-schema/prisma/migrations/20261120120000_comment_v3_mirror/migration.sql': {
    textWrites: 3,
    ...NONE,
    why: `${MIRROR_WHY}; the third blanks a deleted mirrored comment (commentv3_mirror_delete)`,
  },
  'packages/civitai-db-schema/prisma/migrations/20261210120000_comment_v3_mirror_changed_columns/migration.sql':
    { textWrites: 1, ...NONE, why: MIRROR_WHY },
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
  const files = globSync(
    '{src,apps,packages,scripts,event-engine-common,.claude/skills}/**/*.{ts,tsx,js,mjs,cjs,svelte,go,py,sh,sql}',
    {
      cwd: root,
      exclude: (f: string | { name: string }) =>
        /node_modules|\.svelte-kit|(^|[\\/])dist([\\/]|$)/.test(typeof f === 'string' ? f : f.name),
    }
  )
    .map((f) => f.split(path.sep).join('/'))
    .filter(
      (f) => !/(__tests__|\.test\.|\.spec\.)/.test(f) && statSync(path.join(root, f)).isFile()
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
    // CI's unit job checks the submodule out; without it this fails rather than scanning less.
    for (const dir of [
      'event-engine-common/',
      '.claude/skills/',
      'packages/civitai-db-schema/prisma/migrations/',
    ])
      expect(files.some((f) => f.startsWith(dir))).toBe(true);
  });

  it('each pattern still matches what it was written for (instrument control)', () => {
    const [raw, kysely, prisma] = TEXT_WRITES.map(
      (re) => new RegExp(re.source, re.flags.replace('g', ''))
    );
    expect('`UPDATE "CommentV3" SET content = $2, "updatedAt" = now()').toMatch(raw);
    expect('UPDATE "CommentV3" SET "deletedAt" = now(), content = \'\'').toMatch(raw);
    expect('UPDATE "CommentV3" c\n SET hidden = true, "content" = $1').toMatch(raw);
    expect(".updateTable('CommentV3').set({ content: text })").toMatch(kysely);
    expect('UPDATE public."CommentV3" SET content = $1').toMatch(raw);
    expect(".updateTable('CommentV3 as c').set({ content: text })").toMatch(kysely);
    expect('.updateTable("CommentV3")\n  .set((eb) => ({ content: eb.val(text) }))').toMatch(
      kysely
    );
    expect(".updateTable('CommentV3').set('content', text)").toMatch(kysely);
    expect(".updateTable('CommentV3').set({ ...patch })").toMatch(kysely);
    expect(".updateTable('CommentV3').set(patch)").toMatch(kysely);
    expect('dbWrite.commentV3\n  .update({ where').toMatch(prisma);
    // Other columns, other tables and reads are not text writes.
    expect('UPDATE "CommentV3" SET hidden = true WHERE content = $1').not.toMatch(raw);
    expect('UPDATE "CommentV3Report" SET content = $1').not.toMatch(raw);
    expect('SELECT content FROM "CommentV3"').not.toMatch(raw);
    expect(".updateTable('CommentV3').set({ hidden: true })").not.toMatch(kysely);
    expect(".updateTable('CommentV3Report').set({ content: text })").not.toMatch(kysely);
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

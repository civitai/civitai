import { readdirSync, readFileSync, statSync } from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

/**
 * When content tied to a minor is restricted is stated once, in `@civitai/shared/minor-content-gate`
 * (with its SQL twin), so that every gate that hides, caps, refuses or keeps such content flagged
 * gives the same answer, and a later change to the rule reaches all of them. This guard fails when a
 * statement names a minor and compares a rating by hand instead of asking the shared rule.
 *
 * The minor review queue's Accept is allowed by file and line: it clears the flag rather than
 * restricting, so it keeps its own rule. Moving it, or adding another exception, must be a visible
 * change to the list below.
 *
 * It is a text guard: it catches a hand-written rating compare, or a hand-written ceiling constant,
 * in the same statement as a minor. It does not prove every gate is wired to the rule; the truth
 * table tests beside each gate do that.
 */

const repoRoot = path.resolve(__dirname, '../../../..');

const RULE_MODULES = [
  'packages/civitai-shared/src/minor-content-gate.ts',
  'src/server/utils/minor-content-gate.sql.ts',
];

/**
 * Permissive sites, by file, the exact compare they keep, and how many times it appears there. Keyed
 * by text rather than line, so an unrelated edit above one does not fail the guard.
 */
const ACCEPT_CASE = 'CASE WHEN "nsfwLevel" >= 4 THEN FALSE ELSE TRUE END';
const PERMIT_SITES = [
  { file: 'src/server/services/image.service.ts', snippet: ACCEPT_CASE, count: 1 },
  {
    file: 'apps/moderator/src/lib/server/image-moderation.service.ts',
    snippet: ACCEPT_CASE,
    count: 1,
  },
];

/**
 * The flagged compares in one file, less the permissive sites listed for it. Only the listed compare
 * itself is exempt: it is cut out of the text first, so anything else on its line is still checked.
 */
function unlistedCompares(file: string, text: string, permits = PERMIT_SITES) {
  const kept = permits
    .filter((p) => p.file === file)
    .reduce((t, p) => t.split(p.snippet).join(''), text);
  return handWrittenMinorRatingCompares(file, kept);
}

const occurrences = (text: string, snippet: string) => text.split(snippet).length - 1;

const ROOTS = ['src', 'apps/moderator/src', 'apps/event-engine/src', 'packages'];

const RATING_COMPARES = [
  /\bnsfwLevel"?\s*>=\s*4\b/,
  />=\s*NsfwLevel\.R\b/,
  /<\s*NsfwLevel\.R\b/,
  />\s*NsfwLevel\.PG13\b/,
  /<=\s*NsfwLevel\.PG13\b/,
  />\s*sfwBrowsingLevelsFlag\b/,
  /=\s*NsfwLevel\.PG13\s*;/,
  // The same compares written with the level's number.
  /(>=|<)\s*4\b/,
  /(>|<=)\s*[23]\b/,
];

const isComment = (line: string) => /^\s*(\/\/|\*|\/\*)/.test(line);

/** The statement around `index`: back to the previous statement end, forward to the next. */
function statementAt(lines: string[], index: number) {
  let start = index;
  while (start > 0 && index - start < 4 && !/[;{}]\s*$/.test(lines[start - 1])) start--;
  let end = index;
  while (end < lines.length - 1 && end - index < 4 && !/[;{]\s*$/.test(lines[end])) end++;
  return lines
    .slice(start, end + 1)
    .filter((line) => !isComment(line))
    .join('\n');
}

/** `file:line` for every statement that names a minor and compares a rating by hand. */
function handWrittenMinorRatingCompares(file: string, text: string) {
  const lines = text.split('\n');
  const found: string[] = [];
  lines.forEach((line, i) => {
    if (isComment(line) || !RATING_COMPARES.some((re) => re.test(line))) return;
    if (/minor/i.test(statementAt(lines, i))) found.push(`${file}:${i + 1}`);
  });
  return found;
}

function walk(dir: string, out: string[] = []) {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry.startsWith('.') || entry === '__tests__') continue;
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(tsx?|svelte)$/.test(entry) && !/\.(test|harness)\./.test(entry)) out.push(full);
  }
  return out;
}

const files = ROOTS.flatMap((root) => walk(path.join(repoRoot, root))).map((full) => ({
  rel: path.relative(repoRoot, full).split(path.sep).join('/'),
  text: readFileSync(full, 'utf8'),
}));

describe('the minor content rule has one definition', () => {
  it('scans the trees the gates live in', () => {
    const scanned = new Set(files.map((f) => f.rel));
    for (const file of [...RULE_MODULES, ...PERMIT_SITES.map((s) => s.file)])
      expect(scanned.has(file), `${file} is not scanned`).toBe(true);
  });

  it('no gate compares a minor rating by hand outside the rule', () => {
    const found = files
      .filter((f) => !RULE_MODULES.includes(f.rel))
      .flatMap((f) => unlistedCompares(f.rel, f.text));
    expect(found, 'call isMinorContentRestricted / minorContentRestrictedSql instead').toEqual([]);
  });

  it('each permissive site is still in its file, exactly as many times as listed', () => {
    for (const { file, snippet, count } of PERMIT_SITES) {
      const text = files.find((f) => f.rel === file)!.text;
      expect(occurrences(text, snippet), `${file}: ${snippet}`).toBe(count);
    }
  });

  const permitted = [`const accept = sql\`"minor" = ${ACCEPT_CASE}\`;`, 'const other = 1;'].join(
    '\n'
  );
  const permits = [{ file: 'x.ts', snippet: ACCEPT_CASE, count: 1 }];

  it('a permissive site that moves down a line still passes', () => {
    expect(handWrittenMinorRatingCompares('x.ts', permitted)).toEqual(['x.ts:1']);
    expect(unlistedCompares('x.ts', permitted, permits)).toEqual([]);
    expect(unlistedCompares('x.ts', `// a new line above\n${permitted}`, permits)).toEqual([]);
  });

  it('a hand compare on the same line as a permissive site still fails', () => {
    const sameLine = `const accept = sql\`"minor" = ${ACCEPT_CASE}\` && level >= NsfwLevel.R;`;
    expect(unlistedCompares('x.ts', sameLine, permits)).toEqual(['x.ts:1']);
  });

  it('counts a second copy of a permissive compare', () => {
    expect(occurrences(permitted, ACCEPT_CASE)).toBe(1);
    expect(occurrences(`${permitted}\n${permitted}`, ACCEPT_CASE)).toBe(2);
  });

  it('a hand compare planted beside a permissive site still fails', () => {
    const planted = `${permitted}\nconst hide = minor && level >= NsfwLevel.R;`;
    expect(unlistedCompares('x.ts', planted, permits)).toEqual(['x.ts:3']);
  });

  it.each([
    ['a refusal', 'const refuse = minor && (level == null || level >= NsfwLevel.R);'],
    ['a SQL keep', 'sql`"minor" = CASE WHEN "nsfwLevel" >= 4 THEN TRUE END`;'],
    ['a ceiling', 'export const MINOR_HOST_CEILING = NsfwLevel.PG13;'],
    ['a two-line compare', 'const hide =\n  isMinor && level > NsfwLevel.PG13;'],
    ['a compare by number', 'const hide = minor && level > 3;'],
  ])('catches %s', (_, snippet) => {
    expect(handWrittenMinorRatingCompares('x.ts', snippet)).not.toEqual([]);
  });

  it('leaves a rating compare that names no minor', () => {
    expect(handWrittenMinorRatingCompares('x.ts', 'const nsfw = level >= NsfwLevel.R;')).toEqual(
      []
    );
  });
});

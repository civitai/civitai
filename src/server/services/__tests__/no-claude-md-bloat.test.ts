import { existsSync, readFileSync, readdirSync } from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

/**
 * The root CLAUDE.md is loaded into every session and every subagent and re-read on every turn. It grew
 * to 959 lines one "write it down" at a time before #5376 cut it to ~120; nothing but this test stops it
 * growing back. If you are over a cap, move the content where it loads on demand (see the header of
 * CLAUDE.md) — do not raise the cap to fit.
 */
const ROOT_CAP = 150;
const APP_CAP = 150;
const RULE_CAP = 120;

const repoRoot = path.resolve(__dirname, '../../../..');
const MOVE_IT =
  'move content to a path-scoped .claude/rules/ file, docs/dev/, docs/features/ or a skill';

const lineCount = (relPath: string) =>
  readFileSync(path.join(repoRoot, relPath), 'utf8').trimEnd().split('\n').length;

const appClaudeMds = readdirSync(path.join(repoRoot, 'apps'))
  .map((app) => `apps/${app}/CLAUDE.md`)
  .filter((f) => existsSync(path.join(repoRoot, f)));

const rules = readdirSync(path.join(repoRoot, '.claude/rules'))
  .filter((f) => f.endsWith('.md'))
  .map((f) => `.claude/rules/${f}`);

describe('always-loaded agent instructions stay small', () => {
  it('finds the files it guards', () => {
    expect(appClaudeMds.length).toBeGreaterThan(0);
    expect(rules.length).toBeGreaterThan(0);
  });

  it(`root CLAUDE.md is at most ${ROOT_CAP} lines`, () => {
    expect(lineCount('CLAUDE.md'), `CLAUDE.md: ${MOVE_IT}`).toBeLessThanOrEqual(ROOT_CAP);
  });

  it.each(appClaudeMds)(`%s is at most ${APP_CAP} lines`, (f) => {
    expect(lineCount(f), `${f}: ${MOVE_IT}`).toBeLessThanOrEqual(APP_CAP);
  });

  it.each(rules)(`%s is at most ${RULE_CAP} lines`, (f) => {
    expect(lineCount(f), `${f}: split it or move detail to docs/`).toBeLessThanOrEqual(RULE_CAP);
  });

  // A rule without `paths:` frontmatter loads in every session, which is the root file again.
  it.each(rules)('%s is path-scoped', (f) => {
    const src = readFileSync(path.join(repoRoot, f), 'utf8');
    expect(src, `${f} needs a "paths:" list in its frontmatter`).toMatch(/^---\npaths:\n\s+- /);
  });
});

import { execFileSync } from 'child_process';
import { existsSync, globSync, readFileSync } from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

/**
 * `unit` and `unit-fast` must PARTITION the unit suite — every file in exactly one, never both,
 * never neither.
 *
 * A file that runs in neither project is the worst outcome available here: the suite still passes,
 * the counts still look plausible, and the file's coverage is simply gone. Two documented ways in,
 * both silent — the projects need distinct `sequence.groupOrder` or `groupSpecs` throws and reports
 * `Test Files: no tests`, and a CI selector matching one project leaves the other running nowhere
 * and still exiting 0.
 *
 * The structural defence is that `unit-fast`'s `include` and `unit`'s `exclude` are the SAME list,
 * read from `unit-fast-manifest.json`. This guard checks the properties that the shared list cannot
 * enforce on its own: that the list is current, that it only names files the `unit` project's
 * include actually matches, and that nothing is in two states at once.
 *
 * 🔴 What this CANNOT check is that both projects ran. "Runs nowhere and exits 0" is invisible to
 * any static test — that needs a CI assertion on each project's collected count, the same
 * instrument as the per-file collected-count diff that gates the flip.
 */
const repoRoot = path.resolve(__dirname, '../../../..');
const MANIFEST = path.join(repoRoot, 'src/__tests__/mocks/unit-fast-manifest.json');
const GENERATOR = path.join(repoRoot, 'scripts/test-perf/gen-fast-project.mjs');

type Manifest = {
  members: string[];
  excluded: Record<string, string>;
  unitInclude: string[];
  totals: Record<string, number>;
};

const manifest: Manifest = JSON.parse(readFileSync(MANIFEST, 'utf8'));

const unitFiles = new Set(
  [...new Set(manifest.unitInclude.flatMap((g) => globSync(g, { cwd: repoRoot })))].map((f) =>
    f.replace(/\\/g, '/')
  )
);

describe('unit / unit-fast partition', () => {
  it('every member is matched by the unit project include', () => {
    const orphans = manifest.members.filter((f) => !unitFiles.has(f));
    expect(orphans, 'these would run in NEITHER project').toEqual([]);
  });

  it('every permanently-excluded file is matched by the unit project include', () => {
    const orphans = Object.keys(manifest.excluded).filter((f) => !unitFiles.has(f));
    expect(orphans).toEqual([]);
  });

  it('no file is both a member and permanently excluded', () => {
    const both = manifest.members.filter((f) => f in manifest.excluded);
    expect(both).toEqual([]);
  });

  it('every permanently-excluded file records why', () => {
    const unexplained = Object.entries(manifest.excluded)
      .filter(([, reason]) => !reason?.trim())
      .map(([file]) => file);
    expect(unexplained).toEqual([]);
  });

  it('the member list has no duplicates and is sorted', () => {
    expect(manifest.members).toEqual([...new Set(manifest.members)].sort());
  });

  /**
   * The other half of the "runs in neither project" hole, and the half a manifest cannot close: a
   * selector naming `unit` alone runs half the suite and exits 0.
   *
   * Textual, over the config and every script that spawns vitest. It cannot prove a project ran —
   * only a collected count from the run itself can — but it does catch the mechanical mistake of
   * adding a unit-family project and leaving a selector behind, which is how this fails in
   * practice.
   */
  it('every unit-family project is named by every unit-family selector', () => {
    const config = readFileSync(path.join(repoRoot, 'vitest.config.mts'), 'utf8');
    const projects = [...config.matchAll(/name: '(unit[\w-]*)'/g)].map((m) => m[1]);
    expect(projects, 'expected at least unit and unit-fast').toContain('unit-fast');

    const selectors: [string, string][] = [
      ['package.json', readFileSync(path.join(repoRoot, 'package.json'), 'utf8')],
      [
        'scripts/test-unit-run.mjs',
        readFileSync(path.join(repoRoot, 'scripts/test-unit-run.mjs'), 'utf8'),
      ],
    ];

    const gaps: string[] = [];
    for (const [where, text] of selectors)
      for (const line of text.split('\n')) {
        if (!/--project/.test(line) || !/\bunit\b/.test(line)) continue;
        for (const project of projects)
          if (!new RegExp(`['"\`\\s]${project}['"\`,\\s]`).test(line))
            gaps.push(`${where}: a unit selector does not name '${project}': ${line.trim()}`);
      }
    expect(gaps).toEqual([]);
  });

  // Freshness, not correctness of the rule: a test file added since the last generate is neither a
  // member nor recorded anywhere, and without this it falls through as "not yet migrated" forever
  // rather than being classified.
  it('the manifest is current', () => {
    expect(existsSync(GENERATOR), 'generator missing').toBe(true);
    // Read the generator's own message out rather than letting `execFileSync` report
    // "Command failed" — a guard whose failure does not say what to do gets an exemption instead
    // of a fix.
    let failure = '';
    try {
      execFileSync(process.execPath, [GENERATOR, '--check'], { cwd: repoRoot, encoding: 'utf8' });
    } catch (e) {
      const err = e as { stderr?: string; stdout?: string; message: string };
      failure = (err.stderr || err.stdout || err.message).trim();
    }
    expect(failure).toBe('');
  });
});

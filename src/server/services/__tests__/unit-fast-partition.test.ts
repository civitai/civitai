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
  canonicalSpecifiers: string[];
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
   * 🔴 The membership rule exempts canonical specifiers from its sharing test, because the canonical
   * mock exists so they CAN be shared. That exemption is about the specifier and says nothing about
   * whether a given file still mocks it directly — and a file carrying its own direct mock of a
   * canonical module overrides the canonical registration for its whole worker under
   * `isolate: false`, freezing its factory for every member beside it.
   *
   * ⚠️ Written without the literal call spelled out, because `no-direct-shared-module-mock` scans
   * raw text and cannot tell a comment from code. Quoting the shape here put THIS file on the
   * allowlist. `app-access.service.test.ts` is on `main`'s allowlist for the same reason and has
   * no mock to migrate — see the PR body; the guard fix is a follow-up, not this change.
   *
   * So the exemption written to admit files that USE the canonical mock also admitted the files it
   * was built to replace: 52 of them at 3c9ac23165, against 3 members that mocked anything and were
   * safe. Reading the manifest's own count could not see it, which is why this reads the FILES.
   */
  it('no member directly mocks a canonical specifier', () => {
    const canonical = new Set(manifest.canonicalSpecifiers);
    const offenders: string[] = [];
    for (const file of manifest.members) {
      const full = path.join(repoRoot, file);
      if (!existsSync(full)) continue;
      const src = readFileSync(full, 'utf8');
      const mocked = [...src.matchAll(/vi\.mock\(\s*(['"`])([^'"`]+)\1/g)]
        .map((m) => m[2])
        .filter((s) => canonical.has(s));
      if (mocked.length) offenders.push(`${file} -> ${[...new Set(mocked)].join(', ')}`);
    }
    expect(offenders, 'these override the canonical mock for their whole worker').toEqual([]);
  });

  /**
   * The other half of the "runs in neither project" hole, and the half a manifest cannot close: a
   * selector naming `unit` alone runs half the suite and exits 0.
   *
   * Textual, over `package.json` and `scripts/test-unit-run.mjs`. It cannot prove a project ran —
   * only a collected count from the run itself can — but it does catch the mechanical mistake of
   * adding a unit-family project and leaving a selector behind, which is how this fails in
   * practice.
   *
   * 🔴 The separator class must tolerate a QUOTE, because the highest-stakes selector in the repo
   * is an argv array, not a command string: `spawn(bin, ['run', '--project', 'unit*', …])`. An
   * earlier `--project[ =]+` matched nothing there, so the guard opened that file, iterated its
   * lines and evaluated NONE of them — while `package.json:97` routes every `test:unit:run`,
   * CI's included, through exactly that line. Narrowing it to `'unit'` left the guard green with
   * `unit-fast` and `unit-native` running nowhere. Mutation-tested in both files; see the
   * scoreboard doc for the table.
   *
   * ⚠️ Still per-line, so a selector whose value sits on the NEXT line is invisible to it
   * (`scripts/test-perf/bench.mjs`, `run-pilot.mjs`, `accept-mock-default.mjs` are all that shape).
   * Those are perf tooling rather than the suite's entry points, which is why this is a bound and
   * not a bug — but it is a bound, so do not read a pass here as "every spawn site is checked".
   */
  it('every unit-family project is covered by every unit-family selector', () => {
    const config = readFileSync(path.join(repoRoot, 'vitest.config.mts'), 'utf8');
    const projects = [...config.matchAll(/name: '(unit[\w-]*)'/g)].map((m) => m[1]);
    expect(projects, 'expected at least unit and unit-fast').toEqual(
      expect.arrayContaining(['unit', 'unit-fast'])
    );

    const selectors: [string, string][] = [
      ['package.json', readFileSync(path.join(repoRoot, 'package.json'), 'utf8')],
      [
        'scripts/test-unit-run.mjs',
        readFileSync(path.join(repoRoot, 'scripts/test-unit-run.mjs'), 'utf8'),
      ],
    ];

    // Vitest matches `--project` against a project name as a glob, so `'unit*'` covers the whole
    // family and an explicit list covers whatever it names. Check COVERAGE, not spelling: a guard
    // that insisted on one of the two forms would fail on the other while nothing was wrong.
    //
    // Deliberately STRICTER than vitest's own `wildcardPatternToRegExp`, which maps `*` to `.*` and
    // matches case-insensitively. Narrower can only produce a false failure here, never a false
    // pass, which is the safe direction for a guard.
    const covers = (spec: string, project: string) =>
      new RegExp(`^${spec.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[\\w-]*')}$`).test(
        project
      );

    const gaps: string[] = [];
    for (const [where, text] of selectors)
      for (const line of text.split('\n')) {
        const specs = [...line.matchAll(/--project['"`]?[\s,=]+['"`]?([\w*@:/-]+)/g)].map(
          (m) => m[1]
        );
        if (!specs.some((s) => covers(s, 'unit'))) continue;
        for (const project of projects)
          if (!specs.some((s) => covers(s, project)))
            gaps.push(`${where}: a unit selector does not cover '${project}': ${line.trim()}`);
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

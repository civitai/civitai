import { readdirSync, readFileSync } from 'fs';
import { dirname, relative, resolve, sep } from 'path';
import { fileURLToPath } from 'url';
import { describe, expect, it } from 'vitest';

import { DEFAULT_DAEMON_PORT } from '../../.claude/skills/dev-server/scripts/daemon-port.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const skillDir = resolve(repoRoot, '.claude/skills/dev-server');
const cliScript = resolve(skillDir, 'cli.mjs');
const portModule = resolve(skillDir, 'scripts/daemon-port.mjs');

/**
 * The ledger. What made this bug possible was several files each deciding the port for
 * themselves, and it is not a bug any of them contains — it is a bug in the SET. console.mjs in
 * particular is a TUI with no end-to-end case here, so a claim about the set is most of what
 * stands between it and a second hardcoded copy.
 *
 * The first version of this scanned a FIXED list of four readers, which could not see the set
 * GROW — and a fifth copy already existed, in `.claude/hooks/check-writable.mjs`, while the test
 * was green. It now walks the tree, so a file that does not exist yet is still covered.
 */
describe('nothing outside daemon-port.mjs decides the daemon port', () => {
  const roots = [skillDir, resolve(repoRoot, 'scripts'), resolve(repoRoot, '.claude/hooks')];

  /** Every .mjs/.js/.ts under the roots, minus node_modules and test files. */
  function sourceFiles(): string[] {
    const out: string[] = [];
    const walk = (dir: string) => {
      let entries;
      try {
        entries = readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        const full = resolve(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name === 'node_modules' || entry.name === '__tests__') continue;
          walk(full);
          continue;
        }
        if (!/\.(mjs|cjs|js|ts)$/.test(entry.name)) continue;
        // Test files legitimately pin the expected default as a literal — a test that derived
        // its expectation from the implementation would assert nothing.
        if (/\.(test|spec|selftest)\./.test(entry.name)) continue;
        out.push(full);
      }
    };
    roots.forEach(walk);
    return out;
  }

  it('finds the files it claims to scan', () => {
    // The positive control. Without it a typo in `roots` yields an empty set, every assertion
    // below passes vacuously, and "no second copy anywhere" would be a fact about the walk.
    const files = sourceFiles().map((f) => relative(repoRoot, f).split(sep).join('/'));
    expect(files.length).toBeGreaterThan(10);
    expect(files).toContain('.claude/skills/dev-server/cli.mjs');
    expect(files).toContain('.claude/skills/dev-server/console.mjs');
    expect(files).toContain('.claude/skills/dev-server/scripts/daemon.mjs');
    // The entry AND the logic module: the ports live in the logic file now, so naming only the
    // entry would leave this control proving the walk reaches a file with nothing to find.
    expect(files).toContain('.claude/hooks/check-writable.logic.mjs');
    expect(files).toContain('scripts/test-unit-run.mjs');
  });

  it('spells the port in exactly one source file', () => {
    // \b so 19444 and 94440 are not counted as a copy of 9444.
    const literal = new RegExp(String.raw`\b${DEFAULT_DAEMON_PORT}\b`);
    const owner = relative(repoRoot, portModule);

    const holders = sourceFiles()
      .filter((f) => literal.test(readFileSync(f, 'utf8')))
      .map((f) => relative(repoRoot, f))
      .sort();

    expect(holders).toEqual([owner]);
  });

  it('has every daemon client take its address from that module', () => {
    const clients = [cliScript, resolve(skillDir, 'console.mjs')];
    for (const file of clients) {
      const source = readFileSync(file, 'utf8');
      const name = relative(repoRoot, file);
      // An IMPORT, not a mention: `includes('daemon-port.mjs')` alone is satisfied by a comment,
      // and this file's prose names the module in several of them.
      expect(`${name}: ${/^import .*from '.*daemon-port\.mjs';$/m.test(source)}`).toBe(
        `${name}: true`
      );
      // The client takes the whole URL. Resolving a PORT and then doing arithmetic on it is the
      // shape that let a wrong-but-non-literal value through: `resolveDaemonPort() + 1` used to
      // satisfy every assertion here.
      expect(`${name}: ${/const DAEMON_URL = resolveDaemonUrl\(\);/.test(source)}`).toBe(
        `${name}: true`
      );
    }
  });
});

import { readFileSync } from 'fs';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

import { describe, expect, it } from 'vitest';

import * as QueueModule from '../../.claude/skills/dev-server/scripts/test-queue.mjs';
import { DIRECT_COMMANDS, directCommandFor, queuedCheckDecision } from '../queued-check-rules.mjs';

const ON = { CIVITAI_TEST_QUEUE: '1' };

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const packageScripts = JSON.parse(readFileSync(resolve(repoRoot, 'package.json'), 'utf8')).scripts;

const { RUN_KINDS } = QueueModule as unknown as {
  RUN_KINDS: Record<string, { script: string; capWorkers: boolean; resultCache: boolean }>;
};

describe('which wrapped suites go through the queue', () => {
  it('queues a full run when the flag is on', () => {
    expect(queuedCheckDecision([], ON)).toEqual({ queue: true });
  });

  it('never queues on CI', () => {
    expect(queuedCheckDecision([], { ...ON, CI: 'true' }).queue).toBe(false);
  });

  it.each(['', '0', 'false', 'off', 'no'])('stays direct when the flag is %j', (flag) => {
    expect(queuedCheckDecision([], { CIVITAI_TEST_QUEUE: flag }).queue).toBe(false);
  });

  /**
   * Unlike `typecheck:apps`, narrowing here is real: the direct path forwards the arguments to a
   * runner that understands them. If you are here because you made these lanes queue WITH
   * arguments, check the wrapper still forwards them - a rule that un-queues and a path that
   * discards is the pair that shipped a caller asking for one thing and getting everything.
   */
  it('stays direct when arguments narrow the run', () => {
    expect(queuedCheckDecision(['--reporter=json'], ON).queue).toBe(false);
  });
});

/**
 * 🔴 The wrapper is spawned as `pnpm run <lane script>`, and that script names the lane back to it
 * as argv. A lane whose script names a kind the wrapper does not know exits 2 in the daemon's
 * child, so the run fails from inside the queue with nothing local to point at.
 */
describe('every wrapped lane is wired end to end', () => {
  // Driven from DIRECT_COMMANDS, NOT from "which package scripts happen to mention the wrapper".
  // Measured: filtering RUN_KINDS by that mention meant unwiring ONE lane left the others behind
  // and a `length > 0` guard still passed - the file stayed entirely green with a lane silently
  // no longer routed. A lane that claims a direct command is a lane that must be wired.
  const claimed = Object.keys(DIRECT_COMMANDS);

  it('claims at least one lane', () => {
    expect(claimed.length).toBeGreaterThan(0);
  });

  it('declares a lane in RUN_KINDS for every direct command', () => {
    for (const kind of claimed) {
      expect(Object.keys(RUN_KINDS), `${kind} has a direct command but no lane`).toContain(kind);
    }
  });

  it('routes each claimed lane through the wrapper, under its OWN kind', () => {
    for (const kind of claimed) {
      const script = RUN_KINDS[kind]?.script;
      expect(script, `${kind} has no script`).toBeTruthy();
      expect(
        packageScripts[script],
        `${script} must run the wrapper as \`queued-check.mjs ${kind}\``
      ).toContain(`queued-check.mjs ${kind}`);
    }
  });
});

/**
 * 🔴 `resultCache` is what attaches the cache reporter and sets CIVITAI_TEST_CACHE. The cache
 * sequencer only ever skips files in the `unit` projects, so a lane that is not a vitest run at
 * all cannot be cached - it would be handed a `--reporter` flag its runner rejects.
 */
describe('the cache flag cannot outrun the runner it depends on', () => {
  it('never caches a lane that takes no worker cap', () => {
    for (const [kind, spec] of Object.entries(RUN_KINDS)) {
      if (!spec.resultCache) continue;
      expect(spec.capWorkers, `${kind} is cached but is not a vitest lane`).toBe(true);
    }
  });
});

/**
 * 🔴 `pnpm run lint <file>` used to lint `src/` AND the file - measured at 4666 problems for one
 * filename. eslint takes its target as a positional, so appending one to a command that already
 * names `src/` adds to the run instead of replacing it. The decision rule beside this one
 * un-queues on "arguments narrow the run", so for these lanes that reason has to be TRUE.
 */
describe('a named target replaces the default one rather than joining it', () => {
  it('drops src/ from a narrowed lint', () => {
    const { argv } = directCommandFor('lint', ['src/utils/date-helpers.ts'])!;
    expect(argv).not.toContain('src/');
    expect(argv).toContain('src/utils/date-helpers.ts');
  });

  it('keeps src/ when nothing was named', () => {
    expect(directCommandFor('lint', [])!.argv).toContain('src/');
  });

  it('drops packages from a narrowed packages lint', () => {
    const { argv } = directCommandFor('lintPackages', ['packages/civitai-shared'])!;
    expect(argv).not.toContain('packages');
    expect(argv).toContain('packages/civitai-shared');
  });

  // vitest filters its project by positional rather than adding to it, so these lanes must NOT
  // have a narrowed variant - dropping `--project` would widen the run instead of narrowing it.
  it.each(['component', 'packages', 'apps', 'geometry'])(
    'leaves the %s lane its project selector',
    (kind) => {
      const { argv } = directCommandFor(kind, ['some.test.ts'])!;
      expect(argv).toContain('some.test.ts');
      expect(DIRECT_COMMANDS[kind].narrowedArgs).toBeUndefined();
    }
  );

  it('returns null for a kind it does not know', () => {
    expect(directCommandFor('bogus', [])).toBeNull();
  });
});

import { readFileSync } from 'fs';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

import { describe, expect, it } from 'vitest';

import * as QueueModule from '../../.claude/skills/dev-server/scripts/test-queue.mjs';

type LaneSpec = {
  group: string;
  script: string;
  capWorkers: boolean;
  defaultConcurrency: number;
  configKey: string;
  flag: string | null;
};

const { RUN_KINDS, RUN_GROUPS, laneConcurrencyArgs } = QueueModule as unknown as {
  RUN_KINDS: Record<string, LaneSpec>;
  RUN_GROUPS: Record<string, { defaultConcurrency: number; configKey: string; flag: string }>;
  laneConcurrencyArgs: (rest: string[]) => Record<string, number>;
};

/**
 * Lanes and groups are addressed through ONE namespace: `laneConcurrencyArgs` parses both tables
 * and the daemon writes both into one reply object. A group whose configKey or flag collided with
 * a lane's would silently move the wrong limit and report back the one you asked for, so every
 * guard below reads the union rather than the lanes alone.
 */
const ADDRESSABLE: Record<string, { configKey: string; flag: string | null }> = {
  ...RUN_KINDS,
  ...RUN_GROUPS,
};

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const cliSource = readFileSync(resolve(repoRoot, '.claude/skills/dev-server/cli.mjs'), 'utf8');
// The usage block alone. Searching the whole file would let a passing MENTION of a flag in any
// comment satisfy the help-text assertion below, which is the thing it exists to detect.
const cliUsage = cliSource.slice(cliSource.indexOf('Commands:'));
const packageScripts = JSON.parse(readFileSync(resolve(repoRoot, 'package.json'), 'utf8')).scripts;
const appsWrapperSource = readFileSync(resolve(repoRoot, 'scripts/typecheck-apps-run.mjs'), 'utf8');

/**
 * Keys the daemon's `/test-runs/config` reply writes AFTER spreading the lane limits into it
 * (daemon.mjs). A lane whose `configKey` were one of these would have its limit overwritten by the
 * literal on the way out, and would read a client's unrelated field as a limit on the way in -
 * silently, with a plausible-looking value printed either way.
 */
const RESERVED_REPLY_KEYS = ['maxWorkers', 'cacheMode', 'paused', 'queued', 'running', 'lanes'];

/**
 * 🔴 The daemon's `/test-runs/config` and the CLI's `test config` both read these fields instead
 * of naming each lane by hand. Two lanes sharing a `configKey` or a `flag` would silently collapse
 * into one knob: setting either would report back the value you asked for, having moved the other
 * lane's limit. If you are here because a lane you added collides, rename the lane's key - do not
 * relax the assertion.
 */
describe('the lane registry is addressable', () => {
  it('gives every lane a distinct, non-empty configKey', () => {
    const keys = Object.values(ADDRESSABLE).map((spec) => spec.configKey);
    // Per lane, not `arrayContaining`: that form passes as long as ONE entry is a string, so a
    // lane with no configKey at all would satisfy it and then publish its limit under "undefined".
    for (const [kind, spec] of Object.entries(ADDRESSABLE)) {
      expect(typeof spec.configKey, `${kind} has no configKey`).toBe('string');
      expect(spec.configKey.length, `${kind}'s configKey is empty`).toBeGreaterThan(0);
    }
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('never gives a lane a configKey the config reply already uses', () => {
    for (const [kind, spec] of Object.entries(ADDRESSABLE)) {
      expect(RESERVED_REPLY_KEYS, `${kind}'s configKey collides with a reply field`).not.toContain(
        spec.configKey
      );
    }
  });

  /**
   * 🔴 `RUN_KINDS[kind].script` is spawned as `pnpm run <script>`. Renaming that script in
   * package.json alone leaves the lane pointing at a name that no longer exists, and the breakage
   * surfaces only when someone next uses that lane - in the daemon's child, not here.
   */
  it('names a package script that exists for every lane', () => {
    for (const [kind, spec] of Object.entries(RUN_KINDS)) {
      expect(
        Object.keys(packageScripts),
        `${kind} is spawned as \`pnpm run ${spec.script}\`, which package.json does not define`
      ).toContain(spec.script);
    }
  });

  it('gives every flagged lane a distinct flag', () => {
    const flags = Object.values(ADDRESSABLE)
      .map((spec) => spec.flag)
      .filter((flag): flag is string => Boolean(flag));
    expect(new Set(flags).size).toBe(flags.length);
  });

  it('documents every flagged lane in the CLI help', () => {
    for (const [kind, spec] of Object.entries(ADDRESSABLE)) {
      if (!spec.flag) continue;
      expect(
        cliUsage,
        `${kind}'s flag ${spec.flag} is missing from the cli.mjs usage text`
      ).toContain(`[${spec.flag} <n>]`);
    }
  });
});

/**
 * 🔴 `--typecheck` is a PREFIX of `--typecheck-apps`. A prefix match sets the wrong lane's limit
 * and then prints back the lane the caller named, so the command reads as having worked. These
 * cases exist to make that substitution fail loudly; they are not redundant with each other.
 */
describe('laneConcurrencyArgs picks exactly the lane that was named', () => {
  it('sets only the app lane for --typecheck-apps', () => {
    expect(laneConcurrencyArgs(['--typecheck-apps', '3'])).toEqual({ typecheckAppsConcurrency: 3 });
  });

  it('sets only the root lane for --typecheck', () => {
    expect(laneConcurrencyArgs(['--typecheck', '2'])).toEqual({ typecheckConcurrency: 2 });
  });

  it('reads the inline = spelling', () => {
    expect(laneConcurrencyArgs(['--typecheck-apps=4'])).toEqual({ typecheckAppsConcurrency: 4 });
  });

  it('sets both when both are named', () => {
    expect(laneConcurrencyArgs(['--typecheck', '1', '--typecheck-apps', '2'])).toEqual({
      typecheckConcurrency: 1,
      typecheckAppsConcurrency: 2,
    });
  });

  it('sets nothing from the bare positional operand, which is the unit lane', () => {
    expect(laneConcurrencyArgs(['2'])).toEqual({});
  });
});

/**
 * 🔴 Every lane must name a group that exists. A lane with an unknown or missing group reads
 * `groupLimits[undefined]` in the admission loop, which is `undefined`, and `running >= undefined`
 * is false forever - so that lane would be admitted without any budget check at all, silently, and
 * only under load.
 */
describe('every lane belongs to a real group', () => {
  it('names a declared group', () => {
    for (const [kind, spec] of Object.entries(RUN_KINDS)) {
      expect(Object.keys(RUN_GROUPS), `${kind} has group ${String(spec.group)}`).toContain(
        spec.group
      );
    }
  });
});

/**
 * 🔴 A TEXT pin, with the blind spot that implies: it reads the wrapper's source, so it cannot see
 * a `kind` chosen at runtime or behind a condition. It exists because nothing executes
 * `scripts/typecheck-apps-run.mjs`, and the mutation it guards is one character of damage with no
 * other detector - point the wrapper at `kind: 'typecheck'` and app typechecks silently queue in
 * the ROOT typecheck lane, sharing its limit. That is the exact lane-sharing condition
 * `dev-server-test-queue-lanes.test.ts` claims to rule out, and that test builds its own queue, so
 * it never sees this file and stays green.
 *
 * Replace this with a test that runs the wrapper if you ever make its queue client injectable.
 */
describe('the app-typecheck wrapper asks for its own lane', () => {
  it('names a kind that exists in RUN_KINDS', () => {
    const named = appsWrapperSource.match(/kind:\s*'([^']+)'/)?.[1];
    expect(named, 'no `kind:` literal found in scripts/typecheck-apps-run.mjs').toBeDefined();
    expect(Object.keys(RUN_KINDS)).toContain(named);
  });

  it('names typecheckApps, not another lane', () => {
    expect(appsWrapperSource).toContain("kind: 'typecheckApps'");
  });

  it('is what package.json runs for typecheck:apps', () => {
    expect(packageScripts['typecheck:apps']).toContain('typecheck-apps-run.mjs');
  });
});

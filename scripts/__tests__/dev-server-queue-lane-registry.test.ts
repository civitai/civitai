import { readFileSync } from 'fs';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

import { describe, expect, it } from 'vitest';

import * as QueueModule from '../../.claude/skills/dev-server/scripts/test-queue.mjs';

type LaneSpec = {
  script: string;
  capWorkers: boolean;
  defaultConcurrency: number;
  configKey: string;
  flag: string | null;
};

const { RUN_KINDS, laneConcurrencyArgs } = QueueModule as unknown as {
  RUN_KINDS: Record<string, LaneSpec>;
  laneConcurrencyArgs: (rest: string[]) => Record<string, number>;
};

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const cliSource = readFileSync(resolve(repoRoot, '.claude/skills/dev-server/cli.mjs'), 'utf8');

/**
 * 🔴 The daemon's `/test-runs/config` and the CLI's `test config` both read these fields instead
 * of naming each lane by hand. Two lanes sharing a `configKey` or a `flag` would silently collapse
 * into one knob: setting either would report back the value you asked for, having moved the other
 * lane's limit. If you are here because a lane you added collides, rename the lane's key - do not
 * relax the assertion.
 */
describe('the lane registry is addressable', () => {
  it('gives every lane a distinct configKey', () => {
    const keys = Object.values(RUN_KINDS).map((spec) => spec.configKey);
    expect(keys).toEqual(expect.arrayContaining([expect.any(String)]));
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('gives every flagged lane a distinct flag', () => {
    const flags = Object.values(RUN_KINDS)
      .map((spec) => spec.flag)
      .filter((flag): flag is string => Boolean(flag));
    expect(new Set(flags).size).toBe(flags.length);
  });

  it('documents every flagged lane in the CLI help', () => {
    for (const [kind, spec] of Object.entries(RUN_KINDS)) {
      if (!spec.flag) continue;
      expect(
        cliSource,
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

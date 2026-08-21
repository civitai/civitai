import { describe, expect, it } from 'vitest';

/**
 * Both skill CLIs degraded a flag whose value was missing, empty, or `--`-prefixed into a truthy
 * placeholder — `true` in metabase, the string `'true'` in cloudflare — which every downstream guard
 * then accepted. The metabase case created Metabase cards carrying no query at all: the API reported
 * success, the card opened blank, and that reads as a permissions problem rather than a malformed
 * request. It cost a day and nearly a production DDL.
 *
 * The parsers live in their own modules because both CLIs run on import (each exits when its
 * credentials are unset), so this is the only way to exercise them without spawning a process.
 *
 * They are deliberately NOT one shared module: no skill in this repo imports from another skill's
 * directory, and creating that coupling for thirty lines is the worse trade. Both are covered here,
 * so a fix to one that is not made to the other is visible.
 */

const metabase = await import('../../.claude/skills/metabase/parse-opts.mjs');
const cloudflare = await import('../../.claude/skills/cloudflare/parse-flags.mjs');

/** Each parser reduced to `(args) => flags`, so the same cases run against both. */
const PARSERS = [
  // metabase's CLI passes the command as args[0], so its parser starts at index 1.
  ['metabase', (args: string[]) => metabase.parseOpts(['cmd', ...args])] as const,
  ['cloudflare', (args: string[]) => cloudflare.parseFlags(args).flags] as const,
];

describe.each(PARSERS)('%s flag values', (name, parse) => {
  it('rejects a flag whose value was swallowed by the next flag', () => {
    // The real shape: SQL opening with a `--` comment line, or a shell that ate the value.
    expect(() => parse(['--query', '--database', '3'])).toThrowError(/--query needs a value/);
  });

  it('rejects a flag at the end of the line with no value', () => {
    expect(() => parse(['--query'])).toThrowError(/--query needs a value/);
  });

  it('rejects an empty value', () => {
    expect(() => parse(['--query', ''])).toThrowError(/--query needs a value/);
  });

  // The escape hatch the error message names. If this stops working the message sends people nowhere.
  it('accepts a --`--`-prefixed value through --key=value', () => {
    expect(parse(['--query=--comment first', '--database', '3'])).toMatchObject({
      query: '--comment first',
      database: '3',
    });
  });

  it('still parses an ordinary flag', () => {
    expect(parse(['--database', '3'])).toMatchObject({ database: '3' });
  });

  it('never yields a non-string value for a value-taking flag', () => {
    const parsed = parse(['--database', '3', '--query=SELECT 1']);
    for (const [key, value] of Object.entries(parsed)) {
      expect(typeof value, `${name} parsed --${key} as ${typeof value}`).toBe('string');
    }
  });
});

// Each CLI has flags that genuinely carry no value, and the whole fix rests on that list being right:
// a boolean flag left off it starts erroring, and a value-taking flag added to it silently degrades again.
describe('boolean flags keep working', () => {
  it('metabase --required', () => {
    expect(metabase.parseOpts(['cmd', '--id', '1', '--required'])).toMatchObject({
      required: true,
    });
    expect(metabase.BOOLEAN_FLAGS.has('required')).toBe(true);
  });

  it('cloudflare --apply, --skip-disabled and --pro-compat', () => {
    const { flags } = cloudflare.parseFlags(['port-rules', '--apply', '--skip-disabled']);
    // The CLI reads these as `=== 'true'`, so the string is the contract, not a boolean.
    expect(flags).toMatchObject({ apply: 'true', 'skip-disabled': 'true' });
    expect([...cloudflare.BOOLEAN_FLAGS].sort()).toEqual(['apply', 'pro-compat', 'skip-disabled']);
  });

  it('cloudflare keeps positional arguments', () => {
    const { positional } = cloudflare.parseFlags(['top-paths', '--limit', '5', 'extra']);
    expect(positional).toEqual(['top-paths', 'extra']);
  });
});

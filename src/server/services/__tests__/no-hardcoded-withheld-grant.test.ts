import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'fs';
import path from 'path';

/**
 * 🔴 Fails when server code sets `csamReview` to anything but the caller's own grant, `false`, or a
 * value passed through. The writers take the grant as an argument, so a hard-coded `true` at an entry
 * point leaves every service test green while the withheld rule stops applying.
 */

const REPO = path.resolve(__dirname, '../../../..');
const ROOT = path.join(REPO, 'src/server');

/** A text-scan setting of the same name, not a moderator's grant. */
const SKIP_DIRS = ['src/server/services/text-scan'];

const ALLOWED_VALUES = [
  'false',
  '!!ctx.features?.csamReports',
  'ctx.user.isModerator && !!ctx.features?.csamReports',
  '!!getFeatureFlags({ user, req }).csamReports',
  '!!getFeatureFlags({ user: ctx.actor, req: ctx.req }).csamReports',
  'input.csamReview',
];

// What may follow an allowed value: the end of the argument, the object or the statement.
const TERMINATOR = /^\s*(?:[,;)}]|$)/;

const SETTING = /\bcsamReview(\??)\s*([:=])(?!=)\s*/g;

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    const rel = path.relative(REPO, full).split(path.sep).join('/');
    if (statSync(full).isDirectory()) {
      if (entry === '__tests__' || SKIP_DIRS.includes(rel)) continue;
      walk(full, out);
    } else if (/\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
}

/** The setting's value if it is not a type annotation; `null` when it is one. */
function settingValue(line: string, match: RegExpMatchArray) {
  const rest = line.slice((match.index ?? 0) + match[0].length);
  if (match[1] === '?' || /^boolean\b/.test(rest)) return null;
  return rest;
}

function isAllowedValue(rest: string) {
  return ALLOWED_VALUES.some(
    (value) => rest.startsWith(value) && TERMINATOR.test(rest.slice(value.length))
  );
}

function violations() {
  const found: string[] = [];
  for (const file of walk(ROOT)) {
    const lines = readFileSync(file, 'utf8').split('\n');
    lines.forEach((line, i) => {
      for (const match of line.matchAll(SETTING)) {
        const rest = settingValue(line, match);
        if (rest !== null && !isAllowedValue(rest))
          found.push(`${path.relative(REPO, file)}:${i + 1}: ${line.trim()}`);
      }
    });
  }
  return found;
}

describe('no-hardcoded-withheld-grant', () => {
  it('sets csamReview only from the caller, to false, or passed through', () => {
    expect(violations()).toEqual([]);
  });

  it('scans the entry points that set it', () => {
    const source = readFileSync(
      path.join(REPO, 'src/server/controllers/image.controller.ts'),
      'utf8'
    );
    expect([...source.matchAll(SETTING)].length).toBeGreaterThan(0);
  });

  it.each(['true })', '!!ctx.features?.csamReports || true', 'isModerator,', 'true'])(
    'control: refuses `%s`',
    (value) => {
      expect(isAllowedValue(value)).toBe(false);
    }
  );

  it.each(['!!ctx.features?.csamReports,', 'false }', 'input.csamReview })', 'false'])(
    'control: accepts `%s`',
    (value) => {
      expect(isAllowedValue(value)).toBe(true);
    }
  );
});

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
const PAGES = path.join(REPO, 'src/pages');
const MODERATOR_APP = path.join(REPO, 'apps/moderator/src');

/** A text-scan setting of the same name, not a moderator's grant. */
const SKIP_DIRS = ['src/server/services/text-scan'];

const ALLOWED_VALUES = [
  'false',
  '!!ctx.features?.csamReports',
  'ctx.user.isModerator && !!ctx.features?.csamReports',
  '!!getFeatureFlags({ user, req }).csamReports',
  '!!getFeatureFlags({ user: ctx.actor, req: ctx.req }).csamReports',
  'input.csamReview',
  // A token route's request schema: the moderator app forwards its moderator's grant, fail-closed.
  // WebhookEndpoint routes only: in a session or tRPC input a client would assert its own grant.
  'forwardedCsamGrantInBody',
  'forwardedCsamGrantInQuery',
];

/** The moderator app takes the grant from its own access check, never from a request. */
const MODERATOR_APP_ALLOWED_VALUES = [
  'false',
  'holdsCsamReview(locals.user)',
  'holdsCsamReview(user)',
  'holdsCsamReview(viewer)',
  'input.csamReview',
  'String(input.csamReview)',
];

const FORWARDED_GRANT = /\bforwardedCsamGrantIn(?:Body|Query)\b/;
const FORWARDED_GRANT_HOME = 'src/server/services/moderator-withheld.service.ts';

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

function isAllowedValue(rest: string, allowed = ALLOWED_VALUES) {
  return allowed.some(
    (value) => rest.startsWith(value) && TERMINATOR.test(rest.slice(value.length))
  );
}

function settingViolations(files: string[], allowed: string[]) {
  const found: string[] = [];
  for (const file of files) {
    const lines = readFileSync(file, 'utf8').split('\n');
    lines.forEach((line, i) => {
      for (const match of line.matchAll(SETTING)) {
        const rest = settingValue(line, match);
        if (rest !== null && !isAllowedValue(rest, allowed))
          found.push(`${path.relative(REPO, file)}:${i + 1}: ${line.trim()}`);
      }
    });
  }
  return found;
}

const violations = () => settingViolations(walk(ROOT), ALLOWED_VALUES);

/**
 * Whether a file that names a forwarded-grant schema may: only a token route, whose default export is
 * a `WebhookEndpoint`. Named in any form (an import, a destructured or aliased binding, a namespace
 * member), so a rename cannot carry it into a session or tRPC input.
 */
function mayNameForwardedGrant(source: string) {
  return /\bexport\s+default\s+WebhookEndpoint\(/.test(source);
}

function forwardedGrantViolations() {
  return [...walk(ROOT), ...walk(PAGES), ...walk(MODERATOR_APP)]
    .map((file) => [path.relative(REPO, file).split(path.sep).join('/'), file] as const)
    .filter(([rel]) => rel !== FORWARDED_GRANT_HOME)
    .filter(([, file]) => {
      const source = readFileSync(file, 'utf8');
      return FORWARDED_GRANT.test(source) && !mayNameForwardedGrant(source);
    })
    .map(([rel]) => rel);
}

describe('no-hardcoded-withheld-grant', () => {
  it('sets csamReview only from the caller, to false, or passed through', () => {
    expect(violations()).toEqual([]);
  });

  it('sets csamReview in the moderator app only from its own access check, or to false', () => {
    expect(settingViolations(walk(MODERATOR_APP), MODERATOR_APP_ALLOWED_VALUES)).toEqual([]);
  });

  it('names a forwarded-grant schema only in a WebhookEndpoint route', () => {
    expect(forwardedGrantViolations()).toEqual([]);
  });

  it('scans the routes that name a forwarded-grant schema, and the moderator app', () => {
    expect(
      walk(ROOT).filter((file) => FORWARDED_GRANT.test(readFileSync(file, 'utf8'))).length
    ).toBeGreaterThan(1);
    expect(
      walk(MODERATOR_APP).filter((file) =>
        new RegExp(SETTING.source).test(readFileSync(file, 'utf8'))
      ).length
    ).toBeGreaterThan(0);
  });

  it.each([
    [
      'a tRPC procedure',
      `import { forwardedCsamGrantInBody } from 'x';\nexport const r = router({});`,
    ],
    ['an aliased import', `import { forwardedCsamGrantInQuery as grant } from 'x';`],
    ['a destructured binding', `const { forwardedCsamGrantInBody: grant } = mod;`],
    [
      'a named WebhookEndpoint',
      `export const h = WebhookEndpoint(() => forwardedCsamGrantInBody);`,
    ],
  ])('control: refuses %s', (_, source) => {
    expect(FORWARDED_GRANT.test(source) && !mayNameForwardedGrant(source)).toBe(true);
  });

  it('control: accepts a WebhookEndpoint route', () => {
    const source = `const s = z.object({ csamReview: forwardedCsamGrantInQuery });\nexport default WebhookEndpoint(async function h() {});`;
    expect(FORWARDED_GRANT.test(source) && !mayNameForwardedGrant(source)).toBe(false);
  });

  it.each(['true', 'locals.user.isModerator', "url.searchParams.get('csamReview') === 'true'"])(
    'control: refuses `%s` in the moderator app',
    (value) => {
      expect(isAllowedValue(value, MODERATOR_APP_ALLOWED_VALUES)).toBe(false);
    }
  );

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

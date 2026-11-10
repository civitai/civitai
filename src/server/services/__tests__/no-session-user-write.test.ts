import { readdirSync, readFileSync, statSync } from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

/**
 * 🔴 Server code never writes to a field of the request's session user (`ctx.user`, or a user
 * object handed down from it). Other code reads the same object, so a write meant for one read
 * changes it for them too. Pass a copy: `{ ...user, isModerator: true }`.
 */

const SRC = path.resolve(__dirname, '../../../../src');
const CODE_EXTENSIONS = new Set(['.ts', '.tsx']);
const TEST_FILE = /\.test\.tsx?$|(^|\/)__tests__\//;

const SESSION_USER_WRITE = [
  /\bctx\.user!?\??\.\w+\s*(?:[-+*/|&]|\?\?)?=(?!=)/,
  /\b\w*[uU]ser!?\??\.isModerator\s*(?:\|\||&&|\?\?)?=(?!=)/,
  /Object\.assign\(\s*ctx\.user\b/,
];

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules') continue;
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (CODE_EXTENSIONS.has(path.extname(entry))) out.push(full);
  }
  return out;
}

const files = walk(path.join(SRC, 'server'))
  .concat(walk(path.join(SRC, 'pages', 'api')))
  .map((file) => path.relative(SRC, file).split(path.sep).join('/'))
  .filter((file) => !TEST_FILE.test(file));

const writesSessionUser = (source: string) => SESSION_USER_WRITE.some((re) => re.test(source));
const read = (file: string) => readFileSync(path.join(SRC, file), 'utf8');

describe("🔴 server code never writes to the request's session user", () => {
  it('the scan reached the source tree', () => {
    expect(files.length).toBeGreaterThan(1000);
  });

  it.each([
    ['user.isModerator = true;'],
    ['  sessionUser.isModerator ||= true'],
    ['ctx.user.isModerator = true'],
    ['ctx.user!.tier = "pro"'],
    ['ctx.user.id ??= 1'],
    ['Object.assign(ctx.user, { isModerator: true })'],
  ])('flags %j', (source) => {
    expect(writesSessionUser(source)).toBe(true);
  });

  it.each([
    ['user = { ...user, isModerator: true };'],
    ['if (user.isModerator === true) return;'],
    ['const isMod = ctx.user?.isModerator;'],
    ['ctx.user.id == other'],
    ['`user.id = ${viewerId}`'],
  ])('allows %j', (source) => {
    expect(writesSessionUser(source)).toBe(false);
  });

  it('no non-test server file writes to a session user field', () => {
    expect(files.filter((file) => writesSessionUser(read(file)))).toEqual([]);
  });
});

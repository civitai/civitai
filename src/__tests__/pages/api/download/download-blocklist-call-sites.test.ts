import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Every download-route read of the ip/user blocklist goes through the cached reader.
 *
 * Only the attachments route has a behavioural cache test; the others' blocklist tests mock the
 * database directly, so reverting one of them to an inline `keyValue.findUnique` would leave
 * every test green. This pins the relationship instead: the exact set of reader call sites (it
 * fails if the set grows or shrinks), and no file outside the reader that pairs a
 * `keyValue.findUnique`/`findFirst` call with either row's literal key. It does not see a read
 * through a variable key or `findMany`; it does not pin which row each call site passes.
 */

const SRC = path.resolve(__dirname, '../../../..');
const SERVICE = 'server/services/download-blocklist.service.ts';

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === '__tests__' || entry.name === 'node_modules') continue;
      out.push(...sourceFiles(abs));
    } else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) {
      out.push(abs);
    }
  }
  return out;
}

const files = sourceFiles(SRC).map((abs) => ({
  rel: path.relative(SRC, abs).split(path.sep).join('/'),
  text: fs.readFileSync(abs, 'utf8'),
}));

describe('download blocklist call sites', () => {
  it('reads each blocklist row only through getDownloadBlocklistValue', () => {
    const calls: string[] = [];
    for (const { rel, text } of files) {
      for (const m of text.matchAll(/getDownloadBlocklistValue\('([a-z-]+)'\)/g))
        calls.push(`${rel} ${m[1]}`);
    }
    expect(calls.sort()).toEqual(
      [
        'pages/api/download/[...key].ts ip-blacklist',
        'pages/api/download/attachments/[fileId].ts ip-blacklist',
        'pages/api/download/attachments/[fileId].ts user-blacklist',
        'pages/api/download/models/[modelVersionId].ts ip-blacklist',
        'pages/api/download/models/[modelVersionId].ts user-blacklist',
        'pages/api/download/vault/[vaultItemId].ts ip-blacklist',
      ].sort()
    );
  });

  it('has no inline database read of either row outside the cached reader', () => {
    // Positive control: the reader's own inline read must be found, so a pattern that can no
    // longer match anything cannot report a clean zero.
    const inline = files
      .filter(({ rel }) => rel !== SERVICE)
      .filter(({ text }) => /keyValue\.find(Unique|First)\(/.test(text))
      .filter(({ text }) => /'(ip|user)-blacklist'/.test(text))
      .map(({ rel }) => rel);
    const serviceText = files.find(({ rel }) => rel === SERVICE)?.text ?? '';
    expect(serviceText).toMatch(/keyValue\.findUnique\(/);
    expect(inline).toEqual([]);
  });
});

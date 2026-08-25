import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';
import { getTosMeta } from '~/server/services/content.service';
import { TOS_PROHIBITED_CONTENT_ID } from '~/components/Markdown/rehype-tos-section-ids';

/**
 * The ToS modal scrolls a struck user to §9.6 by an id that lives in the ToS files themselves.
 * Nothing else records that dependency, so this is where a ToS edit finds out it broke something.
 *
 * The identity test is the one that matters operationally: re-acceptance is triggered by comparing
 * the ToS body's hash against what the user accepted, so ANY edit re-prompts everyone unless its new
 * hash is aliased back. It goes through `getTosMeta` — the function the client actually reads — so it
 * covers the hasher, the alias table AND the per-domain file selection. Asserting against a local
 * re-implementation of the hash would leave the hasher itself unguarded.
 */
const CONTENT_ROOT = join(process.cwd(), 'src', 'static-content');

/** `tos.md` -> blue (and red, which has no file of its own); `tos.<x>.md` -> x. */
const tosFiles = readdirSync(CONTENT_ROOT).filter((f) => /^tos(\.[\w-]+)?\.md$/.test(f));

/**
 * What `getTosMeta` advertised before the anchor was added — the identity users have already
 * accepted. It must keep advertising these, or everyone is asked to re-accept.
 */
const ACCEPTED_IDENTITY: Record<string, string> = {
  blue: '31f28b3e38065449f2ea1e9a342e64e79f3c1bcbe10d6185cad484f4ceebce6f',
  red: '31f28b3e38065449f2ea1e9a342e64e79f3c1bcbe10d6185cad484f4ceebce6f', // no tos.red.md — falls back to tos.md
  green: '978c839dea33653f13bce7440d91f4024e886e93557d4deb5718086c904ce0b5',
};

describe('ToS prohibited-content anchor', () => {
  it.each(tosFiles)('%s carries the anchor the ToS modal scrolls to', (file) => {
    const body = readFileSync(join(CONTENT_ROOT, file), 'utf-8');

    expect(
      body,
      `${file} lost id="${TOS_PROHIBITED_CONTENT_ID}". The ToS modal scrolls struck users to §9.6 by it —` +
        ` put it back on the "expressly prohibited" line, or drop the deep link deliberately.`
    ).toContain(`id="${TOS_PROHIBITED_CONTENT_ID}"`);

    // On the prohibited list, not merely somewhere in the document.
    const anchorLine = body.split('\n').find((l) => l.includes(TOS_PROHIBITED_CONTENT_ID)) ?? '';
    expect(anchorLine.toLowerCase()).toContain('expressly prohibited');
  });

  it('every ToS variant on disk is covered by the identity check below', () => {
    // A variant nobody listed would otherwise be silently exempt from the re-prompt guard — and the
    // FIRST edit to it is harmless (nobody has accepted it), so the gap only bites on the second.
    const domains = tosFiles.map((f) => (f === 'tos.md' ? 'blue' : f.slice(4, -3)));
    for (const domain of domains) {
      expect(
        ACCEPTED_IDENTITY[domain],
        `tos.${domain}.md has no entry in ACCEPTED_IDENTITY. Add the hash getTosMeta currently` +
          ` advertises for it, so a later edit cannot re-prompt everyone who accepted it.`
      ).toBeDefined();
    }
  });

  it.each(Object.keys(ACCEPTED_IDENTITY))(
    '%s still advertises the identity users have accepted',
    async (domainColor) => {
      const expected = ACCEPTED_IDENTITY[domainColor];
      const { hash } = await getTosMeta({ domainColor });

      expect(
        hash,
        `The ${domainColor} ToS changed and its new hash is not aliased, so EVERY user on it will be\n` +
          `asked to re-accept. If the edit carries no legal meaning, add the new hash to\n` +
          `tosHashOverrideMap pointing at ${expected}. If it does, update ACCEPTED_IDENTITY here —\n` +
          `that is the decision to re-prompt.`
      ).toBe(expected);
    }
  );
});

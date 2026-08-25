import { vi, describe, it, expect, beforeEach } from 'vitest';
import { TRPCError } from '@trpc/server';

import { throwOnBlockedCommentContent } from '../blocklist.service';
import { BlocklistType } from '~/server/common/enums';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { redisMock } from '~/__tests__/mocks/redis.mock';
import { loggingMock } from '~/__tests__/mocks/logging.mock';

void dbMock;
void loggingMock;

const redisGet = redisMock.redis.get;

/**
 * `getBlocklistData` reads redis first and skips the DB entirely on a hit, so a keyed
 * `get` stub drives the whole guard. Keyed rather than a flat `mockResolvedValue` because
 * this guard reads BOTH lists — one blob would serve the patterns as link domains too.
 */
function setLists({ domains = [], patterns = [] }: { domains?: string[]; patterns?: string[] }) {
  redisGet.mockImplementation(async (key: string) => {
    if (key.endsWith(`:${BlocklistType.LinkDomain}`))
      return JSON.stringify({ type: BlocklistType.LinkDomain, data: domains });
    if (key.endsWith(`:${BlocklistType.MessagePattern}`))
      return JSON.stringify({ type: BlocklistType.MessagePattern, data: patterns });
    return null;
  });
}

const rejection = async (content: string) => {
  try {
    await throwOnBlockedCommentContent(content);
  } catch (e) {
    return e;
  }
  return null;
};

const PHISH = 'phish-verify592807.example';

describe('throwOnBlockedCommentContent', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('lets an ordinary comment through', async () => {
    setLists({
      domains: ['blocked.example'],
      patterns: [PHISH, 'to safely unlock your held balance'],
    });
    await expect(
      throwOnBlockedCommentContent('<p>Great model, thanks for sharing!</p>')
    ).resolves.toBeUndefined();
  });

  /**
   * The ticket itself (868kw2f8y). `MessagePattern` was enforced on DMs and on nothing else,
   * which is how 366 accounts posted phishing comments in four hours on 2026-08-24. Revert the
   * `MessagePattern` read in `throwOnBlockedCommentContent` and this is the assertion that fails.
   */
  it('enforces the MessagePattern list on comments, not only on DMs', async () => {
    setLists({ patterns: ['to safely unlock your held balance'] });

    const error = await rejection(
      '<p>Please verify your identity to safely unlock your held balance.</p>'
    );
    expect(error).toBeInstanceOf(TRPCError);
    expect((error as TRPCError).code).toBe('BAD_REQUEST');
  });

  /**
   * 🔴 Do not "simplify" this guard to scan one normalised form. Each case below is a form
   * that a DIFFERENT single choice misses, and all four were measured against the real
   * sanitiser before this test was written:
   *
   * - a tag inside the pattern defeats the raw string
   * - an `href` is gone once tags are stripped, so the stripped form misses a link whose
   *   visible text is only "click"
   * - `removeTags` joins with a SPACE, which does not close the first case
   * - joining with nothing glues adjacent block tags, which breaks a pattern needing the space
   *
   * If you remove a form, one of these four goes green-but-useless rather than failing.
   */
  describe('scans every form, because no single form covers all of them', () => {
    it('catches a pattern split by an inline tag', async () => {
      setLists({ patterns: [PHISH] });
      const error = await rejection(
        `<p>Verify at https://phish-verify<strong>5</strong>92807.example/x</p>`
      );
      expect(error).toBeInstanceOf(TRPCError);
    });

    it('catches a pattern split by a sticker span', async () => {
      setLists({ patterns: [PHISH] });
      const error = await rejection(
        `<p>https://phish-verify<span data-type="sticker" data-id="1"></span>592807.example/x</p>`
      );
      expect(error).toBeInstanceOf(TRPCError);
    });

    it('catches a blocked domain that exists only inside an href', async () => {
      setLists({ domains: ['phish-verify592807.example'] });
      const error = await rejection(`<p><a href="https://${PHISH}/x" rel="ugc">click</a></p>`);
      expect(error).toBeInstanceOf(TRPCError);
    });

    it('catches a multi-word pattern spanning two block tags', async () => {
      setLists({ patterns: ['unlock your held balance'] });
      const error = await rejection('<p>unlock</p><p>your held balance</p>');
      expect(error).toBeInstanceOf(TRPCError);
    });
  });

  /**
   * 19 of the 90 live entries are non-ASCII, several of them Unicode skins of an entry that is
   * also on the list in ASCII — moderators were adding a row per alphabet because the matcher
   * compared code points. Both directions have to work or the folding is worse than useless:
   * fold only the content and those 19 entries stop matching anything at all.
   */
  describe('folds confusables on both sides', () => {
    it('catches small-caps content against an ASCII pattern', async () => {
      setLists({ patterns: ['example security desk'] });
      const error = await rejection('<p>ᴇxᴀᴍᴘʟᴇ sᴇᴄᴜʀɪᴛʏ ᴅᴇsᴋ here, verify your account</p>');
      expect(error).toBeInstanceOf(TRPCError);
    });

    /**
     * 🔴 The stored PATTERN is deliberately not folded, and this is the test that says so.
     * Do not "fix" it by folding entries in `substringEntries` so a stylised row catches its
     * ASCII spelling. Measured on the live list: 17 of the 19 non-ASCII rows fold to a string
     * nobody added, and two fold to a single ordinary English word that appeared in 44 of
     * 94,376 comments and 42 of 87,113 DMs over 30 days. A substring rule that eats a common
     * word cannot be undone by a moderator; a missing ASCII row can be added by one. The live
     * rows are deliberately not quoted here — this repo is public.
     */
    it('does not let a stylised entry become an ASCII rule nobody wrote', async () => {
      setLists({ patterns: ['ᴀᴄᴄᴏᴜɴᴛ'] });
      await expect(
        throwOnBlockedCommentContent('<p>Updated my account settings, thanks!</p>')
      ).resolves.toBeUndefined();

      // Control: the stylised spelling the moderator actually typed is still blocked, so the
      // pass above is the entry staying narrow rather than the rule being inert.
      expect(await rejection('<p>complete your ᴀᴄᴄᴏᴜɴᴛ now</p>')).toBeInstanceOf(TRPCError);
    });

    /**
     * Link domains are matched with `===` against `url.host`, so folding a stored domain yields
     * one more exact host and cannot broaden anything - which is why `exactEntries` folds and
     * `substringEntries` does not. Drop the fold in `exactEntries` and this fails: 6 of the 696
     * live domain rows are non-ASCII and would then enforce nothing.
     */
    it('catches an ASCII host against a non-ASCII stored domain entry', async () => {
      setLists({
        domains: [
          '\u{1D5BE}\u{1D5D1}\u{1D5BA}\u{1D5C6}\u{1D5C9}\u{1D5C5}\u{1D5BE}verify.short.example',
        ],
      });
      const error = await rejection('<p>go to https://exampleverify.short.example/x now</p>');
      expect(error).toBeInstanceOf(TRPCError);
    });

    /**
     * NFKC specifically. Obscenity's confusables map already covers fullwidth and several maths
     * blocks, so most stylised fixtures still pass with `.normalize('NFKC')` deleted. U+1D42F
     * (MATHEMATICAL BOLD SMALL V) is one the map does NOT carry, so this is the fixture that
     * actually pins the step.
     */
    it('catches a mathematical-alphanumeric character the confusables map does not cover', async () => {
      setLists({ patterns: ['phish-verify592807.example'] });
      const error = await rejection('<p>go to phish-\u{1D42F}erify592807.example now</p>');
      expect(error).toBeInstanceOf(TRPCError);
    });

    /**
     * The variation selector supplement (U+E0100-U+E01EF) is category `Mn`, so `\p{Cf}` misses
     * it - the same bypass as the tag characters above, one block over.
     */
    it('catches a variation selector inserted mid-pattern', async () => {
      setLists({ patterns: [PHISH] });
      const error = await rejection('<p>go to phish-verify\u{E0100}592807.example now</p>');
      expect(error).toBeInstanceOf(TRPCError);
    });

    it('catches a Cyrillic lookalike domain', async () => {
      setLists({ patterns: [PHISH] });
      // The leading character is U+0440 (Cyrillic er), not an ASCII `p`. It is invisible as a
      // difference, so do not retype this fixture by eye.
      const error = await rejection('<p>go to рhish-verify592807.example now</p>');
      expect(error).toBeInstanceOf(TRPCError);
    });

    it('catches a zero-width space inserted mid-pattern', async () => {
      setLists({ patterns: [PHISH] });
      const error = await rejection('<p>go to phish-verify​592807.example now</p>');
      expect(error).toBeInstanceOf(TRPCError);
    });

    /**
     * A hand-written list of invisible characters is a normaliser with an invisible hole. This
     * one is a Unicode TAG character (U+E0020) - renders as nothing, legal between two letters,
     * and missed by the enumeration that preceded `\p{Cf}` here, along with 144 others.
     * Narrow `INVISIBLE` in `confusable-fold.ts` back to a literal list and this is what fails.
     */
    it('catches an invisible character outside the obvious zero-width block', async () => {
      setLists({ patterns: [PHISH] });
      const error = await rejection('<p>go to phish-verify\u{E0020}592807.example now</p>');
      expect(error).toBeInstanceOf(TRPCError);
    });

    /**
     * 🔴 The one way this feature can take the site down. `includes('')` is true for every
     * string, so a single empty pattern blocks every comment — and folding MANUFACTURES that
     * case, because a pattern of nothing but invisible characters folds to `''`. Delete the
     * `.filter(...)` in `matchableEntries` and this test is the only thing that says so.
     */
    it('does not block every comment when a pattern folds away to nothing', async () => {
      setLists({ patterns: ['​​', ''] });
      await expect(
        throwOnBlockedCommentContent('<p>Lovely work, thanks for posting.</p>')
      ).resolves.toBeUndefined();
    });
  });

  /**
   * Host spellings that mean the same host to a browser but not to `===`. Each of these was
   * verified to PASS the guard before the fix, against an entry the plain URL is blocked by.
   */
  describe('normalises the host before comparing it to the domain list', () => {
    const DOMAIN = 'blocked.example';

    it('blocks a plain URL (the control the three below are measured against)', async () => {
      setLists({ domains: [DOMAIN] });
      expect(await rejection('<p>see https://blocked.example/x</p>')).toBeInstanceOf(TRPCError);
    });

    /**
     * The one that mattered most. `sanitizeHtml` stores a scheme-relative href verbatim, the
     * browser resolves it to a live link, and a scheme-anchored regex sees no URL at all - so
     * this defeated the whole domain half of the guard with a one-character edit.
     */
    it('blocks a scheme-relative href', async () => {
      setLists({ domains: [DOMAIN] });
      expect(
        await rejection('<p><a href="//blocked.example/x" rel="ugc">click</a></p>')
      ).toBeInstanceOf(TRPCError);
    });

    it('blocks a host carrying a non-default port', async () => {
      setLists({ domains: [DOMAIN] });
      expect(await rejection('<p>see http://blocked.example:8080/x</p>')).toBeInstanceOf(TRPCError);
    });

    it('blocks a trailing-dot FQDN', async () => {
      setLists({ domains: [DOMAIN] });
      expect(await rejection('<p>see https://blocked.example./x</p>')).toBeInstanceOf(TRPCError);
    });

    /**
     * The cost of making the scheme optional: a bare `//` now anchors a match wherever it
     * appears, so a pasted path or code comment can be parsed as a link. That direction only
     * ever over-blocks, never bypasses — these three pin where the line actually falls, because
     * "it only over-blocks" is not an answer to "does it reject legitimate comments".
     */
    it('ignores a scheme-less path with no dotted host in it', async () => {
      setLists({ domains: [DOMAIN] });
      await expect(
        throwOnBlockedCommentContent('<pre><code>src = "//assets/img/logo.png";</code></pre>')
      ).resolves.toBeUndefined();
    });

    it('ignores a scheme-less path whose host is not on the list', async () => {
      setLists({ domains: [DOMAIN] });
      await expect(
        throwOnBlockedCommentContent('<pre><code>fetch("//cdn.jsdelivr.net/x");</code></pre>')
      ).resolves.toBeUndefined();
    });

    // The one real over-block, pinned as chosen: a scheme-less reference to a LISTED host is
    // still a working link once rendered, so blocking it in a code block is the right answer.
    it('blocks a scheme-less reference to a listed host even inside a code block', async () => {
      setLists({ domains: [DOMAIN] });
      expect(
        await rejection('<pre><code>fetch("//blocked.example/x");</code></pre>')
      ).toBeInstanceOf(TRPCError);
    });

    // Not covered on purpose: matching a subdomain against a bare entry would also block every
    // subdomain of every host on the list, which is a moderation decision rather than a
    // normalisation one. Pinned so the omission reads as chosen.
    it('does NOT block a subdomain of a listed host', async () => {
      setLists({ domains: [DOMAIN] });
      await expect(
        throwOnBlockedCommentContent('<p>see https://www.blocked.example/x</p>')
      ).resolves.toBeUndefined();
    });
  });

  /**
   * `' '` is a substring of essentially every comment, so a single whitespace entry is the same
   * site-wide outage as an empty one. The write path filters on length alone, so a moderator
   * pasting a stray space stores one.
   */
  it('does not block every comment when an entry is only whitespace', async () => {
    setLists({ patterns: [' ', '\u00a0'] });
    await expect(
      throwOnBlockedCommentContent('<p>Lovely work, thanks for posting.</p>')
    ).resolves.toBeUndefined();
  });

  /**
   * Decision 1, 2026-08-24: moderators are exempt, as they already are on DMs. Several of these
   * patterns ARE the phishing text, and quoting it to warn people is a thing moderators do —
   * there is a live comment on the site doing exactly that.
   */
  it('exempts moderators from BOTH lists, links included', async () => {
    setLists({ patterns: ['to safely unlock your held balance'], domains: ['blocked.example'] });

    // The link half is the deliberate part: on `main` moderators WERE subject to the
    // link-domain check on comments, and this exemption removes that. Justin's call,
    // 2026-08-24, asked explicitly after the review flagged it as an unintended relaxation.
    // Do not restore the link check for moderators without re-asking.
    await expect(
      throwOnBlockedCommentContent('<p>this scam links to https://blocked.example/x</p>', {
        isModerator: true,
      })
    ).resolves.toBeUndefined();
    expect(await rejection('<p>this scam links to https://blocked.example/x</p>')).toBeInstanceOf(
      TRPCError
    );

    setLists({ patterns: ['to safely unlock your held balance'] });

    await expect(
      throwOnBlockedCommentContent(
        '<p>Scam alert: "to safely unlock your held balance" is a phish.</p>',
        {
          isModerator: true,
        }
      )
    ).resolves.toBeUndefined();

    // Control: the same content from a non-moderator is rejected, so the pass above is the
    // exemption and not an inert list.
    expect(
      await rejection('<p>Scam alert: "to safely unlock your held balance" is a phish.</p>')
    ).toBeInstanceOf(TRPCError);
  });
});

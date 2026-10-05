import { describe, expect, it } from 'vitest';
import {
  createProfanityFilter,
  LIBRARY_OVERMATCH_TOKENS,
  type SimpleProfanityFilter,
} from '~/libs/profanity-simple';
import { blockedWords, whitelistWords } from '@civitai/mod-utils/profanity/lists';

/**
 * obscenity's `fuck` phrase carries `|fu|`, so a bare `fu` token matched and blocked legitimate
 * Danbooru tags in the trainer's audit — 143 `Tag` rows carry one, including `fu hua`, `fu xuan`
 * and `fu manchu` (ClickUp 868m5agjq, Freshdesk 72556).
 */

const analyze = (filter: SimpleProfanityFilter, text: string) => filter.analyze(text);

describe('LIBRARY_OVERMATCH_TOKENS', () => {
  it('is the one token obscenity over-matches', () => {
    expect([...LIBRARY_OVERMATCH_TOKENS]).toEqual(['fu']);
  });

  // `whitelistSet` drops any entry that is also one of our blocked words, so adding `fu` to
  // blocked-words.json would make this silently INERT rather than wrong.
  it('no floor token is also one of our blocked words', () => {
    const blocked = new Set(
      (blockedWords as string[]).map((w) => w.replace(/\|/g, '').trim().toLowerCase())
    );
    for (const token of LIBRARY_OVERMATCH_TOKENS) {
      expect(blocked.has(token), token).toBe(false);
    }
  });

  it('is not duplicated into whitelist-words.json', () => {
    for (const token of LIBRARY_OVERMATCH_TOKENS) {
      expect((whitelistWords as string[]).includes(token), token).toBe(false);
    }
  });
});

describe('the reported false positives are clean', () => {
  const cases = [
    'fu manchu mustache',
    '1girl, fu manchu mustache, solo',
    'fu manchu',
    'fu',
    'fu dog',
    'fu xi',
    'FU MANCHU MUSTACHE',
  ];

  it.each(cases)('%s', (text) => {
    expect(analyze(createProfanityFilter(), text)).toMatchObject({
      isProfane: false,
      matchedWords: [],
    });
  });

  // Must survive a moderator whitelist, which REPLACES whitelist-words.json.
  it.each(cases)('%s — under a moderator whitelist', (text) => {
    const filter = createProfanityFilter({ moderatorWhitelist: ['spreadsheet'] });
    expect(analyze(filter, text).isProfane).toBe(false);
  });

  it.each(cases)('%s — under an emptied moderator whitelist', (text) => {
    const filter = createProfanityFilter({ moderatorWhitelist: [] });
    expect(analyze(filter, text).isProfane).toBe(false);
  });
});

describe('detection of the actual word is unchanged', () => {
  const stillBlocked = [
    'fuck',
    'fucking',
    'motherfucker',
    'fuk',
    'fukin',
    'fuks',
    'fk',
    'fkin',
    'fking',
    'fkn',
    'fck',
    'f*ck',
    'fuuuck',
    'FUCK',
    'what the fuck',
    'fu manchu mustache, fucking angry',
  ];

  it.each(stillBlocked)('%s', (text) => {
    expect(analyze(createProfanityFilter(), text).isProfane, text).toBe(true);
  });

  it.each(stillBlocked)('%s — under an emptied moderator whitelist', (text) => {
    const filter = createProfanityFilter({ moderatorWhitelist: [] });
    expect(analyze(filter, text).isProfane, text).toBe(true);
  });

  it('other short obscenity patterns are untouched by this change', () => {
    const filter = createProfanityFilter();
    for (const text of ['tit', 'great tit', 'fagus', 'moby dick']) {
      expect(analyze(filter, text).isProfane, text).toBe(true);
    }
  });

  it('kung fu stays clean, as it already was', () => {
    expect(analyze(createProfanityFilter(), 'kung fu').isProfane).toBe(false);
  });
});

/**
 * Accepted cost: a bare `fu` abbreviation now passes, as do the space-split evasions that
 * `|fu|` used to catch incidentally (`fu c k`, `fu'ta` — both real `Tag` rows). Judged worth
 * 143 legitimate tags, and profanity is a click-through anyway, so those were never stopped.
 * Not only on green, since `evaluateContent`'s auto-NSFW path has no domain gate.
 */
describe('accepted cost', () => {
  it.each(['fu you', 'fu c k', "fu'ta"])('%s passes', (text) => {
    expect(analyze(createProfanityFilter(), text).isProfane).toBe(false);
  });
});

/**
 * `LIBRARY_OVERMATCH_TOKENS` feeds `whitelistSet`, which only `analyze()` filters against.
 * `evaluateContent` goes through it; `clean()` does NOT — it censors the matcher's raw
 * matches. So the trainer and `evaluateAutoNsfw` honour it and `RenderHtml` does not.
 */
describe('the other static-list consumers', () => {
  it('evaluateContent does not count the excused tokens', () => {
    const filter = createProfanityFilter();
    const tags = 'fu, fu manchu, fu dog, fu xi, fu hua, fu manchu mustache';
    expect(filter.evaluateContent(tags)).toMatchObject({
      shouldMarkNSFW: false,
      metrics: { matchCount: 0 },
    });
  });

  it('evaluateContent still marks profanity-dense text', () => {
    const filter = createProfanityFilter();
    const text = 'fuck shit cunt whore bitch dick twat wank jizz slut';
    expect(filter.evaluateContent(text).shouldMarkNSFW).toBe(true);
  });

  /**
   * `clean()` consults no whitelist at all, so `RenderHtml` censors shipped whitelist entries
   * like `fukushima` and `futari` too. Pre-existing; sharing `analyze()`'s filter would change
   * rendered output for every whitelist entry.
   */
  it.each([
    ['fu manchu mustache', '** manchu mustache'],
    ['fukushima', '***ushima'],
    ['futari', '****ri'],
  ])('clean() still censors %s, though analyze() clears it', (text, censored) => {
    const filter = createProfanityFilter();
    expect(filter.analyze(text).isProfane).toBe(false);
    expect(filter.clean(text)).toBe(censored);
  });
});

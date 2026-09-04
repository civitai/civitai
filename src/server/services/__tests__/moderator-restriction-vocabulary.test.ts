import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  asModeratorVocabulary,
  MODERATOR_VOCABULARY_FILE,
  readModeratorVocabulary,
} from './moderator-restriction-vocabulary.harness';
import {
  RULINGS_WIRED_FOR,
  USER_RESTRICTION_TYPES,
  unwiredRulingReason,
} from '~/server/services/user-restriction.service';

/**
 * The READER behind `restriction-type-seam.test.ts`, tested against fixtures rather than only
 * against the one pairing it happens to read today.
 *
 * 🔴 Why this file exists. The seam guard used to read the moderator app's vocabulary as TEXT, with
 * `/…= \[([^\]]*)\]/` plus a single-quoted-string extractor. Measured on #4609: with the moderator
 * list written across several lines and a comment naming an index, the seam suite reported
 * **8 passed / 0 failed** while the two apps genuinely disagreed about which restriction types a
 * verdict may be handed to — the `]` in the comment truncated the capture, and the first entry
 * survived the truncation, so even the `length > 0` positive control stayed green.
 *
 * That divergence is not cosmetic. If the moderator app believes `bot-account` is rulable, its
 * audit-queue `ban` action bans the account and posts the ruling AFTERWARDS — a ruling the main app
 * refuses — leaving a banned account with a Pending row nobody can close.
 *
 * 🔴 The fix is not a wider regex. A guard that pins source text by PATTERN is walkable by
 * rewriting the text, and the rewrites that walk it are ordinary: a Prettier reflow, a comment, a
 * quote-style change. The reader now IMPORTS AND EXECUTES the module, so formatting cannot be the
 * difference between agreeing and disagreeing. Each fixture below is a formatting that the text
 * parser either misread or could not have read at all; every one of them carries a REAL divergence,
 * so a reader that could not see it would report agreement.
 */

const fixture = (name: string) =>
  path.resolve(__dirname, '__fixtures__/moderator-vocabulary', `${name}.ts`);

/**
 * Every fixture declares the SAME two lists, in a different shape:
 *   RESTRICTION_TYPES   = generation, bot-account, spam-account   (main app: generation, bot-account)
 *   RULINGS_WIRED_FOR   = generation, bot-account                 (main app: generation)
 * so one expectation covers all of them and a reader that silently returns something else fails.
 */
const FIXTURE_TYPES = ['generation', 'bot-account', 'spam-account'];
const FIXTURE_WIRED = ['generation', 'bot-account'];

const FIXTURES: readonly (readonly [string, string])[] = [
  ['a multi-line array', 'multi-line-array'],
  ['a comment containing a closing bracket', 'comment-with-bracket'],
  ['double-quoted entries', 'double-quoted'],
  ['a trailing comma', 'trailing-comma'],
  ['values assembled at runtime', 'computed'],
];

describe('moderator restriction vocabulary — the reader the seam guard uses', () => {
  it('has fixtures that genuinely disagree with the main app, or the cases below prove nothing', () => {
    // The control that makes every fixture case non-vacuous. If the main app ever widened to match
    // these, the fixtures would stop being divergences and would pass against a reader that could
    // not see anything at all.
    expect([...FIXTURE_WIRED].sort()).not.toEqual([...RULINGS_WIRED_FOR].sort());
    expect([...FIXTURE_TYPES].sort()).not.toEqual([...USER_RESTRICTION_TYPES].sort());
  });

  it.each(FIXTURES)('reads both lists through %s', async (_label, name) => {
    const vocabulary = await readModeratorVocabulary(fixture(name));

    expect([...vocabulary.restrictionTypes]).toEqual(FIXTURE_TYPES);
    expect([...vocabulary.rulingsWiredFor]).toEqual(FIXTURE_WIRED);
  });

  /**
   * The refusal SENTENCE, which the text parser read out of a template literal with a third regex
   * and which is now simply called. Pinned separately from the list because the two fail
   * differently: a drifted list is the ban-then-strand hazard above, a drifted sentence is two
   * surfaces explaining one refusal in two ways.
   */
  it.each(FIXTURES)('reads the refusal message by executing it, through %s', async (_l, name) => {
    const vocabulary = await readModeratorVocabulary(fixture(name));

    // The fixture claims a verdict path for `bot-account` that the main app refuses — the exact
    // divergence, expressed as behaviour rather than as text.
    expect(vocabulary.unwiredRulingReason('bot-account')).toBeNull();
    expect(unwiredRulingReason('bot-account')).not.toBeNull();

    // …and where the two DO agree, they agree word for word, so this is not merely detecting that
    // something changed.
    expect(vocabulary.unwiredRulingReason('generation')).toBeNull();
    expect(vocabulary.unwiredRulingReason('spam-account')).toBe(
      unwiredRulingReason('spam-account')
    );
  });

  it('loads the real moderator module when given no path', async () => {
    // Positive control on the default argument: the fixture cases would all pass against a reader
    // pointed at nothing real.
    const vocabulary = await readModeratorVocabulary();

    expect([...vocabulary.restrictionTypes]).toContain('generation');
    expect(typeof vocabulary.unwiredRulingReason).toBe('function');
  });
});

/**
 * 🔴 The reader must fail LOUDLY, not emptily. A reader that returned `[]` for a module it could
 * not understand would make the seam guard's equality assertions compare two nearly-empty things —
 * the reassuring-zero shape the text parser died of.
 */
describe('moderator restriction vocabulary — refuses a module it cannot read', () => {
  const ok = {
    RESTRICTION_TYPES: ['generation'],
    RULINGS_WIRED_FOR: ['generation'],
    unwiredRulingReason: () => null,
  };

  it('accepts a well-formed module, so the refusals below are specific', () => {
    expect(asModeratorVocabulary(ok, MODERATOR_VOCABULARY_FILE).restrictionTypes).toEqual([
      'generation',
    ]);
  });

  it.each([
    ['a renamed type list', { ...ok, RESTRICTION_TYPES: undefined }, 'RESTRICTION_TYPES'],
    ['a renamed wired-for list', { ...ok, RULINGS_WIRED_FOR: undefined }, 'RULINGS_WIRED_FOR'],
    ['an empty type list', { ...ok, RESTRICTION_TYPES: [] }, 'RESTRICTION_TYPES'],
    ['an empty wired-for list', { ...ok, RULINGS_WIRED_FOR: [] }, 'RULINGS_WIRED_FOR'],
    ['a list holding a non-string', { ...ok, RULINGS_WIRED_FOR: ['a', 1] }, 'RULINGS_WIRED_FOR'],
    [
      'a missing refusal function',
      { ...ok, unwiredRulingReason: undefined },
      'unwiredRulingReason',
    ],
    ['nothing at all', undefined, 'RESTRICTION_TYPES'],
  ])('throws on %s, naming what it could not read', (_label, mod, named) => {
    expect(() => asModeratorVocabulary(mod, MODERATOR_VOCABULARY_FILE)).toThrow(
      new RegExp(`\`${named}\``)
    );
  });
});

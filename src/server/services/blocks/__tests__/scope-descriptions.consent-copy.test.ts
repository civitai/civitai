import { describe, expect, it } from 'vitest';
import { SCOPE_DESCRIPTIONS } from '~/server/services/blocks/scope-descriptions.constants';

/**
 * The `ai:write:budgeted` consent sentence is a PROMISE a user agreed to, not a
 * UI label. It was rewritten when the scope's meaning widened under the
 * no-allowlist direction: the per-call cap half stayed true, "generations" did
 * not, because the scope now reaches hosted LLM inference and model training.
 *
 * 🔴 WHY PIN THE WHOLE STRING AND NOT A KEYWORD. A guard on words is walkable by
 * rewording — someone could satisfy "mentions training" while dropping the cap,
 * or restore the old sentence with a synonym. Pinning the exact string means a
 * cosmetic reword fails this test, and paying that is the point: the test exists
 * so the sentence cannot change without someone deciding that it should, and
 * asking whether the 15 live consent grants need re-taking again.
 *
 * If you are here because this test went red: changing this string does NOT
 * re-ask anybody. Consent is stored per (user, app) and the lookup never reads
 * the `version` column it stamps. Read
 * `scripts/oneoffs/2026-09-16-reconsent-ai-write-budgeted.sql` before you decide
 * a copy change is cosmetic.
 */
describe('ai:write:budgeted consent copy', () => {
  const CURRENT =
    "Run AI work that spends the viewer's Buzz, with a per-call cap — including generating images and video, running language models, and training models";

  const SUPERSEDED_2026_09_16 = 'Submit generations with a per-call Buzz cap';

  it('is the exact agreed sentence', () => {
    expect(SCOPE_DESCRIPTIONS['ai:write:budgeted']).toBe(CURRENT);
  });

  it('is NOT the superseded sentence, which described a narrower scope', () => {
    expect(SCOPE_DESCRIPTIONS['ai:write:budgeted']).not.toBe(SUPERSEDED_2026_09_16);
  });

  /**
   * The two capabilities the widening ADDED are the two a reader is most likely
   * to be surprised by, so they are asserted by meaning as well as by the exact
   * string above — a future reword that keeps the string test passing cannot
   * happen, but a future reword that REPLACES both tests should still have to
   * delete these deliberately.
   */
  it('names the two capabilities the widening added', () => {
    const copy = SCOPE_DESCRIPTIONS['ai:write:budgeted']!.toLowerCase();
    expect(copy).toContain('language model');
    expect(copy).toContain('training models');
  });

  it('still promises the per-call cap, which did not change', () => {
    expect(SCOPE_DESCRIPTIONS['ai:write:budgeted']!.toLowerCase()).toContain('per-call cap');
  });
});

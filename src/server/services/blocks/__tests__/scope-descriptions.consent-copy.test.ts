import { describe, expect, it } from 'vitest';
import { SCOPE_DESCRIPTIONS } from '~/server/services/blocks/scope-descriptions.constants';

/**
 * The `ai:write:budgeted` consent sentence is a PROMISE a user agreed to, not a
 * UI label. It was rewritten when the scope's meaning widened under the
 * no-allowlist direction: the per-call cap half stayed true, "generations" did
 * not, because the scope now reaches hosted LLM inference (`chatCompletion`).
 *
 * 🔴 WHY PIN THE WHOLE STRING AND NOT A KEYWORD. A guard on words is walkable by
 * rewording — someone could satisfy "mentions training" while dropping the cap,
 * or restore the old sentence with a synonym. Pinning the exact string means a
 * cosmetic reword fails this test, and paying that is the point: the test exists
 * so the sentence cannot change without someone deciding that it should, and
 * asking whether the live consent grants need re-taking again. (Deliberately no
 * count here: the SQL that revokes them opens with "do not take the population
 * from any document" — it can only have grown.)
 *
 * If you are here because this test went red: changing this string does NOT
 * re-ask anybody. Consent is stored per (user, app) and the lookup never reads
 * the `version` column it stamps. Read
 * `scripts/oneoffs/2026-09-16-reconsent-ai-write-budgeted.sql` before you decide
 * a copy change is cosmetic.
 */
describe('ai:write:budgeted consent copy', () => {
  const CURRENT =
    "Run AI work that spends the viewer's Buzz, with a per-call cap — including generating images and running language models";

  const SUPERSEDED_2026_09_16 = 'Submit generations with a per-call Buzz cap';

  it('is the exact agreed sentence', () => {
    expect(SCOPE_DESCRIPTIONS['ai:write:budgeted']).toBe(CURRENT);
  });

  it('is NOT the superseded sentence, which described a narrower scope', () => {
    expect(SCOPE_DESCRIPTIONS['ai:write:budgeted']).not.toBe(SUPERSEDED_2026_09_16);
  });

  /**
   * The capability the widening actually ADDED and that is reachable today.
   * Asserted by meaning as well as by the exact string above, so a future reword
   * that replaces both tests still has to delete this deliberately.
   */
  it('names the capability the widening added', () => {
    const copy = SCOPE_DESCRIPTIONS['ai:write:budgeted']!.toLowerCase();
    expect(copy).toContain('language model');
  });

  /**
   * 🔴 A SPELLED GUARD, AND ITS NAME NOW SAYS SO — the previous version was
   * titled "does NOT promise a capability that is not reachable yet" while
   * checking exactly one word (`training`). That description claimed coverage of
   * a CLASS and the body inspected a single member, and the gap it left was
   * immediately occupied: the very next audit round found "and video" sitting in
   * the sentence, unreachable for the same reason training was.
   *
   * So this list is defence-in-depth against the specific capabilities we have
   * already caught ourselves pre-promising. It is NOT a reachability check and
   * cannot be one — a reword ("clip generation", "moving images") walks straight
   * past it.
   *
   * 🔴 THE REAL CONTROL IS THE WHOLE-STRING PIN ABOVE plus a human enumerating
   * `blockWorkflowBodySchema`'s members before changing the sentence. If you are
   * adding a capability here, do that enumeration; do not just extend this list
   * and assume it protected you.
   */
  const NOT_REACHABLE_TODAY = [
    'training', // no implemented billing mode can carry a variable-cost step
    'train ',
    'video', // textToImage is bounded to BLOCK_IMAGE_WORKFLOW_TYPES
    'audio',
    'music',
    'speech',
    'voice',
    '3d',
  ];

  it('does not name any capability we have previously caught ourselves pre-promising', () => {
    const copy = SCOPE_DESCRIPTIONS['ai:write:budgeted']!.toLowerCase();
    for (const term of NOT_REACHABLE_TODAY) {
      expect(copy, `consent copy must not promise "${term.trim()}" — it is not reachable`).not.toContain(
        term
      );
    }
  });

  it('still promises the per-call cap, which did not change', () => {
    expect(SCOPE_DESCRIPTIONS['ai:write:budgeted']!.toLowerCase()).toContain('per-call cap');
  });
});

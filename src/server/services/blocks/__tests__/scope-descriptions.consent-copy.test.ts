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
  const CURRENT = "Run AI generation services that spend the viewer's Buzz, with a per-call cap";

  /**
   * Every sentence this scope has carried, newest first. Kept as a list rather
   * than a single `not.toBe` because the arc is the evidence: each was replaced
   * for a DIFFERENT reason, and a reader reaching for "let's just enumerate the
   * capabilities again" should see how that went.
   */
  const SUPERSEDED = [
    // Too narrow once chatCompletion shipped — "generations" did not cover LLM
    // inference.
    'Submit generations with a per-call Buzz cap',
    // Over-promised: training is denylist-ALLOWED but not reachable, because no
    // implemented billing mode can carry a variable-cost step.
    "Run AI work that spends the viewer's Buzz, with a per-call cap — including generating images and video, running language models, and training models",
    // Still over-promised: "and video" was cut as unreachable — and that cut was
    // itself WRONG. An inline customComfy graph can generate video
    // (operator-confirmed). The enum reasoning covered every arm except the one
    // bounded by no enum.
    "Run AI work that spends the viewer's Buzz, with a per-call cap — including generating images and video, and running language models",
    "Run AI work that spends the viewer's Buzz, with a per-call cap — including generating images and running language models",
  ];

  it('is the exact agreed sentence', () => {
    expect(SCOPE_DESCRIPTIONS['ai:write:budgeted']).toBe(CURRENT);
  });

  it('is none of the superseded sentences', () => {
    for (const old of SUPERSEDED) {
      expect(SCOPE_DESCRIPTIONS['ai:write:budgeted']).not.toBe(old);
    }
  });

  /**
   * 🔴 THE GUARD IS NOW "DO NOT ENUMERATE", WHICH IS THE ONE THING THAT ACTUALLY
   * HELD. The previous version listed modalities believed unreachable and
   * asserted the copy named none of them. That premise collapsed: `video` was on
   * the list and video turns out to be REACHABLE via an inline customComfy
   * graph, so the guard was asserting something false about the product.
   *
   * Enumerating capabilities in a consent sentence failed three times — twice by
   * over-promising, once by under-naming — and each failure costs a re-consent
   * of every live grant, because consent is per (user, app) and no lookup reads
   * a version. A generic term cannot be falsified by a capability arriving.
   *
   * So what is pinned is the SHAPE: no modality nouns. This is still a SPELLED
   * guard — "moving pictures" walks past it — and the real control remains the
   * whole-string pin above plus a human deciding. Its value is narrow and
   * specific: it makes re-adding a list a deliberate act with a red test and
   * this comment attached, rather than a helpful-looking edit.
   */
  const MODALITY_NOUNS = ['video', 'audio', 'music', 'speech', 'voice', '3d', 'image', 'training'];

  it('does not enumerate modalities — the shape that failed three times', () => {
    const copy = SCOPE_DESCRIPTIONS['ai:write:budgeted']!.toLowerCase();
    for (const term of MODALITY_NOUNS) {
      expect(
        copy,
        `consent copy should not name "${term}" — enumerating modalities here has been wrong in both directions; keep it generic`
      ).not.toContain(term);
    }
  });

  it('still promises the per-call cap, which did not change', () => {
    expect(SCOPE_DESCRIPTIONS['ai:write:budgeted']!.toLowerCase()).toContain('per-call cap');
  });
});

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
  const CURRENT = "Run AI work that spends the viewer's Buzz, with a per-call cap";

  /**
   * Every sentence this scope has carried OR was one merge away from carrying,
   * newest first. Kept as a list rather than a single `not.toBe` because the arc
   * is the evidence: each was replaced for a DIFFERENT reason, and a reader
   * reaching for "let's just enumerate the capabilities again" should see how
   * that went.
   *
   * The last entry never shipped — it was caught in audit — and it is in the
   * list precisely because it is the draft most likely to be re-proposed: it
   * looks generic and reads well, and it is wrong for a reason you have to know
   * the arc to see.
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
    // NEVER SHIPPED — proposed as the generic replacement and rejected in audit.
    // It drops the enumeration correctly but reuses the ONE root word the
    // re-consent exists to retire: "generation". See the `generation` guard
    // below for why that is not a nit.
    "Run AI generation services that spend the viewer's Buzz, with a per-call cap",
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
   * So what is pinned is the SHAPE: no named capability. This is still a SPELLED
   * guard — "moving pictures" walks past it — and the real control remains the
   * whole-string pin above plus a human deciding. Its value is narrow and
   * specific: it makes re-adding a list a deliberate act with a red test and
   * this comment attached, rather than a helpful-looking edit.
   *
   * ⚠️ The list mixes modalities (`video`, `3d`) with a capability KIND
   * (`training`), and the name says so. `training` is here for a second,
   * independent reason: it is denylist-ALLOWED but NOT REACHABLE
   * (`isBillingModeImplemented` accepts `'prepaidFixed'` only), so naming it
   * would bank permission for a widening that has not shipped. That supersedes
   * decision 6 of §5a in the decision doc (NOT in this repo — it is
   * `claudedocs/appblocks-no-allowlist-decision-2026-09-15.md` in the private
   * `civitai/talos-infra` repo), on the
   * operator's call of 2026-09-16. When training becomes reachable, remove it
   * from this list, change the sentence, AND re-take the grants.
   */
  const NAMED_CAPABILITIES = [
    'video',
    'audio',
    'music',
    'speech',
    'voice',
    '3d',
    'image',
    'training',
  ];

  it('does not enumerate capabilities — the shape that failed three times', () => {
    const copy = SCOPE_DESCRIPTIONS['ai:write:budgeted']!.toLowerCase();
    for (const term of NAMED_CAPABILITIES) {
      expect(
        copy,
        `consent copy should not name "${term}" — enumerating capabilities here has been wrong in both directions; keep it generic`
      ).not.toContain(term);
    }
  });

  /**
   * 🔴 A SEPARATE RULE FROM THE ONE ABOVE, AND IT WAS LEARNED THE EXPENSIVE WAY.
   * "Do not enumerate" and "do not reuse the word `generation`" are independent:
   * a sentence can satisfy the first and violate the second, and one did —
   * "Run AI generation services…" was proposed as THE generic fix and shipped
   * nowhere only because a human read it.
   *
   * Why the root word is disqualified: `generations` is precisely what the
   * original sentence said, and the stated justification for revoking every live
   * grant is that it does NOT cover hosted LLM inference (`chatCompletion`,
   * registered and live) — see the head of
   * `scripts/oneoffs/2026-09-16-reconsent-ai-write-budgeted.sql`. On Civitai the
   * word is narrower still: "Generate" and "Train a LoRA" are two distinct
   * top-level actions. So a replacement built on the same root re-commits the
   * defect the re-consent is being spent to fix, while looking like a fix.
   *
   * Matched as a PREFIX so `generation`, `generations`, `generating` and
   * `generative` are all caught.
   */
  it('does not rebuild the sentence on the word the scope outgrew', () => {
    expect(
      SCOPE_DESCRIPTIONS['ai:write:budgeted']!.toLowerCase(),
      'consent copy must not reuse the "generat*" root — it is the exact word whose inadequacy justifies re-taking every live grant'
    ).not.toMatch(/generat/);
  });

  it('still promises the per-call cap, which did not change', () => {
    expect(SCOPE_DESCRIPTIONS['ai:write:budgeted']!.toLowerCase()).toContain('per-call cap');
  });
});

import { readFileSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';
import {
  clampPrivateRunScopes,
  clampTunnelDeclaredScopes,
  parseManifestBuzzBudget,
  PRIVATE_RUN_FORBIDDEN_SCOPES,
  PRIVATE_RUN_MINT_SCOPE_ALLOWLIST,
  resolveDevBuzzBudget,
  DEV_BUZZ_BUDGET_CAP,
  DEV_BUZZ_BUDGET_DEFAULT,
} from '~/server/services/blocks/dev-scoped-mint.service';
import {
  REVIEW_RUN_FOR_REAL_MINT_SCOPE_ALLOWLIST,
  TUNNEL_HOST_MINT_SCOPE_ALLOWLIST,
} from '~/server/services/blocks/dev-scoped-mint.service';
import { BLOCK_SCOPE_TO_OAUTH_BIT } from '~/shared/constants/block-scope.constants';

/**
 * THE PRIVATE-RUN SCOPE CLAMP — non-widening, the third-rail strip, and the editor
 * read-only strip.
 *
 * ⚠️ MOSTLY [REG] — `clampPrivateRunScopes` does not exist at `f7f5eb4996`, so every row
 * that calls it is red there. The header used to say "All [REG]" and that was an
 * over-claim: the rows asserting properties of PRE-EXISTING constants are [INV] and are
 * marked individually. Laundering an invariant into regression coverage is exactly what
 * this file's own doctrine forbids.
 *
 * 🔴 THE VOCABULARY IS ASSERTED AGAINST `BLOCK_SCOPE_TO_OAUTH_BIT`, NEVER A
 * HAND-WRITTEN LIST. A hand-written list of "the known scopes" drifts from the real
 * one silently, and then every membership assertion in this file is a claim about the
 * list rather than about the platform.
 */
describe('clampPrivateRunScopes — non-widening [REG]', () => {
  it('sources the APPROVED SNAPSHOT and cannot be widened by a re-published manifest', () => {
    // The scenario: a suspended publisher edits their manifest to ask for spend and
    // two private read scopes. The clamp is handed `approvedScopes` — the moderator
    // snapshot — so none of it can reach the token.
    const approved = ['models:read:self'];
    const granted = clampPrivateRunScopes(approved, 'owner');
    expect(granted).toEqual(['models:read:self', 'user:read:self']);
    expect(granted).not.toContain('ai:write:budgeted');
  });

  it('🔴 [REG] the NON-OWNER scopes are refused EVEN WHEN THE SNAPSHOT DECLARES THEM', () => {
    // ⚠️ THIS TEST EXISTS BECAUSE ITS FIRST VERSION WAS VACUOUS AND THE CODE WAS WRONG.
    // The row above used to also assert `not.toContain('posts:write:self')` and
    // `not.toContain('collections:read:private')` — against an input containing NEITHER.
    // Both assertions passed whatever the clamp did, including with the allowlist step
    // deleted entirely, and they were the ONLY assertions in the file about those
    // scopes. They read as coverage for a property that did not hold.
    //
    // 🔴 WHAT THEY WERE HIDING: the clamp composed `clampTunnelDeclaredScopes`, whose
    // ceiling is the AUTHOR-FACING dev-tunnel allowlist. That allowlist includes
    // `posts:write:self`, `collections:write:self`, `collections:read:private` and
    // `goods:read:self` — safe for an owner-only surface, and handed straight to a
    // MODERATOR and an accepted COLLABORATOR here. The worst reachable consequence was a
    // taken-down app publishing a real, feed-visible, reward-earning Post under the
    // REVIEWING MODERATOR'S byline.
    //
    // The fixture now FEEDS each scope in and watches it be dropped, which is the only
    // form of this assertion that can fail. Per audience, because the hazard is
    // audience-shaped.
    // 🔴 THE LIST COVERS *BOTH* DIFFERENCES, AND THE SECOND HALF WAS MISSING.
    // The first seven are `TUNNEL \ PRIVATE_RUN` — the scopes the original bug leaked.
    // But the most plausible single-token regression is not re-adding the tunnel
    // ceiling; it is swapping the allowlist argument to the set this one is DERIVED
    // from. That mutant survived the whole file, because none of those seven is in the
    // REVIEW set either. The last three are `REVIEW \ PRIVATE_RUN` — the deliberate
    // subtractions — and they are what makes the derivation itself testable.
    const hostile = [
      // TUNNEL \ PRIVATE_RUN — the original leak.
      'posts:write:self',
      'collections:write:self',
      'collections:read:private',
      'goods:read:self',
      'goods:purchase:self',
      'apps:storage:shared:read',
      'apps:storage:shared:write',
      // REVIEW \ PRIVATE_RUN — the three subtractions. Storage functions only under the
      // review sandbox's disposable schema, and `buzz:read:self` is consent-gated and
      // withheld by the DEFAULT review allowlist for a reason that names this surface.
      'apps:storage:read',
      'apps:storage:write',
      'buzz:read:self',
      // The survivor, i.e. the positive control.
      'models:read:self',
    ];
    for (const audience of ['owner', 'editor', 'moderator'] as const) {
      const granted = clampPrivateRunScopes(hostile, audience);
      for (const denied of hostile.filter((s) => s !== 'models:read:self')) {
        expect(granted, `audience=${audience} must not receive ${denied}`).not.toContain(denied);
      }
      // POSITIVE CONTROL in the same assertion set: a scope that SHOULD survive does,
      // so this is not a clamp that returns nothing.
      expect(granted, `audience=${audience}`).toContain('models:read:self');
    }
  });

  it('🔴 [INV] the ceiling is DERIVED from the reviewed non-owner allowlist, not invented', () => {
    // Pins the relationship rather than the members: the private-run ceiling must remain
    // a SUBSET of `REVIEW_RUN_FOR_REAL_MINT_SCOPE_ALLOWLIST`, which is the repo's already
    // reviewed answer to "a non-owner running someone else's non-approved app against
    // their own session". Deriving means a future tightening of that set tightens this
    // one too; asserting containment is what stops the two drifting apart if somebody
    // later spells this list out by hand.
    for (const s of PRIVATE_RUN_MINT_SCOPE_ALLOWLIST) {
      expect(
        REVIEW_RUN_FOR_REAL_MINT_SCOPE_ALLOWLIST.has(s),
        `${s} is in the private-run ceiling but not in the reviewed non-owner ceiling`
      ).toBe(true);
    }
    // And the two deliberate subtractions are actually subtracted — otherwise
    // "derived minus storage" is a comment rather than a fact.
    expect(PRIVATE_RUN_MINT_SCOPE_ALLOWLIST.has('apps:storage:read')).toBe(false);
    expect(PRIVATE_RUN_MINT_SCOPE_ALLOWLIST.has('apps:storage:write')).toBe(false);
    expect(REVIEW_RUN_FOR_REAL_MINT_SCOPE_ALLOWLIST.has('apps:storage:read')).toBe(true);
    // Non-empty, or every assertion above is vacuous.
    expect(PRIVATE_RUN_MINT_SCOPE_ALLOWLIST.size).toBeGreaterThan(2);
  });

  it('🔴 [REG] swapping the allowlist to the set it DERIVES from is caught', () => {
    // The one-token regression the first version of this file could not see: change
    // `allowlist: PRIVATE_RUN_MINT_SCOPE_ALLOWLIST` to
    // `REVIEW_RUN_FOR_REAL_MINT_SCOPE_ALLOWLIST` and every earlier assertion still
    // passed, because they only tested the TUNNEL difference. These three are the
    // subtractions, so they are the only scopes that can distinguish the derived set
    // from its source — which makes them the whole value of the derivation.
    for (const audience of ['owner', 'editor', 'moderator'] as const) {
      const granted = clampPrivateRunScopes(
        ['apps:storage:read', 'apps:storage:write', 'buzz:read:self'],
        audience
      );
      expect(granted, `audience=${audience}`).toEqual(['user:read:self']);
    }
    // …and the REVIEW set really does grant them, so the row above is a real difference
    // rather than two empty sets agreeing.
    for (const s of ['apps:storage:read', 'apps:storage:write', 'buzz:read:self']) {
      expect(REVIEW_RUN_FOR_REAL_MINT_SCOPE_ALLOWLIST.has(s), s).toBe(true);
      expect(PRIVATE_RUN_MINT_SCOPE_ALLOWLIST.has(s), s).toBe(false);
    }
  });

  it('🔴 [REG] it is NOT the author-facing tunnel ceiling — the two must differ', () => {
    // The discriminating assertion for the whole finding. If someone "simplifies" the
    // clamp back to `clampTunnelDeclaredScopes`, this is what goes red.
    expect(TUNNEL_HOST_MINT_SCOPE_ALLOWLIST.has('posts:write:self')).toBe(true);
    expect(PRIVATE_RUN_MINT_SCOPE_ALLOWLIST.has('posts:write:self')).toBe(false);
    expect(clampPrivateRunScopes(['posts:write:self'], 'moderator')).toEqual(['user:read:self']);
    // …while the TUNNEL clamp, correctly for its own owner-only surface, keeps it.
    expect(clampTunnelDeclaredScopes(['posts:write:self'])).toContain('posts:write:self');
  });

  it('🔴 approvedScopes: [] mints a VALID set that can spend NOTHING — not a refusal', () => {
    // The load-bearing invariant of the whole branch: `approvedScopes` is written only
    // by the mod-approval flow, so empty means never-approved, and an empty clamp
    // cannot invent a spend scope. Zero-scope is a legitimate manifest state, so this
    // must be a read-only token rather than a 403 (a refusal here would also be an
    // existence oracle).
    for (const audience of ['owner', 'editor', 'moderator'] as const) {
      const granted = clampPrivateRunScopes([], audience);
      expect(granted, `audience=${audience}`).toEqual(['user:read:self']);
      expect(granted).not.toContain('ai:write:budgeted');
    }
  });

  it('drops a RETIRED scope rather than refusing the whole mint', () => {
    // `catalog:read` was retired; an app approved before the retirement still carries
    // it in its snapshot. Refusing the mint would make such an app un-runnable for its
    // own owner for a reason unrelated to its takedown.
    const granted = clampPrivateRunScopes(['catalog:read', 'models:read:self'], 'owner');
    expect(granted).not.toContain('catalog:read');
    expect(granted).toContain('models:read:self');
  });

  it('every granted scope is in the platform vocabulary (asserted against the real map)', () => {
    const granted = clampPrivateRunScopes(
      ['models:read:self', 'collections:read:self', 'ai:write:budgeted', 'not-a-real-scope'],
      'moderator'
    );
    const vocabulary = new Set(Object.keys(BLOCK_SCOPE_TO_OAUTH_BIT));
    for (const s of granted) {
      expect(vocabulary.has(s), `${s} must be a known block scope`).toBe(true);
    }
    expect(granted).not.toContain('not-a-real-scope');
  });
});

describe('clampPrivateRunScopes — the THIRD BUZZ RAIL is stripped [REG]', () => {
  it('social:tip:self never survives, for ANY audience including moderator and owner', () => {
    // 🔴 WHY THIS MATTERS EVEN THOUGH THE TUNNEL ALLOWLIST ALREADY EXCLUDES IT.
    // `social:tip:self` moves IRREVERSIBLE Buzz to any `toUserId` the block's own code
    // names, has no status check of its own, and is not in `PAGE_FORBIDDEN_SCOPES`. On a
    // delisted app it was refused by ONE thing: the approved-status verdict. This
    // feature widens that verdict to render at all, which admits the tip route in the
    // same move — so the scope strip is the belt that widening requires.
    for (const audience of ['owner', 'editor', 'moderator'] as const) {
      const granted = clampPrivateRunScopes(['social:tip:self', 'models:read:self'], audience);
      expect(granted, `audience=${audience}`).not.toContain('social:tip:self');
      // …and the strip is surgical: the neighbouring scope survives.
      expect(granted).toContain('models:read:self');
    }
  });

  it('🔴 the step-2 STRIP EXISTS IN SOURCE — the only form of this that can fail', () => {
    // ⚠️ THE TEST BELOW CLAIMS A MUTATION IT DOES NOT PERFORM, and review caught it.
    // Deleting the `PRIVATE_RUN_FORBIDDEN_SCOPES` filter from `clampPrivateRunScopes`
    // leaves this whole FILE green, because the allowlist step already drops the tip
    // scope — so the strip is a no-op TODAY and no behavioural assertion can see it.
    //
    // 🔴 SO IT IS LEDGERED IN SOURCE INSTEAD, which is the same remedy
    // `no-unthreaded-private-run-claim` uses for the same reason: a guard whose value is
    // entirely in the FUTURE cannot be pinned behaviourally in the present. The day
    // anyone adds `social:tip:self` to the private-run ceiling for some other reason,
    // the strip becomes load-bearing — and it will still be there, because this went red
    // the moment somebody removed it as dead code.
    const src = readFileSync(
      join(process.cwd(), 'src/server/services/blocks/dev-scoped-mint.service.ts'),
      'utf8'
    );
    const body = src.slice(src.indexOf('export function clampPrivateRunScopes'));
    const fnEnd = body.indexOf('\n}');
    const clampBody = body.slice(0, fnEnd);
    // Positive control: the region really is the function, not an empty slice.
    expect(clampBody).toContain('clampDevScopes');
    expect(clampBody).toContain("audience === 'editor'");
    // The strip itself.
    expect(clampBody, 'the step-2 third-rail strip must remain in clampPrivateRunScopes').toContain(
      'PRIVATE_RUN_FORBIDDEN_SCOPES.has'
    );
  });

  it('the strip is a NO-OP today relative to the ceiling — stated, not implied', () => {
    // The redundancy is the point, and this is the test that makes it real rather than
    // a comment. `clampPrivateRunScopes` composes the tunnel belt, which today happens
    // to exclude the tip scope — so the strip is currently a no-op and would SURVIVE a
    // mutation that deleted it. This asserts the property structurally instead: the
    // forbidden set is non-empty, names the tip scope, and the clamp filters against it
    // independently of whatever the inner belt does.
    expect(PRIVATE_RUN_FORBIDDEN_SCOPES.has('social:tip:self')).toBe(true);
    // A positive control on the composition: feed the OUTER function a value the inner
    // belt DOES pass through, and watch the outer strip remove it. `ai:write:budgeted`
    // survives the tunnel belt for an owner, and the editor branch strips it — same
    // mechanism, observable.
    const ownerKeeps = clampPrivateRunScopes(['ai:write:budgeted'], 'owner');
    const editorLoses = clampPrivateRunScopes(['ai:write:budgeted'], 'editor');
    expect(ownerKeeps).toContain('ai:write:budgeted');
    expect(editorLoses).not.toContain('ai:write:budgeted');
  });

  it('🔴 MEASURED CONSEQUENCE: apps:storage:* is unreachable on a private run', () => {
    // Not a decision this feature took — an inherited property of composing the audited
    // tunnel belt, recorded because it is surprising and because a reader would
    // otherwise assume the opposite. `TUNNEL_HOST_MINT_SCOPE_ALLOWLIST` does not
    // contain ANY `apps:storage:*` scope, so a private-run token cannot read or write
    // the app's KV datastore even when the app's approved snapshot declares it.
    //
    // ⚠️ THIS MAKES ONE ARGUMENT IN THE DESIGN MOOT, AND IT IS BETTER TO SAY SO THAN TO
    // LEAVE THE STALE REASONING STANDING: "per-app storage namespacing resolves against
    // the real app" was given as a reason to sign the app's REAL ids rather than a
    // synthetic one. That reason does not apply, because no storage scope survives the
    // clamp. The OTHER two reasons stand on their own and are what the decision now
    // rests on — the ban-revocation instance id `page_<appBlockId>` and the runtime
    // metric labels both need the real ids.
    //
    // Widening the allowlist is deliberately NOT done here: it is shared with the dev
    // tunnel, so it would grant storage to that surface too, which is a separate
    // decision with its own blast radius.
    for (const audience of ['owner', 'editor', 'moderator'] as const) {
      const granted = clampPrivateRunScopes(
        ['apps:storage:read', 'apps:storage:write', 'apps:storage:shared:read'],
        audience
      );
      expect(granted, `audience=${audience}`).toEqual(['user:read:self']);
    }
  });

  it('goods:purchase:self is deliberately NOT in the forbidden set', () => {
    // Recorded as a test so a future reader does not "complete" the set: the sibling
    // owner-crediting rail is already closed on its own terms (it requires an approved
    // block), and listing it here would imply a protection this set is not providing.
    expect(PRIVATE_RUN_FORBIDDEN_SCOPES.has('goods:purchase:self')).toBe(false);
  });
});

describe('clampPrivateRunScopes — EDITOR is READ-ONLY [REG]', () => {
  it('ai:write:budgeted is stripped for editor and kept for owner and moderator', () => {
    // The operator decision, taken against the original recommendation on
    // reversibility grounds. Asserted per-audience rather than "editor gets less", so a
    // mutation that widened the strip to moderators is caught too.
    const source = ['ai:write:budgeted', 'models:read:self'];
    expect(clampPrivateRunScopes(source, 'owner')).toContain('ai:write:budgeted');
    expect(clampPrivateRunScopes(source, 'moderator')).toContain('ai:write:budgeted');
    expect(clampPrivateRunScopes(source, 'editor')).not.toContain('ai:write:budgeted');
    // Read scopes are untouched for an editor — read-only, not no-access.
    expect(clampPrivateRunScopes(source, 'editor')).toContain('models:read:self');
  });

  it('an editor therefore resolves NO budget at all', () => {
    // The consequence that actually stops spend: `resolveDevBuzzBudget` returns
    // `undefined` when the spend scope is absent, so the token carries no `buzzBudget`
    // claim and every per-call comparison fails closed.
    const editor = clampPrivateRunScopes(['ai:write:budgeted'], 'editor');
    expect(resolveDevBuzzBudget(editor, undefined, 137)).toBeUndefined();
    const owner = clampPrivateRunScopes(['ai:write:budgeted'], 'owner');
    expect(resolveDevBuzzBudget(owner, undefined, 137)).toBe(137);
  });
});

describe('private-run budget containment [REG]', () => {
  /**
   * 🔴 FIXTURE BOUNDS OVERSHOOT AND ARE NOT MULTIPLES OF THE CAP. 137 and 301 are
   * chosen so a clamp mutant MOVES the output: a manifest budget of 250 (the cap
   * itself) or 500 (a multiple) would land exactly on the boundary, the guard would
   * never execute, and the mutant would survive a fully green suite.
   */
  it('a manifest budget UNDER the cap passes through verbatim', () => {
    const granted = clampPrivateRunScopes(['ai:write:budgeted'], 'moderator');
    expect(resolveDevBuzzBudget(granted, undefined, 137)).toBe(137);
  });

  it('a manifest budget OVER the cap clamps to the cap', () => {
    const granted = clampPrivateRunScopes(['ai:write:budgeted'], 'moderator');
    expect(resolveDevBuzzBudget(granted, undefined, 301)).toBe(DEV_BUZZ_BUDGET_CAP);
    expect(DEV_BUZZ_BUDGET_CAP).toBe(250);
  });

  it('an ABSENT manifest budget falls back to the platform default', () => {
    const granted = clampPrivateRunScopes(['ai:write:budgeted'], 'moderator');
    expect(resolveDevBuzzBudget(granted, undefined, undefined)).toBe(DEV_BUZZ_BUDGET_DEFAULT);
  });

  it('🔴 a BAD manifest budget is refused by the PRODUCER, which is where it must be', () => {
    // ⚠️ THIS TEST REPLACED A TAUTOLOGY, and the tautology is the point of the comment.
    // It previously computed `usable = typeof got === 'number' && Number.isInteger(got)
    // && got > 0` and asserted `usable && got === bad` was false. Every input in the set
    // is non-positive, non-finite or non-integer, so that conjunction is UNSATISFIABLE —
    // the assertion held for every possible output, including the hazardous ones.
    //
    // 🔴 AND THE HAZARDOUS OUTPUTS ARE REAL: `resolveDevBuzzBudget` is `Math.min(bad,
    // CAP)`, so it returns NaN for NaN, -5 for -5 and 12.5 for 12.5. It is NOT the guard.
    // The guard is `parseManifestBuzzBudget`, which is where the comment always said it
    // should be ("caught where the number is PRODUCED") — and which the old test never
    // called. In a money path NaN is not "a bad number", it is a value that makes every
    // `>` and `<` comparison return false at once, so proving the PRODUCER refuses it is
    // the assertion that matters.
    for (const bad of [NaN, Infinity, -Infinity, 0, -5, 12.5, -0.5]) {
      expect(
        parseManifestBuzzBudget({ buzzBudgetPerGen: bad }),
        `a manifest budget of ${String(bad)} must not be parsed into a usable ceiling`
      ).toBeUndefined();
    }
    // Non-numbers too — the manifest is publisher JSON.
    for (const bad of ['250', null, {}, [], true, undefined]) {
      expect(parseManifestBuzzBudget({ buzzBudgetPerGen: bad }), String(bad)).toBeUndefined();
    }
  });

  it('POSITIVE CONTROL: the producer DOES accept a good budget', () => {
    // Without this, the loop above passes against a `parseManifestBuzzBudget` that
    // returns `undefined` unconditionally — i.e. a parser wired to nothing.
    expect(parseManifestBuzzBudget({ buzzBudgetPerGen: 137 })).toBe(137);
    expect(parseManifestBuzzBudget({ buzzBudgetPerGen: 1 })).toBe(1);
  });

  it('⚠️ RECORDED: resolveDevBuzzBudget itself does NOT sanitise — it clamps only', () => {
    // Pinned as the honest statement of where the guard is NOT, so nobody reads the
    // rows above as evidence that the whole chain is defensive. If this ever starts
    // returning `undefined` for NaN, that is an improvement — update this test then.
    const granted = clampPrivateRunScopes(['ai:write:budgeted'], 'moderator');
    expect(resolveDevBuzzBudget(granted, undefined, NaN)).toBeNaN();
    expect(resolveDevBuzzBudget(granted, undefined, -5)).toBe(-5);
    expect(resolveDevBuzzBudget(granted, undefined, 12.5)).toBe(12.5);
    // Which is why the MINT must source its budget through the producer. It does:
    // `parseManifestBuzzBudget(app.manifest.page)` feeds `resolveDevBuzzBudget`, so a
    // bad manifest value becomes `undefined` and then the flat platform default.
    expect(
      resolveDevBuzzBudget(granted, undefined, parseManifestBuzzBudget({ buzzBudgetPerGen: NaN }))
    ).toBe(DEV_BUZZ_BUDGET_DEFAULT);
  });
});

describe('the private-run clamp COMPOSES the audited tunnel belt [INV]', () => {
  it('for an owner with no forbidden scopes it is byte-identical to the tunnel clamp', () => {
    // The composition is the anti-drift property: the private run inherits every
    // future tightening of the audited belt for free. Asserted on a source set that
    // contains nothing the private-run layer strips, so any difference would be the
    // private layer having grown an unintended behaviour.
    const source = ['models:read:self', 'collections:read:self'];
    expect(clampPrivateRunScopes(source, 'owner')).toEqual(clampTunnelDeclaredScopes(source));
  });

  it('and DIVERGES where it is supposed to — the EDITOR strip', () => {
    // The negative control on the assertion above: if the two functions were the same
    // function, the test above would pass vacuously. This input proves they are not, so
    // the equality above is a real claim about a real difference.
    expect(clampPrivateRunScopes(['ai:write:budgeted'], 'editor')).not.toEqual(
      clampTunnelDeclaredScopes(['ai:write:budgeted'])
    );
  });

  it('🔴 …and the TIP STRIP is currently a NO-OP relative to the tunnel belt', () => {
    // ⚠️ WRITTEN AS AN ASSERTION RATHER THAN A COMMENT BECAUSE THE FIRST DRAFT OF THIS
    // FILE GOT IT WRONG. That draft asserted `clampPrivateRunScopes` DIVERGES from the
    // tunnel clamp on `social:tip:self`, and the test failed: the tunnel allowlist does
    // not contain the tip scope either, so both functions already return the same thing
    // for that input. The over-claim was mine, and pinning the true state is what stops
    // the next reader making it again.
    //
    // 🔴 THE STRIP STAYS ANYWAY, AND THIS TEST IS THE REASON IT CAN. Its value is
    // entirely in the FUTURE: the day anyone adds `social:tip:self` to
    // `TUNNEL_HOST_MINT_SCOPE_ALLOWLIST` for a dev-tunnel reason, this equality breaks
    // and the private-run strip becomes load-bearing — with no code change and no
    // reasoning required at that moment. A redundant guard whose redundancy is
    // ASSERTED is a tripwire; one whose redundancy is merely believed is dead weight.
    expect(clampPrivateRunScopes(['social:tip:self'], 'owner')).toEqual(
      clampTunnelDeclaredScopes(['social:tip:self'])
    );
    // Both must be exactly the force-added self-read, i.e. the scope reached neither.
    expect(clampPrivateRunScopes(['social:tip:self'], 'owner')).toEqual(['user:read:self']);
  });
});

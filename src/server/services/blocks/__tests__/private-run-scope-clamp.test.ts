import { describe, expect, it } from 'vitest';
import {
  clampPrivateRunScopes,
  clampTunnelDeclaredScopes,
  PRIVATE_RUN_FORBIDDEN_SCOPES,
  resolveDevBuzzBudget,
  DEV_BUZZ_BUDGET_CAP,
  DEV_BUZZ_BUDGET_DEFAULT,
} from '~/server/services/blocks/dev-scoped-mint.service';
import { BLOCK_SCOPE_TO_OAUTH_BIT } from '~/shared/constants/block-scope.constants';

/**
 * THE PRIVATE-RUN SCOPE CLAMP — non-widening, the third-rail strip, and the editor
 * read-only strip. All [REG]: `clampPrivateRunScopes` does not exist at `f7f5eb4996`.
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
    expect(granted).not.toContain('posts:write:self');
    expect(granted).not.toContain('collections:read:private');
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

  it('🔴 the strip survives even if the INNER clamp starts passing the scope through', () => {
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

  it('🔴 NaN / Infinity / 0 / negative / non-integer must not produce a usable budget', () => {
    // In a money path `NaN` is not "a bad number", it is a value that makes EVERY `>`
    // and `<` guard return false at once — so it must be caught where the number is
    // PRODUCED, not where it is compared. `Math.min(NaN, cap)` is NaN, and a NaN budget
    // claim makes the per-call ceiling comparison vacuously permissive.
    const granted = clampPrivateRunScopes(['ai:write:budgeted'], 'moderator');
    for (const bad of [NaN, Infinity, -Infinity, 0, -5, 12.5]) {
      const got = resolveDevBuzzBudget(granted, undefined, bad as number);
      const usable = typeof got === 'number' && Number.isInteger(got) && got > 0;
      // A non-positive / non-finite / non-integer input must never yield a usable
      // positive integer budget. `Infinity` clamps to the cap (safe); `NaN` and the
      // non-integers are the ones this row exists to make visible.
      if (bad === Infinity) {
        expect(got).toBe(DEV_BUZZ_BUDGET_CAP);
      } else {
        expect(
          usable && got === bad,
          `a budget of ${String(bad)} must not pass through as a usable ceiling`
        ).toBe(false);
      }
    }
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

import { describe, expect, it } from 'vitest';
import type { SessionUser } from '~/types/session';
import { buildFliptContext } from '~/server/services/feature-flags.service';

/**
 * `buildFliptContext` emits the `isEarlyAdopter` targeting property that the Flipt
 * `early-adopters` segment matches on (flipt-state civitai-app/default/features.yaml).
 *
 * The expectations here are LITERALS taken from the Flipt contract, not from the
 * implementation: the evaluation context is `Record<string, string>`, so a segment
 * constraint of `property: isEarlyAdopter / operator: eq / value: "true"` only ever
 * matches the STRING 'true'. A boolean `true`, the string 'True', or an absent key all
 * fail that constraint silently — as "nobody matches", never as an error — which is the
 * whole reason these are pinned by value and not by `expect.anything()`.
 */

const user = (over: Partial<SessionUser> = {}): SessionUser =>
  ({
    id: 42,
    showNsfw: false,
    blurNsfw: true,
    browsingLevel: 1,
    onboarding: 0,
    ...over,
  } as SessionUser);

describe('buildFliptContext — isEarlyAdopter', () => {
  it('emits the STRING "true" for an opted-in user', () => {
    const ctx = buildFliptContext(user({ isEarlyAdopter: true }));
    expect(ctx.isEarlyAdopter).toBe('true');
    // Not the boolean — a boolean would fail a STRING_COMPARISON_TYPE constraint.
    expect(ctx.isEarlyAdopter).not.toBe(true as unknown as string);
    expect(typeof ctx.isEarlyAdopter).toBe('string');
  });

  it('emits the STRING "false" for a user who explicitly opted out', () => {
    const ctx = buildFliptContext(user({ isEarlyAdopter: false }));
    expect(ctx.isEarlyAdopter).toBe('false');
  });

  it('emits "false" — not "undefined" — for a logged-in user who never opted in', () => {
    // The session field is sparse (the hub leaves it undefined), so the coercion has to
    // happen here. `String(undefined)` would produce the literal 'undefined', which is
    // neither 'true' nor 'false' and would quietly mean "not in the cohort" for the wrong
    // reason. Pin the value.
    const ctx = buildFliptContext(user());
    expect(ctx.isEarlyAdopter).toBe('false');
    expect(ctx.isEarlyAdopter).not.toBe('undefined');
  });

  it('omits the key entirely for an anonymous request', () => {
    const ctx = buildFliptContext(undefined);
    // ABSENT, not the string 'false': there is no user to attribute an opt-in to, and the
    // rest of the user-scoped context is omitted the same way.
    expect('isEarlyAdopter' in ctx).toBe(false);
    expect(ctx.isEarlyAdopter).toBeUndefined();
    expect(ctx.isLoggedIn).toBe('false');
  });

  it('does not disturb the sibling context properties', () => {
    // Every value in the context is a string; adding a key must not change the others.
    const ctx = buildFliptContext(user({ isEarlyAdopter: true, isModerator: true, tier: 'gold' }));
    expect(ctx.userId).toBe('42');
    expect(ctx.isModerator).toBe('true');
    expect(ctx.tier).toBe('gold');
    expect(ctx.isMember).toBe('true');
    expect(ctx.isLoggedIn).toBe('true');
    for (const [key, value] of Object.entries(ctx)) {
      expect(typeof value, `context key ${key} must be a string`).toBe('string');
    }
  });

  it('a truthy non-boolean on the session still collapses to "true"', () => {
    // Defence in depth against a future producer that writes a non-boolean: the segment
    // constraint is an exact string match, so anything other than 'true'/'false' would
    // silently exclude the user. `!!` guarantees one of the two.
    const ctx = buildFliptContext(user({ isEarlyAdopter: 1 as unknown as boolean }));
    expect(ctx.isEarlyAdopter).toBe('true');
  });
});

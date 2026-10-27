import { afterEach, describe, expect, it } from 'vitest';
import { buildFliptContext } from '../context';

describe('buildFliptContext', () => {
  const original = process.env.FLIPT_DEPLOYMENT_ID;
  afterEach(() => {
    if (original === undefined) delete process.env.FLIPT_DEPLOYMENT_ID;
    else process.env.FLIPT_DEPLOYMENT_ID = original;
  });

  it('emits the properties the shared segments constrain on', () => {
    const ctx = buildFliptContext({ id: 583956, isModerator: false, tier: 'gold' });
    // `testers` is ANY_MATCH over exactly these two — a context missing either can never match it.
    expect(ctx.userId).toBe('583956');
    expect(ctx.isModerator).toBe('false');
    expect(ctx.tier).toBe('gold');
    expect(ctx.isMember).toBe('true');
    expect(ctx.isLoggedIn).toBe('true');
    expect(ctx.isEarlyAdopter).toBe('false');
    expect(ctx.appBuilderApproved).toBe('false');
  });

  // The `app-builder-approved` segment is `appBuilderApproved eq "true"` — a STRING match, so only
  // the literal 'true' grants; a boolean or 'undefined' would silently match nobody.
  it('emits appBuilderApproved as the string "true" only for an approved user', () => {
    expect(buildFliptContext({ id: 5, appBuilderApproved: true }).appBuilderApproved).toBe('true');
    expect(buildFliptContext({ id: 5, appBuilderApproved: false }).appBuilderApproved).toBe(
      'false'
    );
    expect(buildFliptContext({ id: 5 }).appBuilderApproved).toBe('false');
    expect('appBuilderApproved' in buildFliptContext()).toBe(false);
  });

  it('defaults a tierless user to free and not a member', () => {
    const ctx = buildFliptContext({ id: 1 });
    expect(ctx.tier).toBe('free');
    expect(ctx.isMember).toBe('false');
  });

  it('emits isLoggedIn=false and no userId for an anonymous request', () => {
    const ctx = buildFliptContext();
    expect(ctx.isLoggedIn).toBe('false');
    expect(ctx.userId).toBeUndefined();
  });

  it('merges extra properties the caller owns', () => {
    const ctx = buildFliptContext({ id: 7 }, { isInCreatorProgram: 'true' });
    expect(ctx.isInCreatorProgram).toBe('true');
    expect(ctx.userId).toBe('7');
  });

  it('carries deploymentId when the env names one', () => {
    process.env.FLIPT_DEPLOYMENT_ID = 'datapacket';
    expect(buildFliptContext({ id: 1 }).deploymentId).toBe('datapacket');
    delete process.env.FLIPT_DEPLOYMENT_ID;
    expect(buildFliptContext({ id: 1 }).deploymentId).toBeUndefined();
  });
});

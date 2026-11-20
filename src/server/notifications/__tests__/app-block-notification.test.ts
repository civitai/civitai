import { describe, expect, it } from 'vitest';
import { appBlockNotifications } from '~/server/notifications/app-block.notifications';
import type { AppBlockModerationNotificationDetails } from '~/server/notifications/app-block.notifications';

/**
 * On-site App Block submitter-notification DEFINITION coverage (pure — no DB / client).
 *
 * Asserts the two imperative types render the right copy + url from their details:
 *   - approved copy, its run-page url, and the submissions-view fallback without a slug,
 *   - rejected copy WITH a reason and the empty/whitespace-reason fallback.
 * These are the same guarantees the off-site `app-listing-*` types carry, adapted to
 * the distinct on-site App Block copy.
 */

type Def = (typeof appBlockNotifications)['app-block-approved'];
const approved = (appBlockNotifications as Record<string, Def>)['app-block-approved'];
const rejected = (appBlockNotifications as Record<string, Def>)['app-block-rejected'];

function msg(def: Def, details: AppBlockModerationNotificationDetails) {
  return def.prepareMessage({ details } as Parameters<Def['prepareMessage']>[0]);
}

describe('app-block notification definitions — registration shape', () => {
  it('both types are non-toggleable System notifications with no prepareQuery', () => {
    for (const def of [approved, rejected]) {
      expect(def).toBeTruthy();
      expect(def.toggleable).toBe(false);
      expect(def.category).toBe('System');
      // Imperative (emitted from the service), so there is no scheduled scan.
      expect((def as { prepareQuery?: unknown }).prepareQuery).toBeUndefined();
    }
  });
});

describe('app-block-approved — prepareMessage', () => {
  it('says the app was approved and links to its run page', () => {
    const m = msg(approved, { slug: 'cool-app', name: 'Cool App', version: '1.2.0' });
    expect(m!.message).toBe('Your app "Cool App" was approved and will be live in a few minutes.');
    expect(m!.url).toBe('/apps/run/cool-app');
  });

  it('encodes the slug into the run page path', () => {
    expect(msg(approved, { slug: 'a b/c' })!.url).toBe('/apps/run/a%20b%2Fc');
  });

  it.each([
    ['missing', {}],
    ['empty', { slug: '' }],
    ['whitespace', { slug: '   ' }],
    ['not a string', { slug: 42 }],
  ])('falls back to the submissions view when the slug is %s', (_label, details) => {
    const m = msg(approved, details as unknown as AppBlockModerationNotificationDetails);
    expect(m!.url).toBe('/apps/build?view=apps');
    expect(m!.message).toBe('Your app was approved and will be live in a few minutes.');
  });

  it('treats a whitespace-only name as absent (no empty quotes)', () => {
    const m = msg(approved, { slug: 'cool-app', name: '   ' });
    expect(m!.message).toBe('Your app was approved and will be live in a few minutes.');
  });

  it('labels its email button for opening the app', () => {
    expect(approved.emailButtonLabel).toBe('Open your app');
    expect(rejected.emailButtonLabel).toBeUndefined();
  });
});

describe('app review copy calls them apps', () => {
  it('names every type without "block"', () => {
    const defs = Object.values(appBlockNotifications as Record<string, Def>);
    expect(defs).toHaveLength(2);
    expect(defs.map((d) => d.displayName)).toEqual(['App approved', 'App not approved']);
    for (const def of defs) {
      expect(def.displayName).not.toMatch(/block/i);
      for (const details of [{ slug: 'cool-app', name: 'Cool App', reason: 'r' }, { slug: '' }])
        expect(msg(def, details)!.message).not.toMatch(/block/i);
    }
  });
});

describe('app-block-rejected — prepareMessage', () => {
  it('renders the moderator reason inline after the block name', () => {
    const m = msg(rejected, {
      slug: 'cool-app',
      name: 'Cool App',
      reason: 'Uses a disallowed scope',
    });
    expect(m!.message).toBe('Your app "Cool App" was not approved: Uses a disallowed scope');
    expect(m!.url).toBe('/apps/build?view=apps');
  });

  it('falls back to a clean sentence (period, no dangling colon) when no reason is given', () => {
    const m = msg(rejected, { slug: 'cool-app', name: 'Cool App' });
    expect(m!.message).toContain('Cool App');
    expect(m!.message.toLowerCase()).toMatch(/not approved/);
    expect(m!.message.trimEnd().endsWith('.')).toBe(true);
    expect(m!.message).not.toContain(':');
  });

  it('treats a whitespace-only reason as absent (fallback, not a dangling colon)', () => {
    const m = msg(rejected, { slug: 'cool-app', name: 'Cool App', reason: '   ' });
    expect(m!.message).not.toContain(':');
    expect(m!.message.trimEnd().endsWith('.')).toBe(true);
  });

  it('uses the terse label when neither name nor reason is present', () => {
    const m = msg(rejected, { slug: 'cool-app' });
    expect(m!.message).toBe('Your app was not approved.');
  });
});

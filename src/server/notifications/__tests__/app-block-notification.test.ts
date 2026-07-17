import { describe, expect, it } from 'vitest';
import { appBlockNotifications } from '~/server/notifications/app-block.notifications';
import type { AppBlockModerationNotificationDetails } from '~/server/notifications/app-block.notifications';

/**
 * On-site App Block submitter-notification DEFINITION coverage (pure — no DB / client).
 *
 * Asserts the two imperative types render the right copy + url from their details:
 *   - approved copy (+ name-present vs name-absent label),
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
  it('names the block and points at the submissions view', () => {
    const m = msg(approved, { slug: 'cool-app', name: 'Cool App', version: '1.2.0' });
    expect(m).toBeTruthy();
    expect(m!.message).toContain('Cool App');
    expect(m!.message.toLowerCase()).toMatch(/approved/);
    expect(m!.url).toBe('/apps/my-submissions');
  });

  it('falls back to a terse "Your app block" when no name is present', () => {
    const m = msg(approved, { slug: 'cool-app' });
    expect(m!.message).toContain('Your app block');
    expect(m!.message).not.toContain('""');
    expect(m!.message.toLowerCase()).toMatch(/approved/);
  });

  it('treats a whitespace-only name as absent (no empty quotes)', () => {
    const m = msg(approved, { slug: 'cool-app', name: '   ' });
    expect(m!.message).toContain('Your app block');
    expect(m!.message).not.toContain('""');
  });
});

describe('app-block-rejected — prepareMessage', () => {
  it('renders the moderator reason inline after the block name', () => {
    const m = msg(rejected, {
      slug: 'cool-app',
      name: 'Cool App',
      reason: 'Uses a disallowed scope',
    });
    expect(m!.message).toContain('Cool App');
    expect(m!.message.toLowerCase()).toMatch(/not approved/);
    expect(m!.message).toContain('Uses a disallowed scope');
    expect(m!.url).toBe('/apps/my-submissions');
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
    expect(m!.message).toContain('Your app block');
    expect(m!.message).not.toContain('""');
    expect(m!.message.trimEnd().endsWith('.')).toBe(true);
  });
});

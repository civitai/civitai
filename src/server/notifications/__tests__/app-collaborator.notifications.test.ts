import { describe, expect, it } from 'vitest';

import { appCollaboratorNotifications } from '~/server/notifications/app-collaborator.notifications';
import type { AppCollaboratorNotificationDetails } from '~/server/notifications/app-collaborator.notifications';

/**
 * App Listing COLLABORATOR notification DEFINITIONS (pure — no DB / client), following
 * the sibling `app-block-notification.test.ts` shape.
 *
 * 🔴 WHY THIS FILE EXISTS. Eleven notification suites sat in this directory and this
 * family had none, so `url: APP_INVITES_URL` on the invite type — the ONE line that makes
 * `/apps/invites` reachable from the flow the page exists for — could be reverted to
 * `appUrl(details)` with the entire suite still green. An invite notification is the only
 * route an invitee has: they own nothing, hold no accepted seat, and every
 * `/apps/<id>/…` surface resolves their role and refuses. Send them anywhere else and the
 * feature has no entry point at all.
 */

type Def = (typeof appCollaboratorNotifications)['app-collaborator-invited'];
const defs = appCollaboratorNotifications as Record<string, Def>;

function msg(type: string, details: AppCollaboratorNotificationDetails) {
  const def = defs[type];
  expect(def, `${type} is not registered`).toBeTruthy();
  const message = def.prepareMessage({ type, details } as Parameters<Def['prepareMessage']>[0]);
  // Thrown rather than `!`: `prepareMessage` returns `NotificationMessage | undefined`, and a
  // caller reading `.url` off nothing is the one failure that would otherwise read as a null url.
  if (!message) throw new Error(`${type} produced no message`);
  return message;
}

const ONSITE: AppCollaboratorNotificationDetails = {
  slug: 'my-app',
  appListingId: 'apl_1',
  appBlockId: 'ab_1',
  name: 'My App',
};
/** 🔴 An OFF-SITE listing has NO AppBlock — a legitimately-absent id, not a missing one. */
const OFFSITE: AppCollaboratorNotificationDetails = {
  slug: 'external-app',
  appListingId: 'apl_2',
  appBlockId: null,
  name: 'External App',
};

describe('app-collaborator notification definitions — registration shape', () => {
  it('the invite type is a non-toggleable System notification with no prepareQuery', () => {
    const def = defs['app-collaborator-invited'];
    expect(def).toBeTruthy();
    expect(def.toggleable).toBe(false);
    expect(def.category).toBe('System');
    // Imperative (emitted post-commit from the service), so there is no scheduled scan.
    expect((def as { prepareQuery?: unknown }).prepareQuery).toBeUndefined();
  });
});

describe('🔴 the INVITE notification points at the invitee inbox', () => {
  it('links to /apps/invites, NOT to the app', () => {
    expect(msg('app-collaborator-invited', ONSITE).url).toBe('/apps/invites');
  });

  it('links there for an OFF-SITE listing too — the app id is irrelevant to the route', () => {
    // The pre-change `appUrl(details)` fell back to `/apps` whenever `appBlockId` was
    // null, so an off-site invitee landed on the marketplace with no way to find the
    // invitation at all.
    expect(msg('app-collaborator-invited', OFFSITE).url).toBe('/apps/invites');
  });

  it('the url does NOT vary with the app ids — it is keyed to the RECIPIENT', () => {
    // `listMyPendingInvites` is scoped to `ctx.user.id`; the page needs no app id, and a
    // url that carried one would be the app-keyed shape this notification must not use.
    const a = msg('app-collaborator-invited', ONSITE).url;
    const b = msg('app-collaborator-invited', { ...ONSITE, appBlockId: 'ab_totally_other' }).url;
    expect(a).toBe(b);
    expect(a).not.toContain('ab_1');
    expect(a).not.toContain('apl_1');
  });

  it('still names the app in the MESSAGE, so the invite is identifiable', () => {
    expect(msg('app-collaborator-invited', ONSITE).message).toContain('My App');
    // Name absent ⇒ the terser slug form (the sibling families' convention).
    expect(msg('app-collaborator-invited', { ...ONSITE, name: null }).message).toContain('my-app');
  });
});

/**
 * The CONTROL that stops the fix over-reaching: the other types in this family are about
 * an app the recipient already has access to, so they must keep pointing at the APP.
 * Sending everything to the inbox would be as wrong as sending nothing there.
 */
describe('the other collaborator notifications still point at the APP', () => {
  it('an ACCEPTED notification links to the app, not the inbox', () => {
    const { url } = msg('app-collaborator-accepted', ONSITE);
    expect(url).not.toBe('/apps/invites');
    expect(url).toContain('ab_1');
  });

  it('…and falls back to /apps for an off-site listing, which has no app-block route', () => {
    expect(msg('app-collaborator-accepted', OFFSITE).url).toBe('/apps');
  });
});

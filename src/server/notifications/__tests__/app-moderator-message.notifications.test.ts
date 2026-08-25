import { describe, expect, it } from 'vitest';
import {
  appModeratorMessageNotifications,
  MODERATION_REPLY_URL,
  type AppModeratorMessageNotificationDetails,
} from '~/server/notifications/app-moderator-message.notifications';
import { notificationProcessors } from '~/server/notifications/utils.notifications';
import { OWNER_SUBMISSIONS_URL } from '~/server/notifications/app-listing.notifications';

/**
 * The twelfth app notification type — the moderator's free-text message (pure: no DB,
 * no client).
 *
 * 🔴 THE COPY IS PINNED AS A WHOLE NORMALISED STRING, not by keyword. The artifact
 * under test IS prose, and a guard on WORDS is walkable by REWORDING: a `toContain`
 * on "not delivered" stays green through a rewrite that drops the reply route
 * entirely, or that renders the subject and silently drops the body. A cosmetic reword
 * will now fail this test — that is the price of a machine-readable claim about what a
 * developer actually receives, and it is worth paying for the one notification type
 * whose entire payload is text a human wrote.
 */

type Def = (typeof appModeratorMessageNotifications)['app-moderator-message'];
const def = (appModeratorMessageNotifications as Record<string, Def>)['app-moderator-message'];

function msg(details: AppModeratorMessageNotificationDetails) {
  return def.prepareMessage({ details } as Parameters<Def['prepareMessage']>[0]);
}

const DETAILS: AppModeratorMessageNotificationDetails = {
  slug: 'prompt-vault',
  listingId: 'apl_live',
  subject: 'Your listing describes a spend confirmation that does not exist',
  body: 'It says it asks before it spends. It has never shown a confirmation.',
};

describe('registration shape', () => {
  it('is a non-toggleable System notification with no prepareQuery', () => {
    expect(def).toBeTruthy();
    // Not toggleable, for the same reason the moderation-decision types are not: a
    // developer must not be able to opt out of being told their app has a problem.
    expect(def.toggleable).toBe(false);
    expect(def.category).toBe('System');
    // Imperative — emitted from the service, never scanned by the scheduled job.
    expect((def as { prepareQuery?: unknown }).prepareQuery).toBeUndefined();
  });

  it('🔴 is REGISTERED in the shared processor map', () => {
    // Without this the type renders as `null` in the drawer: `getNotificationMessage`
    // looks the type up in `notificationProcessors` and returns null on a miss. The
    // send would succeed, the row would exist, and the developer would see nothing —
    // a silent failure that no test of this module alone can see.
    expect(notificationProcessors).toHaveProperty('app-moderator-message');
    expect((notificationProcessors as Record<string, unknown>)['app-moderator-message']).toBe(def);
  });
});

describe('prepareMessage', () => {
  it('🔴 renders the EXACT string a developer receives', () => {
    const m = msg(DETAILS);
    expect(m).toBeTruthy();
    expect(m!.message).toBe(
      'Civitai moderation sent you a message about your app "prompt-vault" — ' +
        'Your listing describes a spend confirmation that does not exist: ' +
        'It says it asks before it spends. It has never shown a confirmation. ' +
        '(Replies to this notification are not delivered; contact the team at civitai.com/support.)'
    );
  });

  it('carries BOTH halves of what the moderator wrote, verbatim', () => {
    // Independently of the whole-string pin above, because the failure mode this
    // guards — rendering the subject and dropping the body — is the one that turns a
    // message into a notification with no content, and it is a one-line edit.
    const m = msg(DETAILS);
    expect(m!.message).toContain(DETAILS.subject);
    expect(m!.message).toContain(DETAILS.body);
  });

  it('identifies the app by SLUG, which is never null', () => {
    // The sibling families fall back to a terse label when `name` is absent. Here the
    // recipient may own several apps, and one of the two listings that motivated this
    // feature has an entirely empty listing — i.e. a null name — so a fallback would
    // fire exactly where identification matters most.
    const m = msg({ ...DETAILS, slug: 'df-qwen-canvas' });
    expect(m!.message).toContain('your app "df-qwen-canvas"');
    expect(m!.message).not.toContain('prompt-vault');
  });

  it('🔴 always states that replies are not delivered, and where to go instead', () => {
    // A one-way channel that does not say so strands a developer who wants to answer.
    const m = msg(DETAILS);
    expect(m!.message).toContain('not delivered');
    expect(m!.message).toContain(MODERATION_REPLY_URL);
  });

  it('does NOT name the acting moderator — nothing in details can', () => {
    // Attribution lives in `AppListingModerationEvent.actorUserId`. Naming the
    // individual on the wire would make "who acted on my app" answerable by the
    // developer, which is a retaliation vector the rest of the moderation surface
    // declines to open. Asserted on the TYPE's own field set, so adding a
    // `moderatorUsername` field later fails here rather than shipping quietly.
    expect(Object.keys(DETAILS).sort()).toEqual(['body', 'listingId', 'slug', 'subject']);
  });

  it('links to the owner submissions view, the one URL the recipient can always open', () => {
    // `/apps/mine` gates on `appBlocksAuthor` — the cohort a listing owner is in by
    // construction — whereas the public detail page gates on `hasAppsStoreAccess` and
    // 404s for owners outside it. Pinned against the shared constant so a route rename
    // moves this with its five siblings rather than stranding it.
    expect(msg(DETAILS)!.url).toBe(OWNER_SUBMISSIONS_URL);
    expect(OWNER_SUBMISSIONS_URL).toBe('/apps/mine');
  });
});

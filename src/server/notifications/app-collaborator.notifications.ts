import { NotificationCategory } from '~/server/common/enums';
import { createNotificationProcessor } from '~/server/notifications/base.notifications';

/**
 * App Listing COLLABORATORS — seat + ownership-transfer notifications.
 *
 * IMPERATIVE types (emitted directly from the services POST-COMMIT via
 * `createNotification`, behind the `notifyAppCollaborator` helper) — NOT scanned by a
 * scheduled `prepareQuery`, so they carry only a `prepareMessage`. Same shape as the
 * sibling `app-block.notifications` / `app-listing.notifications` families.
 *
 * 🔴 REUSING THIS PATH IS A DELIBERATE DIVERGENCE FROM THE PRIOR ART.
 * `EntityCollaborator` delivers its invite as a SYSTEM CHAT MESSAGE (`upsertChat` +
 * `createMessage` with `userId: -1`). That drags the whole chat subsystem into an
 * App Blocks flow, has no idempotency key, and is not toggleable or dismissible like a
 * notification. The App Blocks surface already has a notification path; using it keeps
 * the seat lifecycle on the same rails as approve/reject.
 *
 * The `type` strings are free-form (the notifications app stores them as text, no DB
 * enum), so adding these needs NO notifications-DB migration. Registered in
 * `utils.notifications.ts`.
 */

export type AppCollaboratorNotificationDetails = {
  /** The listing's public slug — identity + link target. */
  slug: string;
  /** The store listing the seat/transfer belongs to (the stable key). */
  appListingId?: string | null;
  /**
   * The backing AppBlock id, when there is one. 🔴 `null` for an OFF-SITE listing —
   * seats are listing-keyed and off-site listings have no AppBlock, so this is a
   * legitimately-absent value, not a missing one.
   */
  appBlockId?: string | null;
  /** Best-effort display name for nicer copy; absent ⇒ terser message. */
  name?: string | null;
};

/**
 * Where each notification points.
 *
 * 🔴 The per-app authoring pages are BLOCK-keyed (`/apps/[appBlockId]/…`), so an
 * off-site listing has no such page to deep-link to and falls back to `/apps`. That is
 * the pre-existing behaviour for a null `appBlockId`, kept deliberately rather than
 * inventing a route that does not exist.
 */
const APP_INVITES_URL = '/apps/invites';

function appUrl(details: AppCollaboratorNotificationDetails): string {
  return details.appBlockId ? `/apps/${details.appBlockId}` : '/apps';
}

/** `the app "Name"` when a name is present, else `the app <slug>`. */
function appLabel(details: AppCollaboratorNotificationDetails): string {
  const name = details.name?.trim();
  return name ? `the app "${name}"` : `the app ${details.slug}`;
}

export const appCollaboratorNotifications = createNotificationProcessor({
  'app-collaborator-invited': {
    displayName: 'App collaborator invitation',
    category: NotificationCategory.System,
    toggleable: false,
    prepareMessage: (notification) => {
      const details = notification.details as AppCollaboratorNotificationDetails;
      return {
        message: `You were invited to collaborate on ${appLabel(details)}.`,
        // 🔴 THE INVITE INBOX, not `appUrl`. A PENDING invitee owns nothing and holds no
        // accepted seat, so every `/apps/<id>/…` page resolves their role, finds none and
        // refuses — pointing this notification at the app would land them on a 404 for
        // the app they were just invited to. `/apps/invites` is keyed to their own user
        // id (`listMyPendingInvites`) and is the only surface that can show it.
        url: APP_INVITES_URL,
      };
    },
  },
  'app-collaborator-accepted': {
    displayName: 'App collaborator accepted',
    category: NotificationCategory.System,
    toggleable: false,
    prepareMessage: (notification) => {
      const details = notification.details as AppCollaboratorNotificationDetails;
      return {
        message: `Your collaborator invitation for ${appLabel(details)} was accepted.`,
        url: appUrl(details),
      };
    },
  },
  'app-collaborator-removed': {
    displayName: 'App collaborator removed',
    category: NotificationCategory.System,
    toggleable: false,
    prepareMessage: (notification) => {
      const details = notification.details as AppCollaboratorNotificationDetails;
      return {
        message: `You are no longer a collaborator on ${appLabel(details)}.`,
        url: '/apps',
      };
    },
  },
  'app-ownership-transfer-offered': {
    displayName: 'App ownership transfer offered',
    category: NotificationCategory.System,
    toggleable: false,
    prepareMessage: (notification) => {
      const details = notification.details as AppCollaboratorNotificationDetails;
      return {
        message: `You were offered ownership of ${appLabel(details)}. Accept it to take over.`,
        url: appUrl(details),
      };
    },
  },
  'app-ownership-transfer-accepted': {
    displayName: 'App ownership transfer accepted',
    category: NotificationCategory.System,
    toggleable: false,
    prepareMessage: (notification) => {
      const details = notification.details as AppCollaboratorNotificationDetails;
      return {
        message: `Ownership of ${appLabel(details)} was transferred.`,
        url: appUrl(details),
      };
    },
  },
});

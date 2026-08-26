import * as z from 'zod';

/**
 * App Store Listings — MOD "message this app's owner" input.
 *
 * A moderator-initiated, free-text message that lands in the app owner's
 * notifications. The listing is named by id (`apl_<ULID>`; a shadow revision id is
 * accepted and resolved to its parent by the service), the recipient is DERIVED — the
 * caller never supplies a userId, so this surface cannot be turned into a
 * "notify arbitrary user" primitive by changing one field.
 */

/**
 * Bounds. A notification renders as ONE message string in a drawer, so the ceiling is
 * set by what is readable there rather than by what Postgres can hold.
 *
 * The floors are the point, not the ceilings: a 1-character subject or body is a
 * misfire (a stray Enter in a modal), and it would still reach the developer as a
 * "Civitai moderation sent you a message" push. `OFFSITE_MOD_REASON_MIN` (3) is the
 * house precedent for "a mod must actually have typed something"; the BODY floor is
 * deliberately higher, because a 3-character body cannot carry the "here is what to
 * fix" this channel exists to deliver.
 */
export const MOD_MESSAGE_SUBJECT_MIN = 3;
export const MOD_MESSAGE_SUBJECT_MAX = 200;
export const MOD_MESSAGE_BODY_MIN = 20;
export const MOD_MESSAGE_BODY_MAX = 2000;

export const messageAppOwnerSchema = z.object({
  appListingId: z.string().min(1).max(64),
  subject: z.string().min(MOD_MESSAGE_SUBJECT_MIN).max(MOD_MESSAGE_SUBJECT_MAX),
  body: z.string().min(MOD_MESSAGE_BODY_MIN).max(MOD_MESSAGE_BODY_MAX),
  /**
   * Also deliver to the listing's ACCEPTED collaborators.
   *
   * 🔴 DEFAULTS TO FALSE, deliberately. The OWNER is the accountable party — they are
   * who the platform holds responsible for the listing, and who a takedown lands on.
   * An accepted collaborator consented to EDIT an app, not to receive moderation
   * correspondence about it, and a moderator's message can be adverse ("this claim is
   * false"), so fanning it out by default would broadcast a private accusation to
   * third parties the owner invited.
   *
   * It is offered at all because the failure mode in the other direction is real: on
   * an app whose owner is unresponsive, the accepted editors are the only people who
   * can actually fix the listing. That is a judgement call per message, which is
   * exactly what an explicit opt-in is for.
   *
   * `displayed` is NOT consulted — it is a PUBLIC-CREDIT preference, not a capability,
   * and an editor who declined a byline can still edit the listing.
   */
  includeCollaborators: z.boolean().optional(),
});
export type MessageAppOwnerInput = z.infer<typeof messageAppOwnerSchema>;

import { z } from 'zod';

/**
 * App Listing COLLABORATORS — tRPC input schemas.
 *
 * 🔴 THESE ARE ALL NEW SCHEMAS ON NEW PROCS. No existing proc's input schema is
 * touched anywhere in this feature, which is the CLI wire contract: released
 * `civitai` CLI versions drive the listing-media procs
 * (`setIcon`/`setCover`/`addScreenshot`/`removeScreenshot`/`reorderScreenshots`/
 * `getMyListingForApp`/`beginListingRevision`/`submitListingRevision`, …) under the
 * `AppBlocksSubmit` token scope. Widening a GATE is invisible to those clients;
 * changing an INPUT SCHEMA breaks them. `app-collaborator.cli-contract.test.ts`
 * asserts every `listingMediaCliScope`-annotated proc's schema shape is unchanged.
 *
 * `appBlockId` bounds mirror the rest of the App Blocks surface (`min(1).max(64)`) so
 * a request-size guard is consistent across routers.
 */

const appBlockId = z.string().min(1).max(64);
/** A civitai `User.id`. Positive int — the FK would reject anything else anyway. */
const userId = z.number().int().positive();

export const inviteAppCollaboratorSchema = z.object({
  appBlockId,
  targetUserId: userId,
});
export type InviteAppCollaboratorInput = z.infer<typeof inviteAppCollaboratorSchema>;

export const respondToAppInviteSchema = z.object({
  appBlockId,
  accept: z.boolean(),
});
export type RespondToAppInviteInput = z.infer<typeof respondToAppInviteSchema>;

export const removeAppCollaboratorSchema = z.object({
  appBlockId,
  targetUserId: userId,
});
export type RemoveAppCollaboratorInput = z.infer<typeof removeAppCollaboratorSchema>;

export const leaveAppSchema = z.object({ appBlockId });
export type LeaveAppInput = z.infer<typeof leaveAppSchema>;

export const setCollaboratorDisplayedSchema = z.object({
  appBlockId,
  displayed: z.boolean(),
});
export type SetCollaboratorDisplayedInput = z.infer<typeof setCollaboratorDisplayedSchema>;

export const listAppCollaboratorsSchema = z.object({ appBlockId });
export type ListAppCollaboratorsInput = z.infer<typeof listAppCollaboratorsSchema>;

export const initiateAppTransferSchema = z.object({
  appBlockId,
  toUserId: userId,
});
export type InitiateAppTransferInput = z.infer<typeof initiateAppTransferSchema>;

export const transferIdSchema = z.object({
  transferId: z.string().min(1).max(64),
});
export type TransferIdInput = z.infer<typeof transferIdSchema>;

export const getPendingAppTransferSchema = z.object({ appBlockId });
export type GetPendingAppTransferInput = z.infer<typeof getPendingAppTransferSchema>;

export const getAppEarningsSchema = z.object({
  appBlockId,
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
});
export type GetAppEarningsInput = z.infer<typeof getAppEarningsSchema>;

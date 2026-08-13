import * as z from 'zod';
import { CollectionCollaboratorRole } from '~/shared/utils/prisma/enums';

export type InviteCollaboratorInput = z.infer<typeof inviteCollaboratorInput>;
export const inviteCollaboratorInput = z.object({
  collectionId: z.number(),
  targetUserId: z.number(),
  role: z.enum(CollectionCollaboratorRole),
});

export type RespondToInviteInput = z.infer<typeof respondToInviteInput>;
export const respondToInviteInput = z.object({
  inviteId: z.number(),
  accept: z.boolean(),
});

export type RemoveCollaboratorInput = z.infer<typeof removeCollaboratorInput>;
export const removeCollaboratorInput = z.object({
  collectionId: z.number(),
  targetUserId: z.number(),
});

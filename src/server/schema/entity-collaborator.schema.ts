import { EntityType } from '@prisma/client';
import { z } from 'zod';

export type UpsertEntityCollaboratorInput = z.infer<typeof upsertEntityCollaboratorInput>;
export const upsertEntityCollaboratorInput = z.object({
  targetUserId: z.number(),
  entityId: z.number(),
  entityType: z.nativeEnum(EntityType),
  sendMessage: z.boolean().optional().default(true),
});

export type RemoveEntityCollaboratorInput = z.infer<typeof removeEntityCollaboratorInput>;
export const removeEntityCollaboratorInput = z.object({
  targetUserId: z.number(),
  entityId: z.number(),
  entityType: z.nativeEnum(EntityType),
});

export type GetEntityCollaboratorsInput = z.infer<typeof getEntityCollaboratorsInput>;
export const getEntityCollaboratorsInput = z.object({
  entityId: z.number(),
  entityType: z.nativeEnum(EntityType),
});

// TODO: Add end-point to send system message to user / new action type.

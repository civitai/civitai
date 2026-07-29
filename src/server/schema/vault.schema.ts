import * as z from 'zod';
import { VaultSort } from '~/server/common/enums';
import { paginationSchema } from '~/server/schema/base.schema';
import { ModelType } from '~/shared/utils/prisma/enums';

export type GetPaginatedVaultItemsSchema = z.infer<typeof getPaginatedVaultItemsSchema>;
export const getPaginatedVaultItemsSchema = paginationSchema.merge(
  z.object({
    limit: z.coerce.number().min(1).max(200).default(60),
    query: z.string().optional(),
    types: z.array(z.enum(ModelType)).optional(),
    categories: z.array(z.string()).optional(),
    baseModels: z.array(z.string()).optional(),
    dateCreatedFrom: z.date().optional(),
    dateCreatedTo: z.date().optional(),
    dateAddedFrom: z.date().optional(),
    dateAddedTo: z.date().optional(),
    sort: z.enum(VaultSort).default(VaultSort.RecentlyAdded),
  })
);

export type VaultItemsAddModelVersionSchema = z.infer<typeof vaultItemsAddModelVersionSchema>;
export const vaultItemsAddModelVersionSchema = z.object({
  modelVersionId: z.number(),
});

export type VaultItemsRefreshSchema = z.infer<typeof vaultItemsRefreshSchema>;
export const vaultItemsRefreshSchema = z.object({
  modelVersionIds: z.array(z.number()).min(1),
});

export type VaultItemsUpdateNotesSchema = z.infer<typeof vaultItemsUpdateNotesSchema>;
export const vaultItemsUpdateNotesSchema = z.object({
  modelVersionIds: z.array(z.number()).min(1),
  notes: z.string().optional(),
});

export type VaultItemsRemoveModelVersionsSchema = z.infer<
  typeof vaultItemsRemoveModelVersionsSchema
>;
export const vaultItemsRemoveModelVersionsSchema = z.object({
  modelVersionIds: z.array(z.number()).min(1),
});

export type VaultItemMetadataSchema = z.infer<typeof vaultItemMetadataSchema>;
export const vaultItemMetadataSchema = z.object({
  failures: z.number().default(0),
  latestError: z.string().optional(),
  // Advisory in-flight lease (epoch millis) set by the process-vault-items job
  // while it works an item, so overlapping runs don't double-process it. Cleared
  // on completion; a killed run's stale lease ages out. `nullish` because the job
  // clears it by writing JSON null.
  processingStartedAt: z.number().nullish(),
});

export type VaultItemFilesSchema = z.infer<typeof vaultItemFilesSchema>;
export const vaultItemFilesSchema = z.array(
  z.object({
    id: z.number(),
    sizeKB: z.number(),
    url: z.string(),
    displayName: z.string(),
  })
);

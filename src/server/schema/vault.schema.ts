import { ModelType } from '@prisma/client';
import _ from 'lodash';
import { z } from 'zod';
import { VaultSort } from '~/server/common/enums';
import { paginationSchema } from '~/server/schema/base.schema';

export type GetPaginatedVaultItemsSchema = z.infer<typeof getPaginatedVaultItemsSchema>;
export const getPaginatedVaultItemsSchema = paginationSchema.merge(
  z.object({
    limit: z.coerce.number().min(1).max(200).default(60),
    query: z.string().optional(),
    types: z.array(z.nativeEnum(ModelType)).optional(),
    categories: z.array(z.string()).optional(),
    baseModels: z.array(z.string()).optional(),
    dateCreatedFrom: z.date().optional(),
    dateCreatedTo: z.date().optional(),
    dateAddedFrom: z.date().optional(),
    dateAddedTo: z.date().optional(),
    sort: z.nativeEnum(VaultSort).default(VaultSort.RecentlyAdded),
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

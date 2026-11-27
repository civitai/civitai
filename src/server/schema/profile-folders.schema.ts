import * as z from 'zod';
import { CollectionReadConfiguration } from '~/shared/utils/prisma/enums';

export const profileFolderLimits = {
  folders: 100,
  rows: 20,
  rowName: 60,
  foldersPerRow: 12,
  showcase: 8,
  editorItems: 1000,
  name: 30,
  description: 300,
} as const;

export const createFolderInput = z.object({
  name: z.string().trim().min(1).max(profileFolderLimits.name),
  description: z.string().trim().max(profileFolderLimits.description).nullish(),
  read: z
    .enum([
      CollectionReadConfiguration.Public,
      CollectionReadConfiguration.Unlisted,
      CollectionReadConfiguration.Private,
    ])
    .default(CollectionReadConfiguration.Public),
});
export type CreateFolderInput = z.infer<typeof createFolderInput>;

export const setItemShowcaseInput = z.object({
  collectionItemId: z.number().int().positive(),
  showcased: z.boolean(),
});
export type SetItemShowcaseInput = z.infer<typeof setItemShowcaseInput>;

export const folderRowSchema = z.object({
  id: z.string().regex(/^[A-Za-z0-9_-]{1,32}$/),
  name: z.string().trim().max(profileFolderLimits.rowName),
  folders: z
    .array(z.object({ id: z.number().int().positive(), hidden: z.boolean().optional() }))
    .max(profileFolderLimits.foldersPerRow),
});
export type FolderRowSchema = z.infer<typeof folderRowSchema>;

export const setFolderRowsInput = z.object({
  rows: z.array(folderRowSchema).max(profileFolderLimits.rows),
  /** The rows the editor started from; a save over newer rows is refused instead of lost. */
  ifUnchangedFrom: z.array(folderRowSchema).optional(),
});
export type SetFolderRowsInput = z.infer<typeof setFolderRowsInput>;

export const getProfileFoldersInput = z.object({ userId: z.number().int().positive() });
export type GetProfileFoldersInput = z.infer<typeof getProfileFoldersInput>;

export const getProfileFolderInput = z.object({
  userId: z.number().int().positive(),
  folderId: z.number().int().positive(),
});
export type GetProfileFolderInput = z.infer<typeof getProfileFolderInput>;

export const getFolderItemsInput = z.object({ folderId: z.number().int().positive() });
export type GetFolderItemsInput = z.infer<typeof getFolderItemsInput>;

/** Stored rows with every row name blanked: the order, grouping and hidden folders stay. */
export const folderRowsWithoutNames = (rows: unknown): FolderRowSchema[] =>
  ((rows ?? []) as FolderRowSchema[]).map((row) => ({ ...row, name: '' }));

export const folderRowsText = (rows: unknown) =>
  ((rows ?? []) as FolderRowSchema[])
    .map(({ name }) => name)
    .filter(Boolean)
    .join('\n');

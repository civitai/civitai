import type { Context, ProtectedContext } from '~/server/createContext';
import type {
  CreateFolderInput,
  GetFolderItemsInput,
  GetProfileFolderInput,
  GetProfileFoldersInput,
  SetFolderRowsInput,
  SetItemShowcaseInput,
} from '~/server/schema/profile-folders.schema';
import { createFolder } from '~/server/services/collection.service';
import { setItemShowcase } from '~/server/services/profile-folder-showcase.service';
import { getProfileFolders, setFolderRows } from '~/server/services/profile-folders.service';
import { getFolderItems, getProfileFolder } from '~/server/services/profile-folder-reads.service';

export const createFolderHandler = ({
  input,
  ctx,
}: {
  input: CreateFolderInput;
  ctx: ProtectedContext;
}) => createFolder({ ...input, userId: ctx.user.id, isModerator: ctx.user.isModerator });

export const setItemShowcaseHandler = ({
  input,
  ctx,
}: {
  input: SetItemShowcaseInput;
  ctx: ProtectedContext;
}) => setItemShowcase({ ...input, userId: ctx.user.id });

export const setFolderRowsHandler = ({
  input,
  ctx,
}: {
  input: SetFolderRowsInput;
  ctx: ProtectedContext;
}) => setFolderRows({ ...input, userId: ctx.user.id });

export const getProfileFoldersHandler = ({
  input,
  ctx,
}: {
  input: GetProfileFoldersInput;
  ctx: Context;
}) =>
  getProfileFolders({
    ...input,
    viewerId: ctx.user?.id,
    isModerator: ctx.user?.isModerator,
  });

export const getProfileFolderHandler = ({
  input,
  ctx,
}: {
  input: GetProfileFolderInput;
  ctx: Context;
}) => getProfileFolder({ ...input, viewerId: ctx.user?.id, isModerator: ctx.user?.isModerator });

export const getFolderItemsHandler = ({
  input,
  ctx,
}: {
  input: GetFolderItemsInput;
  ctx: ProtectedContext;
}) => getFolderItems({ ...input, userId: ctx.user.id });

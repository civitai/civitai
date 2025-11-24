import type { ImageDetailDialog } from './image-detail.dialog';
import type { CollectionEditDialog } from './collection-edit.dialog';
import type { HiddenCommentsDialog } from './hidden-comments.dialog';
import type { ResourceReviewDialog } from './resource-review.dialog';
import type { FilesEditDialog } from './files-edit.dialog';
import type { CommentEditDialog } from './comment-edit.dialog';
import type { CommentThreadDialog } from './comment-thread.dialog';
import type { SupportDialog } from './support.dialog';
import './image-detail.dialog';
import './collection-edit.dialog';
import './hidden-comments.dialog';
import './resource-review.dialog';
import './files-edit.dialog';
import './comment-edit.dialog';
import './comment-thread.dialog';
import './support.dialog';
import { routedDialogDictionary } from './utils';
import type { ComponentProps } from 'react';

type Dialogs = ImageDetailDialog &
  CollectionEditDialog &
  HiddenCommentsDialog &
  ResourceReviewDialog &
  FilesEditDialog &
  CommentEditDialog &
  CommentThreadDialog &
  SupportDialog;

export const dialogs = routedDialogDictionary.getItems<Dialogs>();
export type DialogKey = keyof typeof dialogs;
export type DialogState<T extends DialogKey> = ComponentProps<(typeof dialogs)[T]['component']>;

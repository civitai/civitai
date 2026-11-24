import type { RoutedDialog } from './utils';
import { collectionEditDialog } from './collection-edit.dialog';
import { commentEditDialog } from './comment-edit.dialog';
import { commentThreadDialog } from './comment-thread.dialog';
import { filesEditDialog } from './files-edit.dialog';
import { hiddenCommentsDialog } from './hidden-comments.dialog';
import { imageDetailDialog } from './image-detail.dialog';
import { resourceReviewDialog } from './resource-review.dialog';
import { supportDialog } from './support.dialog';

/** URL rules only: no modal is imported here. The components are in `RoutedDialogProvider`. */
export const dialogs = {
  imageDetail: imageDetailDialog,
  collectionEdit: collectionEditDialog,
  hiddenComments: hiddenCommentsDialog,
  resourceReview: resourceReviewDialog,
  filesEdit: filesEditDialog,
  commentEdit: commentEditDialog,
  commentThread: commentThreadDialog,
  support: supportDialog,
};
export type DialogKey = keyof typeof dialogs;
export type DialogState<T extends DialogKey> = Parameters<(typeof dialogs)[T]['resolve']>[1];

/** One dialog's URL rule, typed for its own state (indexing `dialogs` with a generic name would intersect every rule's arguments). */
export const getRoutedDialog = <T extends DialogKey>(name: T) =>
  dialogs[name] as unknown as RoutedDialog<DialogState<T>> | undefined;

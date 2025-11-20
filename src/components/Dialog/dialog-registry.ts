/**
 * Dialog Registry - String-based dialog opening system
 *
 * This file exports dialog trigger functions that use string-based dialog names
 * instead of directly importing dialog components. This breaks circular dependencies.
 *
 * Migration from old pattern:
 * OLD: import { SomeModal } from './SomeModal'; openDialog({ component: SomeModal })
 * NEW: openSomeModal() -> uses string name -> dynamic import
 *
 * NOTE: This file intentionally does NOT import any types from modal components
 * to avoid circular dependencies. TypeScript will infer types from usage.
 */

import { createDialogTriggerByName, dialogStore } from '~/components/Dialog/dialogStore';

// ============================================================================
// Simple Modals (no props required)
// ============================================================================

export const openBrowsingLevelGuide = createDialogTriggerByName('browsing-level-guide');
export const openHiddenTagsModal = createDialogTriggerByName('hidden-tags', {
  target: '#browsing-mode',
});
export const openReadOnlyModal = createDialogTriggerByName('read-only');
export const openLoginModal = createDialogTriggerByName('login');

// Modals with default options
export const openBlockModelTagsModal = createDialogTriggerByName('block-model-tags');
export const openUnpublishModal = createDialogTriggerByName('unpublish');
export const openArticleUnpublishModal = createDialogTriggerByName('article-unpublish');
export const openRunStrategyModal = createDialogTriggerByName('run-strategy');
export const openCivitaiLinkWizardModal = createDialogTriggerByName('civitai-link-wizard');
export const openAssociateModelsModal = createDialogTriggerByName('associate-models');
export const openCivitaiLinkSuccessModal = createDialogTriggerByName('civitai-link-success');
export const openManageHomeBlocksModal = createDialogTriggerByName('manage-home-blocks');
export const openCardDecorationModal = createDialogTriggerByName('card-decoration');
export const openUserProfileEditModal = createDialogTriggerByName('user-profile-edit');
export const openAddToCollectionModal = createDialogTriggerByName('collection-add-to');
export const openBountyEntryFilesModal = createDialogTriggerByName('bounty-entry-files');
export const openChatShareModal = createDialogTriggerByName('chat-share');

// ============================================================================
// Modals with Props
// ============================================================================

export function openSetBrowsingLevelModal(props: any) {
  dialogStore.trigger({ name: 'browsing-level-set', props });
}

export function openResourceSelectModal(props: any) {
  dialogStore.trigger({
    name: 'resource-select',
    props,
  });
}

export function openCollectionSelectModal(props: any) {
  dialogStore.trigger({ name: 'collection-select', props });
}

export function openMigrateModelToCollectionModal(props: { modelId: number }) {
  dialogStore.trigger({ name: 'model-migrate-to-collection', props });
}

export function openResourceReviewEditModal(props: any) {
  dialogStore.trigger({ name: 'resource-review-edit', props });
}

export function openReportModal(props: any) {
  dialogStore.trigger({ name: 'report', props });
}

export function openImageSelectModal(props: any) {
  dialogStore.trigger({ name: 'image-select', props });
}

import type { ComponentType } from 'react';

/**
 * Dialog loaders - maps string-based dialog names to dynamic import functions
 * This breaks circular dependencies by not importing dialog components directly
 */

type DialogLoader<T = any> = () => Promise<{ default: ComponentType<T> }>;

export const dialogLoaders = {
  // Browsing Level
  'browsing-level-guide': () => import('~/components/BrowsingLevel/BrowsingLevelGuide'),
  'browsing-level-set': () => import('~/components/BrowsingLevel/SetBrowsingLevelModal'),

  // Tags
  'hidden-tags': () => import('~/components/Tags/HiddenTagsModal'),
  'block-model-tags': () => import('~/components/Modals/BlockModelTagsModal'),

  // Resources
  'resource-select': () =>
    import('~/components/ImageGeneration/GenerationForm/ResourceSelectModal2'),

  // Collections
  'collection-select': () => import('~/components/CollectionSelectModal/CollectionSelectModal'),
  'collection-add-to': () => import('~/components/Collections/AddToCollectionModal'),
  'model-migrate-to-collection': () =>
    import('~/components/Model/Actions/MigrateModelToCollection'),

  // Reviews
  'resource-review-edit': () => import('~/components/ResourceReview/EditResourceReviewModal'),

  // Reports
  report: () => import('~/components/Modals/ReportModal'),

  // Images
  'image-select': () => import('~/components/Training/Form/ImageSelectModal'),

  // Modals
  'read-only': () => import('~/components/Modals/ReadOnlyModal'),
  unpublish: () => import('~/components/Modals/UnpublishModal'),
  'article-unpublish': () => import('~/components/Modals/ArticleUnpublishModal'),
  'run-strategy': () => import('~/components/Modals/RunStrategyModal'),
  'associate-models': () => import('~/components/Modals/AssociateModelsModal'),
  'user-profile-edit': () => import('~/components/Modals/UserProfileEditModal'),
  'card-decoration': () => import('~/components/Modals/CardDecorationModal'),

  // Civitai Link
  'civitai-link-wizard': () => import('~/components/CivitaiLink/CivitaiLinkWizard'),
  'civitai-link-success': () => import('~/components/CivitaiLink/CivitaiLinkSuccessModal'),

  // Bounty
  'bounty-entry-files': () => import('~/components/Bounty/BountyEntryFilesModal'),

  // Chat
  'chat-share': () => import('~/components/Chat/ChatShareModal'),

  // Home Blocks
  'manage-home-blocks': () => import('~/components/HomeBlocks/ManageHomeBlocksModal'),

  // Login
  login: () => import('~/components/Login/LoginModal'),
} as const satisfies Record<string, DialogLoader>;

export type DialogName = keyof typeof dialogLoaders;

/**
 * Loads a dialog component by name
 */
export async function loadDialogComponent(name: DialogName): Promise<ComponentType<any>> {
  const loader = dialogLoaders[name];
  if (!loader) {
    throw new Error(`Unknown dialog: ${name}`);
  }
  const module = await loader();
  return module.default;
}

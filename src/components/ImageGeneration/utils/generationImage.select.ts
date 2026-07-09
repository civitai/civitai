import { createSelectionContext, createSelectionStore } from '~/store/createSelectionStore';
import type { BlobData } from '~/shared/orchestrator/workflow-data';

const getKey = (image: BlobData) => `${image.workflowId}:${image.stepName}:${image.id}`;

/**
 * The default generated-image selection store instance. Provided to the Queue/Feed
 * subtree via the exported {@link SelectionProvider}, and also used as the context's
 * default so portaled consumers (the lightbox dialog, rendered outside the provider)
 * resolve to the same instance. Exported for imperative/non-React access via
 * `generatedImageSelectStore.actions`.
 */
export const generatedImageSelectStore = createSelectionStore<BlobData>({
  getKey,
  name: 'generated-image-select',
});

export const {
  SelectionProvider,
  useActions,
  useSelection,
  useIsSelected,
  useIsSelecting,
  useSelectedCount,
  useRegisterOrder,
} = createSelectionContext<BlobData>(generatedImageSelectStore);

import { SegmentedControl } from '@mantine/core';
import { useCollection, useMutateCollection } from '~/components/Collections/collection.utils';
import { browsingLevelLabels, browsingLevels } from '~/shared/constants/browsingLevel.constants';

export const CollectionItemNSFWLevelSelector = ({
  collectionId,
  collectionItemId,
  nsfwLevel,
  onNsfwLevelUpdated,
}: {
  collectionId: number;
  collectionItemId: number;
  nsfwLevel?: number;
  onNsfwLevelUpdated?: (value: string) => void;
}) => {
  const { collection, permissions, isLoading: loadingCollection } = useCollection(collectionId);
  const {
    updateCollectionItemNsfwLevel,
    updatingCollectionItemNsfwLevel,
    updateCollectionItemNsfwLevelPayload,
  } = useMutateCollection();

  const handleNSFWLevelChange = (value: string) => {
    updateCollectionItemNsfwLevel(
      {
        collectionItemId,
        nsfwLevel: parseInt(value, 10),
      },
      {
        onSuccess: async () => {
          onNsfwLevelUpdated?.(value);
        },
      }
    ).catch(() => null);
  };

  if (loadingCollection) return null;

  const judgesCanApplyRatings = collection?.metadata?.judgesApplyBrowsingLevel ?? false;

  if (!judgesCanApplyRatings || !permissions?.manage) return null;

  return (
    <SegmentedControl
      value={nsfwLevel?.toString() ?? undefined}
      onChange={handleNSFWLevelChange}
      data={browsingLevels.map((level) => ({
        value: level.toString(),
        label: browsingLevelLabels[level],
      }))}
      disabled={
        updatingCollectionItemNsfwLevel &&
        updateCollectionItemNsfwLevelPayload?.collectionItemId === collectionItemId
      }
    />
  );
};

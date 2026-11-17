import { SegmentedControl, Text } from '@mantine/core';
import { useState } from 'react';
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
  // The item and level a rescan was started at: the note clears once either changes, e.g. when the
  // item refetches with the rescan's level.
  const [rescanStartedAt, setRescanStartedAt] = useState<{
    collectionItemId: number;
    nsfwLevel?: number;
  }>();
  const rescanning =
    rescanStartedAt?.collectionItemId === collectionItemId &&
    rescanStartedAt.nsfwLevel === nsfwLevel;

  const handleNSFWLevelChange = (value: string) => {
    updateCollectionItemNsfwLevel(
      {
        collectionItemId,
        nsfwLevel: parseInt(value, 10),
      },
      {
        // The saved level is the higher of the pick and the scan's level. A raise into an NSFW level
        // is saved once the rescan's checks have run at it, so until then the old level shows.
        onSuccess: async (res) => {
          setRescanStartedAt(
            res?.rescanning ? { collectionItemId, nsfwLevel: res.nsfwLevel } : undefined
          );
          onNsfwLevelUpdated?.(String(res?.nsfwLevel ?? value));
        },
      }
    ).catch(() => null);
  };

  if (loadingCollection) return null;

  const judgesCanApplyRatings = collection?.metadata?.judgesApplyBrowsingLevel ?? false;

  if (!judgesCanApplyRatings || !permissions?.manage) return null;

  return (
    <>
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
      {rescanning && (
        <Text size="xs" c="dimmed">
          Rescanning: try again after the scan finishes.
        </Text>
      )}
    </>
  );
};

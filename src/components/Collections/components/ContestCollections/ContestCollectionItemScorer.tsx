import { Button, SegmentedControl, Text } from '@mantine/core';
import { useState } from 'react';
import { useSetCollectionItemScore } from '~/components/Collections/collection.utils';

export function ContestCollectionItemScorer({
  collectionItemId,
  currentScore = 0,
  onScoreChanged,
  layout = 'default',
}: {
  layout?: 'default' | 'minimal';
  collectionItemId: number;
  currentScore?: number;
  onScoreChanged?: (data: { userId: number; collectionItemId: number; score: number }) => void;
}) {
  const [selectedScore, setSelectedScore] = useState(currentScore);

  const { setItemScore, loading } = useSetCollectionItemScore();
  const handleSetItemScore = async (_score?: number) => {
    await setItemScore(
      {
        collectionItemId,
        score: _score ?? selectedScore,
      },
      {
        onSuccess: (result) => {
          if (onScoreChanged)
            onScoreChanged({
              userId: result.userId,
              collectionItemId: result.collectionItemId,
              score: result.score,
            });
        },
      }
    ).catch(() => null);
  };

  if (layout === 'minimal') {
    return (
      <SegmentedControl
        data={['1', '2', '3', '4', '5', '6', '7', '8', '9', '10']}
        value={selectedScore.toString()}
        onChange={(value) => {
          setSelectedScore(Number(value));
          handleSetItemScore(Number(value));
        }}
      />
    );
  }

  return (
    <div className="flex flex-col gap-2">
      <Text>
        Rate this submission on a scale of 1 to 10, with 1 being the lowest and 10 being the
        highest.
      </Text>
      <SegmentedControl
        data={['1', '2', '3', '4', '5', '6', '7', '8', '9', '10']}
        value={selectedScore.toString()}
        onChange={(value) => setSelectedScore(Number(value))}
      />
      <Button onClick={() => handleSetItemScore()} loading={loading}>
        Submit
      </Button>
    </div>
  );
}

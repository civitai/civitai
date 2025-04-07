import { SegmentedControl } from '@mantine/core';
import { useState } from 'react';
import { useDialogContext } from '~/components/Dialog/DialogProvider';
import { PageModal } from '~/components/Dialog/Templates/PageModal';
import { useJoinKnightsNewOrder } from '~/components/Games/KnightsNewOrder.utils';
import { NewOrderImageRatingStatus } from '~/server/common/enums';

export default function JudgementHistoryModal() {
  const dialog = useDialogContext();

  const [activeTab, setActiveTab] = useState<NewOrderImageRatingStatus | 'All'>('All');

  const { playerData } = useJoinKnightsNewOrder();

  return (
    <PageModal
      {...dialog}
      transition="scale"
      title={
        <div className="flex flex-col gap-1">
          <h1 className="text-xl">Your Judgement History</h1>
          <p className="text-sm text-gray-500">
            This is where you can view the history of your judgements. You can see the details of
            each judgement, including your rating, the final decision, and the image that was
            judged.
          </p>
        </div>
      }
      transitionDuration={300}
      fullScreen
    >
      <SegmentedControl
        value={activeTab}
        onChange={(value) => setActiveTab(value as NewOrderImageRatingStatus | 'All')}
        data={[
          'All',
          NewOrderImageRatingStatus.Correct,
          NewOrderImageRatingStatus.Failed,
          NewOrderImageRatingStatus.Pending,
        ]}
      />
    </PageModal>
  );
}

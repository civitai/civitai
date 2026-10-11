import { FlagAppealAlert } from '~/components/Moderation/FlagAppealAlert';
import {
  selectModelFlagAlertMessage,
  type MinorFlagAppeal,
} from '~/components/Model/minor-flag-alert-state';
import type { FlagScanReason } from '~/server/services/text-scan/flag-snapshot';
import { EntityType } from '~/shared/utils/prisma/enums';
import { trpc } from '~/utils/trpc';

export function ModelMinorFlagAlert({ model }: Props) {
  const queryUtils = trpc.useUtils();
  return (
    <FlagAppealAlert
      entityType={EntityType.Model}
      entityId={model.id}
      message={selectModelFlagAlertMessage(model)}
      scanReasons={model.flagScanReasons}
      appeal={model.minorAppeal}
      onRequested={() => queryUtils.model.getById.invalidate({ id: model.id })}
    />
  );
}

type Props = {
  model: {
    id: number;
    minorFlagged: boolean;
    poiFlagged: boolean;
    flagScanReasons: FlagScanReason[];
    minorAppeal: MinorFlagAppeal | null;
  };
};

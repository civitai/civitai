import { FlagAppealAlert } from '~/components/Moderation/FlagAppealAlert';
import {
  selectModelFlagAlertMessage,
  type MinorFlagAppeal,
} from '~/components/Model/minor-flag-alert-state';
import { EntityType } from '~/shared/utils/prisma/enums';
import { trpc } from '~/utils/trpc';

export function ModelMinorFlagAlert({ model }: Props) {
  const queryUtils = trpc.useUtils();
  return (
    <FlagAppealAlert
      entityType={EntityType.Model}
      entityId={model.id}
      message={selectModelFlagAlertMessage(model)}
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
    minorAppeal: MinorFlagAppeal | null;
  };
};

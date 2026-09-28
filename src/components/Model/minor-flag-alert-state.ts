import type { AppealStatus } from '~/shared/utils/prisma/enums';

export type MinorFlagAppeal = { status: AppealStatus; resolvedAt: Date | null };

export type MinorFlagAlertCopyVariant = 'noAppeal' | 'pending' | 'rejected';

export type MinorFlagAlertState = {
  showRequestButton: boolean;
  upheldAt: Date | null;
  copyVariant: MinorFlagAlertCopyVariant;
};

export function getMinorFlagAlertState(appeal: MinorFlagAppeal | null): MinorFlagAlertState {
  if (appeal?.status === 'Pending') {
    return { showRequestButton: false, upheldAt: null, copyVariant: 'pending' };
  }

  if (appeal?.status === 'Rejected') {
    return { showRequestButton: true, upheldAt: appeal.resolvedAt, copyVariant: 'rejected' };
  }

  return { showRequestButton: true, upheldAt: null, copyVariant: 'noAppeal' };
}

export const FLAG_ALERT_MESSAGES = {
  modelMinor: 'Your model has been marked as depicting a minor.',
  modelPoi:
    'Your model has been marked as depicting a real person and restricted to SFW generation.',
  bountyPoi: 'Your bounty has been hidden because it appears to depict a real person.',
} as const;

// Minor is the stricter restriction, so it names the alert when both are set.
export function selectModelFlagAlertMessage({
  minorFlagged,
}: {
  minorFlagged: boolean;
  poiFlagged: boolean;
}) {
  return minorFlagged ? FLAG_ALERT_MESSAGES.modelMinor : FLAG_ALERT_MESSAGES.modelPoi;
}

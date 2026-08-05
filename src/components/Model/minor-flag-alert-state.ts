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

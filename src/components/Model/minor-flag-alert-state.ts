import type { AppealStatus } from '~/shared/utils/prisma/enums';

export type MinorFlagAppeal = { status: AppealStatus; resolvedAt: Date | null };

export type MinorFlagAlertCopyVariant = 'noAppeal' | 'pending' | 'rejected';

export type MinorFlagAlertState = {
  tone: 'red' | 'yellow';
  showRequestButton: boolean;
  upheldAt: Date | null;
  copyVariant: MinorFlagAlertCopyVariant;
};

export function getMinorFlagAlertState(appeal: MinorFlagAppeal | null): MinorFlagAlertState {
  if (appeal?.status === 'Pending') {
    return { tone: 'yellow', showRequestButton: false, upheldAt: null, copyVariant: 'pending' };
  }

  if (appeal?.status === 'Rejected') {
    return {
      tone: 'red',
      showRequestButton: true,
      upheldAt: appeal.resolvedAt,
      copyVariant: 'rejected',
    };
  }

  return { tone: 'red', showRequestButton: true, upheldAt: null, copyVariant: 'noAppeal' };
}

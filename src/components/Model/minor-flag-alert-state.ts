import type { AppealStatus } from '~/shared/utils/prisma/enums';

export type MinorFlagAppeal = { status: AppealStatus; resolvedAt: Date | null };

export type MinorFlagAlertState = {
  tone: 'red' | 'yellow';
  showRequestButton: boolean;
  upheldAt: Date | null;
};

export function getMinorFlagAlertState(appeal: MinorFlagAppeal | null): MinorFlagAlertState {
  if (appeal?.status === 'Pending') {
    return { tone: 'yellow', showRequestButton: false, upheldAt: null };
  }

  return {
    tone: 'red',
    showRequestButton: true,
    upheldAt: appeal?.status === 'Rejected' ? appeal.resolvedAt : null,
  };
}

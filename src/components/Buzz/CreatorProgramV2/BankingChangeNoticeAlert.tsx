import { Button } from '@mantine/core';
import { DismissibleAlert } from '~/components/DismissibleAlert/DismissibleAlert';
import { dialogs } from '~/components/Dialog/dialog-registry2';
import { dialogStore } from '~/components/Dialog/dialogStore';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import {
  BANKING_CHANGE_NOTICE_SHOW_UNTIL,
  BANKING_CHANGE_NOTICE_SUBJECT,
} from '~/shared/constants/banking-change-notice.constants';

export function BankingChangeNoticeAlert() {
  const features = useFeatureFlags();
  if (!features.bankingChangeNotice) return null;
  if (Date.now() >= BANKING_CHANGE_NOTICE_SHOW_UNTIL.getTime()) return null;

  return (
    <DismissibleAlert
      id="banking-change-notice-2026-11"
      color="yellow"
      title={BANKING_CHANGE_NOTICE_SUBJECT}
    >
      <Button
        size="compact-sm"
        variant="light"
        color="yellow"
        className="self-start"
        onClick={() =>
          dialogStore.trigger({
            component: dialogs['banking-change-notice'].component,
            id: 'banking-change-notice',
          })
        }
      >
        Read the notice
      </Button>
    </DismissibleAlert>
  );
}

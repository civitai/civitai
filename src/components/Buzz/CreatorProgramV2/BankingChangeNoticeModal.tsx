import { Modal } from '@mantine/core';
import remarkBreaks from 'remark-breaks';
import remarkGfm from 'remark-gfm';
import { useDialogContext } from '~/components/Dialog/DialogProvider';
import { CustomMarkdown } from '~/components/Markdown/CustomMarkdown';
import { TypographyStylesWrapper } from '~/components/TypographyStylesWrapper/TypographyStylesWrapper';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import {
  BANKING_CHANGE_NOTICE_MARKDOWN,
  BANKING_CHANGE_NOTICE_SUBJECT,
} from '~/shared/constants/banking-change-notice.constants';

export default function BankingChangeNoticeModal() {
  const dialog = useDialogContext();
  const currentUser = useCurrentUser();
  const features = useFeatureFlags();
  if (!features.bankingChangeNotice) return null;

  const markdown = BANKING_CHANGE_NOTICE_MARKDOWN.replace(
    /\{username\}/g,
    () => currentUser?.username ?? 'there'
  );

  return (
    <Modal {...dialog} size="lg" title={BANKING_CHANGE_NOTICE_SUBJECT}>
      <TypographyStylesWrapper>
        <CustomMarkdown remarkPlugins={[remarkGfm, remarkBreaks]}>{markdown}</CustomMarkdown>
      </TypographyStylesWrapper>
    </Modal>
  );
}

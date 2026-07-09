/**
 * /moderator/scanner-audit → redirect to /moderator/scanner-audit/text.
 * Text is the default mode landing; mods navigate to other modes via the
 * shared tab chrome in ScannerAuditLayout.
 */
import { createServerSideProps } from '~/server/utils/server-side-helpers';

export const getServerSideProps = createServerSideProps({
  requireModerator: true,
  resolver: async () => ({
    redirect: { destination: '/moderator/scanner-audit/text', permanent: false },
  }),
});

export default function ScannerAuditRedirect() {
  return null;
}

/**
 * /moderator/scanner-audit → redirect to /moderator/scanner-audit/text.
 * Text is the default mode landing; mods navigate to other modes via the
 * shared tab chrome in ScannerAuditLayout.
 */
import type { GetServerSideProps } from 'next';

export const getServerSideProps: GetServerSideProps = async () => {
  return {
    redirect: { destination: '/moderator/scanner-audit/text', permanent: false },
  };
};

export default function ScannerAuditRedirect() {
  return null;
}

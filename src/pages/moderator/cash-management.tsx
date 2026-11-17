import { Page } from '~/components/AppLayout/Page';
import { CashManagementPage } from '~/components/Moderation/CashManagement/CashManagementPage';
import { createServerSideProps } from '~/server/utils/server-side-helpers';

export const getServerSideProps = createServerSideProps({ requireModerator: true });

export default Page(CashManagementPage, {
  features: (features) => features.cashManagement,
});

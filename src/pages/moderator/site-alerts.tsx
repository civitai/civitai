import { Page } from '~/components/AppLayout/Page';
import { Meta } from '~/components/Meta/Meta';
import { SiteAlertsManager } from '~/components/SiteAlerts/SiteAlertsManager';
import { createServerSideProps } from '~/server/utils/server-side-helpers';

export const getServerSideProps = createServerSideProps({ requireModerator: true });

function SiteAlertsPage() {
  return (
    <>
      <Meta title="Site Alerts" deIndex />
      <SiteAlertsManager />
    </>
  );
}

export default Page(SiteAlertsPage);

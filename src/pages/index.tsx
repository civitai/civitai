import { FeedLayout } from '~/components/AppLayout/FeedLayout';
import { Page } from '~/components/AppLayout/Page';
import { Home as PersonalizedHomepage } from '~/pages/home';
import { createServerSideProps } from '~/server/utils/server-side-helpers';
import { publicBrowsingLevelsFlag } from '~/shared/constants/browsingLevel.constants';

export const getServerSideProps = createServerSideProps({
  useSession: true,
  useSSG: true,
  resolver: async ({ ssg, domainSettings }) => {
    if (ssg)
      await ssg.homeBlock.getHomeBlocks.prefetch({
        excludedSystemHomeBlockIds: domainSettings?.excludedSystemHomeBlockIds,
        systemHomeBlockIds: domainSettings?.systemHomeBlockIds,
      });

    return { props: {} };
  },
});

function Home() {
  return <PersonalizedHomepage />;
}

export default Page(Home, {
  announcements: true,
  InnerLayout: FeedLayout,
  browsingLevel: publicBrowsingLevelsFlag,
});

import { Page } from '~/components/AppLayout/Page';
import { ClientOnlySectionsProvider } from '~/components/ClientOnlySection/ClientOnlySection';
import { ImageDetailPage } from '~/components/Image/Detail/ImageDetailPage';
import { resolveImageDetailPageData } from '~/server/page-data/image-detail';
import { createServerSideProps } from '~/server/utils/server-side-helpers';
import { ssrClientOnlySectionsOn } from '~/server/utils/ssr-client-only-sections';

export const getServerSideProps = createServerSideProps({
  useSSG: true,
  useSession: true,
  // Shared with `GET /api/page-data/images/[imageId]`; see `~/server/page-data/image-detail`.
  // The page data carries no page props, so a shell boot never defers a section (it renders on
  // the client anyway).
  resolver: async (args) => {
    const result = await resolveImageDetailPageData(args);
    if ('notFound' in result) return result;
    return {
      ...result,
      props: {
        ...(result.props as Record<string, unknown>),
        ssrClientOnlySections: ssrClientOnlySectionsOn(),
      },
    };
  },
  // A request `_app` renders as the route's static shell; see `~/server/shell/shell-mode`.
  shell: 'images',
});

function ImageDetailRoutePage({ ssrClientOnlySections }: { ssrClientOnlySections?: boolean }) {
  return (
    <ClientOnlySectionsProvider enabled={ssrClientOnlySections}>
      <ImageDetailPage />
    </ClientOnlySectionsProvider>
  );
}

export default Page(ImageDetailRoutePage, {
  header: null,
  footer: null,
  subNav: null,
  scrollable: false,
  announcements: false,
});

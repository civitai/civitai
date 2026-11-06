import { Page } from '~/components/AppLayout/Page';
import { ImageDetailPage } from '~/components/Image/Detail/ImageDetailPage';
import { resolveImageDetailPageData } from '~/server/page-data/image-detail';
import { createServerSideProps } from '~/server/utils/server-side-helpers';

export const getServerSideProps = createServerSideProps({
  useSSG: true,
  useSession: true,
  // Shared with `GET /api/page-data/images/[imageId]`; see `~/server/page-data/image-detail`.
  resolver: resolveImageDetailPageData,
  // A request `_app` renders as the route's static shell; see `~/server/shell/shell-mode`.
  shell: 'images',
});

export default Page(ImageDetailPage, {
  header: null,
  footer: null,
  subNav: null,
  scrollable: false,
  announcements: false,
});

import { Page } from '~/components/AppLayout/Page';
import { ImageDetailPage } from '~/components/Image/Detail/ImageDetailPage';
import { renderImageDetailLean } from '~/server/bot-cache/lean/images-lean';
import { resolveImageDetailPageData } from '~/server/page-data/image-detail';
import { createServerSideProps } from '~/server/utils/server-side-helpers';

export const getServerSideProps = createServerSideProps({
  useSSG: true,
  useSession: true,
  // Shared with `GET /api/page-data/images/[imageId]`; see `~/server/page-data/image-detail`.
  resolver: resolveImageDetailPageData,
  // A request `_app` renders as the route's static shell; see `~/server/shell/shell-mode`.
  shell: 'images',
  // A verified crawler's cacheable render, as a lean HTML page; see `~/server/bot-cache/bot-lean`.
  botLean: { route: 'images', render: renderImageDetailLean },
});

export default Page(ImageDetailPage, {
  header: null,
  footer: null,
  subNav: null,
  scrollable: false,
  announcements: false,
});

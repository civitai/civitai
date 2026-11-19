import { Page } from '~/components/AppLayout/Page';
import { ClientOnlySectionsProvider } from '~/components/ClientOnlySection/ClientOnlySection';
import { ImageDetailPage } from '~/components/Image/Detail/ImageDetailPage';
import { imageDetailId, resolveImageDetailPageData } from '~/server/page-data/image-detail';
import { createServerSideProps } from '~/server/utils/server-side-helpers';
import { ssrClientOnlySectionsOn } from '~/server/utils/ssr-client-only-sections';
import { resolveSsrPrefetchCohort } from '~/server/utils/ssr-skip-prefetch';

export const getServerSideProps = createServerSideProps({
  useSSG: true,
  useSession: true,
  // Shared with `GET /api/page-data/images/[imageId]`; see `~/server/page-data/image-detail`.
  // The page data carries no page props, so a shell boot never defers a section (it renders on
  // the client anyway).
  resolver: async (args) => {
    // `ssrSignedInSkipPrefetchImages`: the trial arm, once the id is known to be a page (a
    // non-numeric id is a 404 in every arm). `skip` keeps `image.get` (the main image, its NotFound
    // and the `<head>`), the contest details (the rating the page gates on) and the hidden
    // preferences (NotFound for a creator the viewer blocked), and leaves the generation data to
    // the client; the content renders as a loading shell until the client has mounted.
    // Decided before `image.get` answers, so a missing image (a 200 with the client NotFound) is
    // still counted: waiting for it would serialize the full arm's prefetches, which start together.
    const deferredSsr =
      imageDetailId(args.ctx.params) !== null &&
      resolveSsrPrefetchCohort({ ...args, route: '/images/[imageId]' }) === 'skip';
    const result = await resolveImageDetailPageData({ ...args, deferred: deferredSsr });
    if ('notFound' in result) return result;
    return {
      ...result,
      props: {
        ...(result.props as Record<string, unknown>),
        ssrClientOnlySections: ssrClientOnlySectionsOn(),
        // Only on `skip`, so every other arm's props are exactly what they were.
        ...(deferredSsr ? { deferredSsr } : {}),
      },
    };
  },
  // A request `_app` renders as the route's static shell; see `~/server/shell/shell-mode`.
  shell: 'images',
});

function ImageDetailRoutePage({
  ssrClientOnlySections,
  deferredSsr,
}: {
  ssrClientOnlySections?: boolean;
  deferredSsr?: boolean;
}) {
  return (
    <ClientOnlySectionsProvider enabled={ssrClientOnlySections}>
      <ImageDetailPage deferredSsr={deferredSsr} />
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

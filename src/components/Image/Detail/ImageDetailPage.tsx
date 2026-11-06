import Head from 'next/head';
import { NotFound } from '~/components/AppLayout/NotFound';
import { useBrowserRouter } from '~/components/BrowserRouter/BrowserRouterProvider';
import { ImageDetailProvider } from '~/components/Image/Detail/ImageDetailProvider';
import { ImageDetail2 } from '~/components/Image/DetailV2/ImageDetail2';
import { parseImageQueryParams } from '~/components/Image/image.utils';
import { useShellPagePending } from '~/components/Shell/ShellBootstrapProvider';
import { StorylineModeProvider } from '~/components/Storyline/StorylineModeProvider';

/**
 * `/images/[imageId]`. Kept out of `src/pages` so it can be rendered without the page's
 * `getServerSideProps` graph.
 *
 * On a static shell boot it renders `ImageDetailShellSkeleton` — on the server and in the hydration
 * render alike — until the page data is adopted and the router holds the real `imageId`; nothing
 * below reads the route query before then. The shell's head is generic and `noindex`; the real
 * tree's own `Meta` sets the title once the image has loaded. A signed-in viewer of a deleted or
 * hidden image gets the client-side NotFound with a 200 (a full render answers 404 to everyone
 * else: bots and signed-out viewers never get the shell).
 */
export function ImageDetailPage() {
  const router = useBrowserRouter();
  const shellPending = useShellPagePending();
  if (shellPending) return <ImageDetailShellSkeleton />;

  return <ImageDetailRoute query={router.query} />;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- the browser router's own query type
function ImageDetailRoute({ query }: { query: Record<string, any> }) {
  const imageId = query.imageId;
  // Not `imagesQueryParamSchema.parse` — a throw here is a 500, and this page is the
  // destination of notification links carrying `?postId=null`. See parseImageQueryParams.
  const filters = parseImageQueryParams(query);

  if (!imageId) return <NotFound />;

  return (
    <StorylineModeProvider>
      {(storylineImages, modeKey) => (
        <ImageDetailProvider
          key={`${imageId}-${modeKey}`}
          imageId={imageId}
          filters={filters}
          images={storylineImages}
        >
          <ImageDetail2 />
        </ImageDetailProvider>
      )}
    </StorylineModeProvider>
  );
}

/**
 * The shell's page body: the detail view's two boxes — media area and, from `@md`, the 450px
 * sidebar — empty, so the layout does not shift when the real tree replaces it.
 */
export function ImageDetailShellSkeleton() {
  return (
    <>
      <Head>
        <meta name="robots" content="noindex,nofollow" key="shell-robots" />
      </Head>
      <div
        className="flex size-full max-h-full max-w-full flex-col overflow-hidden bg-gray-2 dark:bg-dark-9"
        data-testid="image-detail-shell-skeleton"
        aria-busy="true"
      >
        <div className="relative flex flex-1 overflow-hidden">
          <div className="relative flex flex-1 flex-col" />
          <div className="z-10 flex flex-col bg-gray-2 @md:w-[450px] @md:min-w-[450px] @max-md:hidden dark:bg-dark-9" />
        </div>
      </div>
    </>
  );
}

import { FeedLayout } from '~/components/AppLayout/FeedLayout';

/**
 * Hub navigation is not here: the sidebar mounts as AppLayout's `left` column and,
 * on small screens where that is hidden, `HubPageNav` takes over in the sub-nav. What
 * is left for the inner layout is the feed's masonry context.
 */
export function HubsLayout({ children }: { children: React.ReactNode }) {
  return <FeedLayout>{children}</FeedLayout>;
}

import { createServerSideProps } from '~/server/utils/server-side-helpers';
import { REMIX_QUEUE_RECEIVED_URL } from '~/components/Placement/queue-routes';

/**
 * Moved to `/user/placements`, which holds remixes and stickers together.
 *
 * Kept as a redirect for the same reason as the sticker one: notifications sent
 * before this change carry this URL, and they outlive the route.
 */
export default function RemixSubmissionsRedirect() {
  return null;
}

export const getServerSideProps = createServerSideProps({
  resolver: async ({ ctx }) => {
    const tab = ctx?.query.tab;
    const destination =
      typeof tab === 'string' && tab === 'sent'
        ? '/user/placements?type=remix&tab=sent'
        : REMIX_QUEUE_RECEIVED_URL;

    return { redirect: { destination, permanent: false } };
  },
});

import { createServerSideProps } from '~/server/utils/server-side-helpers';
import { STICKER_QUEUE_RECEIVED_URL } from '~/components/Placement/queue-routes';

/**
 * Moved to `/user/placements`, which holds stickers and remixes together.
 *
 * Kept as a redirect rather than deleted: every pending-placement notification
 * sent before this change carries this URL, and a notification is a link
 * someone clicks weeks later. The `tab` param is carried through so a link to
 * the placed side still lands on the placed side.
 */
export default function StickerPlacementsRedirect() {
  return null;
}

export const getServerSideProps = createServerSideProps({
  resolver: async ({ ctx }) => {
    const tab = ctx?.query.tab;
    const destination =
      typeof tab === 'string' && tab === 'sent'
        ? '/user/placements?type=sticker&tab=sent'
        : STICKER_QUEUE_RECEIVED_URL;

    return { redirect: { destination, permanent: false } };
  },
});

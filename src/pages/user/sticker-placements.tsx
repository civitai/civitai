import type { GetServerSidePropsContext } from 'next';
import { STICKER_QUEUE_RECEIVED_URL } from '~/components/Placement/queue-routes';

/**
 * Moved to `/user/placements`, which holds stickers and remixes together.
 *
 * Kept as a redirect rather than deleted: every pending-placement notification
 * sent before this change carries this URL, and a notification is a link
 * someone clicks weeks later. The `tab` param is carried through so a link to
 * the placed side still lands on the placed side.
 *
 * A bare `getServerSideProps` rather than `createServerSideProps`: that helper
 * runs the session and settings bootstrap, which measured 2.1s per hit here —
 * paid entirely to decide a redirect that depends on neither. The destination
 * does its own auth check.
 */
export default function StickerPlacementsRedirect() {
  return null;
}

export async function getServerSideProps(ctx: GetServerSidePropsContext) {
  const destination =
    ctx.query.tab === 'sent'
      ? '/user/placements?type=sticker&tab=sent'
      : STICKER_QUEUE_RECEIVED_URL;

  return { redirect: { destination, permanent: false } };
}

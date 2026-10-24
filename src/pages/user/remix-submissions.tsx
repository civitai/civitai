import type { GetServerSidePropsContext } from 'next';
import { REMIX_QUEUE_RECEIVED_URL } from '~/components/Placement/queue-routes';

/**
 * Moved to `/user/placements`, which holds remixes and stickers together.
 *
 * Kept as a redirect for the same reason as the sticker one: notifications sent
 * before this change carry this URL, and they outlive the route. Bare
 * `getServerSideProps` for the same reason too — see that file.
 */
export default function RemixSubmissionsRedirect() {
  return null;
}

export async function getServerSideProps(ctx: GetServerSidePropsContext) {
  const destination =
    ctx.query.tab === 'sent' ? '/user/placements?type=remix&tab=sent' : REMIX_QUEUE_RECEIVED_URL;

  return { redirect: { destination, permanent: false } };
}

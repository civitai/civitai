import { PlacementsPanel } from '~/components/Placement/PlacementsPanel';
import { createServerSideProps } from '~/server/utils/server-side-helpers';

/**
 * The creator's own queues, both surfaces, one route.
 *
 * The shell lives in `PlacementsPanel` rather than here: a page module pulls
 * `createServerSideProps` — and the server graph behind it — into anything that
 * imports it, which puts it out of reach of the browser test that covers the
 * surface switching and the counts.
 */
export default function PlacementsPage() {
  return <PlacementsPanel />;
}

export const getServerSideProps = createServerSideProps({
  useSession: true,
  resolver: async ({ session }) => {
    if (!session?.user || session.user.bannedAt)
      return { redirect: { destination: '/', permanent: false } };
  },
});

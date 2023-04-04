import { NotFound } from '~/components/AppLayout/NotFound';
import { dbRead } from '~/server/db/client';
import { createServerSideProps } from '~/server/utils/server-side-helpers';

export const getServerSideProps = createServerSideProps({
  useSSG: false,
  resolver: async ({ ctx }) => {
    const { to } = ctx.query as { to: string };
    let destination = '/404';
    if (to === 'review') {
      const reviewId = ctx.query.reviewId as string;
      if (reviewId) {
        const [{ id }] = await dbRead.$queryRaw<{ id: number }[]>`
          SELECT id
          FROM "ResourceReview"
          WHERE jsonb_typeof(metadata->'reviewIds') IS NOT NULL
          AND metadata->'reviewIds' @> ${reviewId}::jsonb
        `;
        if (id) destination = `/reviews/${id}`;
      }
    }

    return {
      redirect: {
        permanent: false,
        destination,
      },
    };
  },
});

export default function Redirect() {
  return <NotFound />;
}

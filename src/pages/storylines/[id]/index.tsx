import { Meta } from '~/components/Meta/Meta';
import { StorylinePage } from '~/components/Storyline/StorylinePage';
import { storylineUrl } from '~/components/Storyline/storyline-routes';
import { createServerSideProps } from '~/server/utils/server-side-helpers';

export const getServerSideProps = createServerSideProps({
  useSession: true,
  resolver: async ({ features, ctx }) => {
    if (!features?.storylines) return { notFound: true };
    const id = Number(ctx.query.id);
    if (!Number.isInteger(id) || id < 1) return { notFound: true };
    return { props: { id } };
  },
});

export default function StorylineRoute({ id }: { id: number }) {
  return (
    <>
      <Meta title="Storyline" canonical={storylineUrl(id)} />
      <StorylinePage id={id} />
    </>
  );
}

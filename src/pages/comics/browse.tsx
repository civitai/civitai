import { createServerSideProps } from '~/server/utils/server-side-helpers';

// Redirect old /comics/browse URL to /comics
export const getServerSideProps = createServerSideProps({
  resolver: async ({ features }) => {
    if (!features?.comicCreator) return { notFound: true };
    return {
      redirect: {
        destination: '/comics',
        permanent: true,
      },
    };
  },
});

export default function ComicsBrowseRedirect() {
  return null;
}

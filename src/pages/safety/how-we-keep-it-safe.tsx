import ContentPage from '~/pages/content/[[...slug]]';
import { createServerSideProps } from '~/server/utils/server-side-helpers';

// The plain-language safety overview, served from src/static-content/safety/how-we-keep-it-safe.md
// at /safety/how-we-keep-it-safe (the same file is also reachable at /content/safety/how-we-keep-it-safe).
const slug = ['safety', 'how-we-keep-it-safe'];

export const getServerSideProps = createServerSideProps<{ slug: string[] }>({
  useSSG: true,
  resolver: async ({ ssg }) => {
    if (ssg) await ssg.content.get.prefetch({ slug });
    return { props: { slug } };
  },
});

export default ContentPage;

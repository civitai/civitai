import ContentPage from '~/pages/content/[[...slug]]';
import { createServerSideProps } from '~/server/utils/server-side-helpers';

// The plain-language safety overview, served from src/static-content/safety/eu-ai-act.md
// at /safety/eu-ai-act (the same file is also reachable at /content/safety/eu-ai-act).
const slug = ['safety', 'eu-ai-act'];

export const getServerSideProps = createServerSideProps<{ slug: string[] }>({
  useSSG: true,
  resolver: async ({ ssg }) => {
    if (ssg) await ssg.content.get.prefetch({ slug });
    return { props: { slug } };
  },
});

export default ContentPage;

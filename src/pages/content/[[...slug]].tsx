import fs from 'fs';
import matter from 'gray-matter';
import { InferGetServerSidePropsType } from 'next';
import { Container, Title, TypographyStylesProvider } from '@mantine/core';
import rehypeRaw from 'rehype-raw';
import remarkGfm from 'remark-gfm';
import { Meta } from '~/components/Meta/Meta';
import { removeTags } from '~/utils/string-helpers';
import { truncate } from 'lodash-es';
import { env } from '~/env/client';
import { CustomMarkdown } from '~/components/Markdown/CustomMarkdown';
import { createServerSideProps } from '~/server/utils/server-side-helpers';

const contentRoot = 'src/static-content';
// export const getStaticPaths: GetStaticPaths = async () => {
//   const files = await getFilesWithExtension(contentRoot, ['.md']);

//   const paths = files.map((fileName) => ({
//     params: {
//       slug: fileName
//         .replace(contentRoot + '/', '')
//         .replace('.md', '')
//         .split('/'),
//     },
//   }));

//   return {
//     paths,
//     fallback: false,
//   };
// };

// export const getStaticProps: GetStaticProps<{
//   frontmatter: MixedObject;
//   content: string;
// }> = async ({ params }) => {
//   let { slug } = params ?? {};
//   if (!slug) return { notFound: true };
//   if (!Array.isArray(slug)) slug = [slug];

//   const fileName = fs.readFileSync(`${contentRoot}/${slug.join('/')}.md`, 'utf-8');
//   const { data: frontmatter, content } = matter(fileName);
//   return {
//     props: {
//       frontmatter,
//       content,
//     },
//   };
// };

export const getServerSideProps = createServerSideProps({
  useSSG: true,
  resolver: async ({ ctx }) => {
    let { slug } = ctx.params ?? {};
    if (!slug) return { notFound: true };
    if (!Array.isArray(slug)) slug = [slug];

    try {
      const fileName = fs.readFileSync(`${contentRoot}/${slug.join('/')}.md`, 'utf-8');
      const { data: frontmatter, content } = matter(fileName);
      return {
        props: {
          title: frontmatter.title,
          description: frontmatter.description,
          content,
        },
      };
    } catch {
      return { notFound: true };
    }
  },
});

export default function ContentPage({
  title,
  description,
  content,
}: InferGetServerSidePropsType<typeof getServerSideProps>) {
  return (
    <>
      <Meta
        title={`${title} | Civitai`}
        description={description ?? truncate(removeTags(content), { length: 150 })}
        links={[{ href: `${env.NEXT_PUBLIC_BASE_URL}/content/${title}`, rel: 'canonical' }]}
      />
      <Container size="md">
        <Title order={1}>{title}</Title>
        <TypographyStylesProvider>
          <CustomMarkdown rehypePlugins={[rehypeRaw, remarkGfm]}>{content}</CustomMarkdown>
        </TypographyStylesProvider>
      </Container>
    </>
  );
}

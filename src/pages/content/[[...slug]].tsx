import { Container, Title } from '@mantine/core';
import fs from 'fs';
import matter from 'gray-matter';
import { truncate } from 'lodash-es';
import type { InferGetServerSidePropsType } from 'next';
import path from 'path';
import rehypeRaw from 'rehype-raw';
import remarkGfm from 'remark-gfm';
import { CustomMarkdown } from '~/components/Markdown/CustomMarkdown';
import { Meta } from '~/components/Meta/Meta';
import { TypographyStylesWrapper } from '~/components/TypographyStylesWrapper/TypographyStylesWrapper';
import { env } from '~/env/client';
import { createServerSideProps } from '~/server/utils/server-side-helpers';
import { removeTags } from '~/utils/string-helpers';

const contentRoot = path.join(process.cwd(), 'src', 'static-content');
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
  resolver: async ({ ctx }) => {
    let { slug } = ctx.params ?? {};
    if (!slug) return { notFound: true };
    if (!Array.isArray(slug)) slug = [slug];

    // Sanitize slug to prevent directory traversal
    const sanitizedSlug = slug.filter(Boolean).map((s) => s.replace(/[^a-zA-Z0-9-_]/g, ''));
    if (sanitizedSlug.length === 0) return { notFound: true };

    try {
      const filePath = path.join(contentRoot, `${sanitizedSlug.join('/')}.md`);

      // Ensure the file is within the content directory (security check)
      const realContentRoot = fs.realpathSync(contentRoot);
      const realFilePath = path.resolve(filePath);
      if (!realFilePath.startsWith(realContentRoot)) {
        console.warn('Attempted access outside content directory:', filePath);
        return { notFound: true };
      }

      // Check if file exists before trying to read it
      if (!fs.existsSync(filePath)) {
        console.log('Content file not found:', filePath);
        return { notFound: true };
      }

      const fileContent = fs.readFileSync(filePath, 'utf-8');
      const { data: frontmatter, content } = matter(fileContent);

      const title = frontmatter.title as string | null;
      const description = frontmatter.description as string | null;

      if (!title) {
        console.warn('Content file missing title:', filePath);
        return { notFound: true };
      }

      return {
        props: {
          title,
          description,
          content,
          slug: sanitizedSlug.join('/'), // Use sanitized slug for canonical URL
        },
      };
    } catch (error) {
      console.error('Error reading content file:', error);
      return { notFound: true };
    }
  },
});

export default function ContentPage({
  title,
  description,
  content,
  slug,
}: InferGetServerSidePropsType<typeof getServerSideProps>) {
  return (
    <>
      <Meta
        title={`${title} | Civitai`}
        description={description ?? truncate(removeTags(content), { length: 150 })}
        links={
          env.NEXT_PUBLIC_BASE_URL
            ? [{ href: `${env.NEXT_PUBLIC_BASE_URL}/content/${slug}`, rel: 'canonical' }]
            : undefined
        }
      />
      <Container size="md" pt="sm">
        <Title order={1} mb="sm">
          {title}
        </Title>
        <TypographyStylesWrapper>
          <CustomMarkdown rehypePlugins={[rehypeRaw, remarkGfm]}>{content}</CustomMarkdown>
        </TypographyStylesWrapper>
      </Container>
    </>
  );
}

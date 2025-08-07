import { Container, Title } from '@mantine/core';
import { truncate } from 'lodash-es';
import type { InferGetServerSidePropsType } from 'next';
import rehypeRaw from 'rehype-raw';
import remarkGfm from 'remark-gfm';
import { CustomMarkdown } from '~/components/Markdown/CustomMarkdown';
import { Meta } from '~/components/Meta/Meta';
import { TypographyStylesWrapper } from '~/components/TypographyStylesWrapper/TypographyStylesWrapper';
import { env } from '~/env/client';
import { createServerSideProps } from '~/server/utils/server-side-helpers';
import { trpc } from '~/utils/trpc';
import { removeTags } from '~/utils/string-helpers';
import { PageLoader } from '~/components/PageLoader/PageLoader';

export const getServerSideProps = createServerSideProps({
  useSSG: true,
  prefetch: 'always',
  resolver: async ({ ctx, ssg }) => {
    let { slug } = ctx.params ?? {};
    if (!slug) return { notFound: true };
    if (!Array.isArray(slug)) slug = [slug];

    // Sanitize slug to prevent directory traversal
    const sanitizedSlug = slug
      .filter(Boolean)
      .map((s) => s.replace(/[^a-zA-Z0-9-_]/g, ''))
      .join('/');
    if (sanitizedSlug.length === 0) return { notFound: true };

    try {
      if (ssg) await ssg.content.get.prefetch({ slug: sanitizedSlug });

      return {
        props: { slug: sanitizedSlug },
      };
    } catch (error) {
      console.error('Error loading content:', error);
      return { notFound: true };
    }
  },
});

export default function ContentPage({
  slug,
}: InferGetServerSidePropsType<typeof getServerSideProps>) {
  const { data: content, isLoading } = trpc.content.get.useQuery({ slug });

  if (isLoading) return <PageLoader />;
  if (!content) return null;

  const { title, description, content: markdownContent } = content;

  return (
    <>
      <Meta
        title={`${title} | Civitai`}
        description={description ?? truncate(removeTags(markdownContent), { length: 150 })}
        links={[
          { href: `${env.NEXT_PUBLIC_BASE_URL as string}/content/${slug}`, rel: 'canonical' },
        ]}
      />
      <Container size="md" pt="sm">
        <Title order={1} mb="sm">
          {title}
        </Title>
        <TypographyStylesWrapper>
          <CustomMarkdown rehypePlugins={[rehypeRaw, remarkGfm]}>{markdownContent}</CustomMarkdown>
        </TypographyStylesWrapper>
      </Container>
    </>
  );
}

import { Container, Stack, Text, Title } from '@mantine/core';
import { truncate } from 'lodash-es';
import type { InferGetServerSidePropsType } from 'next';
import { useRouter } from 'next/router';
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
import { formatDate } from '~/utils/date-helpers';

// Helper function to sanitize slug segments
function sanitizeSlug(slug: string | string[] | undefined): string[] {
  if (!slug) return [];

  const slugArray = Array.isArray(slug) ? slug : [slug];
  return slugArray.filter(Boolean).map((s) => s.replace(/[^a-zA-Z0-9-_]/g, ''));
}

export const getServerSideProps = createServerSideProps<{ slug?: string[] }>({
  useSSG: true,
  resolver: async ({ ctx, ssg }) => {
    let { slug } = ctx.params ?? {};
    if (!slug) return { notFound: true };
    if (!Array.isArray(slug)) slug = [slug];

    // Sanitize slug to prevent directory traversal
    const sanitizedSlugArray = sanitizeSlug(slug);
    if (sanitizedSlugArray.length === 0) return { notFound: true };

    try {
      if (ssg) await ssg.content.get.prefetch({ slug: sanitizedSlugArray });

      return {
        props: { slug: sanitizedSlugArray },
      };
    } catch (error) {
      console.error('Error loading content:', error);
      return { notFound: true };
    }
  },
});

export default function ContentPage({
  slug: slugFromProps,
}: InferGetServerSidePropsType<typeof getServerSideProps>) {
  const router = useRouter();

  const sanitizedRouterSlug = sanitizeSlug(router.query.slug);
  const slug = slugFromProps && slugFromProps.length > 0 ? slugFromProps : sanitizedRouterSlug;

  const { data: content, isLoading } = trpc.content.get.useQuery(
    { slug },
    { enabled: slug.length > 0 }
  );

  if (slug.length === 0 || isLoading) return <PageLoader />;
  if (!content) return null;

  const { title, description, lastmod, content: markdownContent } = content;

  const slugString = slug.join('/');

  return (
    <>
      <Meta
        title={`${title} | Civitai`}
        description={description ?? truncate(removeTags(markdownContent), { length: 150 })}
        links={[
          { href: `${env.NEXT_PUBLIC_BASE_URL as string}/content/${slugString}`, rel: 'canonical' },
        ]}
      />
      <Container size="md" pt="sm">
        <Stack mb="lg" gap={0}>
          <Title order={1}>{title}</Title>
          {lastmod ? (
            <Text c="dimmed" size="sm">
              Last modified: {formatDate(lastmod, undefined, true)}
            </Text>
          ) : null}
        </Stack>
        <TypographyStylesWrapper>
          <CustomMarkdown rehypePlugins={[rehypeRaw, remarkGfm]}>{markdownContent}</CustomMarkdown>
        </TypographyStylesWrapper>
      </Container>
    </>
  );
}

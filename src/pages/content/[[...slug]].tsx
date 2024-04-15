import fs from 'fs';
import matter from 'gray-matter';
import { GetStaticPaths, GetStaticProps, InferGetStaticPropsType } from 'next';
import { Container, Table, Title, TypographyStylesProvider } from '@mantine/core';
import ReactMarkdown from 'react-markdown';
import rehypeRaw from 'rehype-raw';
import remarkGfm from 'remark-gfm';
import { getFilesWithExtension } from '~/utils/fs-helpers';
import { Meta } from '~/components/Meta/Meta';
import { removeTags } from '~/utils/string-helpers';
import { truncate } from 'lodash-es';
import Link from 'next/link';
import { env } from '~/env/client.mjs';

const contentRoot = 'src/static-content';
export const getStaticPaths: GetStaticPaths = async () => {
  const files = await getFilesWithExtension(contentRoot, ['.md']);

  const paths = files.map((fileName) => ({
    params: {
      slug: fileName
        .replace(contentRoot + '/', '')
        .replace('.md', '')
        .split('/'),
    },
  }));

  return {
    paths,
    fallback: false,
  };
};

export const getStaticProps: GetStaticProps<{
  frontmatter: MixedObject;
  content: string;
}> = async ({ params }) => {
  let { slug } = params ?? {};
  if (!slug) return { notFound: true };
  if (!Array.isArray(slug)) slug = [slug];

  const fileName = fs.readFileSync(`${contentRoot}/${slug.join('/')}.md`, 'utf-8');
  const { data: frontmatter, content } = matter(fileName);
  return {
    props: {
      frontmatter,
      content,
    },
  };
};

export default function ContentPage({
  frontmatter: { title, description },
  content,
}: InferGetStaticPropsType<typeof getStaticProps>) {
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
          <ReactMarkdown
            rehypePlugins={[rehypeRaw, remarkGfm]}
            className="markdown-content"
            components={{
              a: ({ node, ...props }) => {
                return (
                  <Link href={props.href as string} passHref>
                    <a
                      target={props.href?.includes('http') ? '_blank' : '_self'}
                      rel="nofollow noreferrer"
                    >
                      {props.children?.[0]}
                    </a>
                  </Link>
                );
              },
              table: ({ node, ...props }) => {
                return (
                  <Table {...props} striped withBorder withColumnBorders>
                    {props.children}
                  </Table>
                );
              },
            }}
          >
            {content}
          </ReactMarkdown>
        </TypographyStylesProvider>
      </Container>
    </>
  );
}

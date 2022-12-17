import fs from 'fs';
import matter from 'gray-matter';
import { GetStaticPaths, GetStaticProps, InferGetStaticPropsType } from 'next';
import { Container, Title } from '@mantine/core';
import ReactMarkdown from 'react-markdown';
import rehypeRaw from 'rehype-raw';

const contentRoot = 'src/static-content';
export const getStaticPaths: GetStaticPaths = async () => {
  const files = fs.readdirSync(contentRoot);
  const paths = files.map((fileName) => ({
    params: {
      slug: fileName.replace('.md', ''),
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
  const { slug } = params ?? {};
  if (!slug) return { notFound: true };

  const fileName = fs.readFileSync(`${contentRoot}/${slug}.md`, 'utf-8');
  const { data: frontmatter, content } = matter(fileName);
  return {
    props: {
      frontmatter,
      content,
    },
  };
};

export default function ContentPage({
  frontmatter,
  content,
}: InferGetStaticPropsType<typeof getStaticProps>) {
  return (
    <Container size="md">
      <Title order={1}>{frontmatter.title}</Title>
      <ReactMarkdown rehypePlugins={[rehypeRaw]} className="markdown-content">
        {content}
      </ReactMarkdown>
    </Container>
  );
}

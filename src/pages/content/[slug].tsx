import fs from 'fs';
import matter from 'gray-matter';
import { GetStaticPaths, GetStaticProps, InferGetStaticPropsType } from 'next';
import { marked } from 'marked';
import { Container } from '@mantine/core';

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
  frontmatter: { [key: string]: any };
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
      <h1>{frontmatter.title}</h1>
      <div dangerouslySetInnerHTML={{ __html: marked.parse(content) }} />
    </Container>
  );
}

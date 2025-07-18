import React from 'react';
import { Container, Paper, Title, Stack, Text, Anchor } from '@mantine/core';
import { Meta } from '~/components/Meta/Meta';
import Image from 'next/image';
import fs from 'fs';
import matter from 'gray-matter';
import type { InferGetServerSidePropsType } from 'next';
import { CustomMarkdown } from '~/components/Markdown/CustomMarkdown';
import { createServerSideProps } from '~/server/utils/server-side-helpers';
import { getRegion, isRegionBlocked } from '~/server/utils/region-blocking';
import { TypographyStylesWrapper } from '~/components/TypographyStylesWrapper/TypographyStylesWrapper';

const contentRoot = 'src/static-content';

export const getServerSideProps = createServerSideProps({
  useSSG: false,
  resolver: async ({ ctx }) => {
    // Get region from headers
    const region = getRegion(ctx.req);

    // Check if user should be blocked
    const shouldBlock = isRegionBlocked(region);

    // If user is not blocked, redirect to homepage
    if (!shouldBlock) {
      return {
        redirect: {
          destination: '/',
          permanent: false,
        },
      };
    }

    // Determine which markdown file to load based on region

    try {
      const contentFileName = region.countryCode
        ? `${region.countryCode.toLowerCase()}-region-block.md`
        : 'uk-region-block.md';
      const fileName = fs.readFileSync(`${contentRoot}/${contentFileName}`, 'utf-8');
      const { data, content } = matter(fileName);

      return {
        props: { frontMatter: data, content },
      };
    } catch (error) {
      // Fallback if specific file doesn't exist
      const fileName = fs.readFileSync(`${contentRoot}/uk-region-block.md`, 'utf-8');
      const { data, content } = matter(fileName);

      return {
        props: { frontMatter: data, content },
      };
    }
  },
});

export default function RegionBlockedPage({
  frontMatter,
  content,
}: InferGetServerSidePropsType<typeof getServerSideProps>) {
  return (
    <>
      <Meta
        title={frontMatter.title || 'Access Restricted'}
        description={
          frontMatter.description || 'Access to this service is restricted in your region.'
        }
        deIndex
      />
      <Container size="sm" className="py-8">
        <div className="mb-8 flex justify-center">
          <Image
            src="/images/logo_light_mode.png"
            alt="Civitai Logo"
            height={48}
            width={150}
            className="dark:hidden"
            priority
          />
          <Image
            src="/images/logo_dark_mode.png"
            alt="Civitai Logo"
            height={48}
            width={150}
            className="hidden dark:block"
            priority
          />
        </div>
        <Paper className="p-8">
          <TypographyStylesWrapper>
            <Stack gap="md">
              {frontMatter.title && (
                <Title order={1} className="mb-6 text-3xl font-bold text-red-600">
                  {frontMatter.title}
                </Title>
              )}

              <CustomMarkdown>{content}</CustomMarkdown>

              <div className="mt-8 border-t pt-6">
                <Text size="sm" c="dimmed">
                  If you have questions or concerns, please contact our support team at{' '}
                  <Anchor
                    href="mailto:support@civitai.com"
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    support@civitai.com
                  </Anchor>
                </Text>
              </div>
            </Stack>
          </TypographyStylesWrapper>
        </Paper>
      </Container>
    </>
  );
}

RegionBlockedPage.getLayout = (page: React.ReactNode) => {
  return <>{page}</>;
};

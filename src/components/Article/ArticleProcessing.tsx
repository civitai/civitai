import { Container, Loader, Stack, Text, Title } from '@mantine/core';
import { Meta } from '~/components/Meta/Meta';

/**
 * Shown to a non-owner for a published article still inside its content-scan window, in place of
 * the 404 that state used to render. Deliberately says nothing about the article itself — the
 * viewer has not been cleared to see any of it yet.
 */
export function ArticleProcessing() {
  return (
    <>
      {/* The article is expected to resolve within about a minute, so keep this shell out of the
          index rather than let a crawler cache it as the page's content. */}
      <Meta title="Article is being processed" deIndex />

      <Container
        className="flex h-[calc(100%-var(--footer-height))] items-center justify-center"
        size="sm"
      >
        <Stack align="center" gap="md">
          <Loader size="lg" />
          <Title order={1} size="h2" ta="center">
            This article is being processed
          </Title>
          <Text size="lg" c="dimmed" ta="center">
            It was just published or updated, and we&apos;re still reviewing its images. This page
            will load the article as soon as that finishes.
          </Text>
        </Stack>
      </Container>
    </>
  );
}

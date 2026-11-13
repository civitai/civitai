import { Container, Stack } from '@mantine/core';
import type { ReactNode } from 'react';
import { ContainerGrid2 } from '~/components/ContainerGrid/ContainerGrid';

type Props = {
  /** Set only when the article has a banner a reader may see; it switches to the banner layout. */
  banner?: ReactNode;
  overlay?: ReactNode;
  header: ReactNode;
  /** The card cover. Shown above the body in the original layout only. */
  cover?: ReactNode;
  body: ReactNode;
  sidebar: ReactNode;
  comments: ReactNode;
};

/**
 * The article page frame. Without a banner it is the original two-column grid with the cover over
 * the body, unchanged for every article written before banners existed. With one, the banner spans
 * the page and the body sits in a reading column with the sidebar sticky beside it.
 */
export function ArticleDetailLayout({
  banner,
  overlay,
  header,
  cover,
  body,
  sidebar,
  comments,
}: Props) {
  if (!banner)
    return (
      <Container size="xl" pos="relative">
        {overlay}
        {header}
        <ContainerGrid2 gutter="xl">
          <ContainerGrid2.Col span={{ base: 12, sm: 8 }}>
            <Stack gap="xs">
              {cover}
              {body}
            </Stack>
          </ContainerGrid2.Col>
          <ContainerGrid2.Col span={{ base: 12, sm: 4 }}>{sidebar}</ContainerGrid2.Col>
        </ContainerGrid2>
        {comments}
      </Container>
    );

  return (
    <>
      {banner}
      <Container size="xl" pos="relative">
        {overlay}
        {/* 46rem reading column + 2rem gap + 26rem sidebar, centred so the title lines up with the body. */}
        <div className="mx-auto w-full @md:max-w-[74rem]">
          {header}
          <div className="flex flex-col gap-8 @md:flex-row @md:items-start">
            <Stack gap="xs" className="w-full min-w-0 @md:max-w-[46rem] @md:flex-1">
              {body}
            </Stack>
            <aside className="w-full @md:sticky @md:top-4 @md:w-[26rem] @md:shrink-0">
              {sidebar}
            </aside>
          </div>
          {comments}
        </div>
      </Container>
    </>
  );
}

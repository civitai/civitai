import { AspectRatio, Card, Container, Divider, Stack, Text, Title } from '@mantine/core';
import type { ReactNode } from 'react';
import { ArticleDetailLayout } from '~/components/Article/Detail/ArticleDetailLayout';
import { ContainerGrid2 } from '~/components/ContainerGrid/ContainerGrid';
import { constants } from '~/server/common/constants';

const art = (from: string, to: string, label: string) =>
  `data:image/svg+xml;utf8,${encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="400"><defs><linearGradient id="g" x1="0" x2="1"><stop offset="0" stop-color="${from}"/><stop offset="1" stop-color="${to}"/></linearGradient></defs><rect width="100%" height="100%" fill="url(#g)"/><text x="50%" y="55%" font-size="64" text-anchor="middle" fill="white" font-family="sans-serif">${label}</text></svg>`
  )}`;

const header = (
  <Stack gap={8} mb="xl">
    <Title fw="bold" order={1}>
      Lighting a portrait scene with three lamps
    </Title>
    <Text c="dimmed" size="sm">
      creator · Nov 6, 2026 · Guide
    </Text>
  </Stack>
);

const cover = (
  <AspectRatio ratio={constants.article.coverImageWidth / constants.article.coverImageHeight}>
    <img
      src={art('#4c6ef5', '#be4bdb', 'Card cover')}
      alt=""
      className="h-full rounded-lg object-cover"
    />
  </AspectRatio>
);

const body = (
  <>
    <article className="flex flex-col gap-3">
      {Array.from({ length: 6 }, (_, i) => (
        <Text key={i}>
          Paragraph {i + 1}. Key light at forty-five degrees, a fill at half its strength on the
          other side, and a rim behind the subject to separate them from the background. Each step
          below shows the prompt and settings used.
        </Text>
      ))}
    </article>
    <Divider />
    <Text size="sm">Reactions · tips · share</Text>
  </>
);

const sidebar = (
  <Card withBorder>
    <Text fw={600}>Creator card</Text>
    <Text size="sm" c="dimmed">
      Table of contents and attachments
    </Text>
  </Card>
);

const comments = (
  <Text mt="xl" c="dimmed">
    Comments
  </Text>
);

const banner = (
  <div
    className="relative mb-6 max-h-[28rem] w-full overflow-hidden"
    style={{
      aspectRatio: constants.article.bannerImageWidth / constants.article.bannerImageHeight,
    }}
  >
    <img src={art('#0ca678', '#1c7ed6', 'Banner 4:1')} alt="" className="size-full object-cover" />
  </div>
);

const Frame = ({ children }: { children: ReactNode }) => (
  <div className="@container" style={{ width: 'calc(100vw - 3rem)' }}>
    {children}
  </div>
);

/** The page frame exactly as `origin/main` renders it, for a pixel comparison with `NoBanner`. */
export const MainBeforeBanners = () => (
  <Frame>
    <Container size="xl" pos="relative">
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
  </Frame>
);

export const NoBanner = () => (
  <Frame>
    <ArticleDetailLayout
      header={header}
      cover={cover}
      body={body}
      sidebar={sidebar}
      comments={comments}
    />
  </Frame>
);

export const WithBanner = () => (
  <Frame>
    <ArticleDetailLayout
      banner={banner}
      header={header}
      cover={cover}
      body={body}
      sidebar={sidebar}
      comments={comments}
    />
  </Frame>
);

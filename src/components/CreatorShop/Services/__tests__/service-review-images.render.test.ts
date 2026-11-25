import { MantineProvider } from '@mantine/core';
import { createElement, type ComponentProps } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

const { SessionWrapper } = await import(
  '~/components/CreatorShop/Services/__tests__/SessionWrapper'
);
const { ReviewImages } = await import('~/components/CreatorShop/Services/ServiceReviews');

const image = (id: number) => ({
  id,
  url: `u${id}`,
  name: null,
  type: 'image',
  width: 800,
  height: 600,
  hash: null,
  nsfwLevel: 1,
  metadata: {},
});

const html = (count: number) =>
  renderToStaticMarkup(
    createElement(
      MantineProvider,
      null,
      createElement(
        SessionWrapper,
        null,
        createElement(ReviewImages, {
          images: Array.from({ length: count }, (_, i) => image(i + 1)) as ComponentProps<
            typeof ReviewImages
          >['images'],
        })
      )
    )
  );

describe('review images on the service page', () => {
  // One image, a row of 2-3 and a grid of 4 each render their own tiles.
  it.each([1, 2, 4])('with %i image(s), every tile opens its own image page', (count) => {
    const hrefs = [...html(count).matchAll(/<a[^>]*href="([^"]+)"/g)].map((m) => m[1]);
    expect(hrefs).toEqual(Array.from({ length: count }, (_, i) => `/images/${i + 1}`));
  });
});

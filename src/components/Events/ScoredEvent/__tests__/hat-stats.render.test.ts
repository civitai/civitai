import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MantineProvider } from '@mantine/core';
import { describe, expect, it } from 'vitest';
import { HatStats } from '~/components/Events/ScoredEvent/HatStats';
import type { HatStatCounts } from '~/components/Events/ScoredEvent/HatStats';

function wayValue(stats: HatStatCounts, way: string) {
  const html = renderToStaticMarkup(
    createElement(MantineProvider, null, createElement(HatStats, { stats, compact: true }))
  );
  const tiles = html.split('data-way="').slice(1);
  const tile = tiles.filter((t) => t.startsWith(`${way}"`));
  expect(tile).toHaveLength(1);
  // The tile's own text: what follows its opening tag, up to the next tile.
  return tile[0]
    .slice(tile[0].indexOf('>') + 1)
    .replace(/<[^>]*>/g, ' ')
    .trim()
    .split(/\s+/)[0];
}

describe('HatStats hearts tile', () => {
  // A hat on a model scores thumbs-up reviews (modelLike), not reactions. The 2x2 has no fifth tile,
  // so they are summed into the hearts: a model-hatted card showed 1 heart after 50 scored likes.
  it('counts a model hat’s thumbs-up reviews with its reactions', () => {
    const stats = { points: 9911, impressions: 9656, reactions: 1, modelLikes: 50 };
    expect(wayValue(stats, 'reactions')).toBe('51');
  });

  it('shows reactions alone when no model likes are sent', () => {
    expect(wayValue({ points: 10, impressions: 5, reactions: 3 }, 'reactions')).toBe('3');
  });
});

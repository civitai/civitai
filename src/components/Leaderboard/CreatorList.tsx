import OneKeyMap from '@essentials/one-key-map';
import trieMemoize from 'trie-memoize';
import { Stack } from '@mantine/core';
// import { z } from 'zod';

import { CreatorCard } from '~/components/Leaderboard/CreatorCard';
import { numericString } from '~/utils/zod-helpers';
import { LeaderboardGetModel } from '~/types/router';

// const schema = z.object({
//   position: numericString().optional(),
//   id: z.string().default('overall'),
// });

export function CreatorList({ data }: { data: LeaderboardGetModel[] }) {
  return <Stack>{data.map((item, index) => createRenderElement(CreatorCard, index, item))}</Stack>;
}

const createRenderElement = trieMemoize(
  [OneKeyMap, {}, WeakMap, OneKeyMap],
  (RenderComponent, index, data) => (
    <RenderComponent key={data.position} index={index} data={data} />
  )
);

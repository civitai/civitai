import OneKeyMap from '@essentials/one-key-map';
import trieMemoize from 'trie-memoize';
import { Stack } from '@mantine/core';
import styles from './CreatorList.module.scss';
// import { z } from 'zod';

import { CreatorCard } from '~/components/Leaderboard/CreatorCard';
import { numericString } from '~/utils/zod-helpers';
import { LeaderboardGetModel } from '~/types/router';

// const schema = z.object({
//   position: numericString().optional(),
//   id: z.string().default('overall'),
// });

export function CreatorList({ data }: { data: LeaderboardGetModel[] }) {
  return (
    <div className={styles.list}>
      {data.map((item, index) => createRenderElement(CreatorCard, index, item))}
    </div>
  );
}

const createRenderElement = trieMemoize(
  [OneKeyMap, {}, WeakMap, OneKeyMap],
  (RenderComponent, index, data) => (
    <div key={data.position} className={styles.listItem}>
      <RenderComponent index={index} data={data} />
    </div>
  )
);


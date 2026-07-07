import { SimpleGrid } from '@mantine/core';
import { IconBolt, IconCircleCheck, IconClock, IconShoppingBag } from '@tabler/icons-react';
import { StatCard } from '~/components/CreatorShop/Manage/StatCard';
import type { ManageStats as ManageStatsData } from '~/components/CreatorShop/Manage/manage.util';
import { numberWithCommas } from '~/utils/number-helpers';

export function ManageStats({ stats }: { stats: ManageStatsData }) {
  return (
    <SimpleGrid cols={{ base: 2, sm: 4 }} spacing="md">
      <StatCard
        label="Published"
        value={stats.published}
        color="green"
        icon={<IconCircleCheck size={20} />}
      />
      <StatCard
        label="Pending review"
        value={stats.pending}
        color="yellow"
        icon={<IconClock size={20} />}
      />
      <StatCard
        label="Units sold"
        value={stats.units}
        color="blue"
        icon={<IconShoppingBag size={20} />}
      />
      <StatCard
        label="Revenue"
        value={`${numberWithCommas(stats.revenue)} Buzz`}
        color="grape"
        icon={<IconBolt size={20} />}
      />
    </SimpleGrid>
  );
}

import {
  IconBolt,
  IconBuildingStore,
  IconCircleCheck,
  IconClock,
  IconShoppingBag,
  IconUsers,
} from '@tabler/icons-react';
import { StatCard } from '~/components/CreatorShop/Manage/StatCard';
import type { CreatorShopResaleStats } from '~/components/CreatorShop/creator-shop.util';
import type { ManageStats as ManageStatsData } from '~/components/CreatorShop/Manage/manage.util';
import { numberWithCommas } from '~/utils/number-helpers';

export function ManageStats({
  stats,
  resaleStats,
}: {
  stats: ManageStatsData;
  resaleStats?: CreatorShopResaleStats;
}) {
  return (
    // Wrapping is driven by how much room a card needs, not by the viewport, so
    // six sit on one row wherever six fit and only fold when they would squash.
    // auto-FIT, not auto-fill: the count here is fixed at six, so empty tracks
    // would be dead space rather than room for more cards.
    <div className="grid gap-4 [grid-template-columns:repeat(auto-fit,minmax(200px,1fr))]">
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
        sub={`You keep ~${numberWithCommas(stats.earnings)}`}
      />
      <StatCard
        label="Resellers"
        value={resaleStats?.resellers ?? 0}
        color="teal"
        icon={<IconUsers size={20} />}
        sub={`${numberWithCommas(resaleStats?.resoldItems ?? 0)} of your items`}
      />
      <StatCard
        label="You resell"
        value={resaleStats?.reselling ?? 0}
        color="cyan"
        icon={<IconBuildingStore size={20} />}
        sub="from other creators"
      />
    </div>
  );
}

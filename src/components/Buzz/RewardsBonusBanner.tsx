import { IconBolt, IconSparkles } from '@tabler/icons-react';
import { useUserMultipliers } from '~/components/Buzz/useBuzz';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { dialogStore } from '~/components/Dialog/dialogStore';
import { dialogs } from '~/components/Dialog/dialog-registry2';

export function RewardsBonusBanner() {
  const currentUser = useCurrentUser();
  const { multipliers, multipliersLoading } = useUserMultipliers();

  const bonus = (multipliers as { globalRewardsBonus?: number }).globalRewardsBonus ?? 1;

  if (!currentUser || multipliersLoading || bonus <= 1) return null;

  // For 2x+, show as "2x" (people like the multiplier framing).
  // For fractional like 1.5x, show as "50% more" (reads bigger).
  const bonusLabel = bonus >= 2 ? `${bonus}x` : `${((bonus - 1) * 100).toFixed(0)}% MORE`;

  const handleClick = () => {
    dialogStore.trigger({
      component: dialogs['rewards-bonus-info'].component,
      id: 'rewards-bonus-info',
    });
  };

  return (
    <button
      type="button"
      onClick={handleClick}
      className="relative flex w-full cursor-pointer items-center justify-center gap-2 overflow-hidden border-0 px-4 py-1.5 text-sm font-semibold transition-opacity hover:opacity-90"
    >
      {/* Animated gradient background */}
      <div className="absolute inset-0 animate-gradient-shift bg-gradient-to-r from-amber-700 via-amber-500 to-amber-700 bg-[length:200%_100%]" />

      {/* Shimmer overlay */}
      <div className="absolute inset-0 animate-shimmer bg-gradient-to-r from-transparent via-white/20 to-transparent bg-[length:200%_100%]" />

      {/* Content */}
      <div className="relative flex items-center gap-2 text-white [text-shadow:0_1px_3px_rgba(0,0,0,0.4)]">
        <IconSparkles size={16} />
        <IconBolt size={16} fill="currentColor" />
        <span className="tracking-wide">BONUS REWARDS ACTIVE</span>
        <span className="rounded-full bg-black/25 px-2.5 py-0.5 text-xs font-bold">
          {bonusLabel} BUZZ
        </span>
        <IconBolt size={16} fill="currentColor" />
        <IconSparkles size={16} />
      </div>
    </button>
  );
}

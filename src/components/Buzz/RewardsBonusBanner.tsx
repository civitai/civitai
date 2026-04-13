import { IconBolt, IconSparkles } from '@tabler/icons-react';
import { useUserMultipliers } from '~/components/Buzz/useBuzz';
import { useCurrentUser } from '~/hooks/useCurrentUser';

export function RewardsBonusBanner() {
  const currentUser = useCurrentUser();
  const { multipliers, multipliersLoading } = useUserMultipliers();

  const bonus = (multipliers as { globalRewardsBonus?: number }).globalRewardsBonus ?? 1;

  if (!currentUser || multipliersLoading || bonus <= 1) return null;

  const bonusLabel = bonus === Math.floor(bonus) ? `${bonus}x` : `${bonus}x`;

  return (
    <div className="rewards-bonus-banner relative flex items-center justify-center gap-2 overflow-hidden px-4 py-1.5 text-sm font-semibold text-white">
      {/* Animated gradient background */}
      <div className="absolute inset-0 animate-gradient-shift bg-gradient-to-r from-amber-500 via-yellow-400 to-amber-500 bg-[length:200%_100%]" />

      {/* Shimmer overlay */}
      <div className="absolute inset-0 animate-shimmer bg-gradient-to-r from-transparent via-white/20 to-transparent bg-[length:200%_100%]" />

      {/* Content */}
      <div className="relative flex items-center gap-2">
        <IconSparkles size={16} className="animate-pulse" />
        <IconBolt size={16} fill="currentColor" className="drop-shadow-[0_0_4px_rgba(255,255,255,0.6)]" />
        <span className="tracking-wide drop-shadow-[0_1px_2px_rgba(0,0,0,0.3)]">
          BONUS REWARDS ACTIVE
        </span>
        <span className="rounded-full bg-white/25 px-2 py-0.5 text-xs font-bold backdrop-blur-sm">
          {bonusLabel} BUZZ
        </span>
        <IconBolt size={16} fill="currentColor" className="drop-shadow-[0_0_4px_rgba(255,255,255,0.6)]" />
        <IconSparkles size={16} className="animate-pulse" />
      </div>
    </div>
  );
}

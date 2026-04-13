import { Button, Divider, Modal, Stack, Text, ThemeIcon } from '@mantine/core';
import { IconBolt, IconSparkles, IconArrowRight } from '@tabler/icons-react';
import { useDialogContext } from '~/components/Dialog/DialogProvider';
import { useUserMultipliers } from '~/components/Buzz/useBuzz';
import { NextLink as Link } from '~/components/NextLink/NextLink';

type Props = Record<string, never>;

export default function RewardsBonusInfoModal(_props: Props) {
  const dialog = useDialogContext();
  const { multipliers } = useUserMultipliers();

  const globalBonus = (multipliers as { globalRewardsBonus?: number }).globalRewardsBonus ?? 1;
  const totalMultiplier = multipliers.rewardsMultiplier ?? 1;
  const baseMultiplier = globalBonus > 1 ? totalMultiplier / globalBonus : totalMultiplier;
  const hasSubscriptionBonus = baseMultiplier > 1;

  const bonusLabel =
    globalBonus >= 2 ? `${globalBonus}x` : `${((globalBonus - 1) * 100).toFixed(0)}%`;

  return (
    <Modal {...dialog} size="sm" radius="lg" withCloseButton>
      <Stack align="center" gap="md" pb="sm">
        {/* Hero section */}
        <div className="relative flex items-center justify-center overflow-hidden rounded-xl px-6 py-5">
          <div className="absolute inset-0 animate-gradient-shift bg-gradient-to-r from-amber-700 via-amber-500 to-amber-700 bg-[length:200%_100%]" />
          <div className="absolute inset-0 animate-shimmer bg-gradient-to-r from-transparent via-white/20 to-transparent bg-[length:200%_100%]" />
          <div className="relative flex flex-col items-center gap-2">
            <div className="flex items-center gap-2 text-white">
              <IconSparkles size={24} />
              <ThemeIcon size={48} radius="xl" variant="white" color="yellow.6">
                <IconBolt size={28} fill="currentColor" />
              </ThemeIcon>
              <IconSparkles size={24} />
            </div>
            <Text size="xl" fw={800} c="white" className="drop-shadow-[0_1px_3px_rgba(0,0,0,0.3)]">
              BONUS REWARDS ACTIVE
            </Text>
          </div>
        </div>

        <Stack gap="xs" align="center" px="sm">
          <Text size="lg" fw={700} ta="center">
            All reward earnings are boosted by{' '}
            <Text span c="yellow.5" fw={800}>
              {bonusLabel}
            </Text>
            !
          </Text>

          <Text size="sm" c="dimmed" ta="center">
            Every Blue Buzz reward you earn during this bonus period is automatically multiplied.
          </Text>
        </Stack>

        <Divider w="100%" />

        {/* Multiplier breakdown */}
        <Stack gap={4} w="100%" px="sm">
          {hasSubscriptionBonus && (
            <div className="flex items-center justify-between rounded-md bg-gray-1 px-3 py-2 dark:bg-dark-5">
              <Text size="sm">Your membership bonus</Text>
              <Text size="sm" fw={700}>
                {baseMultiplier}x
              </Text>
            </div>
          )}
          <div className="flex items-center justify-between rounded-md bg-gray-1 px-3 py-2 dark:bg-dark-5">
            <Text size="sm">Bonus event multiplier</Text>
            <Text size="sm" fw={700} c="yellow.5">
              {globalBonus}x
            </Text>
          </div>
          <div className="flex items-center justify-between rounded-md bg-blue-1 px-3 py-2 dark:bg-blue-9/20">
            <Text size="sm" fw={700}>
              Your total multiplier
            </Text>
            <Text size="sm" fw={800} c="blue">
              {totalMultiplier}x
            </Text>
          </div>
        </Stack>

        <Button
          component={Link}
          href="/user/buzz-dashboard?buzzType=blue#rewards"
          onClick={() => dialog.onClose()}
          fullWidth
          size="md"
          variant="gradient"
          gradient={{ from: 'yellow.6', to: 'orange.5' }}
          rightSection={<IconArrowRight size={18} />}
        >
          View Ways to Earn
        </Button>
      </Stack>
    </Modal>
  );
}

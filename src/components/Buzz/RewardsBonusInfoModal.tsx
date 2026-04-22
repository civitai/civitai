import { Button, Group, Modal, Stack, Text, ThemeIcon } from '@mantine/core';
import { IconBolt, IconSparkles, IconArrowRight, IconBook2 } from '@tabler/icons-react';
import { useDialogContext } from '~/components/Dialog/DialogProvider';
import { useUserMultipliers } from '~/components/Buzz/useBuzz';
import { NextLink as Link } from '~/components/NextLink/NextLink';
import { CustomMarkdown } from '~/components/Markdown/CustomMarkdown';
import { formatMultiplier } from '~/utils/buzz';

type Props = Record<string, never>;

export default function RewardsBonusInfoModal(_props: Props) {
  const dialog = useDialogContext();
  const { multipliers } = useUserMultipliers();

  const globalBonus = multipliers.globalRewardsBonus;
  const totalMultiplier = multipliers.rewardsMultiplier;
  const baseMultiplier = multipliers.baseRewardsMultiplier;
  const hasSubscriptionBonus = baseMultiplier > 1;
  const event = multipliers.rewardsBonusEvent;

  const bonusLabel =
    globalBonus >= 2
      ? formatMultiplier(globalBonus)
      : `${((globalBonus - 1) * 100).toFixed(0)}%`;

  const headline = event?.name || 'BONUS REWARDS ACTIVE';

  return (
    <Modal
      {...dialog}
      size="sm"
      radius="lg"
      withCloseButton
      closeButtonProps={{
        radius: 'xl',
        className:
          'bg-black/40 text-white hover:bg-black/60 border border-white/20 backdrop-blur-sm',
      }}
      classNames={{
        header: 'absolute right-0 top-0 z-10 min-h-0 bg-transparent p-2',
        body: 'pt-0',
      }}
    >
      <Stack align="center" gap="md" pb="sm">
        {/* Hero section (full-bleed to modal edges) */}
        <div className="relative -mx-4 flex items-center justify-center self-stretch overflow-hidden px-6 py-5 motion-reduce:animate-none">
          <div className="absolute inset-0 animate-gradient-shift bg-gradient-to-r from-amber-700 via-amber-500 to-amber-700 bg-[length:200%_100%] motion-reduce:animate-none" />
          <div className="absolute inset-0 animate-shimmer bg-gradient-to-r from-transparent via-white/20 to-transparent bg-[length:200%_100%] motion-reduce:animate-none" />
          <div className="relative flex flex-col items-center gap-2">
            <div className="flex items-center gap-2 text-white">
              <IconSparkles size={24} />
              <ThemeIcon size={48} radius="xl" variant="white" color="yellow.6">
                <IconBolt size={28} fill="currentColor" />
              </ThemeIcon>
              <IconSparkles size={24} />
            </div>
            <Text
              size="xl"
              fw={800}
              c="white"
              ta="center"
              className="drop-shadow-[0_1px_3px_rgba(0,0,0,0.3)]"
            >
              {headline}
            </Text>
          </div>
        </div>

        <Stack gap="xs" align="center" px="sm">
          <Text size="lg" fw={700} ta="center">
            All reward earnings are boosted by{' '}
            <Text span c="yellow.5" fw={900} size="2rem">
              {bonusLabel}
            </Text>
          </Text>

          {event?.description ? (
            <div className="markdown-content text-center text-sm text-[var(--mantine-color-dimmed)]">
              <CustomMarkdown allowedElements={['a', 'strong', 'em', 'p', 'br']} unwrapDisallowed>
                {event.description}
              </CustomMarkdown>
            </div>
          ) : (
            <Text size="sm" c="dimmed" ta="center">
              Every Blue Buzz reward you earn during this bonus period is automatically multiplied.
            </Text>
          )}
        </Stack>

        {/* Multiplier breakdown */}
        <Stack gap={4} w="100%">
          {hasSubscriptionBonus && (
            <div className="flex items-center justify-between rounded-md bg-gray-1 px-3 py-2 dark:bg-dark-5">
              <Text size="sm">Your membership bonus</Text>
              <Text size="sm" fw={700}>
                {formatMultiplier(baseMultiplier)}
              </Text>
            </div>
          )}
          <div className="flex items-center justify-between rounded-md bg-gray-1 px-3 py-2 dark:bg-dark-5">
            <Text size="sm">Bonus event multiplier</Text>
            <Text size="sm" fw={700} c="yellow.5">
              {formatMultiplier(globalBonus)}
            </Text>
          </div>
          <div className="flex items-center justify-between rounded-md bg-blue-1 px-3 py-2 dark:bg-blue-9/20">
            <Text size="sm" fw={700}>
              Your total multiplier
            </Text>
            <Text size="sm" fw={800} c="blue">
              {formatMultiplier(totalMultiplier)}
            </Text>
          </div>
        </Stack>

        <Group gap="xs" w="100%" grow>
          {event?.articleId ? (
            <Button
              component={Link}
              href={`/articles/${event.articleId}`}
              onClick={() => dialog.onClose()}
              size="md"
              variant="default"
              leftSection={<IconBook2 size={18} />}
            >
              Learn more
            </Button>
          ) : null}
          <Button
            component={Link}
            href="/user/buzz-dashboard?buzzType=blue#rewards"
            onClick={() => dialog.onClose()}
            size="md"
            variant="gradient"
            gradient={{ from: 'yellow.6', to: 'orange.5' }}
            rightSection={<IconArrowRight size={18} />}
          >
            How to Earn
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}

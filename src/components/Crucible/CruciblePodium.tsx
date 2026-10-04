import { Container, Group, Stack, Title } from '@mantine/core';
import { IconTrophy } from '@tabler/icons-react';
import { WinnerPodiumCard, type WinnerPodiumData } from '~/components/Challenge/WinnerPodiumCard';
import type { RouterOutput } from '~/types/router';
import type { CrucibleDisplayPrize } from '~/utils/crucible-helpers';
import { isDefined } from '~/utils/type-guards';

export function CruciblePodium({
  entries,
  prizeWinners,
  buzzType,
}: {
  entries: RouterOutput['crucible']['getEntries']['podium'];
  prizeWinners: CrucibleDisplayPrize[];
  buzzType: 'green' | 'yellow';
}) {
  const prizeByEntryId = new Map(prizeWinners.map((w) => [w.entryId, w.prizeAmount]));
  const winners: WinnerPodiumData[] = entries.map((entry) => ({
    place: entry.prizePlace,
    userId: entry.userId,
    username: entry.user.username ?? '',
    imageId: entry.imageId,
    imageUrl: entry.image.url,
    imageNsfwLevel: entry.image.nsfwLevel,
    buzzAwarded: prizeByEntryId.get(entry.id) ?? 0,
    profilePicture: entry.user.profilePicture,
  }));

  if (!winners.length) return null;

  const podiumOrder = [winners[1], winners[0], winners[2]].filter(isDefined);

  return (
    <section
      className="relative overflow-hidden py-12"
      style={{
        background:
          'linear-gradient(180deg, rgba(250, 176, 5, 0.15) 0%, rgba(250, 176, 5, 0.05) 100%)',
      }}
    >
      <div className="pointer-events-none absolute inset-0 overflow-hidden">
        <div className="absolute -left-20 -top-20 size-40 rounded-full bg-yellow-500/10 blur-3xl" />
        <div className="absolute -right-20 top-1/2 size-60 rounded-full bg-orange-500/10 blur-3xl" />
      </div>

      <Container size="xl" className="relative">
        <Stack gap="xl">
          <Group justify="center" gap="sm">
            <IconTrophy size={32} className="text-yellow-500" />
            <Title order={2}>Crucible Winners</Title>
            <IconTrophy size={32} className="text-yellow-500" />
          </Group>

          <div className="hidden items-end justify-center gap-4 md:flex">
            {podiumOrder.map((winner) => (
              <WinnerPodiumCard
                key={winner.place}
                winner={winner}
                isFirst={winner.place === 1}
                className={winner.place === 1 ? 'z-10' : ''}
                buzzType={buzzType}
              />
            ))}
          </div>

          <Stack gap="md" className="md:hidden">
            {winners.map((winner) => (
              <WinnerPodiumCard
                key={winner.place}
                winner={winner}
                isFirst={winner.place === 1}
                isMobile
                buzzType={buzzType}
              />
            ))}
          </Stack>
        </Stack>
      </Container>
    </section>
  );
}

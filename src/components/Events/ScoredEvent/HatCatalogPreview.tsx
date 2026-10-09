import { Button, Group, SimpleGrid, Stack, Text } from '@mantine/core';
import { IconConfetti, IconHanger } from '@tabler/icons-react';
import { useTeamColor } from '~/components/Events/events.utils';
import { EventSectionHeading } from '~/components/Events/ScoredEvent/EventSectionHeading';
import { HatArt } from '~/components/Events/ScoredEvent/HatArt';
import { LoginRedirect } from '~/components/LoginRedirect/LoginRedirect';
import { trpc } from '~/utils/trpc';

const SHOWN = 12;

/**
 * The event's hat designs for a visitor who has not joined: art only, no prices, each design in a
 * different team colour so all four show. Joining is what opens the shop in your own colour.
 */
export function HatCatalogPreview({
  event,
  onJoin,
  joining,
}: {
  event: string;
  onJoin: () => void;
  joining: boolean;
}) {
  const teamColor = useTeamColor();
  const { data: designs } = trpc.event.getHatCatalog.useQuery({ event });
  if (!designs?.length) return null;
  const teamCount = Math.max(...designs.map((d) => d.hats.length));

  return (
    <Stack gap="md">
      <EventSectionHeading
        icon={IconHanger}
        title={`${designs.length} hats to collect`}
        subtitle={`Every design comes in all ${teamCount} team colours. Join to shop for yours.`}
      />
      <SimpleGrid cols={{ base: 3, sm: 4, md: 6 }} spacing="sm" data-testid="hat-catalog">
        {designs.slice(0, SHOWN).map((d, i) => {
          const hat = d.hats[i % d.hats.length];
          return (
            <Stack key={d.design} gap={4}>
              <HatArt url={hat.url} color={teamColor(hat.team)} />
              <Text size="xs" fw={600} ta="center" lineClamp={1}>
                {d.name}
              </Text>
            </Stack>
          );
        })}
      </SimpleGrid>
      <Group gap="sm">
        <LoginRedirect reason="perform-action">
          <Button
            radius="xl"
            onClick={onJoin}
            loading={joining}
            leftSection={<IconConfetti size={18} />}
          >
            Join and get your free hat
          </Button>
        </LoginRedirect>
        {designs.length > SHOWN && (
          <Text size="sm" c="dimmed">
            and {designs.length - SHOWN} more designs
          </Text>
        )}
      </Group>
    </Stack>
  );
}

import { Button, Card, Center, Group, Loader, Stack, Text } from '@mantine/core';
import Image from 'next/image';
import Link from 'next/link';
import { CurrencyIcon } from '~/components/Currency/CurrencyIcon';
import { HolidayFrame } from '~/components/Decorations/HolidayFrame';
import { Lightbulb } from '~/components/Decorations/Lightbulb';
import { useQueryEvent } from '~/components/Events/events.utils';
import { HomeBlockWrapper } from '~/components/HomeBlocks/HomeBlockWrapper';
import { HomeBlockMetaSchema } from '~/server/schema/home-block.schema';
import { Currency } from '~/shared/utils/prisma/enums';
import { abbreviateNumber } from '~/utils/number-helpers';

export function EventHomeBlock({ showAds, ...props }: Props) {
  if (!props.metadata.event) return null;

  return (
    <HomeBlockWrapper py={32}>
      <EventHomeBlockContent {...props} />
    </HomeBlockWrapper>
  );
}

function EventHomeBlockContent({ metadata }: Props) {
  const { event = '' } = metadata;
  const { eventData, teamScores, eventCosmetic, loading } = useQueryEvent({ event });

  if (!event) return null;

  const userTeam = (eventCosmetic?.cosmetic?.data as { type: string; color: string })?.color;
  const totalTeamScores = teamScores.reduce((acc, teamScore) => acc + teamScore.score, 0);
  const cosmeticData = eventCosmetic?.data as { lights: number; upgradedLights: number };
  const teamScore = teamScores.find((teamScore) => teamScore.team.toLowerCase() === userTeam);

  const equipped = eventCosmetic?.obtained && eventCosmetic?.equipped;
  const ended = !!eventData && eventData?.endDate < new Date();

  return loading ? (
    <Card p={40}>
      <Center>
        <Loader />
      </Center>
    </Card>
  ) : eventData ? (
    <Group gap={48}>
      <Card className="rounded-[16px] p-4 @md:rounded-[32px] @md:p-10" radius="xl">
        <Group align="start" justify="center" gap={40}>
          <Stack className="justify-center @md:flex-1 @md:justify-start" gap="xl">
            <Stack gap={0}>
              <Text size="sm" weight={500} tt="uppercase" inline>
                Holiday Event
              </Text>
              <div className="text-nowrap text-2xl font-bold">{eventData.title}</div>
            </Stack>
            <Group gap={8}>
              <Button
                component={Link}
                href={`/events/${event}`}
                className="flex-1 @md:flex-initial"
                color="dark.4"
                radius="xl"
              >
                {equipped && ended
                  ? 'View results'
                  : equipped && !ended
                  ? 'View event'
                  : 'Learn more'}
              </Button>
              {equipped && !ended && (
                <Button
                  component={Link}
                  href="/challenges"
                  className="flex-1 @md:flex-initial"
                  color="dark.4"
                  radius="xl"
                >
                  Earn lights
                </Button>
              )}
            </Group>
          </Stack>

          <Stack className="@md:flex-1" align="end" gap="xl">
            <div className="max-w-80">
              {eventCosmetic?.cosmetic ? (
                <HolidayFrame
                  cosmetic={eventCosmetic.cosmetic}
                  data={cosmeticData}
                  force
                  animated
                />
              ) : (
                <Image
                  src="/images/holiday/wreath.png"
                  alt="Holiday wreath"
                  width={1819}
                  height={292}
                />
              )}
            </div>
            <Group gap="xl">
              <Stack align="end" gap={0}>
                <Group gap={4} wrap="nowrap">
                  <CurrencyIcon currency={Currency.BUZZ} />
                  <Text size="xl" lh={1} weight={590} style={{ fontVariantNumeric: 'tabular-nums' }}>
                    {abbreviateNumber(totalTeamScores)}
                  </Text>
                </Group>
                <Text size="xs">Total Buzz donations</Text>
              </Stack>
              {teamScore && equipped && (
                <Stack align="end" gap={0}>
                  <Group gap={4} wrap="nowrap">
                    <Lightbulb color={userTeam} size={24} transform="rotate(180)" animated />
                    <Text size="xl" lh={1} weight={590} style={{ fontVariantNumeric: 'tabular-nums' }}>
                      {abbreviateNumber(teamScore.score ?? 0)}
                    </Text>
                  </Group>
                  <Text size="xs">Total team donations</Text>
                </Stack>
              )}
            </Group>
          </Stack>
        </Group>
      </Card>
    </Group>
  ) : null;
}

type Props = { metadata: HomeBlockMetaSchema; showAds?: boolean };

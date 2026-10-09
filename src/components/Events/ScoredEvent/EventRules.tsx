import { Accordion, Group, SimpleGrid, Stack, Text, ThemeIcon } from '@mantine/core';
import {
  IconCheck,
  IconConfetti,
  IconEye,
  IconHanger,
  IconHeart,
  IconMessageQuestion,
  IconScale,
  IconTrophy,
  IconUsersGroup,
} from '@tabler/icons-react';
import type { Icon } from '@tabler/icons-react';
import type { ReactNode } from 'react';
import { EdgeMedia } from '~/components/EdgeMedia/EdgeMedia';
import { useTeamColor } from '~/components/Events/events.utils';
import { EventSectionHeading } from '~/components/Events/ScoredEvent/EventSectionHeading';
import { PrizeBadge } from '~/components/Events/ScoredEvent/PrizeBadge';
import { describeEntityTypes } from '~/components/Events/ScoredEvent/scored-event.utils';
import type { RouterOutput } from '~/types/router';

type EventData = RouterOutput['event']['getData'];

const STEP_ICONS = [IconUsersGroup, IconHanger, IconConfetti];
// The hero's surface, so the section reads as part of the same page. Nothing here is clickable,
// so no card takes a hover state.
const CARD =
  'rounded-xl border border-solid border-gray-3 bg-white p-4 dark:border-dark-4 dark:bg-dark-6';

export function EventRules({ data }: { data: EventData }) {
  const teamColor = useTeamColor();
  const { page, rules, decoration } = data;
  if (!page) return null;
  const wearsOn = decoration ? describeEntityTypes(decoration.entityTypes) : 'your posts';
  const cooldownMin = decoration ? Math.round(decoration.moveCooldownMs / 60_000) : 0;
  // Each step takes the next team's colour, as the hero's headline does.
  const colors = data.teams.map((t) => teamColor(t)).filter((c): c is string => !!c);
  const badges = data.teams.flatMap((team) => {
    const badge = page.prizeBadge?.[team];
    return badge ? [{ team, badge }] : [];
  });

  return (
    <Stack gap="md">
      <EventSectionHeading
        icon={IconConfetti}
        title="How it works"
        subtitle="Three steps, and the rules that keep it fair."
      />

      <ol className="m-0 grid list-none gap-3 p-0 @sm:grid-cols-3" data-testid="event-steps">
        {page.steps.map((step, i) => {
          const StepIcon = STEP_ICONS[i] ?? IconConfetti;
          const color = colors.length ? colors[i % colors.length] : undefined;
          return (
            <li key={step.title} className={CARD}>
              <Group gap="md" wrap="nowrap" align="flex-start" className="@sm:flex-col">
                <ThemeIcon size={44} radius="xl" variant="light" color={color} className="shrink-0">
                  <StepIcon size={24} />
                </ThemeIcon>
                <Stack gap={4}>
                  <Text size="xs" fw={700} tt="uppercase" lts={0.5} c={color ?? 'dimmed'}>
                    Step {i + 1}
                  </Text>
                  <Text fw={800} size="lg" lh={1.25}>
                    {step.title}
                  </Text>
                  <Text size="sm" c="dimmed">
                    {step.body}
                  </Text>
                </Stack>
              </Group>
            </li>
          );
        })}
      </ol>

      {rules && (
        <SimpleGrid cols={{ base: 1, md: 2 }} spacing="sm">
          <RuleCard icon={IconEye} title="How points add up">
            <div className="grid grid-cols-3 gap-2" data-testid="event-points">
              <PointTile value="1" label="per view in a feed" />
              <PointTile
                value={String(rules.reactionWeight)}
                label="per reaction"
                icon={<IconHeart size={16} />}
              />
              <PointTile value="0" label="for your own views and reactions" />
            </div>
            <Text size="xs" c="dimmed">
              Hats go on your own {wearsOn}. Models score views only: reactions aren&apos;t counted
              for models.
            </Text>
          </RuleCard>
          <RuleCard icon={IconScale} title="Keeping it fair">
            <Stack component="ul" gap={8} className="m-0 list-none p-0">
              <FairRule>
                One person counts for at most {rules.viewerOwnerDailyCap} of a creator&apos;s posts
                a day.
              </FairRule>
              <FairRule>
                Accounts made in the {rules.newAccountDays} days before the event don&apos;t count.
              </FairRule>
              <FairRule>
                Signed-out views count, up to a fair share. Bot-like browsing doesn&apos;t.
              </FairRule>
              {cooldownMin > 0 && (
                <FairRule>
                  A hat can move again {cooldownMin} {cooldownMin === 1 ? 'minute' : 'minutes'}{' '}
                  after it was placed.
                </FairRule>
              )}
              <FairRule>Buzz spent doesn&apos;t score. Only attention does.</FairRule>
            </Stack>
          </RuleCard>
        </SimpleGrid>
      )}

      <div
        className="rounded-xl border border-solid border-yellow-6/40 bg-yellow-0 p-4 dark:bg-yellow-9/10"
        data-testid="event-prize"
      >
        <div className="flex flex-col gap-4 @sm:flex-row @sm:items-center @sm:gap-6">
          {badges.length ? (
            // Every colour the badge comes in, in team order: the winners get theirs.
            <div className="flex shrink-0 gap-1" data-testid="event-prize-badges">
              {badges.map(({ team, badge }) => (
                <PrizeBadge key={team} badge={badge} className="w-14 @sm:w-16" />
              ))}
            </div>
          ) : (
            <div className="w-16 shrink-0 @sm:w-20">
              {page.prize.imageUrl ? (
                <EdgeMedia src={page.prize.imageUrl} width={160} alt="" />
              ) : (
                <ThemeIcon size={64} radius="xl" color="yellow" variant="light">
                  <IconTrophy size={36} />
                </ThemeIcon>
              )}
            </div>
          )}
          <Stack gap={4}>
            <Text size="xs" fw={700} tt="uppercase" c="yellow" lts={0.5}>
              The prize
            </Text>
            <Text fw={800} size="lg" lh={1.25}>
              {page.prize.title}
            </Text>
            <Text size="sm" c="dimmed">
              {page.prize.body}
            </Text>
          </Stack>
        </div>
      </div>

      {!!page.faq?.length && (
        <Stack gap="xs">
          <Group gap={8} wrap="nowrap">
            <IconMessageQuestion size={18} className="text-dimmed shrink-0" />
            <Text fw={700}>Questions</Text>
          </Group>
          <Accordion
            variant="separated"
            radius="md"
            // The site-wide `.mantine-Accordion-label { padding: 0 }` leaves the rows with no
            // vertical room, so the control carries it instead.
            styles={{ control: { paddingBlock: 12 }, content: { paddingTop: 0 } }}
            data-testid="event-faq"
          >
            {page.faq.map((f) => (
              <Accordion.Item key={f.question} value={f.question}>
                <Accordion.Control>
                  <Text fw={600}>{f.question}</Text>
                </Accordion.Control>
                <Accordion.Panel>
                  <Text size="sm" c="dimmed">
                    {f.answer}
                  </Text>
                </Accordion.Panel>
              </Accordion.Item>
            ))}
          </Accordion>
        </Stack>
      )}
    </Stack>
  );
}

function RuleCard({
  icon: RuleIcon,
  title,
  children,
}: {
  icon: Icon;
  title: string;
  children: ReactNode;
}) {
  return (
    <div className={CARD}>
      <Stack gap="md">
        <Group gap="sm" wrap="nowrap">
          <ThemeIcon size={32} radius="xl" variant="light" color="gray">
            <RuleIcon size={18} />
          </ThemeIcon>
          <Text fw={800} size="lg">
            {title}
          </Text>
        </Group>
        {children}
      </Stack>
    </div>
  );
}

function PointTile({ value, label, icon }: { value: string; label: string; icon?: ReactNode }) {
  return (
    <Stack gap={2} className="rounded-lg bg-gray-0 px-3 py-2 dark:bg-dark-5">
      <Group gap={4} wrap="nowrap">
        <Text fw={900} className="text-3xl tabular-nums leading-none">
          {value}
        </Text>
        {icon}
      </Group>
      <Text size="xs" c="dimmed" lh={1.3}>
        {label}
      </Text>
    </Stack>
  );
}

function FairRule({ children }: { children: ReactNode }) {
  return (
    <Group component="li" gap="sm" wrap="nowrap" align="flex-start">
      <ThemeIcon size={20} radius="xl" variant="light" color="green" className="mt-px shrink-0">
        <IconCheck size={12} stroke={3} />
      </ThemeIcon>
      <Text size="sm">{children}</Text>
    </Group>
  );
}

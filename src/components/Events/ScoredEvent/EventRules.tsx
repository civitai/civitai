import { Accordion, Group, SimpleGrid, Stack, Text, ThemeIcon, Title } from '@mantine/core';
import {
  IconConfetti,
  IconEye,
  IconHanger,
  IconHeart,
  IconScale,
  IconTrophy,
  IconUsersGroup,
} from '@tabler/icons-react';
import type { ReactNode } from 'react';
import { EdgeMedia } from '~/components/EdgeMedia/EdgeMedia';
import { describeEntityTypes } from '~/components/Events/ScoredEvent/scored-event.utils';
import {
  SpotlightBorderCard,
  SpotlightGlow,
  SpotlightSurface,
} from '~/components/SpotlightCard/SpotlightBorderCard';
import type { RouterOutput } from '~/types/router';

type EventData = RouterOutput['event']['getData'];

const STEP_ICONS = [IconUsersGroup, IconHanger, IconConfetti];

export function EventRules({ data }: { data: EventData }) {
  const { page, rules, decoration } = data;
  if (!page) return null;
  const wearsOn = decoration ? describeEntityTypes(decoration.entityTypes) : 'your posts';
  const cooldownMin = decoration ? Math.round(decoration.moveCooldownMs / 60_000) : 0;

  return (
    <Stack gap="xl">
      <Stack gap="md">
        <Title order={2}>How it works</Title>
        <SimpleGrid cols={{ base: 1, sm: 3 }} spacing="md">
          {page.steps.map((step, i) => {
            const Icon = STEP_ICONS[i] ?? IconConfetti;
            return (
              <SpotlightBorderCard key={step.title} color="var(--mantine-color-blue-5)" size={220}>
                <Stack gap="xs" p="lg">
                  <ThemeIcon size={40} radius="xl" variant="light">
                    <Icon size={22} />
                  </ThemeIcon>
                  <Text fw={700} size="lg">
                    {i + 1}. {step.title}
                  </Text>
                  <Text c="dimmed">{step.body}</Text>
                </Stack>
              </SpotlightBorderCard>
            );
          })}
        </SimpleGrid>
      </Stack>

      {rules && (
        <SimpleGrid cols={{ base: 1, md: 2 }} spacing="md">
          <RuleCard icon={<IconEye size={20} />} title="How points add up">
            <PointRow label="Someone sees your hatted post in a feed" value="1 point" />
            <PointRow
              label="Someone reacts to it"
              value={`${rules.reactionWeight} points`}
              icon={<IconHeart size={14} />}
            />
            <PointRow label="You view or react to your own post" value="0" />
            <Text size="sm" c="dimmed">
              Hats go on your own {wearsOn}. Models score views only: reactions aren&apos;t counted
              for models.
            </Text>
          </RuleCard>
          <RuleCard icon={<IconScale size={20} />} title="Keeping it fair">
            <ul className="m-0 flex flex-col gap-2 pl-5">
              <li>
                <Text size="sm">
                  One person counts for at most {rules.viewerOwnerDailyCap} of a creator&apos;s
                  posts a day.
                </Text>
              </li>
              <li>
                <Text size="sm">
                  Accounts made in the {rules.newAccountDays} days before the event don&apos;t
                  count.
                </Text>
              </li>
              <li>
                <Text size="sm">
                  Signed-out views count, up to a fair share. Bot-like browsing doesn&apos;t.
                </Text>
              </li>
              {cooldownMin > 0 && (
                <li>
                  <Text size="sm">
                    A hat can move again {cooldownMin} minutes after it was placed.
                  </Text>
                </li>
              )}
              <li>
                <Text size="sm">Buzz spent doesn&apos;t score. Only attention does.</Text>
              </li>
            </ul>
          </RuleCard>
        </SimpleGrid>
      )}

      <SimpleGrid cols={{ base: 1, md: 2 }} spacing="md">
        <SpotlightSurface className="overflow-hidden rounded-md border border-solid border-yellow-6/40 bg-yellow-0 dark:bg-yellow-9/10">
          <SpotlightGlow color="rgba(250,176,5,0.12)" />
          <Group gap="lg" p="lg" wrap="nowrap" className="relative">
            <div className="w-24 shrink-0">
              {page.prize.imageUrl ? (
                <EdgeMedia src={page.prize.imageUrl} width={192} alt="" />
              ) : (
                <ThemeIcon size={80} radius="xl" color="yellow" variant="light">
                  <IconTrophy size={44} />
                </ThemeIcon>
              )}
            </div>
            <Stack gap={4}>
              <Text size="xs" fw={700} tt="uppercase" c="yellow" lts={0.5}>
                The prize
              </Text>
              <Text fw={700} size="lg">
                {page.prize.title}
              </Text>
              <Text c="dimmed">{page.prize.body}</Text>
            </Stack>
          </Group>
        </SpotlightSurface>

        {!!page.faq?.length && (
          <Accordion variant="separated" radius="md">
            {page.faq.map((f) => (
              <Accordion.Item key={f.question} value={f.question}>
                <Accordion.Control>
                  <Text fw={600}>{f.question}</Text>
                </Accordion.Control>
                <Accordion.Panel>
                  <Text c="dimmed">{f.answer}</Text>
                </Accordion.Panel>
              </Accordion.Item>
            ))}
          </Accordion>
        )}
      </SimpleGrid>
    </Stack>
  );
}

function RuleCard({
  icon,
  title,
  children,
}: {
  icon: ReactNode;
  title: string;
  children: ReactNode;
}) {
  return (
    <SpotlightBorderCard color="var(--mantine-color-gray-5)" size={260}>
      <Stack gap="sm" p="lg">
        <Group gap={8}>
          {icon}
          <Text fw={700}>{title}</Text>
        </Group>
        {children}
      </Stack>
    </SpotlightBorderCard>
  );
}

function PointRow({ label, value, icon }: { label: string; value: string; icon?: ReactNode }) {
  return (
    <Group justify="space-between" gap="md" wrap="nowrap">
      <Text size="sm" c="dimmed">
        {label}
      </Text>
      <Group gap={4} wrap="nowrap">
        {icon}
        <Text fw={700} className="whitespace-nowrap">
          {value}
        </Text>
      </Group>
    </Group>
  );
}

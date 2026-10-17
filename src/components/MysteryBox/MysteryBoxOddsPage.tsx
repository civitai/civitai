import {
  Badge,
  Group,
  SegmentedControl,
  SimpleGrid,
  Stack,
  Table,
  Text,
  Title,
} from '@mantine/core';
import { useMemo } from 'react';
import { useTeamColor } from '~/components/Events/events.utils';
import { HatArt } from '~/components/Events/ScoredEvent/HatArt';
import { MysteryBoxOddsBar } from '~/components/MysteryBox/MysteryBoxOddsBar';
import {
  baseOddsView,
  formatChance,
  tierColor,
  tierSummaries,
} from '~/components/MysteryBox/mystery-box.utils';
import type { EventDecorationFit } from '~/shared/constants/event-decoration.constants';
import { formatDate } from '~/utils/date-helpers';
import { numberWithCommas } from '~/utils/number-helpers';

import type { MysteryBoxOddsPageData } from '~/components/MysteryBox/mystery-box.utils';

/**
 * A box's public odds and contents: the base odds, everything in it, how the draw works, and every
 * change. With teams, one team at a time: each team draws only from its own contents.
 */
export function MysteryBoxOddsPage({
  page,
  team,
  onTeamChange,
}: {
  page: MysteryBoxOddsPageData;
  /** The team shown; the first of `page.teams` when absent or not one of them. */
  team?: string;
  onTeamChange: (team: string) => void;
}) {
  const teamColor = useTeamColor();
  const shownTeam = team && page.teams.includes(team) ? team : page.teams[0];
  const view = useMemo(() => baseOddsView(page, shownTeam), [page, shownTeam]);
  const tiers = useMemo(() => tierSummaries(view), [view]);
  const color = shownTeam ? teamColor(shownTeam) : undefined;
  const noun = page.noun;
  const published = page.history[page.history.length - 1];
  const updated = page.history.find((h) => h.version === page.version);

  return (
    <Stack gap="xl">
      <div>
        <Title order={1} size="h2">
          {page.name}: odds and contents
        </Title>
        <Text size="sm" c="dimmed" data-testid="box-odds-meta">
          {[
            `Version ${page.version}`,
            published && `published ${formatDate(published.createdAt, 'MMM D, YYYY', true)}`,
            updated &&
              updated !== published &&
              `updated ${formatDate(updated.createdAt, 'MMM D, YYYY', true)}`,
            page.price !== null && `${numberWithCommas(page.price)} Buzz`,
            page.event?.title,
            page.archived && 'no longer sold',
          ]
            .filter(Boolean)
            .join(' · ')}
        </Text>
        {page.description && <Text mt="xs">{page.description}</Text>}
      </div>

      {page.teams.length > 1 && (
        <Stack gap={4}>
          <Text size="sm">
            Each team draws only from its own {noun}s. Showing Team {shownTeam}.
          </Text>
          <SegmentedControl
            data={page.teams.map((t) => ({ value: t, label: t }))}
            value={shownTeam}
            onChange={onTeamChange}
            className="self-start"
          />
        </Stack>
      )}

      <Stack gap="sm">
        <Title order={2} size="h4">
          Odds
        </Title>
        <MysteryBoxOddsBar tiers={tiers} />
        <Table data-testid="box-odds-table">
          <Table.Thead>
            <Table.Tr>
              <Table.Th>Rarity</Table.Th>
              <Table.Th>Chance (nothing owned)</Table.Th>
              <Table.Th className="capitalize">{noun}s</Table.Th>
              <Table.Th>Each {noun}</Table.Th>
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {tiers.map((t) => (
              <Table.Tr key={t.tier.id}>
                <Table.Td>
                  <Group gap={6} wrap="nowrap">
                    <span
                      className="inline-block size-2 rounded-full"
                      style={{ background: tierColor(t.tier) }}
                    />
                    {t.tier.name}
                  </Group>
                </Table.Td>
                <Table.Td>{formatChance(t.probability, 1)}</Table.Td>
                <Table.Td>{t.contents.length}</Table.Td>
                <Table.Td>{t.contents.length ? formatChance(t.itemProbability) : '-'}</Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
      </Stack>

      <Stack gap="xs">
        <Title order={2} size="h4">
          How the draw works
        </Title>
        <ol className="m-0 flex flex-col gap-1 pl-5 text-sm">
          <li>
            We roll the rarity using the weights below, counting only rarities with a {noun} you
            don&apos;t own yet.
          </li>
          <li>Every {noun} you don&apos;t own in that rarity is equally likely.</li>
          <li>
            You never get a {noun} you already own. Once you own every {noun} in a rarity, it drops
            out and the others share its chance, so your odds move toward the rarer {noun}s as you
            collect. When you own them all, the box stops selling to you.
          </li>
          <li>Boxes can&apos;t be traded, resold or exchanged for Buzz.</li>
        </ol>
        <Text size="xs" c="dimmed">
          Weights: {page.tiers.map((t) => `${t.name} ${t.weight}`).join(' · ')}. A rarity&apos;s
          chance is its weight divided by the total weight of the rarities you can still get.
        </Text>
      </Stack>

      <Stack gap="lg">
        <Title order={2} size="h4">
          What&apos;s inside ({view.contents.length})
        </Title>
        {tiers.map((t) => (
          <Stack key={t.tier.id} gap="xs" data-testid="box-tier">
            <Group gap="xs">
              <Badge
                variant="light"
                style={{ color: tierColor(t.tier), background: `${tierColor(t.tier)}22` }}
              >
                {t.tier.name}
              </Badge>
              <Text size="xs" c="dimmed">
                {t.contents.length} {t.contents.length === 1 ? noun : `${noun}s`}
              </Text>
            </Group>
            <SimpleGrid cols={{ base: 4, sm: 8 }} spacing={6}>
              {t.contents.map((c) => (
                <div key={c.contentId} title={c.name ?? undefined}>
                  {c.url ? (
                    <HatArt
                      url={c.url}
                      fit={c.fit as EventDecorationFit | undefined}
                      width={96}
                      color={color}
                    />
                  ) : (
                    <Text size="xs">{c.name}</Text>
                  )}
                </div>
              ))}
            </SimpleGrid>
          </Stack>
        ))}
      </Stack>

      <Stack gap="xs">
        <Title order={2} size="h4">
          Change history
        </Title>
        {page.teams.length > 1 && (
          <Text size="xs" c="dimmed">
            Each change covers the whole box, every team&apos;s {noun}s together.
          </Text>
        )}
        {!page.historyComplete && (
          <Text size="sm" c="dimmed" data-testid="box-odds-history-incomplete">
            The latest change to this box isn&apos;t in the history yet. The odds above are the
            current ones.
          </Text>
        )}
        <Table data-testid="box-odds-history" hidden={!page.history.length}>
          <Table.Thead>
            <Table.Tr>
              <Table.Th>Version</Table.Th>
              <Table.Th>Date</Table.Th>
              <Table.Th>Change</Table.Th>
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {page.history.map((entry) => (
              <Table.Tr key={entry.version}>
                <Table.Td>{entry.version}</Table.Td>
                <Table.Td className="whitespace-nowrap">
                  {formatDate(entry.createdAt, 'MMM D, YYYY', true)}
                </Table.Td>
                <Table.Td>
                  {entry.changes.map((line) => (
                    <div key={line}>{line}</div>
                  ))}
                </Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
      </Stack>
    </Stack>
  );
}

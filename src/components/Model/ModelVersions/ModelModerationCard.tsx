import {
  Accordion,
  Badge,
  Code,
  Group,
  Loader,
  Stack,
  Text,
  useComputedColorScheme,
} from '@mantine/core';
import { useLocalStorage } from '@mantine/hooks';
import { IconShieldCheck, IconShieldHalfFilled } from '@tabler/icons-react';
import type { ReactNode } from 'react';
import { formatDate } from '~/utils/date-helpers';
import { trpc } from '~/utils/trpc';
import classes from './ModelVersionDetails.module.scss';

// Mod-only at-a-glance moderation status for a model. Surfaces automated state
// (minor/POI/nsfw flags, locked properties, profanity lock, unpublish/takedown)
// that mods otherwise can't see since they bypass the enforcement filters.
// Collapsible + persisted, styled to match the version-details card.
export function ModelModerationCard({ modelId }: { modelId: number }) {
  const colorScheme = useComputedColorScheme('dark');
  const { data, isLoading } = trpc.moderator.models.getModerationDetail.useQuery({ id: modelId });
  const [open, setOpen] = useLocalStorage<string[]>({
    key: 'model-moderation-card',
    defaultValue: [],
  });

  const flags: { label: string; color: string }[] = [];
  if (data?.minor) flags.push({ label: 'Minor', color: 'red' });
  if (data?.poi) flags.push({ label: 'POI', color: 'grape' });
  if (data?.nsfw) flags.push({ label: 'NSFW', color: 'red' });
  if (data?.needsReview) flags.push({ label: 'Needs review', color: 'yellow' });
  if (data?.cannotPublish) flags.push({ label: 'Cannot publish', color: 'orange' });
  if (data?.cannotPromote) flags.push({ label: 'Promo banned', color: 'orange' });
  if (data?.commentsLocked) flags.push({ label: 'Comments locked', color: 'gray' });

  const locked = data?.lockedProperties ?? [];
  const hasFooter = !!(
    data?.profanity ||
    data?.unpublishedAt ||
    data?.takenDownAt ||
    data?.deletedAt
  );
  const rows: { key: string; badges: ReactNode }[] = [];
  if (flags.length)
    rows.push({
      key: 'Flags',
      badges: flags.map((f) => (
        <Badge key={f.label} size="sm" radius="xl" color={f.color} variant="light">
          {f.label}
        </Badge>
      )),
    });
  if (locked.length)
    rows.push({
      key: 'Locked',
      badges: locked.map((p) => (
        <Badge key={p} size="sm" radius="xl" color="orange" variant="light">
          {p}
        </Badge>
      )),
    });

  const isEmpty = !isLoading && !!data && rows.length === 0 && !hasFooter;
  const notableCount =
    flags.length +
    locked.length +
    (data?.profanity ? 1 : 0) +
    (data?.unpublishedAt ? 1 : 0) +
    (data?.takenDownAt ? 1 : 0) +
    (data?.deletedAt ? 1 : 0);

  return (
    <Accordion
      variant="separated"
      multiple
      value={open}
      onChange={setOpen}
      styles={(theme) => ({
        content: { padding: 0 },
        label: { padding: 0 },
        item: {
          overflow: 'hidden',
          borderColor: colorScheme === 'dark' ? theme.colors.dark[4] : theme.colors.gray[3],
          boxShadow: theme.shadows.sm,
        },
        control: { padding: theme.spacing.sm, gap: theme.spacing.md },
      })}
    >
      <Accordion.Item value="moderation">
        <Accordion.Control>
          <Group justify="space-between" gap="xs" wrap="nowrap">
            <Group gap={6} wrap="nowrap">
              <IconShieldHalfFilled size={16} />
              Moderation
              {notableCount > 0 && (
                <Badge size="sm" variant="filled" color="orange">
                  {notableCount}
                </Badge>
              )}
            </Group>
            <Badge size="sm" variant="light" color="blue">
              mods only
            </Badge>
          </Group>
        </Accordion.Control>
        <Accordion.Panel>
          {isLoading || !data ? (
            <Group justify="center" py="sm">
              <Loader size="sm" />
            </Group>
          ) : isEmpty ? (
            <Group justify="center" gap={8} py="lg">
              <IconShieldCheck size={18} style={{ color: 'var(--mantine-color-green-6)' }} />
              <Text size="sm" c="dimmed">
                No moderation flags on this model
              </Text>
            </Group>
          ) : (
            <>
              {rows.length > 0 && (
                <Stack gap={0} className={classes.detailsPanel}>
                  {rows.map((r, i) => {
                    const isLast = i === rows.length - 1 && !hasFooter;
                    return (
                      <div
                        key={r.key}
                        className={isLast ? classes.detailRowPlain : classes.detailRow}
                      >
                        <span className={classes.detailLabel}>{r.key}</span>
                        <Group gap={4}>{r.badges}</Group>
                      </div>
                    );
                  })}
                </Stack>
              )}

              {hasFooter && (
                <Stack gap={6} px="md" py="sm">
                  {data.profanity && (
                    <Stack gap={4}>
                      <Text size="xs" fw={600} c="orange">
                        Auto-flagged by profanity filter
                      </Text>
                      <Group gap={4}>
                        {data.profanity.matches.map((m, i) => (
                          <Code key={i}>{m}</Code>
                        ))}
                      </Group>
                      {data.profanity.metrics && (
                        <Text size="xs">
                          {data.profanity.metrics.matchCount} matches in{' '}
                          {data.profanity.metrics.totalWords} words (
                          {(data.profanity.metrics.density * 100).toFixed(2)}%)
                        </Text>
                      )}
                      <Text size="xs" c="dimmed">
                        From lock time — may be stale; re-save to re-run the current filter.
                      </Text>
                    </Stack>
                  )}
                  {data.unpublishedAt && (
                    <Text size="xs">
                      Unpublished {formatDate(data.unpublishedAt)}
                      {data.unpublishedReason ? ` — ${data.unpublishedReason}` : ''}
                    </Text>
                  )}
                  {data.takenDownAt && (
                    <Text size="xs" c="red">
                      Taken down {formatDate(data.takenDownAt)}
                    </Text>
                  )}
                  {data.deletedAt && (
                    <Text size="xs" c="red">
                      Deleted {formatDate(data.deletedAt)}
                    </Text>
                  )}
                </Stack>
              )}
            </>
          )}
        </Accordion.Panel>
      </Accordion.Item>
    </Accordion>
  );
}

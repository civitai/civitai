import {
  Accordion,
  Badge,
  Button,
  Code,
  Group,
  Loader,
  Stack,
  Text,
  useComputedColorScheme,
} from '@mantine/core';
import { useLocalStorage } from '@mantine/hooks';
import { IconHistory, IconShieldCheck, IconShieldHalfFilled } from '@tabler/icons-react';
import type { ReactNode } from 'react';
import { dialogStore } from '~/components/Dialog/dialogStore';
import ModelChangeHistoryModal from '~/components/Model/ModelVersions/ModelChangeHistoryModal';
import { getBrowsingLevelLabel } from '~/shared/constants/browsingLevel.constants';
import { getModelVersionFlagLabels } from '~/shared/constants/model-version-flags.constants';
import { formatDate } from '~/utils/date-helpers';
import { trpc } from '~/utils/trpc';
import classes from './ModelVersionDetails.module.scss';

const scanStatusText: Record<string, string> = {
  Succeeded: 'complete',
  Pending: 'rescan pending',
  Failed: 'failed',
  Expired: 'expired',
  Canceled: 'canceled',
};

// A label's verdict can come from a row whose rescan has not finished; its updatedAt is then the
// rescan's, not the verdict's.
function verdictProvenance(v: { source: string; status: string; updatedAt: Date }) {
  const source = v.source === 'main' ? 'main scan' : v.source;
  if (v.status === 'Succeeded') return `${source} · ${formatDate(v.updatedAt)}`;
  if (v.status === 'Pending') return `${source} · rescan pending — last verdict shown`;
  return `${source} · last rescan failed — last verdict shown`;
}

function detectedText(detected: boolean | null) {
  if (detected === null) return 'no verdict';
  return detected ? 'detected' : 'not detected';
}

// Mod-only at-a-glance moderation status for a model. Surfaces automated state
// (minor/POI/nsfw flags, locked properties, profanity lock, unpublish/takedown)
// that mods otherwise can't see since they bypass the enforcement filters.
// Collapsible + persisted, styled to match the version-details card.
//
// `versionFlags` is the one VERSION-scoped input — the bitwise `ModelVersion.flags`
// of the version currently selected on the page, not the model as a whole. Its
// badges come from `modelVersionFlagLabels`, so a new flag surfaces here for free.
export function ModelModerationCard({
  modelId,
  versionFlags,
}: {
  modelId: number;
  versionFlags?: number;
}) {
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
  for (const label of getModelVersionFlagLabels(versionFlags ?? 0))
    flags.push({ label, color: 'orange' });

  const locked = data?.lockedProperties ?? [];
  const verdicts = data?.textScanFlags ?? [];
  // An open verdict is the reason behind its label's flag badge; count it only without one.
  const badgedLabels = { poi: !!data?.poi, minor: !!data?.minor };
  const unbadgedOpenVerdicts = verdicts.filter((v) => v.open && !badgedLabels[v.label]).length;
  const hasFooter = !!(
    verdicts.length ||
    data?.profanity ||
    data?.textModeration ||
    data?.textScan ||
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
    (data?.textModeration ? 1 : 0) +
    unbadgedOpenVerdicts +
    (data?.textScan?.triggeredLabels.length ? 1 : 0) +
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
                  {data.textModeration && (
                    <Stack gap={4}>
                      <Text size="xs" fw={600} c="orange">
                        Text scan {formatDate(data.textModeration.scannedAt)}
                      </Text>
                      <Group gap={4}>
                        {data.textModeration.labels.map((l) => (
                          <Badge key={l.label} size="sm" radius="xl" color="orange" variant="light">
                            {l.label} {l.score.toFixed(2)}
                          </Badge>
                        ))}
                      </Group>
                      {/* How close a call it was. The labels v1 acts on are LLM-scored, so
                          the score against its own threshold is the only detail available —
                          these policies return no matched terms. */}
                      <Text size="xs" c="dimmed">
                        {data.textModeration.labels
                          .map(
                            (l) => `${l.label} ${l.score.toFixed(2)} / ${l.threshold.toFixed(2)}`
                          )
                          .join(' · ')}
                      </Text>
                      {data.textModeration.matchedTerms.length > 0 && (
                        <Group gap={4}>
                          {data.textModeration.matchedTerms.map((m, i) => (
                            <Code key={i}>{m}</Code>
                          ))}
                        </Group>
                      )}
                      <Text size="xs" c="dimmed">
                        Recorded even when a lock kept the flag from being applied.
                      </Text>
                    </Stack>
                  )}
                  {verdicts.map((v) => (
                    <Stack key={v.label} gap={4}>
                      <Group gap={6}>
                        <Text size="xs" fw={600} c="red">
                          Flagged by text scan · {v.label}
                          {v.at ? ` · ${formatDate(v.at)}` : ''}
                        </Text>
                        {v.open && (
                          <Badge size="xs" radius="xl" color="red" variant="light">
                            Open
                          </Badge>
                        )}
                        {v.appealGranted && (
                          <Badge size="xs" radius="xl" color="green" variant="light">
                            Appeal granted
                          </Badge>
                        )}
                        {v.appealUpheld && (
                          <Badge size="xs" radius="xl" color="gray" variant="light">
                            Appeal upheld
                          </Badge>
                        )}
                      </Group>
                      {v.reason && <Text size="xs">{v.reason}</Text>}
                      {v.names.length > 0 && (
                        <Group gap={4}>
                          {v.names.map((name) => (
                            <Code key={name}>{name}</Code>
                          ))}
                        </Group>
                      )}
                      <Text size="xs" c="dimmed">
                        Workflow {v.workflowId}
                        {v.model ? ` · ${v.model}` : ''}
                      </Text>
                    </Stack>
                  ))}
                  {data.textScan && (
                    <Stack gap={4}>
                      <Text size="xs" fw={600} c="orange">
                        Latest scan · {scanStatusText[data.textScan.status] ?? data.textScan.status}
                        {data.textScan.nsfwLevel
                          ? ` · ${getBrowsingLevelLabel(data.textScan.nsfwLevel)}`
                          : ''}{' '}
                        · {formatDate(data.textScan.updatedAt)}
                      </Text>
                      {data.textScan.reasons
                        .filter(
                          (r) => !data.textScan?.labelVerdicts?.some((v) => v.label === r.label)
                        )
                        .map((r) => (
                          <Text key={r.label} size="xs">
                            <Code>{r.label}</Code> {r.reason}
                          </Text>
                        ))}
                      {data.textScan.labelVerdicts?.map((v) => (
                        <Stack key={v.label} gap={0}>
                          <Text size="xs">
                            <Code>{v.label}</Code> {detectedText(v.detected)}
                            {v.reason ? ` — ${v.reason}` : ''}
                          </Text>
                          <Text size="xs" c="dimmed">
                            {verdictProvenance(v)}
                          </Text>
                        </Stack>
                      ))}
                    </Stack>
                  )}
                  {data.unpublishedAt && (
                    <Text size="xs">
                      Unpublished {formatDate(data.unpublishedAt)}
                      {data.modelRules
                        ? ` — Model rules, ${
                            data.modelRules.source === 'literal'
                              ? 'named at publish'
                              : 'matched by the scan'
                          }: ${data.modelRules.rules
                            .map((rule) => rule.subject ?? `rule ${rule.id}`)
                            .join(', ')}`
                        : data.unpublishedReason
                        ? ` — ${data.unpublishedReason}`
                        : ''}
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
          <Group justify="flex-end" px="sm" py={6}>
            <Button
              size="compact-xs"
              variant="subtle"
              color="gray"
              leftSection={<IconHistory size={14} />}
              onClick={() =>
                dialogStore.trigger({ component: ModelChangeHistoryModal, props: { modelId } })
              }
            >
              Change history
            </Button>
          </Group>
        </Accordion.Panel>
      </Accordion.Item>
    </Accordion>
  );
}

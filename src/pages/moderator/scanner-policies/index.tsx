/**
 * Scanner Policies — moderator-only test bench for XGuard policy candidates.
 *
 * Layout (top → bottom):
 *   - Mode toggle (Prompt / Text)
 *   - System prompt panel (per-mode override; falls back to live registry)
 *   - Two-column: label sidebar | candidate list + editor for selected label
 *   - Dataset export controls (max + button)
 *   - Past datasets list — each row has a "Run tests" button that scores all
 *     currently-active candidates against the dataset in S3 and writes the
 *     results back to the same workbook in place. A "Download" button mints
 *     a fresh signed URL.
 *
 * See docs/scanner-policies/PLAN.md for the full design.
 */
import {
  Accordion,
  ActionIcon,
  Alert,
  Anchor,
  Badge,
  Box,
  Button,
  Card,
  Code,
  Collapse,
  Group,
  Loader,
  NumberInput,
  Progress,
  ScrollArea,
  SegmentedControl,
  Stack,
  Switch,
  Table,
  Tabs,
  Text,
  TextInput,
  Textarea,
  Title,
  Tooltip,
} from '@mantine/core';
import { useDisclosure } from '@mantine/hooks';
import {
  IconArchive,
  IconChevronRight,
  IconDownload,
  IconPlayerPlayFilled,
  IconPlayerStopFilled,
  IconPlus,
  IconTrash,
} from '@tabler/icons-react';
import type { MouseEvent } from 'react';
import { useCallback, useEffect, useState } from 'react';
import { Meta } from '~/components/Meta/Meta';
import { useScannerPolicyTestSignal } from '~/components/Signals/ScannerPolicyTestSignal';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import type {
  ScannerPolicyCandidate,
  ScannerPolicyMode,
  ScannerPolicyTestProgressData,
} from '~/server/schema/scanner-policies.schema';
import { createServerSideProps } from '~/server/utils/server-side-helpers';
import { downloadBlob } from '~/utils/file-utils';
import { showErrorNotification, showSuccessNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';

export const getServerSideProps = createServerSideProps({
  requireModerator: true,
  useSession: true,
  resolver: async ({ session }) => {
    if (!session || !session.user?.isModerator)
      return { redirect: { destination: '/', permanent: false } };
    return { props: {} };
  },
});

type RunState =
  | { phase: 'idle' }
  | { phase: 'starting'; datasetId: string }
  | {
      phase: 'running';
      runId: string;
      datasetId: string;
      processed: number;
      total: number;
      currentCandidate?: string;
    }
  | { phase: 'cancelling'; runId: string; datasetId: string; processed: number; total: number }
  | { phase: 'done'; runId: string; datasetId: string }
  | { phase: 'cancelled'; runId: string; datasetId?: string }
  | { phase: 'error'; message: string };

export default function ScannerPoliciesPage() {
  const user = useCurrentUser();
  const utils = trpc.useUtils();

  const [mode, setMode] = useState<ScannerPolicyMode>('prompt');
  const [selectedLabel, setSelectedLabel] = useState<string | null>(null);
  const [editingCandidate, setEditingCandidate] = useState<ScannerPolicyCandidate | null>(null);
  const [draftCandidate, setDraftCandidate] = useState<{
    name: string;
    threshold: number;
    policy: string;
    notes: string;
  } | null>(null);
  const [newLabelName, setNewLabelName] = useState('');
  const [systemPromptDraft, setSystemPromptDraft] = useState('');
  const [systemPromptOpen, { toggle: toggleSystemPrompt }] = useDisclosure(false);
  const [exportMax, setExportMax] = useState(500);
  const [exporting, setExporting] = useState(false);
  const [runState, setRunState] = useState<RunState>({ phase: 'idle' });

  // --- queries ---
  const labelsQ = trpc.scannerPolicies.listLabels.useQuery();
  const labelsForMode = labelsQ.data?.[mode] ?? [];

  useEffect(() => {
    if (!selectedLabel && labelsForMode.length > 0) {
      setSelectedLabel(labelsForMode[0].label);
    }
  }, [labelsForMode, selectedLabel]);
  useEffect(() => {
    setSelectedLabel(null);
    setEditingCandidate(null);
    setDraftCandidate(null);
  }, [mode]);

  const candidatesQ = trpc.scannerPolicies.listCandidates.useQuery(
    { mode, label: selectedLabel ?? '' },
    { enabled: !!selectedLabel }
  );
  const candidates = candidatesQ.data ?? [];

  const systemPromptQ = trpc.scannerPolicies.getSystemPrompt.useQuery({ mode });
  useEffect(() => {
    setSystemPromptDraft(systemPromptQ.data ?? '');
  }, [systemPromptQ.data, mode]);

  const exportsQ = trpc.scannerPolicies.listExports.useQuery(
    { mode, label: selectedLabel ?? '' },
    { enabled: !!selectedLabel }
  );

  // --- mutations ---
  const upsertM = trpc.scannerPolicies.upsertCandidate.useMutation({
    onSuccess: async () => {
      await Promise.all([
        utils.scannerPolicies.listLabels.invalidate(),
        utils.scannerPolicies.listCandidates.invalidate(),
      ]);
      setEditingCandidate(null);
      setDraftCandidate(null);
      showSuccessNotification({ message: 'Candidate saved' });
    },
    onError: (e) => showErrorNotification({ title: 'Save failed', error: new Error(e.message) }),
  });
  const setActiveM = trpc.scannerPolicies.setActive.useMutation({
    onSuccess: () => utils.scannerPolicies.listCandidates.invalidate(),
    onError: (e) => showErrorNotification({ title: 'Toggle failed', error: new Error(e.message) }),
  });
  const deleteCandidateM = trpc.scannerPolicies.deleteCandidate.useMutation({
    onSuccess: async () => {
      await Promise.all([
        utils.scannerPolicies.listLabels.invalidate(),
        utils.scannerPolicies.listCandidates.invalidate(),
      ]);
      setEditingCandidate(null);
    },
    onError: (e) => showErrorNotification({ title: 'Delete failed', error: new Error(e.message) }),
  });
  const deleteLabelM = trpc.scannerPolicies.deleteLabel.useMutation({
    onSuccess: async () => {
      await utils.scannerPolicies.listLabels.invalidate();
      setSelectedLabel(null);
    },
    onError: (e) => showErrorNotification({ title: 'Delete failed', error: new Error(e.message) }),
  });
  const setSystemPromptM = trpc.scannerPolicies.setSystemPrompt.useMutation({
    onSuccess: () => {
      utils.scannerPolicies.getSystemPrompt.invalidate();
      showSuccessNotification({ message: 'System prompt saved' });
    },
    onError: (e) => showErrorNotification({ title: 'Save failed', error: new Error(e.message) }),
  });
  const cancelRunM = trpc.scannerPolicies.cancelRun.useMutation();
  const startRunM = trpc.scannerPolicies.startRun.useMutation();
  const deleteExportM = trpc.scannerPolicies.deleteExport.useMutation({
    onSuccess: () => {
      utils.scannerPolicies.listExports.invalidate();
      showSuccessNotification({ message: 'Dataset deleted' });
    },
    onError: (e) => showErrorNotification({ title: 'Delete failed', error: new Error(e.message) }),
  });

  // --- signal subscription ---
  const onTestProgress = useCallback(
    (data: ScannerPolicyTestProgressData) => {
      setRunState((prev) => {
        // Only listen to OUR run (we set datasetId in `starting` and keep runId from `started`).
        const ours =
          (prev.phase === 'starting' && data.exportId && data.exportId === prev.datasetId) ||
          (('runId' in prev && prev.runId === data.runId) as boolean);
        if (!ours && prev.phase !== 'starting') return prev;

        if (data.phase === 'started' && prev.phase === 'starting') {
          return {
            phase: 'running',
            runId: data.runId,
            datasetId: prev.datasetId,
            processed: 0,
            total: data.total,
          };
        }
        if (
          data.phase === 'progress' &&
          (prev.phase === 'running' || prev.phase === 'cancelling')
        ) {
          return {
            phase: prev.phase,
            runId: data.runId,
            datasetId: prev.datasetId,
            processed: data.processed,
            total: data.total,
            currentCandidate: data.currentCandidate,
          };
        }
        if (data.phase === 'done') {
          const resolvedDatasetId =
            data.exportId ?? ('datasetId' in prev && prev.datasetId ? prev.datasetId : '');
          return {
            phase: 'done',
            runId: data.runId,
            datasetId: resolvedDatasetId,
          };
        }
        if (data.phase === 'cancelled')
          return { phase: 'cancelled', runId: data.runId, datasetId: data.exportId };
        if (data.phase === 'error')
          return { phase: 'error', message: data.errorMessage ?? 'Unknown error' };
        return prev;
      });

      if (data.phase === 'done' || data.phase === 'cancelled' || data.phase === 'error') {
        utils.scannerPolicies.listExports.invalidate();
      }
    },
    [utils]
  );
  useScannerPolicyTestSignal(onTestProgress);

  // --- handlers ---
  const downloadDataset = async (datasetId: string) => {
    try {
      const { url, filename } = await utils.client.scannerPolicies.getDownloadUrl.query({
        exportId: datasetId,
      });
      const res = await fetch(url);
      if (!res.ok) throw new Error(`Download failed (${res.status})`);
      const blob = await res.blob();
      downloadBlob(blob, filename);
    } catch (err) {
      showErrorNotification({ title: 'Download failed', error: err as Error });
    }
  };

  const handleAddCandidate = () => {
    if (!selectedLabel) return;
    setEditingCandidate(null);
    setDraftCandidate({
      name: '',
      threshold: 0.5,
      policy: `- x: Civitai ${
        mode === 'prompt' ? 'Prompt' : 'Text'
      } ${selectedLabel}\n  - ...\n  - For this binary check, only use x or sec.`,
      notes: '',
    });
  };

  const handleEditCandidate = (c: ScannerPolicyCandidate) => {
    setEditingCandidate(c);
    setDraftCandidate({
      name: c.name,
      threshold: c.threshold,
      policy: c.policy,
      notes: c.notes ?? '',
    });
  };

  const handleSaveCandidate = () => {
    if (!draftCandidate || !selectedLabel) return;
    upsertM.mutate({
      id: editingCandidate?.id,
      name: draftCandidate.name,
      mode,
      label: selectedLabel,
      threshold: draftCandidate.threshold,
      archived: editingCandidate?.archived ?? false,
      active: editingCandidate?.active ?? false,
      policy: draftCandidate.policy,
      notes: draftCandidate.notes || undefined,
    });
  };

  const handleAddLabel = () => {
    const name = newLabelName.trim();
    if (!name) return;
    upsertM.mutate({
      name: 'Draft',
      mode,
      label: name,
      threshold: 0.5,
      archived: false,
      active: false,
      policy: `- x: Civitai ${
        mode === 'prompt' ? 'Prompt' : 'Text'
      } ${name}\n  - ...\n  - For this binary check, only use x or sec.`,
    });
    setNewLabelName('');
    setSelectedLabel(name);
  };

  const handleExportDataset = async () => {
    if (!selectedLabel) return;
    setExporting(true);
    try {
      const res = await fetch('/api/mod/scanner-policies/export-dataset', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ mode, label: selectedLabel, max: exportMax }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: res.statusText }));
        throw new Error(err.error ?? 'Export failed');
      }
      const data = await res.json();
      utils.scannerPolicies.listExports.invalidate();
      showSuccessNotification({
        message: `Exported ${data.rowCount} rows (TP/FP/TN/FN: ${data.perBucket.TP}/${data.perBucket.FP}/${data.perBucket.TN}/${data.perBucket.FN})`,
      });
    } catch (err) {
      showErrorNotification({ title: 'Export failed', error: err as Error });
    } finally {
      setExporting(false);
    }
  };

  const activeCount = candidates.filter((c) => c.active && !c.archived).length;
  const candidatesCount = candidates.filter((c) => !c.archived).length;
  const archivedCount = candidates.filter((c) => c.archived).length;

  const [candidateTab, setCandidateTab] = useState<'candidates' | 'archived'>('candidates');
  useEffect(() => {
    // If the current tab is empty, slide to whichever has content.
    if (candidateTab === 'candidates' && candidatesCount === 0 && archivedCount > 0) {
      setCandidateTab('archived');
    }
  }, [selectedLabel]); // eslint-disable-line react-hooks/exhaustive-deps

  // Sort: active first (so they cluster at the top), then alphabetical by name.
  const sortCandidates = (list: ScannerPolicyCandidate[]) =>
    [...list].sort((a, b) => Number(b.active) - Number(a.active) || a.name.localeCompare(b.name));

  const candidatesInTab = sortCandidates(
    candidates.filter((c) => (candidateTab === 'archived' ? c.archived : !c.archived))
  );

  const handleArchive = (c: ScannerPolicyCandidate) => {
    upsertM.mutate({
      id: c.id,
      name: c.name,
      mode: c.mode,
      label: c.label,
      threshold: c.threshold,
      archived: true,
      active: false,
      policy: c.policy,
      notes: c.notes,
    });
  };

  const handleUnarchive = (c: ScannerPolicyCandidate) => {
    upsertM.mutate({
      id: c.id,
      name: c.name,
      mode: c.mode,
      label: c.label,
      threshold: c.threshold,
      archived: false,
      active: false,
      policy: c.policy,
      notes: c.notes,
    });
  };

  const handleDeletePermanently = (c: ScannerPolicyCandidate) => {
    if (
      !window.confirm(
        `Permanently delete "${c.name}"? Removes the candidate from sysRedis and can't be undone.`
      )
    ) {
      return;
    }
    deleteCandidateM.mutate({ mode, label: c.label, id: c.id });
  };

  const handleRun = (datasetId: string) => {
    if (activeCount === 0) {
      showErrorNotification({
        title: 'No active candidates',
        error: new Error('Toggle at least one candidate active before running.'),
      });
      return;
    }
    setRunState({ phase: 'starting', datasetId });
    startRunM.mutate(
      { datasetId },
      {
        onSuccess: (res) => {
          // Signal will pivot us to 'running' on `phase: 'started'`. The mutation
          // also returns total/runId synchronously which we use as a fallback.
          setRunState((prev) =>
            prev.phase === 'starting' && prev.datasetId === datasetId
              ? {
                  phase: 'running',
                  runId: res.runId,
                  datasetId,
                  processed: 0,
                  total: res.total,
                }
              : prev
          );
          showSuccessNotification({
            message: `Run started — ${res.rowCount} rows × ${res.candidateCount} candidates = ${res.total} scores`,
          });
        },
        onError: (e) => {
          setRunState({ phase: 'error', message: e.message });
          showErrorNotification({ title: 'Run failed to start', error: new Error(e.message) });
        },
      }
    );
  };

  const handleCancelRun = () => {
    if (runState.phase !== 'running') return;
    cancelRunM.mutate({ runId: runState.runId });
    setRunState({
      phase: 'cancelling',
      runId: runState.runId,
      datasetId: runState.datasetId,
      processed: runState.processed,
      total: runState.total,
    });
  };

  const progressPercent =
    runState.phase === 'running' || runState.phase === 'cancelling'
      ? Math.round((runState.processed / Math.max(runState.total, 1)) * 100)
      : 0;
  const datasets = exportsQ.data ?? [];

  if (!user) return null;

  return (
    <>
      <Meta title="Scanner Policies" deIndex />
      <Box p="md" style={{ maxWidth: 1600, margin: '0 auto' }}>
        <Stack gap="md">
          <Group justify="space-between" align="center">
            <Title order={2}>Scanner Policies — Test Bench</Title>
            <SegmentedControl
              value={mode}
              onChange={(v) => setMode(v as ScannerPolicyMode)}
              data={[
                { value: 'prompt', label: 'Prompt mode' },
                { value: 'text', label: 'Text mode' },
              ]}
            />
          </Group>

          {/* System prompt panel */}
          <Card withBorder>
            <Group justify="space-between" mb="xs">
              <Group gap="xs">
                <ActionIcon variant="subtle" onClick={toggleSystemPrompt}>
                  <IconChevronRight
                    size={16}
                    style={{
                      transform: systemPromptOpen ? 'rotate(90deg)' : 'rotate(0)',
                      transition: 'transform 150ms',
                    }}
                  />
                </ActionIcon>
                <Text fw={600}>System prompt ({mode})</Text>
                <Badge color={systemPromptQ.data ? 'orange' : 'gray'} variant="light">
                  {systemPromptQ.data ? 'override active' : 'using live'}
                </Badge>
              </Group>
              <Group gap="xs">
                <Button
                  size="xs"
                  variant="default"
                  disabled={!systemPromptQ.data}
                  onClick={() => setSystemPromptM.mutate({ mode, clear: true })}
                >
                  Reset to live
                </Button>
                <Button
                  size="xs"
                  onClick={() => setSystemPromptM.mutate({ mode, body: systemPromptDraft })}
                  disabled={systemPromptDraft === (systemPromptQ.data ?? '')}
                  loading={setSystemPromptM.isPending}
                >
                  Save override
                </Button>
              </Group>
            </Group>
            <Collapse in={systemPromptOpen}>
              <Textarea
                value={systemPromptDraft}
                onChange={(e) => setSystemPromptDraft(e.currentTarget.value)}
                placeholder="(empty — falls back to the live xguard registry's systemPrompt for this mode)"
                autosize
                minRows={6}
                maxRows={20}
                styles={{ input: { fontFamily: 'ui-monospace, monospace', fontSize: 12 } }}
              />
              <Text size="xs" c="dimmed" mt="xs">
                Snapshotted at the start of each test run — mid-run edits don't shift results.
              </Text>
            </Collapse>
          </Card>

          {/* Two-column: labels + candidates */}
          <Group align="flex-start" wrap="nowrap" grow>
            <Card withBorder style={{ maxWidth: 320, flex: '0 0 320px' }}>
              <Stack gap="xs">
                <Text fw={600}>Labels</Text>
                {labelsQ.isLoading ? (
                  <Loader size="sm" />
                ) : labelsForMode.length === 0 ? (
                  <Text size="sm" c="dimmed">
                    No labels for {mode} mode. Add one below.
                  </Text>
                ) : (
                  <ScrollArea h={400}>
                    <Stack gap={2}>
                      {labelsForMode.map((l) => (
                        <Group
                          key={l.label}
                          justify="space-between"
                          wrap="nowrap"
                          px="xs"
                          py={6}
                          style={{
                            cursor: 'pointer',
                            background:
                              selectedLabel === l.label
                                ? 'var(--mantine-color-blue-light)'
                                : undefined,
                            borderRadius: 4,
                          }}
                          onClick={() => setSelectedLabel(l.label)}
                        >
                          <Text size="sm" fw={selectedLabel === l.label ? 600 : 400} truncate>
                            {l.label}
                          </Text>
                          <Badge size="sm" variant="light" color="gray">
                            {l.candidateCount}
                          </Badge>
                        </Group>
                      ))}
                    </Stack>
                  </ScrollArea>
                )}
                <Group gap="xs">
                  <TextInput
                    value={newLabelName}
                    onChange={(e) => setNewLabelName(e.currentTarget.value)}
                    placeholder="New label name"
                    size="xs"
                    style={{ flex: 1 }}
                  />
                  <Button
                    size="xs"
                    leftSection={<IconPlus size={14} />}
                    onClick={handleAddLabel}
                    disabled={!newLabelName.trim() || upsertM.isPending}
                  >
                    Add
                  </Button>
                </Group>
              </Stack>
            </Card>

            <Card withBorder style={{ flex: 1 }}>
              {!selectedLabel ? (
                <Text c="dimmed">Select a label to view candidates.</Text>
              ) : (
                <Stack gap="md">
                  <Group justify="space-between">
                    <Group gap="xs">
                      <Title order={4}>{selectedLabel}</Title>
                      <Badge variant="light">{candidates.length} candidates</Badge>
                      <Badge variant="light" color={activeCount > 0 ? 'blue' : 'gray'}>
                        {activeCount} active
                      </Badge>
                    </Group>
                    <Group gap="xs">
                      <Button
                        size="xs"
                        leftSection={<IconPlus size={14} />}
                        onClick={handleAddCandidate}
                      >
                        Add candidate
                      </Button>
                      {/* Only surface once we KNOW the label is empty — `isLoading`
                          is true on the initial fetch (before any data), `isFetching` is
                          true on any in-flight refetch (e.g. after switching labels).
                          Hiding during both guards against accidentally clicking
                          "Delete empty label" while candidates are still loading. */}
                      {candidatesQ.isSuccess &&
                        !candidatesQ.isFetching &&
                        candidates.length === 0 && (
                          <Button
                            size="xs"
                            color="red"
                            variant="subtle"
                            leftSection={<IconTrash size={14} />}
                            onClick={() => deleteLabelM.mutate({ mode, label: selectedLabel })}
                            loading={deleteLabelM.isPending}
                          >
                            Delete empty label
                          </Button>
                        )}
                    </Group>
                  </Group>

                  {candidatesQ.isLoading ? (
                    <Loader size="sm" />
                  ) : candidates.length === 0 ? (
                    <Text c="dimmed">No candidates yet. Click "Add candidate" to start.</Text>
                  ) : (
                    <Tabs
                      value={candidateTab}
                      onChange={(v) => setCandidateTab((v as typeof candidateTab) ?? 'candidates')}
                      keepMounted={false}
                    >
                      <Tabs.List>
                        <Tabs.Tab value="candidates">
                          Candidates{' '}
                          <Badge size="xs" variant="light" ml={6}>
                            {candidatesCount}
                          </Badge>
                          {activeCount > 0 && (
                            <Badge size="xs" variant="filled" color="blue" ml={4}>
                              {activeCount} active
                            </Badge>
                          )}
                        </Tabs.Tab>
                        <Tabs.Tab value="archived">
                          Archived{' '}
                          <Badge size="xs" variant="light" color="gray" ml={6}>
                            {archivedCount}
                          </Badge>
                        </Tabs.Tab>
                      </Tabs.List>

                      <Tabs.Panel value={candidateTab} pt="sm">
                        {candidatesInTab.length === 0 ? (
                          <Text size="sm" c="dimmed">
                            No {candidateTab} candidates for this label.
                          </Text>
                        ) : (
                          <Accordion
                            multiple
                            variant="separated"
                            chevronPosition="right"
                            styles={{
                              item: {
                                borderColor: 'var(--mantine-color-gray-3)',
                              },
                              control: { padding: '6px 12px' },
                              content: { padding: '0 12px 12px' },
                            }}
                          >
                            {candidatesInTab.map((c) => (
                              <Accordion.Item key={c.id} value={c.id}>
                                <Group gap="xs" wrap="nowrap" align="center" px="xs">
                                  <Switch
                                    checked={c.active}
                                    disabled={c.archived}
                                    onClick={(e) => e.stopPropagation()}
                                    onChange={(e) =>
                                      setActiveM.mutate({
                                        mode,
                                        label: selectedLabel,
                                        id: c.id,
                                        active: e.currentTarget.checked,
                                      })
                                    }
                                    aria-label={`Toggle ${c.name} active`}
                                  />
                                  <Box style={{ flex: 1, minWidth: 0 }}>
                                    <Accordion.Control style={{ padding: '6px 8px' }}>
                                      <Group gap="xs" wrap="nowrap">
                                        <Text
                                          fw={600}
                                          size="sm"
                                          style={{ flex: 1, minWidth: 0 }}
                                          lineClamp={1}
                                        >
                                          {c.name}
                                        </Text>
                                        <Text size="xs" c="dimmed" w={60} ta="right">
                                          thr {c.threshold}
                                        </Text>
                                      </Group>
                                    </Accordion.Control>
                                  </Box>
                                  {candidateTab === 'archived' ? (
                                    <>
                                      <ActionIcon
                                        variant="subtle"
                                        onClick={(e: MouseEvent) => {
                                          e.stopPropagation();
                                          handleUnarchive(c);
                                        }}
                                        title="Restore (unarchive)"
                                      >
                                        <IconArchive size={14} />
                                      </ActionIcon>
                                      <ActionIcon
                                        variant="subtle"
                                        color="red"
                                        onClick={(e: MouseEvent) => {
                                          e.stopPropagation();
                                          handleDeletePermanently(c);
                                        }}
                                        title="Delete permanently"
                                      >
                                        <IconTrash size={14} />
                                      </ActionIcon>
                                    </>
                                  ) : (
                                    <ActionIcon
                                      variant="subtle"
                                      onClick={(e: MouseEvent) => {
                                        e.stopPropagation();
                                        handleArchive(c);
                                      }}
                                      title="Archive"
                                    >
                                      <IconArchive size={14} />
                                    </ActionIcon>
                                  )}
                                </Group>
                                <Accordion.Panel>
                                  <Stack gap="xs" pt="xs">
                                    {c.notes && (
                                      <Text size="sm">
                                        <Text component="span" fw={600}>
                                          Notes:{' '}
                                        </Text>
                                        {c.notes}
                                      </Text>
                                    )}
                                    <Box>
                                      <Text size="xs" c="dimmed" mb={4}>
                                        Policy text ({c.policy.length} chars)
                                      </Text>
                                      <Code
                                        block
                                        style={{
                                          maxHeight: 260,
                                          overflow: 'auto',
                                          fontSize: 11,
                                          whiteSpace: 'pre-wrap',
                                        }}
                                      >
                                        {c.policy}
                                      </Code>
                                    </Box>
                                    <Group justify="flex-end">
                                      <Button
                                        size="xs"
                                        variant="default"
                                        onClick={() => handleEditCandidate(c)}
                                      >
                                        Open in editor
                                      </Button>
                                    </Group>
                                  </Stack>
                                </Accordion.Panel>
                              </Accordion.Item>
                            ))}
                          </Accordion>
                        )}
                      </Tabs.Panel>
                    </Tabs>
                  )}

                  {draftCandidate && (
                    <Card
                      withBorder
                      bg="light-dark(var(--mantine-color-gray-0), var(--mantine-color-dark-6))"
                    >
                      <Stack gap="sm">
                        <Group justify="space-between">
                          <Text fw={600}>
                            {editingCandidate
                              ? `Editing: ${editingCandidate.name}`
                              : 'New candidate'}
                          </Text>
                          <Button
                            size="xs"
                            variant="subtle"
                            onClick={() => {
                              setEditingCandidate(null);
                              setDraftCandidate(null);
                            }}
                          >
                            Cancel
                          </Button>
                        </Group>
                        <Group grow>
                          <TextInput
                            label="Name"
                            value={draftCandidate.name}
                            onChange={(e) =>
                              setDraftCandidate({
                                ...draftCandidate,
                                name: e.currentTarget.value,
                              })
                            }
                          />
                          <NumberInput
                            label="Threshold"
                            value={draftCandidate.threshold}
                            onChange={(v) =>
                              setDraftCandidate({
                                ...draftCandidate,
                                threshold: typeof v === 'number' ? v : Number(v),
                              })
                            }
                            min={0}
                            max={1}
                            step={0.05}
                            decimalScale={2}
                          />
                        </Group>
                        <Textarea
                          label="Notes"
                          value={draftCandidate.notes}
                          onChange={(e) =>
                            setDraftCandidate({
                              ...draftCandidate,
                              notes: e.currentTarget.value,
                            })
                          }
                          autosize
                          minRows={2}
                          maxRows={4}
                        />
                        <Textarea
                          label="Policy"
                          value={draftCandidate.policy}
                          onChange={(e) =>
                            setDraftCandidate({
                              ...draftCandidate,
                              policy: e.currentTarget.value,
                            })
                          }
                          autosize
                          minRows={10}
                          maxRows={30}
                          styles={{
                            input: { fontFamily: 'ui-monospace, monospace', fontSize: 12 },
                          }}
                        />
                        <Group justify="flex-end">
                          <Button
                            onClick={handleSaveCandidate}
                            disabled={!draftCandidate.name.trim() || !draftCandidate.policy.trim()}
                            loading={upsertM.isPending}
                          >
                            {editingCandidate ? 'Save changes' : 'Create candidate'}
                          </Button>
                        </Group>
                      </Stack>
                    </Card>
                  )}
                </Stack>
              )}
            </Card>
          </Group>

          {/* Dataset list + run controls */}
          {selectedLabel && (
            <Card withBorder>
              <Stack gap="md">
                <Group justify="space-between" align="flex-end">
                  <Group align="flex-end" gap="md">
                    <NumberInput
                      label="Max records"
                      value={exportMax}
                      onChange={(v) => setExportMax(typeof v === 'number' ? v : Number(v))}
                      min={10}
                      max={5000}
                      step={50}
                      style={{ width: 140 }}
                    />
                    <Button
                      leftSection={<IconPlus size={16} />}
                      onClick={handleExportDataset}
                      loading={exporting}
                    >
                      Export new dataset
                    </Button>
                  </Group>
                  <Text size="xs" c="dimmed" style={{ maxWidth: 480 }}>
                    Exports majority-voted moderator verdicts for ({mode}, {selectedLabel}),
                    stratified across TP/FP/TN/FN. Each dataset's workbook lives in S3 — runs score
                    active candidates against it and merge results into the same file.
                  </Text>
                </Group>

                {(runState.phase === 'running' || runState.phase === 'cancelling') && (
                  <Stack gap="xs">
                    <Progress value={progressPercent} striped animated />
                    <Group justify="space-between">
                      <Text size="xs" c="dimmed">
                        {runState.processed} / {runState.total} scored ({progressPercent}%)
                        {runState.phase === 'running' && runState.currentCandidate
                          ? ` — last: ${runState.currentCandidate}`
                          : runState.phase === 'cancelling'
                          ? ' — cancelling…'
                          : ''}
                      </Text>
                      {runState.phase === 'running' && (
                        <Button
                          size="xs"
                          color="red"
                          variant="default"
                          leftSection={<IconPlayerStopFilled size={14} />}
                          onClick={handleCancelRun}
                        >
                          Cancel run
                        </Button>
                      )}
                    </Group>
                  </Stack>
                )}

                {runState.phase === 'error' && (
                  <Alert color="red" title="Run failed">
                    {runState.message}
                  </Alert>
                )}

                <Stack gap="xs">
                  <Text fw={600} size="sm">
                    Datasets for {selectedLabel}
                  </Text>
                  {exportsQ.isLoading ? (
                    <Loader size="sm" />
                  ) : datasets.length === 0 ? (
                    <Text size="sm" c="dimmed">
                      No datasets yet. Click "Export new dataset" to create one.
                    </Text>
                  ) : (
                    <Table withTableBorder fz="sm" verticalSpacing="xs">
                      <Table.Thead>
                        <Table.Tr>
                          <Table.Th>Filename</Table.Th>
                          <Table.Th style={{ width: 90 }}>Rows</Table.Th>
                          <Table.Th style={{ width: 220 }}>Last run</Table.Th>
                          <Table.Th style={{ width: 280 }}></Table.Th>
                        </Table.Tr>
                      </Table.Thead>
                      <Table.Tbody>
                        {datasets.map((d) => {
                          const isThisRunning =
                            (runState.phase === 'starting' && runState.datasetId === d.id) ||
                            (runState.phase === 'running' && runState.datasetId === d.id) ||
                            (runState.phase === 'cancelling' && runState.datasetId === d.id);
                          return (
                            <Table.Tr key={d.id}>
                              <Table.Td>
                                <Text size="sm" truncate style={{ maxWidth: 480 }}>
                                  {d.filename}
                                </Text>
                                <Tooltip label={d.createdAt}>
                                  <Text size="xs" c="dimmed">
                                    created {new Date(d.createdAt).toLocaleString()}
                                  </Text>
                                </Tooltip>
                              </Table.Td>
                              <Table.Td>{d.rowCount}</Table.Td>
                              <Table.Td>
                                {d.lastRunAt ? (
                                  <Stack gap={0}>
                                    <Tooltip label={d.lastRunAt}>
                                      <Text size="xs">
                                        {new Date(d.lastRunAt).toLocaleString()}
                                      </Text>
                                    </Tooltip>
                                    <Text size="xs" c="dimmed">
                                      {d.lastRunCandidateIds?.length ?? 0} candidate
                                      {(d.lastRunCandidateIds?.length ?? 0) === 1 ? '' : 's'}
                                    </Text>
                                  </Stack>
                                ) : (
                                  <Text size="xs" c="dimmed">
                                    no runs yet
                                  </Text>
                                )}
                              </Table.Td>
                              <Table.Td>
                                <Group gap="xs" justify="flex-end" wrap="nowrap">
                                  <ActionIcon
                                    variant="subtle"
                                    color="red"
                                    title="Delete dataset"
                                    onClick={() => {
                                      if (
                                        window.confirm(
                                          `Delete ${d.filename}? This removes the workbook from S3 and the dataset record.`
                                        )
                                      ) {
                                        deleteExportM.mutate({ exportId: d.id });
                                      }
                                    }}
                                    loading={
                                      deleteExportM.isPending &&
                                      deleteExportM.variables?.exportId === d.id
                                    }
                                  >
                                    <IconTrash size={14} />
                                  </ActionIcon>
                                  <Button
                                    size="xs"
                                    variant="subtle"
                                    leftSection={<IconDownload size={14} />}
                                    onClick={() => downloadDataset(d.id)}
                                  >
                                    Download
                                  </Button>
                                  <Button
                                    size="xs"
                                    leftSection={<IconPlayerPlayFilled size={14} />}
                                    onClick={() => handleRun(d.id)}
                                    loading={isThisRunning}
                                    disabled={
                                      activeCount === 0 ||
                                      (runState.phase === 'running' &&
                                        runState.datasetId !== d.id) ||
                                      (runState.phase === 'cancelling' &&
                                        runState.datasetId !== d.id)
                                    }
                                  >
                                    Run tests
                                  </Button>
                                </Group>
                              </Table.Td>
                            </Table.Tr>
                          );
                        })}
                      </Table.Tbody>
                    </Table>
                  )}
                  {activeCount === 0 && datasets.length > 0 && (
                    <Text size="xs" c="orange">
                      Toggle at least one candidate active above to enable "Run tests".
                    </Text>
                  )}
                </Stack>
              </Stack>
            </Card>
          )}
        </Stack>
      </Box>
    </>
  );
}

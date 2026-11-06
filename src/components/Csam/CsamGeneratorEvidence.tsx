import {
  Alert,
  Badge,
  Button,
  Card,
  Checkbox,
  Code,
  Group,
  Loader,
  Stack,
  Text,
  TextInput,
  Title,
} from '@mantine/core';
import { useMemo, useState } from 'react';
import { MAX_FILES_PER_PRESERVE, MAX_WORKFLOWS_PER_PRESERVE } from '~/server/schema/csam.schema';
import { trpc } from '~/utils/trpc';

const STATUS_COLOR: Record<string, string> = {
  preserved: 'green',
  'blocked-unreadable': 'red',
  gone: 'gray',
  unavailable: 'orange',
  external: 'blue',
  excluded: 'dark',
};

function parseCyberTips(value: string) {
  const numbers = value
    .split(/[\s,]+/)
    .filter(Boolean)
    .map(Number);
  return numbers.every((n) => Number.isInteger(n) && n > 0) ? numbers : null;
}

function ArmedConfirmButton({
  label,
  confirmLabel,
  disabled,
  loading,
  onConfirm,
}: {
  label: string;
  confirmLabel: string;
  disabled?: boolean;
  loading?: boolean;
  onConfirm: () => void;
}) {
  const [armed, setArmed] = useState(false);
  if (!armed)
    return (
      <Button disabled={disabled} onClick={() => setArmed(true)}>
        {label}
      </Button>
    );
  return (
    <Group gap="xs">
      <Button
        color="red"
        loading={loading}
        onClick={() => {
          setArmed(false);
          onConfirm();
        }}
      >
        {confirmLabel}
      </Button>
      <Button variant="default" onClick={() => setArmed(false)}>
        Cancel
      </Button>
    </Group>
  );
}

/** A preserved file stays unloaded until a moderator reveals it; loading it records the view. */
function EvidenceFile({
  reportId,
  blobId,
  contentType,
}: {
  reportId: number;
  blobId: string;
  contentType?: string;
}) {
  const [revealed, setRevealed] = useState(false);
  const src = `/api/mod/csam/generator-evidence-file?reportId=${reportId}&blobId=${encodeURIComponent(
    blobId
  )}`;
  if (!revealed)
    return (
      <Card withBorder w={240} h={160} p="xs">
        <Stack h="100%" justify="center" align="center" gap={4}>
          <Text size="xs" c="dimmed" ta="center">
            Hidden. Revealing records your view.
          </Text>
          <Button size="xs" variant="light" onClick={() => setRevealed(true)}>
            Reveal
          </Button>
        </Stack>
      </Card>
    );
  return contentType?.startsWith('video/') ? (
    <video src={src} controls style={{ maxWidth: 360 }} />
  ) : (
    // eslint-disable-next-line @next/next/no-img-element
    <img src={src} alt={blobId} style={{ maxWidth: 360 }} />
  );
}

/** Either action changes what the report sends, so it waits for approval again. */
function FileActions({
  userId,
  reportId,
  blobId,
}: {
  userId: number;
  reportId: number;
  blobId: string;
}) {
  const utils = trpc.useUtils();
  const [reason, setReason] = useState('');
  const [excluding, setExcluding] = useState(false);
  const refresh = () => utils.csam.getGeneratorEvidenceReport.invalidate({ userId });
  const recopy = trpc.csam.recopyGeneratorEvidenceFile.useMutation({ onSuccess: refresh });
  const exclude = trpc.csam.excludeGeneratorEvidenceFile.useMutation({ onSuccess: refresh });
  const error = recopy.error ?? exclude.error;
  const notCopied =
    recopy.data && recopy.data.status !== 'preserved'
      ? `Not copied: ${recopy.data.status}${recopy.data.reason ? `, ${recopy.data.reason}` : ''}`
      : null;

  return (
    <Stack gap={4}>
      <Group gap={4}>
        <Button
          size="compact-xs"
          variant="light"
          loading={recopy.isPending}
          onClick={() => recopy.mutate({ userId, reportId, blobId })}
        >
          Re-copy from generator
        </Button>
        <Button
          size="compact-xs"
          variant="light"
          color="red"
          onClick={() => setExcluding((v) => !v)}
        >
          Exclude from report
        </Button>
      </Group>
      {excluding && (
        <Group gap={4} align="flex-end">
          <TextInput
            size="xs"
            label="Why is this file excluded?"
            value={reason}
            onChange={(e) => setReason(e.currentTarget.value)}
          />
          <Button
            size="xs"
            color="red"
            disabled={reason.trim().length < 3}
            loading={exclude.isPending}
            onClick={() => exclude.mutate({ userId, reportId, blobId, reason })}
          >
            Exclude
          </Button>
        </Group>
      )}
      {notCopied && (
        <Text size="xs" c="orange">
          {notCopied}
        </Text>
      )}
      {error && (
        <Text size="xs" c="red">
          {error.message}
        </Text>
      )}
    </Stack>
  );
}

function PendingReport({ userId }: { userId: number }) {
  const utils = trpc.useUtils();
  const { data: report, isLoading } = trpc.csam.getGeneratorEvidenceReport.useQuery({ userId });
  const [tips, setTips] = useState('');
  const approve = trpc.csam.approveGeneratorEvidence.useMutation({
    onSuccess: () => utils.csam.getGeneratorEvidenceReport.invalidate({ userId }),
  });

  if (isLoading) return <Loader />;
  if (!report)
    return (
      <Text size="sm" c="dimmed">
        No pending generator evidence report for this user.
      </Text>
    );
  const parsedTips = tips.trim() ? parseCyberTips(tips) : [];
  const approved = !!report.meta.approvedAt;

  return (
    <Card withBorder>
      <Stack>
        <Group justify="space-between">
          <Title order={4}>Pending report {report.id}</Title>
          {approved ? (
            <Badge color="green">Approved: queued for sending</Badge>
          ) : (
            <Badge color="yellow">Waiting for approval</Badge>
          )}
        </Group>
        {!!report.meta.priorCTReports?.length && (
          <Text size="sm">Follow-up to CyberTip(s): {report.meta.priorCTReports.join(', ')}</Text>
        )}
        {report.jobs.map((job) => (
          <Card key={job.jobId} withBorder>
            <Stack gap="xs">
              <Text fw={600} size="sm">
                {job.source === 'workflow'
                  ? `Workflow ${job.workflowId}`
                  : `Restriction ${job.restrictionId} trigger`}
                {job.dateTime ? ` · ${job.dateTime}` : ''}
              </Text>
              {job.prompt && (
                <Text size="sm">
                  <b>Prompt:</b> {job.prompt}
                </Text>
              )}
              {job.negativePrompt && (
                <Text size="sm">
                  <b>Negative prompt:</b> {job.negativePrompt}
                </Text>
              )}
              {!!job.resources?.length && (
                <Text size="xs" c="dimmed">
                  Resources: {job.resources.join(', ')}
                </Text>
              )}
              {!job.blobs.length && (
                <Text size="xs" c="dimmed">
                  No file.
                </Text>
              )}
              {job.blobs.map((blob) => (
                <Group key={blob.blobId} align="flex-start">
                  <Stack gap={2} w={280}>
                    <Group gap={4}>
                      <Badge size="xs">{blob.role}</Badge>
                      <Badge size="xs" color={STATUS_COLOR[blob.status] ?? 'gray'}>
                        {blob.status}
                      </Badge>
                      {blob.viewed && (
                        <Badge size="xs" color="grape">
                          viewed
                        </Badge>
                      )}
                    </Group>
                    <Code fz="xs">{blob.blobId}</Code>
                    {blob.sha256 && (
                      <Text size="xs" c="dimmed">
                        sha256 {blob.sha256.slice(0, 16)}… · {blob.bytes} bytes
                      </Text>
                    )}
                    {blob.reason && (
                      <Text size="xs" c="dimmed">
                        {blob.reason}
                      </Text>
                    )}
                    {blob.refreshedAt && (
                      <Text size="xs" c="dimmed">
                        Retention restarted {blob.refreshedAt}
                      </Text>
                    )}
                    {blob.status !== 'external' && blob.status !== 'excluded' && (
                      <FileActions userId={userId} reportId={report.id} blobId={blob.blobId} />
                    )}
                  </Stack>
                  {blob.status === 'preserved' && (
                    <EvidenceFile
                      reportId={report.id}
                      blobId={blob.blobId}
                      contentType={blob.contentType}
                    />
                  )}
                </Group>
              ))}
            </Stack>
          </Card>
        ))}
        {!approved && (
          <Stack gap="xs">
            <TextInput
              label="Prior CyberTip number(s)"
              description="A report already filed on this user, so this one is sent as its follow-up."
              placeholder={report.meta.priorCTReports?.join(', ') ?? 'e.g. 123456789'}
              value={tips}
              onChange={(e) => setTips(e.currentTarget.value)}
              error={parsedTips === null ? 'Numbers only, separated by commas' : undefined}
            />
            {report.sendProblem && <Alert color="red">{report.sendProblem}</Alert>}
            {approve.error && <Alert color="red">{approve.error.message}</Alert>}
            <ArmedConfirmButton
              label="Approve for sending"
              confirmLabel="Confirm: send this report to NCMEC"
              disabled={parsedTips === null || !!report.sendProblem}
              loading={approve.isPending}
              onConfirm={() =>
                approve.mutate({
                  userId,
                  reportId: report.id,
                  version: report.version,
                  priorCTReports: parsedTips?.length ? parsedTips : undefined,
                })
              }
            />
          </Stack>
        )}
      </Stack>
    </Card>
  );
}

function AddEvidence({
  userId,
  preselectRestrictionId,
}: {
  userId: number;
  preselectRestrictionId?: number;
}) {
  const utils = trpc.useUtils();
  const triggersQuery = trpc.csam.getGeneratorEvidenceTriggers.useQuery({ userId });
  const [cursor, setCursor] = useState<string>();
  const workflowsQuery = trpc.csam.getGeneratorEvidenceWorkflows.useQuery({ userId, cursor });
  const [pickedTriggers, setPickedTriggers] = useState<Set<string> | null>(null);
  // Each picked workflow keeps its file count: the page that listed it may no longer be loaded.
  const [pickedWorkflows, setPickedWorkflows] = useState<Map<string, number>>(new Map());
  const [tips, setTips] = useState('');
  const [manifestKey, setManifestKey] = useState('');
  const preserve = trpc.csam.preserveGeneratorEvidence.useMutation({
    onSuccess: () => {
      setPickedWorkflows(new Map());
      setPickedTriggers(new Set());
      void utils.csam.getGeneratorEvidenceReport.invalidate({ userId });
    },
  });

  const defaultTriggers = useMemo(
    () =>
      new Set(
        (triggersQuery.data ?? [])
          .filter((r) => r.restrictionId === preselectRestrictionId)
          .flatMap((r) => r.triggers.map((t) => `${r.restrictionId}:${t.index}`))
      ),
    [triggersQuery.data, preselectRestrictionId]
  );
  const triggers = pickedTriggers ?? defaultTriggers;
  const toggle = (set: Set<string>, key: string) => {
    const next = new Set(set);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    return next;
  };
  const parsedTips = tips.trim() ? parseCyberTips(tips) : [];
  const manifest = manifestKey.trim();
  const count = triggers.size + pickedWorkflows.size;
  const triggerFiles = new Map<string, number>(
    (triggersQuery.data ?? []).flatMap((r) =>
      r.triggers.map((t): [string, number] => [`${r.restrictionId}:${t.index}`, t.inputCount])
    )
  );
  const fileCount =
    [...pickedWorkflows.values()].reduce((n, files) => n + files, 0) +
    [...triggers].reduce((n, key) => n + (triggerFiles.get(key) ?? 0), 0);
  const tooManyFiles = fileCount > MAX_FILES_PER_PRESERVE;

  return (
    <Card withBorder>
      <Stack>
        <Title order={4}>Add generator evidence</Title>
        <Text size="sm" c="dimmed">
          Each file is copied to the evidence store and checked before it is added to the
          user&apos;s pending report. Nothing is shown here; review the files in the report above.
        </Text>

        <Text fw={600}>Generation restriction triggers</Text>
        {triggersQuery.isLoading && <Loader size="sm" />}
        {triggersQuery.error && <Alert color="red">{triggersQuery.error.message}</Alert>}
        {triggersQuery.data?.length === 0 && (
          <Text size="sm" c="dimmed">
            No generation restriction for this user.
          </Text>
        )}
        {triggersQuery.data?.map((restriction) => (
          <Stack key={restriction.restrictionId} gap={4}>
            <Text size="sm">
              Restriction {restriction.restrictionId} · {restriction.status}
            </Text>
            {restriction.triggers.map((trigger) => {
              const key = `${restriction.restrictionId}:${trigger.index}`;
              return (
                <Checkbox
                  key={key}
                  checked={triggers.has(key)}
                  onChange={() => setPickedTriggers(toggle(triggers, key))}
                  label={
                    <Text size="sm" lineClamp={2}>
                      {trigger.time ? `${trigger.time} · ` : ''}
                      {trigger.inputCount} input file(s) · {trigger.prompt ?? '(no prompt)'}
                    </Text>
                  }
                />
              );
            })}
          </Stack>
        ))}

        <Text fw={600}>Workflows</Text>
        {workflowsQuery.isLoading && <Loader size="sm" />}
        {workflowsQuery.error && <Alert color="red">{workflowsQuery.error.message}</Alert>}
        {workflowsQuery.data?.workflows.map((workflow) => (
          <Checkbox
            key={workflow.workflowId}
            checked={pickedWorkflows.has(workflow.workflowId)}
            onChange={() => {
              const next = new Map(pickedWorkflows);
              if (!next.delete(workflow.workflowId))
                next.set(workflow.workflowId, workflow.inputs + workflow.outputs);
              setPickedWorkflows(next);
            }}
            label={
              <Text size="sm" lineClamp={2}>
                {workflow.createdAt ?? workflow.workflowId} · inputs {workflow.inputs} · outputs{' '}
                {workflow.outputs} · withheld {workflow.withheld} · {workflow.prompt ?? ''}
              </Text>
            }
          />
        ))}
        {workflowsQuery.data?.next && (
          <Button variant="subtle" onClick={() => setCursor(workflowsQuery.data?.next)}>
            Older workflows
          </Button>
        )}

        <TextInput
          label="Preserve run manifest (optional)"
          description="The key of a manifest an earlier preserve run wrote for this user. Its workflows and triggers are added, and its copies used once they read back as recorded."
          value={manifestKey}
          onChange={(e) => setManifestKey(e.currentTarget.value)}
        />
        <TextInput
          label="Prior CyberTip number(s)"
          description="Optional. A report already filed on this user."
          value={tips}
          onChange={(e) => setTips(e.currentTarget.value)}
          error={parsedTips === null ? 'Numbers only, separated by commas' : undefined}
        />
        {pickedWorkflows.size > MAX_WORKFLOWS_PER_PRESERVE && (
          <Alert color="yellow">
            {pickedWorkflows.size} workflows picked; preserve at most {MAX_WORKFLOWS_PER_PRESERVE}{' '}
            at once.
          </Alert>
        )}
        {tooManyFiles && (
          <Alert color="yellow">
            {fileCount} files picked; at most {MAX_FILES_PER_PRESERVE} can be preserved at once.
            Pick fewer workflows or triggers.
          </Alert>
        )}
        {preserve.error && <Alert color="red">{preserve.error.message}</Alert>}
        {preserve.data && (
          <Alert color={preserve.data.reportId ? 'green' : 'yellow'}>
            {preserve.data.reportId
              ? `Added to report ${preserve.data.reportId}: `
              : 'Nothing was added: '}
            {Object.entries(preserve.data.counts)
              .map(([status, n]) => `${n} ${status}`)
              .join(', ') || 'no file'}
            {preserve.data.refused.length > 0 &&
              `. Refused: ${preserve.data.refused.map((r) => `${r.ref} (${r.reason})`).join('; ')}`}
          </Alert>
        )}
        <ArmedConfirmButton
          label={`Preserve and add ${count} item(s)${
            manifest ? ' and the manifest' : ''
          } to the report`}
          confirmLabel={`Confirm: preserve ${count} item(s)${manifest ? ' and the manifest' : ''}`}
          disabled={
            (count === 0 && !manifest) ||
            parsedTips === null ||
            pickedWorkflows.size > MAX_WORKFLOWS_PER_PRESERVE ||
            tooManyFiles
          }
          loading={preserve.isPending}
          onConfirm={() =>
            preserve.mutate({
              userId,
              workflowIds: [...pickedWorkflows.keys()],
              triggers: [...triggers].map((key) => {
                const [restrictionId, index] = key.split(':').map(Number);
                return { restrictionId, index };
              }),
              priorCTReports: parsedTips?.length ? parsedTips : undefined,
              manifestKey: manifest || undefined,
            })
          }
        />
      </Stack>
    </Card>
  );
}

export function CsamGeneratorEvidence({
  userId,
  preselectRestrictionId,
}: {
  userId: number;
  preselectRestrictionId?: number;
}) {
  return (
    <Stack>
      <PendingReport userId={userId} />
      <AddEvidence userId={userId} preselectRestrictionId={preselectRestrictionId} />
    </Stack>
  );
}

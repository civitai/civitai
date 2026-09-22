import { Loader, Progress, Text } from '@mantine/core';
import { useEffect, useRef } from 'react';
import type { Icon } from '@tabler/icons-react';
import { IconClock, IconGauge, IconUsers } from '@tabler/icons-react';
import { create } from 'zustand';
import { BuzzTransactionButton } from '~/components/Buzz/BuzzTransactionButton';
import { useBoostWorkflow } from '~/components/ImageGeneration/utils/generationRequestHooks';
import { formatDownloadEtaShort } from '~/components/ResourceLoad/download-eta';
import {
  BOOST_LANE_LABEL,
  DownloadLanesInfo,
  downloadLaneLabel,
  formatLaneSpeed,
} from '~/components/ResourceLoad/download-lanes';
import { DownloadEtaCompare } from '~/components/ResourceLoad/DownloadEtaCompare';
import {
  buildDownloadRows,
  describeDownload,
  downloadPollIds,
  isAwaitingDownload,
  isWorthBoosting,
  toDownloadRow,
  summarizeDownloads,
  type DownloadSummary,
} from '~/components/ImageGeneration/download-status';
import type { WorkflowData } from '~/server/services/orchestrator';
import { numberWithCommas } from '~/utils/number-helpers';
import { showErrorNotification, showWarningNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';

const DOWNLOAD_STATUS_POLL_MS = 10_000;

/**
 * The unboosted ETA at the moment of purchase, by workflow id. Once boosted the orchestrator no
 * longer reports what the wait would have been, so the receipt only survives this page session.
 */
const useBoostReceipts = create<Record<string, number>>(() => ({}));

export type WorkflowDownloads = ReturnType<typeof useWorkflowDownloads>;

/**
 * A pending generation's downloads. The workflow's own `preparation` — on the submit reply, the
 * list and step events — says which lane it is in and where; live model status is polled only
 * while a download is involved, for progress and for when a model lands.
 */
export function useWorkflowDownloads({
  request,
  enabled,
}: {
  request: WorkflowData;
  enabled: boolean;
}) {
  const preparation = request.steps.find((s) => s.preparation)?.preparation;
  const preparing = request.steps.some((s) => s.status === 'preparing');
  const modelVersionIds = downloadPollIds(
    request.resources.map((r) => r.id),
    preparation
  );
  const { data } = trpc.resourceLoad.getDownloadStatus.useQuery(
    { modelVersionIds },
    {
      enabled: enabled && isAwaitingDownload(preparation, preparing) && modelVersionIds.length > 0,
      // Stops on its own once every model has landed, rather than waiting for the workflow refetch
      // that clears `preparation`.
      refetchInterval: (query) =>
        !query.state.data || query.state.data.some((x) => toDownloadRow(x.availability))
          ? DOWNLOAD_STATUS_POLL_MS
          : false,
    }
  );

  useInvalidateResidencyOnLanding(data);

  const rows = buildDownloadRows({
    resources: request.resources,
    preparation,
    preparing,
    live: data,
  });

  return { rows, summary: summarizeDownloads(rows.map((x) => x.row)) };
}

/**
 * `getDownloadStatus` is uncached, so it sees a model land before the 30s-cached indicator query
 * would. Every batch is invalidated: they are keyed by the ids each caller asked for, so the one
 * holding this version cannot be named.
 */
function useInvalidateResidencyOnLanding(
  live: { modelVersionId: number; availability: { status: string } }[] | undefined
) {
  const utils = trpc.useUtils();
  const landed = useRef(new Set<number>());

  useEffect(() => {
    const fresh = (live ?? [])
      .filter((x) => x.availability.status === 'available')
      .map((x) => x.modelVersionId)
      .filter((id) => !landed.current.has(id));
    if (!fresh.length) return;

    for (const id of fresh) landed.current.add(id);
    void utils.resourceLoad.getResidency.invalidate();
  }, [live, utils]);
}

export function DownloadBoostPanel({
  request,
  downloads: { rows, summary },
}: {
  request: WorkflowData;
  downloads: WorkflowDownloads;
}) {
  const boosted = request.downloadPriority === 'high' || summary?.lane === 'high';
  const offer = !boosted && isWorthBoosting(summary) ? summary : undefined;
  const receiptEta = useBoostReceipts((state) => state[request.id]);
  const laneLabel = downloadLaneLabel(summary?.lane);

  return (
    <div className="overflow-hidden rounded-lg border border-solid border-yellow-5/35 bg-yellow-5/5">
      <div className="flex items-center gap-2 border-b border-solid border-yellow-5/20 px-3 py-2.5">
        <Loader size={12} color="yellow" />
        <Text size="sm">
          {summary?.transferring ? 'Downloading' : 'Waiting on downloads'} —{' '}
          <Text span inherit fw={600}>
            {laneLabel ? `${laneLabel} lane` : 'starting'}
          </Text>
        </Text>
        {/* The Boost button carries its own, with the fee — this is for every other state. */}
        {!offer && (
          <span className="ml-auto">
            <DownloadLanesInfo
              placement={
                summary?.lane
                  ? {
                      lane: summary.lane,
                      queuePosition: summary.queuePosition,
                      transferring: summary.transferring,
                      etaSeconds: summary.etaSeconds,
                      boostedEtaSeconds: summary.boostedEtaSeconds,
                      rateLimitBytesPerSecond: summary.rateLimitBytesPerSecond,
                      totalBytes: summary.totalBytes,
                    }
                  : undefined
              }
            />
          </span>
        )}
      </div>

      {summary && (
        <dl className="m-0 grid grid-cols-3 divide-x divide-solid divide-yellow-5/20">
          <Readout
            icon={IconUsers}
            label="Position"
            value={summary.queuePosition != null ? String(summary.queuePosition + 1) : '—'}
            note={
              summary.transferring
                ? 'transferring'
                : summary.queuePosition != null
                ? 'in this lane'
                : 'not queued yet'
            }
          />
          <Readout
            icon={IconGauge}
            label="Lane speed"
            value={formatLaneSpeed(summary.rateLimitBytesPerSecond) ?? '—'}
            note={summary.rateLimitBytesPerSecond === null ? 'boosted lane' : 'per download'}
          />
          <Readout
            icon={IconClock}
            label="Ready in"
            value={
              summary.etaSeconds != null ? `~${formatDownloadEtaShort(summary.etaSeconds)}` : '—'
            }
            note="best case"
          />
        </dl>
      )}

      {rows.length > 0 && (
        <Section>
          <div className="flex flex-col gap-2">
            {rows.map(({ resource, row }) => (
              <div key={resource.id} className="flex flex-col gap-1">
                <div className="flex items-baseline justify-between gap-3">
                  <Text size="xs" fw={600} className="min-w-0 truncate">
                    {resource.model.name} — {resource.name}
                  </Text>
                  <Text size="xs" c="dimmed" className="whitespace-nowrap tabular-nums">
                    {describeDownload(row)}
                  </Text>
                </div>
                {row.progress != null && (
                  <Progress value={Math.round(row.progress * 100)} color="yellow" size={4} />
                )}
              </div>
            ))}
          </div>
        </Section>
      )}

      {offer && offer.etaSeconds != null && (
        <Section>
          <Text size="xs" mb={8}>
            <Text span inherit fw={600}>
              {offer.lane === 'low' ? 'Skip the free lane.' : 'Skip the queue.'}
            </Text>{' '}
            Boost moves {offer.count === 1 ? 'this download' : `all ${offer.count} downloads`} into{' '}
            {BOOST_LANE_LABEL}.
          </Text>
          <DownloadEtaCompare
            etaSeconds={offer.etaSeconds}
            boostedEtaSeconds={offer.boostedEtaSeconds}
          />
        </Section>
      )}

      {boosted && (
        <Section>
          <Text size="xs" mb={receiptEta != null && summary?.etaSeconds != null ? 8 : 0}>
            <Text span inherit fw={600}>
              Boosted.
            </Text>{' '}
            {summary && summary.count > 1
              ? `All ${summary.count} downloads moved into ${BOOST_LANE_LABEL}.`
              : `Moved into ${BOOST_LANE_LABEL}.`}
          </Text>
          {receiptEta != null && summary?.etaSeconds != null && (
            <DownloadEtaCompare
              etaSeconds={receiptEta}
              boostedEtaSeconds={summary.etaSeconds}
              beforeLabel="Would have been"
              afterLabel="Ready in"
              struck
            />
          )}
        </Section>
      )}

      {offer && <BoostButton request={request} summary={offer} />}
    </div>
  );
}

function BoostButton({ request, summary }: { request: WorkflowData; summary: DownloadSummary }) {
  const { data: boostCost, isLoading: costLoading } = trpc.orchestrator.getBoostCost.useQuery(
    { workflowId: request.id },
    { staleTime: 30_000 }
  );
  const cost = boostCost?.cost;
  const { mutate, isPending } = useBoostWorkflow();

  function handleBoost() {
    if (isPending || cost == null) return;
    const unboostedEta = summary.etaSeconds;
    // `expectedCost` is the price on the button; the server refuses if it has moved.
    mutate(
      { workflowId: request.id, expectedCost: cost },
      {
        onSuccess: (result) => {
          if (result.boosted) {
            if (unboostedEta != null) useBoostReceipts.setState({ [request.id]: unboostedEta });
            return;
          }
          if (result.cost == null) {
            showErrorNotification({
              title: 'Nothing left to boost',
              error: new Error('This generation is no longer waiting on a download.'),
            });
            return;
          }
          showWarningNotification({
            title: 'The boost price changed',
            message: `It now costs ${numberWithCommas(result.cost)} Buzz. Press Boost again.`,
          });
        },
      }
    );
  }

  return (
    <Section>
      <div className="flex items-center gap-2">
        <BuzzTransactionButton
          className="flex-1"
          size="sm"
          label="Boost this download"
          buzzAmount={cost ?? 0}
          loading={costLoading || isPending}
          disabled={cost == null}
          message={(required) =>
            `You don't have enough Buzz to boost this download. Required Buzz: ${numberWithCommas(
              required
            )}. Buy more Buzz to perform this action.`
          }
          onPerformTransaction={handleBoost}
        />
        {summary.lane && (
          <DownloadLanesInfo
            placement={{
              lane: summary.lane,
              queuePosition: summary.queuePosition,
              transferring: summary.transferring,
              etaSeconds: summary.etaSeconds,
              boostedEtaSeconds: summary.boostedEtaSeconds,
              rateLimitBytesPerSecond: summary.rateLimitBytesPerSecond,
              totalBytes: summary.totalBytes,
              boostFee: cost,
            }}
          />
        )}
      </div>
      {!costLoading && cost == null && (
        <Text size="xs" c="red" mt={4}>
          Couldn&apos;t price this boost right now. Try again in a moment.
        </Text>
      )}
    </Section>
  );
}

function Section({ children }: { children: React.ReactNode }) {
  return <div className="border-t border-solid border-yellow-5/20 px-3 py-2.5">{children}</div>;
}

function Readout({
  icon: ReadoutIcon,
  label,
  value,
  note,
}: {
  icon: Icon;
  label: string;
  value: string;
  note: string;
}) {
  return (
    <div className="px-3 py-2.5">
      <dt className="text-dimmed mb-0.5 flex items-center gap-1 text-[9.5px] font-bold uppercase tracking-wider">
        <ReadoutIcon size={12} /> {label}
      </dt>
      <dd className="m-0 text-sm font-semibold tabular-nums">
        {value}
        <small className="text-dimmed block text-[10.5px] font-normal">{note}</small>
      </dd>
    </div>
  );
}

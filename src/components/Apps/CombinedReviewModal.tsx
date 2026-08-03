import { Badge, Divider, Group, Modal, Stack, Text, ThemeIcon } from '@mantine/core';
import { IconCode, IconPhoto } from '@tabler/icons-react';
import { useRef } from 'react';
import { OnsiteReviewModalBody, type AnyRequest } from '~/components/Apps/OnsiteReviewModal';
import { OffsiteReviewModalBody, type OffsitePendingRow } from '~/components/Apps/OffsiteReviewQueue';
import type { CombinedReviewPayload } from '~/components/Apps/unifiedReviewRow';

/**
 * App Blocks mod review — the COMBINED code + listing-media review surface. When an
 * app has BOTH a pending on-site CODE request AND a pending on-site listing-MEDIA
 * revision, the unified queue collapses them into one row (`mergeReviewRows`) that
 * opens THIS surface: ONE modal, two STACKED sections —
 *   A) App code review — reuses `OnsiteReviewModalBody` (the ReportTabs report +
 *      bundle/diff + its OWN approve/reject via the `blocks.*` procs);
 *   B) Listing media — reuses `OffsiteReviewModalBody` (the listing preview +
 *      assets + scan status + its OWN approve/reject via the `appListings.*` procs).
 *
 * 🔴 INDEPENDENT approve/reject (locked): each section keeps its own approve/reject
 * wired to its own existing request/proc — there is NO joint approve and NO server
 * coordination. A mod can approve the media while holding the code, or vice-versa;
 * approving one NEVER triggers the other's mutation. (Deciding either section closes
 * the modal + refreshes the queue; the still-pending side reappears as its own single
 * row for a follow-up decision.)
 *
 * Front-end only: this is presentation/composition — it reuses the two existing
 * bodies + their existing procs unchanged.
 */

export type CombinedReviewSelection =
  | (CombinedReviewPayload & { onActioned?: () => void | Promise<void> })
  | null;

function SectionHeader({ icon, title }: { icon: React.ReactNode; title: string }) {
  return (
    <Group gap={8}>
      <ThemeIcon size="sm" variant="light" color="indigo" radius="sm">
        {icon}
      </ThemeIcon>
      <Text fw={700} size="sm">
        {title}
      </Text>
    </Group>
  );
}

export function CombinedReviewModal({
  selection,
  onClose,
}: {
  selection: CombinedReviewSelection;
  onClose: () => void;
}) {
  // Each section publishes its in-flight state; the shell refuses to close while
  // EITHER mutation is running.
  const busyCode = useRef(false);
  const busyMedia = useRef(false);

  const onsiteRequest: AnyRequest | undefined = selection?.onsiteRequest;
  const listingRow: OffsitePendingRow | undefined = selection?.listingRow;

  return (
    <Modal
      opened={!!selection}
      onClose={() => {
        if (busyCode.current || busyMedia.current) return;
        onClose();
      }}
      title={
        selection ? (
          <Group gap={6}>
            <Text fw={600}>{selection.onsiteRequest.slug}</Text>
            <Badge color="indigo" size="sm" variant="light" data-testid="combined-review-kind-badge">
              App + media
            </Badge>
          </Group>
        ) : null
      }
      size="xl"
      centered
    >
      {selection && onsiteRequest && listingRow && (
        <Stack gap="xl">
          <Stack gap="sm" data-testid="combined-review-code-section">
            <SectionHeader icon={<IconCode size={14} />} title="App code review" />
            <OnsiteReviewModalBody
              key={`code-${onsiteRequest.id}`}
              selection={{ request: onsiteRequest, mode: 'pending' }}
              onClose={onClose}
              onActioned={selection.onActioned}
              busyRef={busyCode}
            />
          </Stack>

          <Divider />

          <Stack gap="sm" data-testid="combined-review-media-section">
            <SectionHeader icon={<IconPhoto size={14} />} title="Listing media" />
            <OffsiteReviewModalBody
              key={`media-${listingRow.id}`}
              request={listingRow}
              onClose={onClose}
              onActioned={selection.onActioned}
              busyRef={busyMedia}
            />
          </Stack>
        </Stack>
      )}
    </Modal>
  );
}

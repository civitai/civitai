import {
  Anchor,
  Badge,
  Button,
  Checkbox,
  FileButton,
  Group,
  Paper,
  Stack,
  Text,
} from '@mantine/core';
import { IconDownload, IconTrash, IconUpload } from '@tabler/icons-react';
import { useRef, useState } from 'react';
import {
  attachmentSlotsLeft,
  attachmentStatus,
  canAttachInStatus,
  serviceDealDownloadHref,
  sortPicked,
} from '~/components/CreatorShop/Services/deals/deal-files';
import type { ServiceDealView } from '~/components/CreatorShop/Services/deals/deal.util';
import { useServiceDealFiles } from '~/components/CreatorShop/Services/deals/DealFilesPanel';
import { useDealFileUploads } from '~/components/CreatorShop/Services/deals/useDealFileUploads';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import type { RouterOutput } from '~/types/router';
import { formatBytes } from '~/utils/number-helpers';
import { showErrorNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';

type DealFile = RouterOutput['creatorServiceDealFile']['list'][number];

export const ATTESTATION_RIGHTS =
  'I have the rights to share these files with this creator for this request.';
export const ATTESTATION_LIKENESS =
  'Any real person shown in these files has consented to their likeness being used for this request, and no one shown is under 18.';

/**
 * Files the buyer gives the seller for the work. The buyer attaches them from the request until
 * the seller delivers; the seller sees one only once it has passed its checks (the server decides,
 * this panel only shows what the list returns).
 */
export function DealAttachmentsPanel({ deal }: { deal: ServiceDealView }) {
  const { data = [], isLoading } = useServiceDealFiles(deal);
  const features = useFeatureFlags();
  const attachments = data.filter((file) => file.kind === 'Attachment');
  const isBuyer = deal.viewerRole === 'buyer';
  const canAttach =
    isBuyer &&
    canAttachInStatus(deal.status) &&
    !!features.creatorServices &&
    !!features.creatorServicesAttachments;

  if (isLoading) return null;
  if (attachments.length === 0 && !canAttach) return null;

  return (
    <Paper withBorder radius="md" p="md">
      <Stack gap="md">
        <Text fw={600}>{isBuyer ? 'Your files for the creator' : 'Files from the buyer'}</Text>
        {canAttach && <AttachStep deal={deal} attachments={attachments} />}
        <AttachmentList
          dealId={deal.id}
          attachments={attachments}
          canEdit={canAttach}
          isBuyer={isBuyer}
          showStatus={deal.viewerRole !== 'seller'}
        />
      </Stack>
    </Paper>
  );
}

function AttachStep({ deal, attachments }: { deal: ServiceDealView; attachments: DealFile[] }) {
  const utils = trpc.useUtils();
  const [rights, setRights] = useState(false);
  const [likeness, setLikeness] = useState(false);
  const reset = useRef<() => void>(null);
  const requestAttachment = trpc.creatorServiceDealFile.requestAttachment.useMutation();
  const completeAttachment = trpc.creatorServiceDealFile.completeAttachment.useMutation();
  const refresh = () => utils.creatorServiceDealFile.list.invalidate({ dealId: deal.id });
  const { busy, send: sendFiles } = useDealFileUploads({
    verb: 'attach',
    complete: (fileId) => completeAttachment.mutateAsync({ fileId }),
    refresh,
  });

  const slots = attachmentSlotsLeft(attachments);
  const attested = rights && likeness;

  const attach = async (picked: File[]) => {
    reset.current?.();
    if (!attested) return;
    const { send, refused, overflow } = sortPicked('Attachment', picked, slots);
    for (const { name, reason } of refused)
      showErrorNotification({ title: `Can't attach ${name}`, error: { message: reason } });
    if (overflow > 0)
      showErrorNotification({
        title: 'Too many files',
        error: {
          message: `${overflow} ${
            overflow === 1 ? 'file was' : 'files were'
          } left out: only ${slots} more ${slots === 1 ? 'file fits' : 'files fit'}.`,
        },
      });
    await sendFiles(send, (file, mimeType) =>
      requestAttachment.mutateAsync({
        dealId: deal.id,
        fileName: file.name,
        mimeType,
        size: file.size,
        rightsAttested: true,
        likenessAttested: true,
      })
    );
  };

  return (
    <Stack gap="sm">
      <Text size="sm" c="dimmed">
        Share files the creator needs for this request, such as a dataset or references. Every file
        is checked before the creator can see it. Images rated above this request&apos;s content
        level, and anything else the check rejects, are not accepted and never reach the creator.
        You can attach files until the creator delivers.
      </Text>
      <Checkbox
        size="sm"
        label={ATTESTATION_RIGHTS}
        checked={rights}
        onChange={(event) => setRights(event.currentTarget.checked)}
      />
      <Checkbox
        size="sm"
        label={ATTESTATION_LIKENESS}
        checked={likeness}
        onChange={(event) => setLikeness(event.currentTarget.checked)}
      />
      <Group gap="sm">
        <FileButton onChange={attach} resetRef={reset} multiple>
          {(props) => (
            <Button
              {...props}
              variant="light"
              leftSection={<IconUpload size={16} />}
              disabled={!attested || slots === 0}
            >
              Attach files
            </Button>
          )}
        </FileButton>
      </Group>
      {busy.length > 0 && (
        <Text size="sm" c="dimmed">
          Uploading {busy.map((item) => item.name).join(', ')}…
        </Text>
      )}
    </Stack>
  );
}

function AttachmentList({
  dealId,
  attachments,
  canEdit,
  isBuyer,
  showStatus,
}: {
  dealId: number;
  attachments: DealFile[];
  canEdit: boolean;
  isBuyer: boolean;
  /** The seller only ever receives files that passed, so a status would tell them nothing. */
  showStatus: boolean;
}) {
  const utils = trpc.useUtils();
  const refresh = () => utils.creatorServiceDealFile.list.invalidate({ dealId });
  const deleteAttachment = trpc.creatorServiceDealFile.deleteAttachment.useMutation({
    onSuccess: refresh,
    onError: (error) => showErrorNotification({ title: 'Could not remove the file', error }),
  });
  const completeAttachment = trpc.creatorServiceDealFile.completeAttachment.useMutation({
    onSuccess: refresh,
    onError: (error) => showErrorNotification({ title: 'Upload not finished', error }),
  });

  if (attachments.length === 0)
    return (
      <Text size="sm" c="dimmed">
        {isBuyer ? 'No files attached.' : 'No files shared yet.'}
      </Text>
    );

  return (
    <Stack gap="xs">
      {attachments.map((file) => {
        const status = attachmentStatus(file);
        return (
          <Stack key={file.id} gap={4}>
            <Group gap="sm" wrap="nowrap" justify="space-between">
              <Group gap="xs" wrap="nowrap" className="min-w-0">
                <Text size="sm" className="truncate">
                  {file.fileName}
                </Text>
                <Text size="xs" c="dimmed">
                  {formatBytes(file.size)}
                </Text>
              </Group>
              <Group gap="xs" wrap="nowrap">
                {showStatus && (
                  <Badge size="sm" variant="light" color={status.color}>
                    {status.label}
                  </Badge>
                )}
                {file.canDownload && (
                  <Anchor
                    href={serviceDealDownloadHref(file.id)}
                    size="sm"
                    aria-label={`Download ${file.fileName}`}
                  >
                    <IconDownload size={16} />
                  </Anchor>
                )}
                {canEdit && file.status === 'Uploading' && (
                  <Button
                    size="compact-xs"
                    variant="subtle"
                    loading={
                      completeAttachment.isPending &&
                      completeAttachment.variables?.fileId === file.id
                    }
                    onClick={() => completeAttachment.mutate({ fileId: file.id })}
                  >
                    Check upload
                  </Button>
                )}
                {canEdit && (
                  <Button
                    size="compact-xs"
                    variant="subtle"
                    color="red"
                    aria-label={`Remove ${file.fileName}`}
                    onClick={() => deleteAttachment.mutate({ fileId: file.id })}
                  >
                    <IconTrash size={14} />
                  </Button>
                )}
              </Group>
            </Group>
            {showStatus && file.failReason && (
              <Text size="xs" c="red">
                {file.failReason}
              </Text>
            )}
          </Stack>
        );
      })}
    </Stack>
  );
}

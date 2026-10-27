import {
  Anchor,
  Badge,
  Button,
  FileButton,
  Group,
  Image,
  Loader,
  Paper,
  SimpleGrid,
  Stack,
  Text,
} from '@mantine/core';
import { IconDownload, IconTrash, IconUpload } from '@tabler/icons-react';
import { useRef, useState } from 'react';
import { roundLabel } from '~/components/CreatorShop/Services/deals/deal-ui';
import {
  buyerRoundFinalsState,
  deliverWait,
  filesByRound,
  filesPollMs,
  finalsCopy,
  sellerFileStatus,
  serviceDealDownloadHref,
  sortPicked,
  uploadSlotsLeft,
} from '~/components/CreatorShop/Services/deals/deal-files';
import { DEAL_FRESHNESS } from '~/components/CreatorShop/Services/deals/deal.util';
import type { ServiceDealView } from '~/components/CreatorShop/Services/deals/deal.util';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import type { ServiceDealFileKind } from '~/shared/utils/prisma/enums';
import type { RouterOutput } from '~/types/router';
import { formatBytes } from '~/utils/number-helpers';
import { showErrorNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';

type DealFile = RouterOutput['creatorServiceDealFile']['list'][number];

export function useServiceDealFiles(deal: ServiceDealView) {
  return trpc.creatorServiceDealFile.list.useQuery(
    { dealId: deal.id },
    {
      enabled: deal.id > 0,
      retry: false,
      ...DEAL_FRESHNESS,
      refetchInterval: (query) => filesPollMs(query.state.data ?? [], deal),
    }
  );
}

export function DealFilesPanel({ deal }: { deal: ServiceDealView }) {
  const { data: files = [], isLoading } = useServiceDealFiles(deal);
  const features = useFeatureFlags();
  const working = deal.status === 'Accepted' || deal.status === 'InRevision';
  const canUpload = deal.viewerRole === 'seller' && working && !!features.creatorServices;

  if (isLoading) return null;
  if (files.length === 0 && !canUpload) return null;

  return (
    <Paper withBorder radius="md" p="md">
      <Stack gap="md">
        <Text fw={600}>Delivery</Text>
        {canUpload && <SellerUploader deal={deal} files={files} />}
        {deal.viewerRole === 'buyer' ? (
          <BuyerFiles deal={deal} files={files} />
        ) : (
          <PartyFiles
            dealId={deal.id}
            files={files}
            canEdit={canUpload}
            currentRound={deal.revisionsUsed}
          />
        )}
      </Stack>
    </Paper>
  );
}

function SellerUploader({ deal, files }: { deal: ServiceDealView; files: DealFile[] }) {
  const utils = trpc.useUtils();
  // Keyed per upload, not by name: two picks of the same name must not clear each other.
  const [busy, setBusy] = useState<{ key: number; name: string }[]>([]);
  const nextKey = useRef(0);
  const resetPreview = useRef<() => void>(null);
  const resetFinal = useRef<() => void>(null);
  const requestUpload = trpc.creatorServiceDealFile.requestUpload.useMutation();
  const completeUpload = trpc.creatorServiceDealFile.completeUpload.useMutation();
  const refreshFiles = () => utils.creatorServiceDealFile.list.invalidate({ dealId: deal.id });
  const deliver = trpc.creatorServiceDealFile.deliver.useMutation({
    onSuccess: async () => {
      await Promise.all([
        refreshFiles(),
        utils.creatorServiceDeal.get.invalidate({ id: deal.id }),
        utils.creatorServiceDeal.listMine.invalidate(),
      ]);
    },
    // The server says what is missing (a preview still being prepared, no final file yet).
    onError: (error) => showErrorNotification({ title: 'Not ready to deliver', error }),
  });

  const round = deal.revisionsUsed;
  const upload = async (kind: ServiceDealFileKind, picked: File[]) => {
    // So the same file can be picked again after a failed attempt.
    (kind === 'Preview' ? resetPreview : resetFinal).current?.();
    const slots = uploadSlotsLeft(kind, deal.previewKind, files, round);
    const { send, refused, overflow } = sortPicked(kind, picked, slots);
    for (const { name, reason } of refused)
      showErrorNotification({ title: `Can't upload ${name}`, error: { message: reason } });
    if (overflow > 0)
      showErrorNotification({
        title: 'Too many files',
        error: {
          message: `${overflow} ${
            overflow === 1 ? 'file was' : 'files were'
          } left out: only ${slots} more ${kind === 'Preview' ? 'preview' : 'file'}${
            slots === 1 ? '' : 's'
          } fit.`,
        },
      });
    for (const file of send) {
      const key = nextKey.current++;
      setBusy((items) => [...items, { key, name: file.name }]);
      try {
        const mimeType = file.type || 'application/octet-stream';
        const { fileId, uploadUrl } = await requestUpload.mutateAsync({
          dealId: deal.id,
          kind,
          fileName: file.name,
          mimeType,
          size: file.size,
        });
        const put = await fetch(uploadUrl, {
          method: 'PUT',
          body: file,
          headers: { 'Content-Type': mimeType },
        });
        if (!put.ok) throw new Error('The upload did not go through. Try again.');
        await completeUpload.mutateAsync({ fileId });
      } catch (error) {
        showErrorNotification({
          title: `Couldn't upload ${file.name}`,
          error: error instanceof Error ? error : { message: String(error) },
        });
      } finally {
        setBusy((items) => items.filter((item) => item.key !== key));
        await refreshFiles();
      }
    }
  };

  const previewSlots = uploadSlotsLeft('Preview', deal.previewKind, files, round);
  const finalSlots = uploadSlotsLeft('Final', deal.previewKind, files, round);
  const takesPreview = deal.previewKind !== 'None';
  const waiting = deliverWait(files, round);

  return (
    <Stack gap="sm">
      <Text size="sm" c="dimmed">
        {takesPreview
          ? 'Upload a preview and your final files. The buyer sees a low-resolution, watermarked copy of the preview. The final files stay sealed until they accept.'
          : 'Upload your final files. They stay sealed until the buyer accepts.'}
      </Text>
      <Group gap="sm">
        {takesPreview && (
          <FileButton
            onChange={(picked) => upload('Preview', picked)}
            resetRef={resetPreview}
            accept="image/jpeg,image/png,image/webp,image/gif"
            multiple
          >
            {(props) => (
              <Button
                {...props}
                variant="light"
                leftSection={<IconUpload size={16} />}
                disabled={previewSlots === 0}
              >
                Add preview
              </Button>
            )}
          </FileButton>
        )}
        <FileButton onChange={(picked) => upload('Final', picked)} resetRef={resetFinal} multiple>
          {(props) => (
            <Button
              {...props}
              variant="light"
              leftSection={<IconUpload size={16} />}
              disabled={finalSlots === 0}
            >
              Add final files
            </Button>
          )}
        </FileButton>
        <Button
          color="yellow"
          loading={deliver.isPending}
          disabled={busy.length > 0 || !!waiting}
          onClick={() => deliver.mutate({ dealId: deal.id })}
        >
          Deliver
        </Button>
      </Group>
      {waiting && busy.length === 0 && (
        <Group gap="xs">
          <Loader size="xs" />
          <Text size="sm" c="dimmed">
            {waiting} Deliver unlocks when they pass.
          </Text>
        </Group>
      )}
      {busy.length > 0 && (
        <Text size="sm" c="dimmed">
          Uploading {busy.map((item) => item.name).join(', ')}…
        </Text>
      )}
    </Stack>
  );
}

/** The seller's and a moderator's view: every file, its state, and its download. */
function PartyFiles({
  dealId,
  files,
  canEdit,
  currentRound,
}: {
  dealId: number;
  files: DealFile[];
  canEdit: boolean;
  currentRound: number;
}) {
  const utils = trpc.useUtils();
  const refresh = () => utils.creatorServiceDealFile.list.invalidate({ dealId });
  const deleteFile = trpc.creatorServiceDealFile.deleteFile.useMutation({
    onSuccess: refresh,
    onError: (error) => showErrorNotification({ title: 'Could not remove the file', error }),
  });
  // An upload whose check failed ("try again in a moment") stays Uploading; this re-runs the check
  // instead of making the seller send the file again.
  const completeUpload = trpc.creatorServiceDealFile.completeUpload.useMutation({
    onSuccess: refresh,
    onError: (error) => showErrorNotification({ title: 'Upload not finished', error }),
  });

  return (
    <Stack gap="md">
      {filesByRound(files).map(({ round, files: roundFiles }) => (
        <Stack key={round} gap="xs">
          <Text size="sm" fw={600}>
            {roundLabel(round)}
          </Text>
          {roundFiles.map((file) => {
            const status = sellerFileStatus(file);
            return (
              <Stack key={file.id} gap={4}>
                <Group gap="sm" wrap="nowrap" justify="space-between">
                  <Group gap="xs" wrap="nowrap" className="min-w-0">
                    <Badge size="sm" variant="light" color="gray">
                      {file.kind === 'Preview' ? 'Preview' : 'File'}
                    </Badge>
                    <Text size="sm" className="truncate">
                      {file.fileName}
                    </Text>
                    <Text size="xs" c="dimmed">
                      {formatBytes(file.size)}
                    </Text>
                  </Group>
                  <Group gap="xs" wrap="nowrap">
                    <Badge size="sm" variant="light" color={status.color}>
                      {status.label}
                    </Badge>
                    {file.canDownload && (
                      <Anchor href={serviceDealDownloadHref(file.id)} size="sm">
                        <IconDownload size={16} />
                      </Anchor>
                    )}
                    {canEdit && round === currentRound && file.status === 'Uploading' && (
                      <Button
                        size="compact-xs"
                        variant="subtle"
                        loading={
                          completeUpload.isPending && completeUpload.variables?.fileId === file.id
                        }
                        onClick={() => completeUpload.mutate({ fileId: file.id })}
                      >
                        Check upload
                      </Button>
                    )}
                    {canEdit && round === currentRound && (
                      <Button
                        size="compact-xs"
                        variant="subtle"
                        color="red"
                        aria-label={`Remove ${file.fileName}`}
                        onClick={() => deleteFile.mutate({ fileId: file.id })}
                      >
                        <IconTrash size={14} />
                      </Button>
                    )}
                  </Group>
                </Group>
                {file.failReason && (
                  <Text size="xs" c="red">
                    {file.failReason}
                  </Text>
                )}
                {file.previewUrl && (
                  <Image src={file.previewUrl} alt="Watermarked preview" radius="sm" maw={256} />
                )}
              </Stack>
            );
          })}
        </Stack>
      ))}
    </Stack>
  );
}

/** The buyer sees ready, watermarked previews, and final files only as the server unlocks them. */
function BuyerFiles({ deal, files }: { deal: ServiceDealView; files: DealFile[] }) {
  if (files.length === 0)
    return (
      <Text size="sm" c="dimmed">
        Nothing delivered yet.
      </Text>
    );

  return (
    <Stack gap="md">
      {filesByRound(files).map(({ round, files: roundFiles }) => {
        const previews = roundFiles.filter((file) => file.kind === 'Preview' && file.previewUrl);
        const finals = roundFiles.filter((file) => file.kind === 'Final');
        const state = buyerRoundFinalsState(deal, round, finals);
        return (
          <Stack key={round} gap="xs">
            <Text size="sm" fw={600}>
              {roundLabel(round)}
            </Text>
            {previews.length > 0 && (
              <SimpleGrid cols={{ base: 2, sm: 3 }} spacing="xs">
                {previews.map((file) => (
                  <Image
                    key={file.id}
                    src={file.previewUrl}
                    alt="Watermarked preview"
                    radius="sm"
                  />
                ))}
              </SimpleGrid>
            )}
            {state && (
              <Text size="sm" c={state === 'failed' ? 'red' : 'dimmed'}>
                {finalsCopy[state]}
              </Text>
            )}
            {finals.length > 0 && (
              <Stack gap={4}>
                {finals.map((file) =>
                  file.canDownload ? (
                    <Anchor key={file.id} href={serviceDealDownloadHref(file.id)} size="sm">
                      <Group gap={6} wrap="nowrap">
                        <IconDownload size={16} />
                        <span className="truncate">{file.fileName}</span>
                        <Text span size="xs" c="dimmed">
                          {formatBytes(file.size)}
                        </Text>
                      </Group>
                    </Anchor>
                  ) : (
                    <Text key={file.id} size="sm" c="dimmed">
                      Sealed file · {formatBytes(file.size)}
                    </Text>
                  )
                )}
              </Stack>
            )}
          </Stack>
        );
      })}
    </Stack>
  );
}

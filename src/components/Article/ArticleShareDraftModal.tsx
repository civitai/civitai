import {
  Button,
  CopyButton,
  Group,
  Loader,
  Modal,
  SegmentedControl,
  Stack,
  Text,
  TextInput,
} from '@mantine/core';
import { IconCheck, IconCopy } from '@tabler/icons-react';
import { useState } from 'react';
import { useDialogContext } from '~/components/Dialog/DialogProvider';
import { dialogStore } from '~/components/Dialog/dialogStore';
import { articleShareExpiryDays } from '~/server/schema/article.schema';
import { formatDate } from '~/utils/date-helpers';
import { showErrorNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';

type ExpiryDays = (typeof articleShareExpiryDays)[number];

export function openArticleShareDraftModal(articleId: number) {
  dialogStore.trigger({ component: ArticleShareDraftModal, props: { articleId } });
}

export function ArticleShareDraftModal({ articleId }: { articleId: number }) {
  const dialog = useDialogContext();
  const queryUtils = trpc.useUtils();
  const [expiresInDays, setExpiresInDays] = useState<ExpiryDays>(7);
  const [createdUrl, setCreatedUrl] = useState<string>();

  const { data: links, isLoading } = trpc.article.getShareLinks.useQuery({ articleId });
  const invalidate = () => queryUtils.article.getShareLinks.invalidate({ articleId });
  const onError = (error: { message: string }) =>
    showErrorNotification({ title: 'Share link', error: new Error(error.message) });

  const createMutation = trpc.article.createShareLink.useMutation({
    onSuccess: async ({ token }) => {
      setCreatedUrl(`${window.location.origin}/articles/shared/${token}`);
      await invalidate();
    },
    onError,
  });
  const revokeMutation = trpc.article.revokeShareLink.useMutation({
    onSuccess: invalidate,
    onError,
  });

  return (
    <Modal {...dialog} title="Share draft" size="md">
      <Stack gap="md">
        <Text size="sm" c="dimmed">
          Anyone with the link can read this draft, signed in or not, until it expires or you revoke
          it. They can&apos;t comment, react or edit.
        </Text>
        <Stack gap={4}>
          <Text size="sm" fw={500}>
            Expires after
          </Text>
          <SegmentedControl
            value={String(expiresInDays)}
            onChange={(value) => setExpiresInDays(Number(value) as ExpiryDays)}
            data={articleShareExpiryDays.map((days) => ({
              value: String(days),
              label: days === 1 ? '1 day' : `${days} days`,
            }))}
          />
        </Stack>
        <Button
          loading={createMutation.isPending}
          onClick={() => createMutation.mutate({ articleId, expiresInDays })}
        >
          Create link
        </Button>
        {createdUrl && (
          <Stack gap={4}>
            <Text size="sm" c="dimmed">
              Copy it now: the link is shown only once.
            </Text>
            <Group gap="xs" wrap="nowrap">
              <TextInput value={createdUrl} readOnly className="flex-1" />
              <CopyButton value={createdUrl}>
                {({ copied, copy }) => (
                  <Button
                    variant="light"
                    onClick={copy}
                    leftSection={copied ? <IconCheck size={16} /> : <IconCopy size={16} />}
                  >
                    {copied ? 'Copied' : 'Copy'}
                  </Button>
                )}
              </CopyButton>
            </Group>
          </Stack>
        )}
        <Stack gap={4}>
          <Text size="sm" fw={500}>
            Active links
          </Text>
          {isLoading ? (
            <Loader size="sm" />
          ) : !links?.length ? (
            <Text size="sm" c="dimmed">
              None
            </Text>
          ) : (
            links.map((link) => (
              <Group key={link.id} justify="space-between" wrap="nowrap">
                <Text size="sm">
                  Created {formatDate(link.createdAt)} · expires {formatDate(link.expiresAt)}
                </Text>
                <Button
                  size="compact-sm"
                  color="red"
                  variant="subtle"
                  loading={revokeMutation.isPending && revokeMutation.variables?.id === link.id}
                  onClick={() => revokeMutation.mutate({ id: link.id })}
                >
                  Revoke
                </Button>
              </Group>
            ))
          )}
        </Stack>
      </Stack>
    </Modal>
  );
}

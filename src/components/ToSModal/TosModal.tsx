import {
  Button,
  Center,
  Checkbox,
  Divider,
  Group,
  Loader,
  Modal,
  ScrollArea,
  Stack,
  Text,
  Title,
} from '@mantine/core';
import { useState } from 'react';
import { useElementSize } from '@mantine/hooks';
import rehypeRaw from 'rehype-raw';
import remarkGfm from 'remark-gfm';
import remarkBreaks from 'remark-breaks';
import { useDialogContext } from '~/components/Dialog/DialogProvider';
import { CustomMarkdown } from '~/components/Markdown/CustomMarkdown';
import type { SetUserSettingsInput } from '~/server/schema/user.schema';
import { showErrorNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';
import { formatDate } from '~/utils/date-helpers';

export default function TosModal({
  onAccepted,
  slug,
  fieldKey,
  hashFieldKey,
  contentHash,
  showBackButton = true,
}: {
  onAccepted: () => Promise<void>;
  slug: string;
  fieldKey: keyof SetUserSettingsInput;
  // When provided (the main ToS-update flow), the accepted content hash is stored
  // alongside the date so future re-prompts key on content, not the `lastmod` date.
  // Other callers (e.g. Creator Program ToS) omit these and remain date-only.
  hashFieldKey?: keyof SetUserSettingsInput;
  contentHash?: string;
  showBackButton?: boolean;
}) {
  const dialog = useDialogContext();
  const handleClose = dialog.onClose;
  const [loading, setLoading] = useState(false);
  const [acceptedCoC, setAcceptedCoC] = useState(false);
  const { data, isLoading } = trpc.content.get.useQuery({
    slug,
  });
  const queryUtils = trpc.useUtils();

  const { ref: headerRef, height: headerHeight } = useElementSize();
  const { ref: footerRef, height: footerHeight } = useElementSize();

  const updateUserSettings = trpc.user.setSettings.useMutation({
    async onSuccess(res) {
      queryUtils.user.getSettings.setData(undefined, (old) => ({ ...old, ...res }));
    },
    onError() {
      showErrorNotification({
        title: 'Failed to accept ToS',
        error: new Error('Something went wrong, please try again later.'),
      });
    },
  });

  const getScrollAreaMaxHeight = () => {
    const elementGaps = 16 * 3;
    const dividerHeight = 2;
    const reservedSpace = headerHeight + footerHeight + elementGaps + dividerHeight + 32;

    return Math.max(210, reservedSpace);
  };

  const handleConfirm = async () => {
    if (!acceptedCoC) return;
    setLoading(true);

    updateUserSettings.mutate({
      [fieldKey]: new Date(),
      ...(hashFieldKey && contentHash ? { [hashFieldKey]: contentHash } : {}),
    });

    handleClose();
    await onAccepted();

    setLoading(false);
  };

  return (
    <Modal.Root {...dialog} size="lg" closeOnClickOutside={false} closeOnEscape={false} radius="md">
      <Modal.Overlay />
      <Modal.Content radius="md" aria-label="Terms of Service">
        <Modal.Body>
          {isLoading || !data?.content ? (
            <Center>
              <Loader />
            </Center>
          ) : (
            <Stack gap="md">
              {data?.title && (
                <>
                  <Stack ref={headerRef} gap={0}>
                    <Title order={2}>{data?.title}</Title>
                    {data.lastmod ? (
                      <Text size="sm" c="dimmed">
                        Last modified: {formatDate(data.lastmod, undefined, true)}
                      </Text>
                    ) : null}
                  </Stack>
                  <Divider mx="-lg" />
                </>
              )}
              <ScrollArea.Autosize mah={`calc(90dvh - ${getScrollAreaMaxHeight()}px`}>
                <Stack>
                  <CustomMarkdown
                    // allowedElements={['p', 'a', 'strong', 'h1', 'h2', 'ul', 'ol', 'li']}
                    rehypePlugins={[rehypeRaw]}
                    remarkPlugins={[remarkBreaks, remarkGfm]}
                    unwrapDisallowed
                    className="markdown-content-spaced"
                  >
                    {data.content}
                  </CustomMarkdown>
                </Stack>
              </ScrollArea.Autosize>
              <Stack ref={footerRef} gap="md">
                <Checkbox
                  checked={acceptedCoC}
                  onChange={(event) => setAcceptedCoC(event.currentTarget.checked)}
                  label="I have read and agree to the Terms of Service"
                  size="sm"
                />
                <Group ml="auto">
                  {showBackButton && (
                    <Button
                      onClick={handleClose}
                      color="gray"
                      disabled={updateUserSettings.isPending}
                    >
                      Go back
                    </Button>
                  )}
                  <Button
                    onClick={handleConfirm}
                    disabled={!acceptedCoC}
                    loading={updateUserSettings.isPending || loading}
                  >
                    Accept
                  </Button>
                </Group>
              </Stack>
            </Stack>
          )}
        </Modal.Body>
      </Modal.Content>
    </Modal.Root>
  );
}

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
import { useUserSettings } from '~/providers/UserSettingsProvider';

export default function TosModal({
  onAccepted,
  slug,
  fieldKey,
}: {
  onAccepted: () => Promise<void>;
  slug: string;
  fieldKey: keyof SetUserSettingsInput;
}) {
  const dialog = useDialogContext();
  const handleClose = dialog.onClose;
  const [loading, setLoading] = useState(false);
  const [acceptedCoC, setAcceptedCoC] = useState(false);
  const { data, isLoading } = trpc.content.get.useQuery({
    slug,
  });

  const { ref: headerRef, height: headerHeight } = useElementSize();
  const { ref: footerRef, height: footerHeight } = useElementSize();
  const setState = useUserSettings((state) => state.setState);

  const getScrollAreaMaxHeight = () => {
    const elementGaps = 16 * 3;
    const dividerHeight = 2;
    const reservedSpace = headerHeight + footerHeight + elementGaps + dividerHeight + 32;
    console.log('Reserved space:', reservedSpace);

    return Math.max(210, reservedSpace);
  };

  const handleConfirm = async () => {
    if (!acceptedCoC) return;
    setLoading(true);

    setState({ [fieldKey]: new Date() });

    handleClose();
    await onAccepted();

    setLoading(false);
  };

  return (
    <Modal {...dialog} size="lg" withCloseButton={false} radius="md">
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
                    Last modifie: {formatDate(data.lastmod, undefined, true)}
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
              <Button onClick={handleClose} color="gray">
                Go back
              </Button>
              <Button onClick={handleConfirm} disabled={!acceptedCoC} loading={loading}>
                Accept
              </Button>
            </Group>
          </Stack>
        </Stack>
      )}
    </Modal>
  );
}

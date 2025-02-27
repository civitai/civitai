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
} from '@mantine/core';
import { useState } from 'react';
import rehypeRaw from 'rehype-raw';
import remarkGfm from 'remark-gfm';
import remarkBreaks from 'remark-breaks';
import { useDialogContext } from '~/components/Dialog/DialogProvider';
import { CustomMarkdown } from '~/components/Markdown/CustomMarkdown';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { SetUserSettingsInput } from '~/server/schema/user.schema';
import { showErrorNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';

export const TosModal = ({
  onAccepted,
  slug,
  key,
}: {
  onAccepted: () => Promise<void>;
  slug: string;
  key: keyof SetUserSettingsInput;
}) => {
  const dialog = useDialogContext();
  const handleClose = dialog.onClose;
  const [loading, setLoading] = useState(false);
  const [acceptedCoC, setAcceptedCoC] = useState(false);
  const { data, isLoading } = trpc.content.get.useQuery({
    slug,
  });
  const queryUtils = trpc.useContext();

  const updateUserSettings = trpc.user.setSettings.useMutation({
    async onSuccess(res) {
      queryUtils.user.getSettings.setData(undefined, res as any);
    },
    onError(_error, _payload, context) {
      showErrorNotification({
        title: 'Failed to accept ToS',
        error: new Error('Something went wrong, please try again later.'),
      });
    },
  });
  const handleConfirm = async () => {
    if (!acceptedCoC) {
      return;
    }

    setLoading(true);

    await updateUserSettings.mutate({
      [key]: new Date(),
    });

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
        <Stack spacing="md">
          <Group position="apart" mb="md">
            <Text size="lg" weight="bold">
              {data?.title}
            </Text>
          </Group>
          <Divider mx="-lg" mb="md" />
          <ScrollArea.Autosize maxHeight={500}>
            <Stack>
              <CustomMarkdown
                // allowedElements={['p', 'a', 'strong', 'h1', 'h2', 'ul', 'ol', 'li']}
                rehypePlugins={[rehypeRaw, remarkGfm, remarkBreaks]}
              >
                {data.content}
              </CustomMarkdown>
            </Stack>
          </ScrollArea.Autosize>
          <Checkbox
            checked={acceptedCoC}
            onChange={(event) => setAcceptedCoC(event.currentTarget.checked)}
            label="I have read and agree to the Terms of Service"
            size="sm"
          />
          <Group ml="auto">
            <Button onClick={handleClose} color="gray" disabled={updateUserSettings.isLoading}>
              Go back
            </Button>
            <Button
              onClick={handleConfirm}
              disabled={!acceptedCoC}
              loading={updateUserSettings.isLoading || loading}
            >
              Accept
            </Button>
          </Group>
        </Stack>
      )}
    </Modal>
  );
};

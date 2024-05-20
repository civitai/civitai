import {
  Alert,
  Button,
  Center,
  Container,
  Group,
  Loader,
  Paper,
  Stack,
  Text,
  Title,
} from '@mantine/core';
import { IconAlertCircle } from '@tabler/icons-react';
import { useRouter } from 'next/router';
import React, { useEffect, useState } from 'react';
import { z } from 'zod';
import { UserAvatar } from '~/components/UserAvatar/UserAvatar';
import { useCFImageUpload } from '~/hooks/useCFImageUpload';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { constants } from '~/server/common/constants';
import { createServerSideProps } from '~/server/utils/server-side-helpers';
import { formatDate } from '~/utils/date-helpers';
import { getLoginLink } from '~/utils/login-helpers';
import { loadImage } from '~/utils/media-preprocessors';
import { showSuccessNotification } from '~/utils/notifications';
import { formatBytes } from '~/utils/number-helpers';
import { trpc } from '~/utils/trpc';

const avatarQuerySchema = z.object({
  mediaUrl: z.string().url(),
});

export const getServerSideProps = createServerSideProps({
  useSSG: true,
  useSession: true,
  resolver: async ({ session, ctx }) => {
    if (!session) {
      return {
        redirect: {
          destination: getLoginLink({ returnUrl: ctx.resolvedUrl, reason: 'perform-action' }),
          permanent: false,
        },
      };
    }
    if (session.user?.muted) return { notFound: true };
  },
});

export default function IntentAvatar() {
  const router = useRouter();
  const [loading, setLoading] = useState(true);
  const [waiting, setWaiting] = useState(false);
  const [errorMsg, setErrorMsg] = useState<React.ReactNode | undefined>(undefined);
  const [imgToUpload, setImgToUpload] = useState<File>();
  const currentUser = useCurrentUser();
  const { uploadToCF } = useCFImageUpload();

  const queryParse = avatarQuerySchema.safeParse(router.query);
  const url = queryParse.success ? queryParse.data.mediaUrl : undefined;

  const { mutate } = trpc.user.update.useMutation({
    async onSuccess() {
      await currentUser?.refresh();
      router.push('/user/account').then(() => {
        showSuccessNotification({ message: 'Your avatar has been updated.' });
        setWaiting(false);
      });
    },
    onError() {
      setErrorMsg('Failed to save avatar. Please refresh the page to try again.');
      setWaiting(false);
    },
  });

  const handleConfirm = async () => {
    if (!imgToUpload || !currentUser) return;
    setWaiting(true);
    try {
      const { id } = await uploadToCF(imgToUpload);
      mutate({ id: currentUser.id, image: id });
    } catch (e) {
      setErrorMsg('Failed to save avatar. Please refresh the page to try again.');
      setWaiting(false);
    }
  };

  useEffect(() => {
    const fetchBlob = async (src: string) => {
      // TODO [bw] how should we handle CORS issues? even with { mode: 'no-cors' }, loadImage still won't work.
      //  technically, that isn't required for the image download, but it is to test if it's valid
      const response = await fetch(src);
      const blob = await response.blob();
      const bytes = blob.size;

      if (bytes > constants.mediaUpload.maxImageFileSize) {
        setErrorMsg(
          `File (${formatBytes(bytes)}) should not exceed ${formatBytes(
            constants.mediaUpload.maxImageFileSize
          )}.`
        );
        setLoading(false);
      } else {
        const objUrl = URL.createObjectURL(blob);
        loadImage(objUrl)
          .then(() => {
            const file = new File([blob], url?.split('/').slice(-1)[0] ?? 'avatar-file', {
              type: blob.type,
            });
            setImgToUpload(file);
          })
          .catch((e) => {
            console.log(e);
            setErrorMsg(
              <>
                Could not parse image from that <code>mediaUrl</code>.
              </>
            );
          })
          .finally(() => {
            setLoading(false);
          });
      }
    };

    if (!url) {
      setErrorMsg(
        <>
          Must pass a valid URL to <code>mediaUrl</code>.
        </>
      );
      setLoading(false);
    } else {
      fetchBlob(url).catch(() => {
        setErrorMsg(
          <>
            Could not parse image from that <code>mediaUrl</code>.
          </>
        );
        setLoading(false);
      });
    }
  }, [url]);

  return (
    <Container my="lg" size="xs">
      {waiting ? (
        <Stack align="center">
          <Title order={2}>Updating Avatar</Title>
          <Loader size="xl" variant="bars" />
        </Stack>
      ) : loading ? (
        <Center>
          <Loader />
        </Center>
      ) : errorMsg ? (
        <Stack>
          <Title order={1}>Invalid Request</Title>
          <Alert icon={<IconAlertCircle size="1rem" />} title="Error" color="red" variant="light">
            {errorMsg}
          </Alert>
        </Stack>
      ) : (
        <Stack spacing="xs">
          <Title order={1}>Update Avatar</Title>
          <Text mt="lg" size="lg">
            Preview:
          </Text>
          <Paper p="sm" withBorder>
            <UserAvatar
              user={currentUser}
              avatarProps={{ src: url ?? '' }}
              size="xl"
              subText={
                currentUser?.createdAt ? `Member since ${formatDate(currentUser.createdAt)}` : ''
              }
              withUsername
            />
          </Paper>
          <Group mt="xl" position="right">
            <Button variant="default" onClick={() => router.push('/')}>
              Cancel
            </Button>
            <Button onClick={handleConfirm}>Confirm</Button>
          </Group>
        </Stack>
      )}
    </Container>
  );
}

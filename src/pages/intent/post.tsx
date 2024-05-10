import {
  Button,
  Code,
  Container,
  Group,
  Loader,
  Paper,
  Stack,
  Text,
  ThemeIcon,
  Timeline,
  Title,
  useMantineTheme,
} from '@mantine/core';
import { IconCheck, IconMinus, IconX } from '@tabler/icons-react';
import { useRouter } from 'next/router';
import React, { useEffect, useState } from 'react';
import { z } from 'zod';
import { EdgeMedia } from '~/components/EdgeMedia/EdgeMedia';
import { Meta } from '~/components/Meta/Meta';
import { constants, POST_TAG_LIMIT } from '~/server/common/constants';
import { IMAGE_MIME_TYPE, MEDIA_TYPE, VIDEO_MIME_TYPE } from '~/server/common/mime-types';
import { createServerSideProps } from '~/server/utils/server-side-helpers';
import {
  orchestratorMediaTransmitter,
  useExternalMetaStore,
} from '~/store/post-image-transmitter.store';
import { getLoginLink } from '~/utils/login-helpers';
import { getVideoData, loadImage } from '~/utils/media-preprocessors';
import { showErrorNotification, showSuccessNotification } from '~/utils/notifications';
import { formatBytes } from '~/utils/number-helpers';
import { titleCase } from '~/utils/string-helpers';
import { trpc } from '~/utils/trpc';
import { commaDelimitedStringArray } from '~/utils/zod-helpers';

const TRANSMITTER_KEY = 'post-intent';

const postQuerySchema = z.object({
  /**
   *  Absolute url of the media to post
   */
  mediaUrl: z.string().url(),
  /**
   * Title to use for the post
   */
  title: z.string().optional(),
  /**
   * Text to use in the description of the post
   */
  description: z.string().optional(),
  /**
   * Url we should call to get additional parameters for the media.
   * They can include parameters specific to your service so that people can have a better idea of how the media was made on your service.
   * Only for approved domains - contact us to be added
   */
  detailsUrl: z.string().url().optional(),
  /**
   * Tags to apply to the post (comma delimited)
   * Maximum of 5
   */
  tags: commaDelimitedStringArray().optional(),
});
type PostQuerySchema = z.infer<typeof postQuerySchema>;

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

type ParseProgress = {
  title: 'Parsing params' | 'Checking media';
  status: 'success' | 'failed' | 'skipped' | undefined;
  errors: React.ReactNode[];
  msg?: React.ReactNode;
};

export default function IntentPost() {
  const router = useRouter();
  const queryUtils = trpc.useUtils();
  const theme = useMantineTheme();
  const [readyData, setReadyData] = useState<PostQuerySchema | undefined>();
  const [creatingPost, setCreatingPost] = useState<string | undefined>();
  const [previewUrl, setPreviewUrl] = useState<{ url: string; type: 'video' | 'image' }>();
  const [progress, setProgress] = useState<ParseProgress[]>([
    { title: 'Parsing params', status: undefined, errors: [] },
    { title: 'Checking media', status: undefined, errors: [] },
  ]);

  const createPostMutation = trpc.post.create.useMutation();

  const doCreate = () => {
    // if (currentUser?.muted) return;
    if (!readyData) return;

    setCreatingPost('Preparing post...');

    createPostMutation.mutate(
      { title: readyData.title, detail: readyData.description, tags: readyData.tags },
      {
        onSuccess: async (res) => {
          queryUtils.post.getEdit.setData({ id: res.id }, () => res);

          orchestratorMediaTransmitter.setUrls(TRANSMITTER_KEY, [readyData.mediaUrl]);

          showSuccessNotification({
            title: 'Success!',
            message: "Please check the data and publish the post when you're ready.",
            autoClose: 10000,
          });

          setCreatingPost('Redirecting...');

          // await router.push({
          //   pathname: `/posts/${res.id}/edit`,
          //   query: { src: TRANSMITTER_KEY },
          // });
          await router.replace(
            {
              pathname: `/posts/${res.id}/edit`,
              query: { src: TRANSMITTER_KEY },
            },
            undefined,
            {
              shallow: true,
            }
          );
          setCreatingPost(undefined);
        },
        onError(error) {
          showErrorNotification({
            title: 'Failed to create post',
            error: new Error(error.message),
          });
          setCreatingPost(undefined);
        },
      }
    );
  };

  const transformProgress = (prev: ParseProgress[], update: ParseProgress) => {
    return prev.map((p) => {
      if (p.title === update.title) return update;
      return p;
    });
  };

  useEffect(() => {
    const queryParse = postQuerySchema.safeParse(router.query);

    if (!queryParse.success) {
      setProgress((prev) =>
        transformProgress(prev, {
          title: 'Parsing params',
          status: 'failed',
          errors: queryParse.error.issues.map((i, idx) => (
            <Group key={idx}>
              <Code>{i.path.join('.')}</Code>
              <Text color="dimmed" size="sm">
                {i.message}
              </Text>
            </Group>
          )),
        })
      );
      return;
    }

    const { data } = queryParse;

    if (data.tags && data.tags.length > POST_TAG_LIMIT) {
      setProgress((prev) =>
        transformProgress(prev, {
          title: 'Parsing params',
          status: 'failed',
          errors: [
            <Group key="tagfail">
              <Code>tags</Code>
              <Text color="dimmed" size="sm">
                Maximum of {POST_TAG_LIMIT} tags allowed (found {data.tags!.length})
              </Text>
            </Group>,
          ],
        })
      );
      return;
    }

    setProgress((prev) =>
      transformProgress(prev, {
        title: 'Parsing params',
        status: 'success',
        errors: [],
      })
    );

    const fetchBlob = async (src: string) => {
      let blob;
      try {
        const response = await fetch(src);
        blob = await response.blob();
      } catch (e) {
        console.log(e);
        throw new Error('Could not fetch media from that url');
      }

      if (!blob.type || blob.type.length === 0) {
        throw new Error('Could not fetch media from that url');
      }

      const bytes = blob.size;
      const mediaType = MEDIA_TYPE[blob.type];

      if (mediaType !== 'image' && mediaType !== 'video') {
        throw new Error(
          `Unsupported file type: "${
            !!blob.type && blob.type.length > 0 ? blob.type : 'unknown'
          }". Accepted types: ${[...IMAGE_MIME_TYPE, ...VIDEO_MIME_TYPE].join(', ')} `
        );
      }

      const objUrl = URL.createObjectURL(blob);

      if (mediaType === 'image') {
        if (bytes > constants.mediaUpload.maxImageFileSize) {
          throw new Error(
            `Image (${formatBytes(bytes)}) should not exceed ${formatBytes(
              constants.mediaUpload.maxImageFileSize
            )}.`
          );
        }

        loadImage(objUrl)
          .catch((e) => {
            console.log(e);
            throw new Error('Could not fetch media from that url');
          })
          .finally(() => {
            URL.revokeObjectURL(objUrl);
            setProgress((prev) =>
              transformProgress(prev, {
                title: 'Checking media',
                status: 'success',
                errors: [],
                msg: (
                  <Stack spacing={6}>
                    <Text>Success!</Text>
                    <Text>Found 1 image ({formatBytes(bytes)})</Text>
                  </Stack>
                ),
              })
            );
            setPreviewUrl({ url: data.mediaUrl, type: 'image' });
            return;
          });
      } else {
        if (bytes > constants.mediaUpload.maxVideoFileSize) {
          throw new Error(
            `Video (${formatBytes(bytes)}) should not exceed ${formatBytes(
              constants.mediaUpload.maxVideoFileSize
            )}.`
          );
        }

        getVideoData(objUrl)
          .then((vidData) => {
            if (
              vidData.duration &&
              vidData.duration > constants.mediaUpload.maxVideoDurationSeconds
            )
              throw new Error(
                `Video duration cannot be longer than ${constants.mediaUpload.maxVideoDurationSeconds} seconds. Please trim your video and try again.`
              );
            if (
              vidData.width > constants.mediaUpload.maxVideoDimension ||
              vidData.height > constants.mediaUpload.maxVideoDimension
            )
              throw new Error(
                `Videos cannot be larger than ${constants.mediaUpload.maxVideoDimension}px from either side. Please resize your image and try again.`
              );
          })
          .catch((e) => {
            console.log(e);
            throw new Error('Could not fetch media from that url');
          })
          .finally(() => {
            URL.revokeObjectURL(objUrl);
            setProgress((prev) =>
              transformProgress(prev, {
                title: 'Checking media',
                status: 'success',
                errors: [],
                msg: (
                  <Stack spacing={6}>
                    <Text>Success!</Text>
                    <Text>Found 1 video ({formatBytes(bytes)})</Text>
                  </Stack>
                ),
              })
            );
            setPreviewUrl({ url: data.mediaUrl, type: 'video' });
            return;
          });
      }
    };

    fetchBlob(data.mediaUrl)
      .then(() => {
        if (data.detailsUrl) {
          useExternalMetaStore.getState().setUrl(data.detailsUrl);
        }
        setReadyData(data);
      })
      .catch((e: Error) => {
        setProgress((prev) =>
          transformProgress(prev, {
            title: 'Checking media',
            status: 'failed',
            errors: [
              <Text key={e.message} color="dimmed" size="sm">
                {e.message.split('. ').map((m, idx) => (
                  <p key={idx}>{m}</p>
                ))}
              </Text>,
            ],
          })
        );
      });
  }, []);

  let activeStep = progress.findIndex((p) => p.status !== 'success' && p.status !== 'skipped');
  if (activeStep === -1) {
    activeStep = progress.length;
  }
  const hasError = progress.find((p) => p.status === 'failed');

  return (
    <>
      <Meta title="Create a Post | Civitai" />
      <Container my="lg" size="xs">
        <Stack>
          <Title order={2}>Create New Post</Title>
          <Paper
            p="sm"
            withBorder
            style={{
              background:
                theme.colorScheme === 'dark' ? theme.colors.dark[6] : theme.colors.gray[1],
            }}
          >
            <Timeline color="green" active={activeStep} bulletSize={22} lineWidth={1}>
              {progress.map((p, idx) => {
                const Icon =
                  p.status === 'success'
                    ? IconCheck
                    : p.status === 'skipped'
                    ? IconMinus
                    : p.status === 'failed'
                    ? IconX
                    : idx === activeStep
                    ? Loader
                    : IconMinus;
                // const color = p.status === undefined ? 'gray' : p.status === 'failed' ? 'red' : 'green';
                const color =
                  p.status === undefined
                    ? 'gray'
                    : p.status === 'skipped'
                    ? 'cyan'
                    : p.status === 'success'
                    ? 'green'
                    : 'red';
                return (
                  <Timeline.Item
                    key={p.title}
                    // bullet={<Icon size={12} />}
                    bullet={
                      <ThemeIcon color={color} radius="xl" size={24}>
                        <Icon size={12} />
                      </ThemeIcon>
                    }
                    title={p.title}
                    // color={color}
                  >
                    <Group position="left" align="start">
                      <Stack mt="xs" spacing={6}>
                        {p.errors.length > 0 ? (
                          p.errors.map((e, idx) => (
                            <Group noWrap key={idx}>
                              <IconX color="red" size={16} style={{ flex: '0 0 auto' }} />
                              {e}
                            </Group>
                          ))
                        ) : p.status !== undefined ? (
                          <Text color="dimmed" size="sm">
                            {p.msg ?? `${titleCase(p.status)}!`}
                          </Text>
                        ) : (
                          <></>
                        )}
                      </Stack>
                      {p.title === 'Checking media' && !!previewUrl && (
                        <Group position="center" style={{ flexGrow: 1 }}>
                          <EdgeMedia
                            width={150}
                            src={previewUrl.url}
                            type={previewUrl.type}
                            style={{
                              height: '150px',
                              objectFit: 'cover',
                            }}
                          />
                        </Group>
                      )}
                    </Group>
                  </Timeline.Item>
                );
              })}
            </Timeline>
          </Paper>
          <Group position="right">
            <Button
              disabled={!readyData || !!hasError}
              loading={!!creatingPost}
              onClick={() => doCreate()}
            >
              {creatingPost ?? (!readyData && !hasError ? 'Parsing...' : 'Proceed')}
            </Button>
          </Group>
        </Stack>
      </Container>
    </>
  );
}

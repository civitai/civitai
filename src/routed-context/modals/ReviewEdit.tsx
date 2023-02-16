import { Alert, Button, Group, LoadingOverlay, Modal, Stack, ThemeIcon, Text } from '@mantine/core';
import { IconAlertCircle, IconExclamationMark } from '@tabler/icons';
import { useRouter } from 'next/router';
import { useEffect, useState } from 'react';
import { z } from 'zod';
import { AlertWithIcon } from '~/components/AlertWithIcon/AlertWithIcon';

import { useCatchNavigation } from '~/hooks/useCatchNavigation';
import { Form, InputImageUpload, InputRating, InputRTE, InputSelect, useForm } from '~/libs/form';
import { openRoutedContext } from '~/providers/RoutedContextProvider';
import { createRoutedContext } from '~/routed-context/create-routed-context';
import { ReviewUpsertInput, reviewUpsertSchema } from '~/server/schema/review.schema';
import { showErrorNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';
import { isDefined } from '~/utils/type-guards';

export default createRoutedContext({
  schema: z.object({
    reviewId: z.number().optional(),
  }),
  Element: ({ context, props: { reviewId } }) => {
    const router = useRouter();
    const queryUtils = trpc.useContext();
    const modelId = Number(router.query.id);

    const [isUploading, setIsUploading] = useState(false);
    const [isComplete, setIsComplete] = useState(true);
    const [isBlocked, setIsBlocked] = useState(false);
    const [nsfwPoi, setNsfwPoi] = useState(false);
    const [catchNavigation, setCatchNavigation] = useState(true);

    const {
      data: review,
      isLoading: reviewLoading,
      isFetching: reviewRefetching,
    } = trpc.review.getDetail.useQuery(
      { id: reviewId ?? 0 },
      { enabled: !!reviewId, keepPreviousData: false }
    );
    const { data: modelDetail } = trpc.model.getModelDetailsForReview.useQuery({ id: modelId });

    const form = useForm({
      schema: reviewUpsertSchema,
      defaultValues: {
        modelId,
      },
      mode: 'onChange',
      shouldFocusError: true,
      shouldUnregister: false,
    });

    const { mutate, isLoading } = trpc.review.upsert.useMutation();
    const handleSubmit = (data: ReviewUpsertInput) => {
      mutate(data, {
        onSuccess: async (_, { modelId }) => {
          context.close();
          await queryUtils.review.getAll.invalidate({ modelId });
          if (reviewId) await queryUtils.review.getDetail.invalidate({ id: reviewId });
        },
        onError: (error) => {
          showErrorNotification({
            error: new Error(error.message),
            title: 'Could not save the review',
          });
        },
      });
    };

    const loadingReview = (reviewLoading || reviewRefetching) && !!reviewId;
    const { isDirty, isSubmitted } = form.formState;
    const rating = form.watch('rating');
    useCatchNavigation({ unsavedChanges: catchNavigation && isDirty && !isSubmitted });

    const goToCommentModal = () => {
      localStorage.setItem('commentContent', form.getValues().text ?? '');
      setCatchNavigation(false);
      openRoutedContext('commentEdit', {}, { replace: true });
    };

    useEffect(() => {
      if (review && !loadingReview) form.reset(review as any); // eslint-disable-line
    }, [review, loadingReview]) //eslint-disable-line

    useEffect(() => {
      const subscription = form.watch((value, { name }) => {
        if (!modelDetail) return;
        if (name === 'nsfw' || name === 'images' || name === undefined) {
          const { nsfw, images } = value;
          const hasNsfwImages = images?.filter(isDefined).some((x) => x.nsfw) ?? false;
          setNsfwPoi(modelDetail.poi && (nsfw || hasNsfwImages));
        }
      });
      return () => subscription.unsubscribe();
    }, [form, modelDetail]);

    return (
      <Modal
        title={reviewId ? 'Editing review' : 'Add a review'}
        opened={context.opened}
        onClose={!isLoading ? context.close : () => ({})}
        closeOnClickOutside={!isLoading}
        closeOnEscape={!isLoading}
      >
        <LoadingOverlay visible={loadingReview} />
        <Form form={form} onSubmit={handleSubmit}>
          <Stack>
            <InputSelect
              name="modelVersionId"
              data={
                modelDetail?.modelVersions?.map(({ id, name }) => ({ label: name, value: id })) ??
                []
              }
              label="Version of the model"
              placeholder="Select a version"
              withAsterisk
              required
            />
            <InputRating name="rating" label="Rate the model" size="xl" withAsterisk required />
            {rating <= 3 && !reviewId && (
              <AlertWithIcon icon={<IconAlertCircle size={14} />} iconColor="yellow" color="yellow">
                {`If you're having trouble with this model or reproducing an example image, `}
                <Text
                  variant="link"
                  sx={{ cursor: 'pointer', lineHeight: 1 }}
                  onClick={goToCommentModal}
                  span
                >
                  consider leaving a comment instead.
                </Text>
              </AlertWithIcon>
            )}
            <InputRTE
              name="text"
              label="Comments or feedback"
              includeControls={['formatting', 'link']}
              editorSize="md"
            />
            <InputImageUpload
              name="images"
              label="Generated Images"
              loading={isUploading}
              onChange={(values) => {
                setIsUploading(values.some((x) => x.status === 'uploading'));
                setIsComplete(values.filter((x) => x.status).every((x) => x.status === 'complete'));
                setIsBlocked(values.some((x) => x.status === 'blocked'));
              }}
            />
            {nsfwPoi && (
              <>
                <Alert color="red" pl={10}>
                  <Group noWrap spacing={10}>
                    <ThemeIcon color="red">
                      <IconExclamationMark />
                    </ThemeIcon>
                    <Stack spacing={0}>
                      <Text size="xs" sx={{ lineHeight: 1.2 }}>
                        The model that this review is based on depicts an actual person. NSFW
                        content depicting actual people is not permitted.
                      </Text>
                    </Stack>
                  </Group>
                </Alert>
                <Text size="xs" color="dimmed" sx={{ lineHeight: 1.2 }}>
                  Please revise the content of this listing to ensure no actual person is depicted
                  in an NSFW context out of respect for the individual.
                </Text>
              </>
            )}
            {isBlocked && (
              <>
                <Alert color="red" pl={10}>
                  <Group noWrap spacing={10}>
                    <ThemeIcon color="red">
                      <IconExclamationMark />
                    </ThemeIcon>
                    <Text size="xs" sx={{ lineHeight: 1.2 }}>
                      TOS Violation
                    </Text>
                  </Group>
                </Alert>
                <Text size="xs" color="dimmed" sx={{ lineHeight: 1.2 }}>
                  Please revise the content of this listing to ensure no images contain content that
                  could constitute a TOS violation.
                </Text>
              </>
            )}
            <Group position="apart">
              <Button variant="default" onClick={() => context.close()} disabled={isLoading}>
                Cancel
              </Button>
              <Button type="submit" loading={isLoading} disabled={nsfwPoi || !isComplete}>
                {isUploading ? 'Uploading...' : isLoading ? 'Saving...' : 'Save'}
              </Button>
            </Group>
          </Stack>
        </Form>
      </Modal>
    );
  },
});

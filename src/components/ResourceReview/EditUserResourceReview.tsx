import { ActionIcon, Button, Card, Divider, Group, Rating, Stack, Text } from '@mantine/core';
import { IconChevronDown, IconPhotoPlus, IconSend } from '@tabler/icons-react';
import { useRouter } from 'next/router';
import { useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { z } from 'zod';

import { DaysFromNow } from '~/components/Dates/DaysFromNow';
import {
  useCreateResourceReview,
  useQueryUserResourceReview,
  useUpdateResourceReview,
} from '~/components/ResourceReview/resourceReview.utils';
import type { EditorCommandsRef } from '~/components/RichTextEditor/RichTextEditorComponent';
import { Form, InputRTE, InputTextArea, useForm } from '~/libs/form';
import {
  ResourceReviewModel,
  ResourceReviewSimpleModel,
} from '~/server/selectors/resourceReview.selector';
import classes from './ResourceReview.module.scss';
import clsx from 'clsx';

const schema = z.object({
  details: z.string().optional(),
});

export type ReviewEditCommandsRef = {
  save: () => void;
};

export function EditUserResourceReview({
  resourceReview,
  modelId,
  modelName,
  modelVersionName,
  modelVersionId,
  openedCommentBox = false,
  innerRef,
}: Props) {
  const [editDetail, setEditDetail] = useState(openedCommentBox);
  const toggleEditDetail = () => {
    setEditDetail((state) => !state);
    if (!editDetail) setTimeout(() => commentRef.current?.focus(), 100);
  };
  const commentRef = useRef<EditorCommandsRef | null>(null);

  const createMutation = useCreateResourceReview();
  const updateMutation = useUpdateResourceReview();

  const createReviewWithRating = (rating: number) => {
    createMutation.mutate({ modelVersionId, modelId, rating, recommended: rating >= 3 });
  };

  const updateReview = ({ rating, details }: { rating?: number; details?: string }) => {
    if (!resourceReview) return;
    updateMutation.mutate(
      { id: resourceReview.id, rating, details },
      {
        onSuccess: (response, request) => {
          if (request.details) {
            toggleEditDetail();
            form.reset({ details: request.details as string });
          }
        },
      }
    );
  };

  const form = useForm({
    schema,
    defaultValues: { details: resourceReview?.details ?? '' },
  });
  const handleSubmit = ({ details }: z.infer<typeof schema>) => updateReview({ details });

  const handleRatingChange = (rating: number) => {
    !resourceReview?.id ? createReviewWithRating(rating) : updateReview({ rating });
  };

  useEffect(() => {
    form.reset({ details: resourceReview?.details ?? '' });
  }, [resourceReview?.details]); // eslint-disable-line

  // Used to call editor commands outside the component via a ref
  useImperativeHandle(innerRef, () => ({
    save: () => {
      if (form.formState.isDirty) form.handleSubmit(handleSubmit)();
    },
  }));

  modelVersionName ??= resourceReview?.modelVersion.name;

  return (
    <Card p={8} withBorder>
      <Stack gap="xs">
        <Stack gap={4}>
          <Group align="center" justify="space-between">
            <Stack gap={0}>
              {modelName && <Text lineClamp={1}>{modelName}</Text>}
              {modelVersionName && (
                <Text lineClamp={1} size="xs" c="dimmed">
                  {modelVersionName}
                </Text>
              )}
            </Stack>
            <Rating value={resourceReview?.rating} onChange={handleRatingChange} />
          </Group>
          {resourceReview?.createdAt && (
            <Text size="xs">
              Reviewed <DaysFromNow date={resourceReview.createdAt} />
            </Text>
          )}
        </Stack>

        {resourceReview?.id && (
          <>
            <Card.Section>
              <Divider />
            </Card.Section>
            <Stack>
              {!editDetail ? (
                <Text variant="link" onClick={toggleEditDetail} size="sm">
                  <Group gap={4} style={{ cursor: 'pointer' }}>
                    <IconChevronDown size={16} />{' '}
                    <span>{!resourceReview.details ? 'Add' : 'Edit'} Review Comments</span>
                  </Group>
                </Text>
              ) : (
                <Form form={form} onSubmit={handleSubmit}>
                  <Stack gap="xs">
                    <InputRTE
                      name="details"
                      includeControls={['formatting', 'link']}
                      hideToolbar
                      editorSize="sm"
                      innerRef={commentRef}
                      placeholder={`What did you think of ${modelName}?`}
                      styles={{ content: { maxHeight: 500, overflowY: 'auto' } }}
                      // withLinkValidation
                    />
                    <Group grow gap="xs">
                      <Button size="xs" variant="default" onClick={toggleEditDetail}>
                        Cancel
                      </Button>
                      <Button
                        size="xs"
                        type="submit"
                        variant={form.formState.isDirty ? undefined : 'outline'}
                        loading={updateMutation.isLoading}
                      >
                        Save
                      </Button>
                    </Group>
                  </Stack>
                </Form>
              )}
            </Stack>
          </>
        )}
      </Stack>
    </Card>
  );
}

type Props = {
  resourceReview?: ResourceReviewModel;
  modelId: number;
  modelName?: string;
  modelVersionName?: string;
  modelVersionId: number;
  openedCommentBox?: boolean;
  innerRef?: React.ForwardedRef<ReviewEditCommandsRef>;
  showNoAccessAlert?: boolean;
};

type UserResourceReviewCompositeProps = {
  userReview: ResourceReviewSimpleModel | null | undefined;
  modelId: number;
  modelVersionId: number;
  modelName?: string;
  loading: boolean;
};

export function UserResourceReviewComposite({
  modelId,
  modelVersionId,
  modelName,
  children,
}: Props & { children: (props: UserResourceReviewCompositeProps) => JSX.Element | null }) {
  const { currentUserReview, loading } = useQueryUserResourceReview({ modelId, modelVersionId });

  return children({
    userReview: currentUserReview,
    modelId,
    modelVersionId,
    modelName,
    loading,
  });
}

export function EditUserResourceReviewV2({
  modelVersionId,
  modelName,
  innerRef,
  userReview,
  showReviewedAt = true,
  opened: initialOpened = false,
  autoFocus = true,
}: PropsV2) {
  const [opened, setOpened] = useState(initialOpened);

  const { loading: loadingUserReview } = useQueryUserResourceReview({ modelVersionId });

  const form = useForm({
    schema,
    defaultValues: { details: userReview?.details ?? '' },
  });

  const updateMutation = useUpdateResourceReview();
  const updateReview = ({ rating, details }: { rating?: number; details?: string }) => {
    if (!userReview) return;
    updateMutation.mutate(
      { id: userReview.id, rating, details },
      {
        onSuccess: (_, payload) => {
          if (payload.details) {
            handleToggleOpen();
            form.reset({ details: payload.details as string });
          }
        },
      }
    );
  };

  const handleSubmit = ({ details }: z.infer<typeof schema>) => updateReview({ details });
  const handleToggleOpen = useCallback(() => setOpened((v) => !v), []);
  const handleCancel = () => {
    form.reset({ details: userReview?.details ?? '' });
    handleToggleOpen();
  };

  useEffect(() => {
    form.reset({ details: userReview?.details ?? '' });
  }, [userReview?.details]); // eslint-disable-line

  const hasComment = !!userReview?.details;
  const { isDirty } = form.formState;

  // Used to call editor commands outside the component via a ref
  useImperativeHandle(innerRef, () => ({
    save: () => {
      if (form.formState.isDirty) form.handleSubmit(handleSubmit)();
    },
  }));

  return (
    <Stack gap="sm" pos="relative">
      <Group gap={8} justify="space-between">
        <Text variant="link" size="sm" style={{ cursor: 'pointer' }} onClick={handleToggleOpen}>
          <Group gap={4}>
            <IconChevronDown className={clsx({ [classes.opened]: opened })} size={20} />
            <span>{hasComment ? 'Edit' : 'Add'} Review Comments</span>
          </Group>
        </Text>
        {userReview && showReviewedAt && (
          <Text c="dimmed" size="xs">
            Reviewed <DaysFromNow date={userReview.createdAt} />
          </Text>
        )}
      </Group>
      {opened && (
        <Form form={form} onSubmit={handleSubmit}>
          <Stack gap="xs">
            <InputTextArea
              name="details"
              placeholder={
                modelName
                  ? `What did you think of ${modelName ?? 'this resource'}?`
                  : 'Tell us more about why? What was it good at? Where did it struggle?'
              }
              maxRows={5}
              autoFocus={autoFocus}
              autosize
            />
            <Group grow gap="xs">
              <Button size="xs" variant="default" onClick={handleCancel}>
                Cancel
              </Button>
              <Button
                size="xs"
                type="submit"
                disabled={!isDirty}
                loading={updateMutation.isLoading || loadingUserReview}
              >
                Post
              </Button>
            </Group>
          </Stack>
        </Form>
      )}
    </Stack>
  );
}

export function EditUserResourceReviewLight({
  modelVersionId,
  modelId,
  userReview,
}: Pick<PropsV2, 'modelVersionId' | 'userReview'> & { modelId: number }) {
  const router = useRouter();
  const { loading: loadingUserReview } = useQueryUserResourceReview({ modelVersionId });

  const form = useForm({
    schema,
    defaultValues: { details: userReview?.details ?? '' },
  });

  const updateMutation = useUpdateResourceReview();
  const updateReview = ({ details }: { details?: string }) => {
    if (!userReview) return;

    return updateMutation.mutateAsync(
      { id: userReview.id, details },
      {
        onSuccess: (_, payload) => {
          if (payload.details) {
            form.reset({ details: payload.details as string });
          }
        },
      }
    );
  };

  const handlePostClick = ({ details }: z.infer<typeof schema>) => updateReview({ details });
  const handleImageUploadClick = async () => {
    await form.handleSubmit(handlePostClick)();
    await router.push(
      `/posts/create?reviewing=true&modelId=${modelId}&modelVersionId=${modelVersionId}`
    );
  };

  useEffect(() => {
    form.reset({ details: userReview?.details ?? '' });
  }, [userReview?.details]); // eslint-disable-line

  const { isDirty } = form.formState;

  return (
    <Form form={form} onSubmit={handlePostClick}>
      <Group gap={0} align="flex-end" wrap="nowrap">
        <InputTextArea
          name="details"
          variant="unstyled"
          placeholder="Tell us more about why? What was it good at? Where did it struggle?"
          maxRows={5}
          minRows={2}
          styles={{ root: { flex: 1 }, input: { padding: '0 2px !important' } }}
          autoFocus
          autosize
        />
        <Group gap={8} wrap="nowrap">
          <ActionIcon
            size="lg"
            variant="light"
            disabled={updateMutation.isLoading}
            onClick={handleImageUploadClick}
          >
            <IconPhotoPlus size={16} />
          </ActionIcon>
          <ActionIcon
            variant="filled"
            size="lg"
            color="blue"
            type="submit"
            disabled={!isDirty}
            loading={updateMutation.isLoading || loadingUserReview}
          >
            <IconSend size={16} />
          </ActionIcon>
        </Group>
      </Group>
    </Form>
  );
}

type PropsV2 = {
  modelVersionId: number;
  userReview?: ResourceReviewSimpleModel | null;
  modelName?: string;
  showReviewedAt?: boolean;
  innerRef?: React.ForwardedRef<ReviewEditCommandsRef>;
  opened?: boolean;
  autoFocus?: boolean;
};

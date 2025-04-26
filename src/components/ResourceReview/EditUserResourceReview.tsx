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
import { styles } from './EditUserResourceReview.styles';

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
      <Stack spacing="xs">
        <Stack spacing={4}>
          <Group align="center" position="apart">
            <Stack spacing={0}>
              {modelName && <Text lineClamp={1}>{modelName}</Text>}
              {modelVersionName && (
                <Text lineClamp={1} size="xs" color="dimmed">
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
                  <Group spacing={4} sx={{ cursor: 'pointer' }}>
                    <IconChevronDown size={16} />{' '}
                    <span>{!resourceReview.details ? 'Add' : 'Edit'} Review Comments</span>
                  </Group>
                </Text>
              ) : (
                <Form form={form} onSubmit={handleSubmit}>
                  <Stack spacing="xs">
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
                    <Group grow spacing="xs">
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
  userReview,
  loading,
  children,
}: Props & { children: (props: UserResourceReviewCompositeProps) => JSX.Element | null }) {
  return children({ userReview, modelId, modelVersionId, modelName, loading });
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
  const [editDetail, setEditDetail] = useState(initialOpened);
  const toggleEditDetail = () => {
    setEditDetail((state) => !state);
    if (!editDetail) setTimeout(() => commentRef.current?.focus(), 100);
  };
  const commentRef = useRef<EditorCommandsRef | null>(null);

  const createMutation = useCreateResourceReview();
  const updateMutation = useUpdateResourceReview();

  const createReviewWithRating = (rating: number) => {
    createMutation.mutate({ modelVersionId, rating, recommended: rating >= 3 });
  };

  const updateReview = ({ rating, details }: { rating?: number; details?: string }) => {
    if (!userReview) return;
    updateMutation.mutate(
      { id: userReview.id, rating, details },
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
    defaultValues: { details: userReview?.details ?? '' },
  });
  const handleSubmit = ({ details }: z.infer<typeof schema>) => updateReview({ details });

  const handleCancel = () => {
    toggleEditDetail();
    form.reset({ details: userReview?.details ?? '' });
  };

  const handleRatingChange = (rating: number) => {
    !userReview?.id ? createReviewWithRating(rating) : updateReview({ rating });
  };

  useEffect(() => {
    form.reset({ details: userReview?.details ?? '' });
  }, [userReview?.details]); // eslint-disable-line

  // Used to call editor commands outside the component via a ref
  useImperativeHandle(innerRef, () => ({
    save: () => {
      if (form.formState.isDirty) form.handleSubmit(handleSubmit)();
    },
  }));

  return (
    <Card p={8} withBorder>
      <Stack spacing="xs">
        <Stack spacing={4}>
          <Group align="center" position="apart">
            <Stack spacing={0}>{modelName && <Text lineClamp={1}>{modelName}</Text>}</Stack>
            <Rating value={userReview?.rating} onChange={handleRatingChange} />
          </Group>
          {showReviewedAt && userReview?.createdAt && (
            <Text size="xs">
              Reviewed <DaysFromNow date={userReview.createdAt} />
            </Text>
          )}
        </Stack>

        {userReview?.id && (
          <>
            <Card.Section>
              <Divider />
            </Card.Section>
            <Stack>
              {!editDetail ? (
                <Text variant="link" onClick={toggleEditDetail} size="sm">
                  <Group spacing={4} sx={{ cursor: 'pointer' }}>
                    <IconChevronDown size={16} />{' '}
                    <span>{!userReview.details ? 'Add' : 'Edit'} Review Comments</span>
                  </Group>
                </Text>
              ) : (
                <Form form={form} onSubmit={handleSubmit}>
                  <Stack spacing="xs">
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
                    <Group grow spacing="xs">
                      <Button size="xs" variant="default" onClick={handleCancel}>
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

export function EditUserResourceReviewLight({
  modelVersionId,
  modelId,
  userReview,
}: Pick<PropsV2, 'modelVersionId' | 'userReview'> & { modelId: number }) {
  const [editDetail, setEditDetail] = useState(false);
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

  const updateReview = ({ details }: { details?: string }) => {
    if (!userReview) return;
    updateMutation.mutate(
      { id: userReview.id, details },
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
    defaultValues: { details: userReview?.details ?? '' },
  });
  const handlePostClick = ({ details }: z.infer<typeof schema>) => updateReview({ details });

  const handleImageUploadClick = async () => {
    // TODO: Implement image upload
  };

  useEffect(() => {
    form.reset({ details: userReview?.details ?? '' });
  }, [userReview?.details]); // eslint-disable-line

  return (
    <Card p={8} withBorder>
      <Stack spacing="xs">
        <Stack spacing={4}>
          <Group align="center" position="apart">
            <Stack spacing={0}>
              <Text lineClamp={1}>Your Review</Text>
            </Stack>
            <Rating value={userReview?.rating} onChange={createReviewWithRating} />
          </Group>
          {userReview?.createdAt && (
            <Text size="xs">
              Reviewed <DaysFromNow date={userReview.createdAt} />
            </Text>
          )}
        </Stack>

        {userReview?.id && (
          <>
            <Card.Section>
              <Divider />
            </Card.Section>
            <Stack>
              {!editDetail ? (
                <Text variant="link" onClick={toggleEditDetail} size="sm">
                  <Group spacing={4} sx={{ cursor: 'pointer' }}>
                    <IconChevronDown size={16} />{' '}
                    <span>{!userReview.details ? 'Add' : 'Edit'} Review Comments</span>
                  </Group>
                </Text>
              ) : (
                <Form form={form} onSubmit={handlePostClick}>
                  <Stack spacing="xs">
                    <InputRTE
                      name="details"
                      includeControls={['formatting', 'link']}
                      hideToolbar
                      editorSize="sm"
                      innerRef={commentRef}
                      placeholder="What did you think of this model?"
                      styles={{ content: { maxHeight: 500, overflowY: 'auto' } }}
                      // withLinkValidation
                    />
                    <Group grow spacing="xs">
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

type PropsV2 = {
  modelVersionId: number;
  userReview?: ResourceReviewSimpleModel | null;
  modelName?: string;
  showReviewedAt?: boolean;
  innerRef?: React.ForwardedRef<ReviewEditCommandsRef>;
  opened?: boolean;
  autoFocus?: boolean;
};

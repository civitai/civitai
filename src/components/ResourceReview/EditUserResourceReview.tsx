import { ResourceReviewModel } from '~/server/selectors/resourceReview.selector';
import { useEffect, useImperativeHandle, useRef, useState } from 'react';
import { Card, Group, Rating, Stack, Text, Divider, Button } from '@mantine/core';
import { DaysFromNow } from '~/components/Dates/DaysFromNow';
import { IconChevronDown } from '@tabler/icons-react';
import { InputRTE, useForm, Form } from '~/libs/form';
import { z } from 'zod';
import {
  useCreateResourceReview,
  useUpdateResourceReview,
} from '~/components/ResourceReview/resourceReview.utils';
import { EditorCommandsRef } from '~/components/RichTextEditor/RichTextEditor';

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
}: {
  resourceReview?: ResourceReviewModel;
  modelId: number;
  modelName?: string;
  modelVersionName?: string;
  modelVersionId: number;
  openedCommentBox?: boolean;
  innerRef?: React.ForwardedRef<ReviewEditCommandsRef>;
}) {
  const [editDetail, setEditDetail] = useState(openedCommentBox);
  const toggleEditDetail = () => {
    setEditDetail((state) => !state);
    if (!editDetail) setTimeout(() => commentRef.current?.focus(), 100);
  };
  const commentRef = useRef<EditorCommandsRef | null>(null);

  const createMutation = useCreateResourceReview({ modelId, modelVersionId });
  const updateMutation = useUpdateResourceReview({ modelId, modelVersionId });

  const createReviewWithRating = (rating: number) => {
    createMutation.mutate({ modelVersionId, modelId, rating });
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
    defaultValues: { details: resourceReview?.details ?? undefined },
  });
  const handleSubmit = ({ details }: z.infer<typeof schema>) => updateReview({ details });

  const handleRatingChange = (rating: number) => {
    !resourceReview?.id ? createReviewWithRating(rating) : updateReview({ rating });
  };

  useEffect(() => {
    form.reset({ details: resourceReview?.details ?? undefined });
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

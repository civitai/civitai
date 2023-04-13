import { ResourceReviewModel } from '~/server/selectors/resourceReview.selector';
import { useEffect, useState } from 'react';
import { Card, Group, Rating, Stack, Text, Divider, Button } from '@mantine/core';
import { DaysFromNow } from '~/components/Dates/DaysFromNow';
import { IconChevronDown } from '@tabler/icons';
import { InputRTE, useForm, Form } from '~/libs/form';
import { z } from 'zod';
import {
  useCreateResourceReview,
  useUpdateResourceReview,
} from '~/components/ResourceReview/resourceReview.utils';

const schema = z.object({
  details: z.string().optional(),
});

export function EditUserResourceReview({
  resourceReview,
  modelId,
  modelName,
  modelVersionId,
  openedCommentBox = false,
}: {
  resourceReview?: ResourceReviewModel;
  modelId: number;
  modelName?: string;
  modelVersionId: number;
  openedCommentBox?: boolean;
}) {
  const [editDetail, setEditDetail] = useState(openedCommentBox);
  const toggleEditDetail = () => setEditDetail((state) => !state);

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

  return (
    <Card p={8} withBorder>
      <Stack spacing="xs">
        <Stack spacing={4}>
          <Group align="center" position="apart">
            <Stack spacing={0}>
              {modelName && <Text lineClamp={1}>{modelName}</Text>}
              {resourceReview?.modelVersion.name && (
                <Text lineClamp={1} size="xs" color="dimmed">
                  {resourceReview?.modelVersion.name}
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
                      placeholder="Add review comments..."
                      styles={{ content: { maxHeight: 500, overflowY: 'auto' } }}
                      withLinkValidation
                    />
                    <Group grow spacing="xs">
                      <Button variant="default" onClick={toggleEditDetail}>
                        Cancel
                      </Button>
                      <Button type="submit" loading={updateMutation.isLoading}>
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

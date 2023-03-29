import { Card, Group, Rating, Stack, Text, Divider, Button } from '@mantine/core';
import { DaysFromNow } from '~/components/Dates/DaysFromNow';
import { trpc } from '~/utils/trpc';
import { useState } from 'react';
import { IconChevronDown } from '@tabler/icons';
import { InputRTE, useForm, Form } from '~/libs/form';
import { z } from 'zod';

type EditResourceReviewProps = {
  id?: number | null;
  modelId?: number | null;
  modelName?: string | null;
  modelVersionId?: number | null;
  modelVersionName?: string | null;
  rating?: number | null;
  details?: string | null;
  createdAt?: Date | null;
  name?: string | null;
};

const schema = z.object({
  details: z.string().optional(),
});

export function EditResourceReview({
  id: initialId,
  modelId,
  modelName,
  modelVersionId,
  modelVersionName,
  rating: initialRating,
  details: initialDetails,
  createdAt,
  name,
}: EditResourceReviewProps) {
  const [id, setId] = useState(initialId ?? undefined);
  const [rating, setRating] = useState(initialRating ?? undefined);
  const [details, setDetails] = useState(initialDetails ?? undefined);
  const { mutate, isLoading } = trpc.resourceReview.upsert.useMutation();

  const [editDetail, setEditDetail] = useState(false);
  const toggleEditDetail = () => setEditDetail((state) => !state);

  const handleRatingChange = (rating: number) => {
    if (!modelVersionId || !modelId) return;
    // stupid prisma
    mutate(
      { id: id ?? undefined, rating, modelVersionId, modelId },
      {
        onSuccess: async (response, request) => {
          setRating(rating);
          setId(response.id);
        },
      }
    );
  };

  const form = useForm({ schema, defaultValues: { details: details ?? undefined } });
  const handleSubmit = ({ details }: z.infer<typeof schema>) => {
    if (!modelId || !modelVersionId || !id || !rating) return;
    mutate(
      { id, modelVersionId, modelId, rating, details },
      {
        onSuccess: async (response, request) => {
          setDetails(details);
          form.reset({ details });
          toggleEditDetail();
        },
      }
    );
  };

  return (
    <Card p={8} withBorder>
      <Stack spacing="xs">
        {modelVersionId ? (
          <Stack spacing={4}>
            <Group align="center" position="apart" noWrap>
              <Stack spacing={0}>
                {modelName && <Text lineClamp={1}>{modelName}</Text>}
                {modelVersionName && (
                  <Text lineClamp={1} size="xs" color="dimmed">
                    {modelVersionName}
                  </Text>
                )}
              </Stack>
              <Rating value={rating} onChange={handleRatingChange} />
            </Group>
            {createdAt && (
              <Text size="xs">
                Reviewed <DaysFromNow date={createdAt} />
              </Text>
            )}
          </Stack>
        ) : (
          <Text>{name}</Text>
        )}
        {id && (
          <>
            <Card.Section>
              <Divider />
            </Card.Section>
            <Stack>
              {!editDetail ? (
                <Text variant="link" onClick={toggleEditDetail} size="sm">
                  <Group spacing={4}>
                    <IconChevronDown size={16} />{' '}
                    <span>{!details ? 'Add' : 'Edit'} Review Comments</span>
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
                      <Button type="submit" loading={isLoading}>
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

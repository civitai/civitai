import { Card, Group, Rating, Stack, Text, Divider, Button } from '@mantine/core';
import { DaysFromNow } from '~/components/Dates/DaysFromNow';
import { trpc } from '~/utils/trpc';
import { useState } from 'react';
import { IconCaretDown } from '@tabler/icons';
import { InputRTE, useForm, Form } from '~/libs/form';
import { z } from 'zod';

type EditResourceReviewProps = {
  id?: number | null;
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
    if (!modelVersionId) return;
    // stupid prisma
    mutate(
      { id: id ?? undefined, rating, modelVersionId },
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
    console.log({ rating });
    if (!modelVersionId || !id || !rating) return;
    mutate(
      { id, modelVersionId, rating, details },
      {
        onSuccess: async (response, request) => {
          setDetails(details);
          form.reset({ details });
        },
      }
    );
  };

  return (
    <Card p={8} withBorder>
      {modelVersionId ? (
        <Stack>
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
            <Divider p={0} />
          </Card.Section>
          <Stack>
            {!editDetail ? (
              <Text variant="link" onClick={toggleEditDetail}>
                <IconCaretDown size={16} /> {!details ? 'Add' : 'Edit'} Review Comments
              </Text>
            ) : (
              <Form form={form} onSubmit={handleSubmit}>
                <Stack>
                  <InputRTE
                    name="details"
                    includeControls={['formatting', 'link']}
                    editorSize="md"
                    placeholder="Add review comments..."
                  />
                  <Button.Group>
                    <Button variant="default" onClick={toggleEditDetail}>
                      Cancel
                    </Button>
                    <Button type="submit">Save</Button>
                  </Button.Group>
                </Stack>
              </Form>
            )}
          </Stack>
        </>
      )}
    </Card>
  );
}

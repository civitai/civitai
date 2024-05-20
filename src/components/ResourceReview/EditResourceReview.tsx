import { Button, Card, Divider, Group, Stack, Text } from '@mantine/core';
import { IconChevronDown } from '@tabler/icons-react';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { z } from 'zod';

import { DaysFromNow } from '~/components/Dates/DaysFromNow';
import { ThumbsDownIcon, ThumbsUpIcon } from '~/components/ThumbsIcon/ThumbsIcon';
import { Form, InputRTE, useForm } from '~/libs/form';
import { trpc } from '~/utils/trpc';

type EditResourceReviewProps = {
  id?: number | null;
  modelId?: number | null;
  modelName?: string | null;
  modelVersionId?: number | null;
  modelVersionName?: string | null;
  rating?: number | null;
  recommended?: boolean | null;
  details?: string | null;
  createdAt?: Date | null;
  name?: string | null;
  onSuccess?: (id: number) => void;
  onCancel?: VoidFunction;
  thumbsUpCount?: number;
  initialEditing?: boolean;
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
  recommended: initialRecommended,
  details: initialDetails,
  createdAt,
  name,
  onSuccess,
  onCancel,
  initialEditing = false,
}: EditResourceReviewProps) {
  const [id, setId] = useState(initialId ?? undefined);
  const [rating, setRating] = useState(initialRating ?? 0);
  const [recommended, setRecommended] = useState(initialRecommended ?? null);
  const [details, setDetails] = useState<string | undefined>(initialDetails ?? '');
  const { mutate, isLoading } = trpc.resourceReview.upsert.useMutation();

  const [editDetail, setEditDetail] = useState(initialEditing);
  const toggleEditDetail = () => {
    setEditDetail((state) => !state);
  };

  const queryUtils = trpc.useUtils();

  const handleRatingChange = (recommended: boolean) => {
    if (!modelVersionId || !modelId) return;

    const rating = recommended ? 5 : 1;
    mutate(
      { id: id ?? undefined, rating, recommended, modelVersionId, modelId },
      {
        onSuccess: async (response) => {
          setRating(rating);
          setRecommended(recommended);
          setId(response.id);
          await queryUtils.resourceReview.getUserResourceReview.invalidate();
        },
      }
    );
  };

  const form = useForm({ schema, defaultValues: { details: details ?? '' } });
  const handleSubmit = ({ details }: z.infer<typeof schema>) => {
    if (!modelId || !modelVersionId || !id || !recommended) return;

    mutate(
      { id, modelVersionId, modelId, rating, recommended, details },
      {
        onSuccess: async () => {
          setDetails(details);
          form.reset({ details });
          toggleEditDetail();
          onSuccess?.(id);
          await queryUtils.resourceReview.getUserResourceReview.invalidate();
        },
      }
    );
  };

  useEffect(() => {
    form.reset({ details });
  }, [details]); // eslint-disable-line
  const { isDirty } = form.formState;

  const isThumbsUp = recommended === true;
  const isThumbsDown = recommended === false;

  return (
    <Card p={8} withBorder>
      <Stack spacing="xs">
        {modelId && modelVersionId ? (
          <Stack spacing={4}>
            <Group align="center" position="apart">
              <Link href={`/models/${modelId}?modelVersionId=${modelVersionId}`} target="_blank">
                <Stack spacing={0} sx={{ cursor: 'pointer' }}>
                  {modelName && <Text lineClamp={1}>{modelName}</Text>}
                  {modelVersionName && (
                    <Text lineClamp={1} size="xs" color="dimmed">
                      {modelVersionName}
                    </Text>
                  )}
                </Stack>
              </Link>
            </Group>
            {createdAt && (
              <Text size="xs" color="dimmed">
                Reviewed <DaysFromNow date={createdAt} />
              </Text>
            )}

            <Button.Group style={{ gap: 4 }}>
              <Button
                variant={isThumbsUp ? 'light' : 'filled'}
                color={isThumbsUp ? 'success' : 'dark.4'}
                radius="md"
                loading={isLoading}
                onClick={() => (!isThumbsUp ? handleRatingChange(true) : undefined)}
                fullWidth
              >
                <Text color="success.5" size="xs" inline>
                  <Group spacing={4} noWrap>
                    <ThumbsUpIcon size={20} filled={isThumbsUp} />{' '}
                  </Group>
                </Text>
              </Button>
              <Button
                variant={isThumbsDown ? 'light' : 'filled'}
                color={isThumbsDown ? 'red' : 'dark.4'}
                radius="md"
                loading={isLoading}
                onClick={() => (!isThumbsDown ? handleRatingChange(false) : undefined)}
                fullWidth
              >
                <Text color="red" inline>
                  <ThumbsDownIcon size={20} filled={isThumbsDown} />
                </Text>
              </Button>
            </Button.Group>
          </Stack>
        ) : (
          <Text>{name}</Text>
        )}
        <Card.Section>
          <Divider />
        </Card.Section>
        {id ? (
          <Stack>
            {!editDetail ? (
              <Text variant="link" onClick={toggleEditDetail} size="sm">
                <Group spacing={4} sx={{ cursor: 'pointer' }}>
                  <IconChevronDown size={16} />{' '}
                  <span>{!details ? 'Add' : 'Edit'} Review Comments</span>
                </Group>
              </Text>
            ) : (
              <Form form={form} onSubmit={handleSubmit}>
                <Stack spacing={4}>
                  <InputRTE
                    name="details"
                    includeControls={['formatting', 'link']}
                    editorSize="sm"
                    placeholder={`What did you think of ${modelName ?? 'this resource'}?`}
                    styles={{
                      content: {
                        minHeight: 50,
                        maxHeight: 500,
                        padding: 0,
                        fontSize: 12,

                        '.ProseMirror': {
                          padding: `6px 10px`,
                          minHeight: 22,
                          cursor: 'text',
                        },
                        '.ProseMirror p.is-editor-empty:first-of-type::before': {
                          fontSize: 12,
                        },
                      },
                    }}
                    hideToolbar
                    autoFocus
                  />
                  <Group grow spacing={4}>
                    <Button
                      size="xs"
                      variant="default"
                      onClick={() => {
                        toggleEditDetail();
                        onCancel?.();
                      }}
                    >
                      Cancel
                    </Button>
                    <Button size="xs" type="submit" loading={isLoading} disabled={!isDirty}>
                      Save
                    </Button>
                  </Group>
                </Stack>
              </Form>
            )}
          </Stack>
        ) : (
          <Text size="sm" color="dimmed">
            What did you think of this resource?
          </Text>
        )}
      </Stack>
    </Card>
  );
}

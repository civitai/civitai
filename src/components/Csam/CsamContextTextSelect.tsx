import { Badge, Button, Card, Checkbox, Group, Input, Loader, Stack, Text } from '@mantine/core';
import { useState } from 'react';
import type { CsamContextSources } from '~/server/schema/csam.schema';
import type { CsamContextPreview } from '~/server/services/csam-context-text';
import { formatDate } from '~/utils/date-helpers';
import { trpc } from '~/utils/trpc';

export const noContextSources: CsamContextSources = {
  postIds: [],
  commentIds: [],
  chatMessageIds: [],
  modelIds: [],
  articleIds: [],
  serviceOfferingIds: [],
  profile: false,
};

export const hasContextSources = ({ profile, ...lists }: CsamContextSources) =>
  profile || Object.values(lists).some((ids) => ids.length > 0);

export function CsamContextTextSelect({
  userId,
  imageIds,
  value,
  onChange,
}: {
  userId: number;
  imageIds: number[];
  value: CsamContextSources;
  onChange: (value: CsamContextSources) => void;
}) {
  const { data, isLoading, error } = trpc.csam.getContextCandidates.useQuery(
    { userId, imageIds },
    { enabled: imageIds.length > 0 }
  );

  type Source = 'postDescription' | 'comment';
  const key = (source: Source) => (source === 'postDescription' ? 'postIds' : 'commentIds');
  const toggle = (source: Source, id: number, checked: boolean) => {
    const field = key(source);
    const ids = value[field].filter((x) => x !== id);
    onChange({ ...value, [field]: checked ? [...ids, id] : ids });
  };

  return (
    <Input.Wrapper
      label="Text posted with these images"
      description="Tick the post descriptions and comments to include in the report. Their text is copied when you submit."
    >
      <Stack gap="sm" mt="xs">
        {isLoading && imageIds.length > 0 ? (
          <Loader size="sm" />
        ) : error ? (
          <Text c="red" size="sm">
            Could not load the text for these images.
          </Text>
        ) : !data?.candidates.length ? (
          <Text size="sm" c="dimmed">
            No post description or comment on these images.
          </Text>
        ) : (
          data.candidates.map((candidate) =>
            candidate.source === 'postText' ? (
              <HeldTextItem
                key={`${candidate.source}:${candidate.id}`}
                candidate={candidate}
                userId={userId}
                imageIds={imageIds}
              />
            ) : (
              <Checkbox
                key={`${candidate.source}:${candidate.id}`}
                checked={value[key(candidate.source as Source)].includes(candidate.id)}
                onChange={(e) =>
                  toggle(candidate.source as Source, candidate.id, e.currentTarget.checked)
                }
                label={
                  <Stack gap={4}>
                    <Group gap="xs">
                      <Text size="sm" fw={600}>
                        {candidate.source === 'postDescription'
                          ? `Post ${candidate.postId} text`
                          : `Comment ${candidate.id}`}
                      </Text>
                      <Badge size="xs" variant="light">
                        {candidate.authorIsReportedUser ? 'reported account' : 'another account'}
                      </Badge>
                      {candidate.deleted && (
                        <Badge size="xs" color="gray">
                          deleted
                        </Badge>
                      )}
                      {candidate.hidden && (
                        <Badge size="xs" color="gray">
                          hidden
                        </Badge>
                      )}
                      <Text size="xs" c="dimmed">
                        {formatDate(candidate.postedAt)}
                      </Text>
                    </Group>
                    <Text size="sm" className="whitespace-pre-wrap" lineClamp={8}>
                      {candidate.text}
                    </Text>
                    {candidate.fullLength && (
                      <Text size="xs" c="dimmed">
                        Preview of {candidate.fullLength.toLocaleString()} characters. The full text
                        is copied.
                      </Text>
                    )}
                  </Stack>
                }
              />
            )
          )
        )}
        {data?.more && (
          <Text size="xs" c="dimmed">
            Only the newest comments are listed. More comments exist on these images.
          </Text>
        )}
      </Stack>
    </Input.Wrapper>
  );
}

/**
 * A held text item: captured with its post's text, and sent marked as not reviewed by Civitai
 * unless you read it here first. Reading it records that you did.
 */
function HeldTextItem({
  candidate,
  userId,
  imageIds,
}: {
  candidate: CsamContextPreview;
  userId: number;
  imageIds: number[];
}) {
  const [read, setRead] = useState<{ text: string; readAt: string }>();
  const readText = trpc.csam.readHeldContextText.useMutation({ onSuccess: setRead });

  return (
    <Card withBorder p="xs" ml="xl">
      <Stack gap={4}>
        <Group gap="xs">
          <Text size="sm" fw={600}>
            Held text item {candidate.id} of post {candidate.postId}
          </Text>
          <Badge size="xs" variant="light">
            {candidate.authorIsReportedUser ? 'reported account' : 'another account'}
          </Badge>
          <Badge size="xs" color={read || candidate.reviewed ? 'green' : 'orange'}>
            {read ? 'read by you' : candidate.reviewed ? 'reviewed at its hold' : 'not reviewed'}
          </Badge>
        </Group>
        <Text size="xs" c="dimmed">
          Copied with post {candidate.postId}&apos;s text when that is ticked. It is sent marked
          &quot;Not reviewed by Civitai&quot; unless you read it here before you submit, or its hold
          was confirmed on its own.
        </Text>
        {read ? (
          <Text size="sm" className="whitespace-pre-wrap">
            {read.text}
          </Text>
        ) : (
          <Group>
            <Button
              size="compact-xs"
              variant="light"
              loading={readText.isPending}
              onClick={() => readText.mutate({ userId, imageIds, postTextId: candidate.id })}
            >
              Read the text
            </Button>
            {readText.error && (
              <Text size="xs" c="red">
                {readText.error.message}
              </Text>
            )}
          </Group>
        )}
      </Stack>
    </Card>
  );
}

import { Badge, Checkbox, Group, Input, Loader, Stack, Text } from '@mantine/core';
import type { CsamContextSources } from '~/server/schema/csam.schema';
import { formatDate } from '~/utils/date-helpers';
import { trpc } from '~/utils/trpc';

export const noContextSources: CsamContextSources = { postIds: [], commentIds: [] };

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

  const key = (source: 'postDescription' | 'comment') =>
    source === 'postDescription' ? 'postIds' : 'commentIds';
  const toggle = (source: 'postDescription' | 'comment', id: number, checked: boolean) => {
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
          data.candidates.map((candidate) => (
            <Checkbox
              key={`${candidate.source}:${candidate.id}`}
              checked={value[key(candidate.source)].includes(candidate.id)}
              onChange={(e) => toggle(candidate.source, candidate.id, e.currentTarget.checked)}
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
          ))
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

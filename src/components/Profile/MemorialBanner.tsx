import { Alert, Anchor, Badge, Group, Stack, Text, ThemeIcon } from '@mantine/core';
import { IconCandle } from '@tabler/icons-react';
import type { MemorialTribute } from '@civitai/shared/memorial';

export function MemorialBadge() {
  return (
    <Badge color="gray" variant="light" leftSection={<IconCandle size={14} />}>
      Remembering
    </Badge>
  );
}

export function MemorialBanner({
  username,
  tributes,
}: {
  username: string;
  tributes: MemorialTribute[];
}) {
  return (
    <Alert color="gray" px="xs">
      <Group gap="xs" wrap="nowrap" align="flex-start">
        <ThemeIcon size={32} variant="transparent" color="gray" p={0}>
          <IconCandle />
        </ThemeIcon>
        <Stack gap={4}>
          <Text size="sm">
            Remembering {username}. This profile is memorialized so the work {username} shared stays
            here for the community.
          </Text>
          {tributes.length > 0 && (
            <Text size="sm">
              <Text span size="sm" c="dimmed">
                Tributes:
              </Text>{' '}
              {tributes.map((tribute, index) => (
                <span key={tribute.url}>
                  {index > 0 && ', '}
                  <Anchor href={tribute.url} size="sm" underline="always">
                    {tribute.label}
                  </Anchor>
                </span>
              ))}
            </Text>
          )}
        </Stack>
      </Group>
    </Alert>
  );
}

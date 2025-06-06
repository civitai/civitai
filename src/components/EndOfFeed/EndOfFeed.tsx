import { Center, Divider, Group, Stack, Text } from '@mantine/core';
import { IconClock } from '@tabler/icons-react';
import type { ReactNode } from 'react';
import { useScrollAreaRef } from '~/components/ScrollArea/ScrollAreaContext';

export function EndOfFeed({ text }: { text?: ReactNode }) {
  const node = useScrollAreaRef();
  return (
    <Stack mt="xl">
      <Divider
        size="sm"
        label={
          <Group gap={4}>
            <IconClock size={16} stroke={1.5} />
            You are all caught up
          </Group>
        }
        labelPosition="center"
        className="text-sm"
      />
      <Center>
        <Stack gap={0} align="center">
          <Text size="sm" c="dimmed">
            {text ?? 'Consider changing your period or filters to find more'}
          </Text>
          <Text
            c="blue.4"
            size="sm"
            onClick={() => {
              node?.current?.scrollTo({ top: 0, behavior: 'smooth' });
            }}
            style={{ cursor: 'pointer' }}
          >
            Back to the top
          </Text>
        </Stack>
      </Center>
    </Stack>
  );
}

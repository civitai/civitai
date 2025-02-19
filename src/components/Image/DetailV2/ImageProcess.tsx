import { Card, Text, Badge, UnstyledButton, Popover, MantineColor } from '@mantine/core';
import { IconChartBubble, IconMessage } from '@tabler/icons-react';
import { LineClamp } from '~/components/LineClamp/LineClamp';
import { slugit } from '~/utils/string-helpers';
import { trpc } from '~/utils/trpc';
import { NextLink as Link } from '~/components/NextLink/NextLink';

const toolPriorityColor: Record<number, MantineColor> = {
  1: 'teal.3',
  2: 'yellow.4',
  3: 'gray.4',
  4: 'orange.5',
};

export function ImageProcess({ imageId }: { imageId: number }) {
  const { data } = trpc.image.getGenerationData.useQuery({ id: imageId });
  if (!data) return null;

  const { tools, techniques } = data;
  if (!tools.length && !techniques.length) return null;

  return (
    <Card className="flex flex-col gap-3 rounded-xl">
      <Text className="flex items-center gap-2 text-xl font-semibold">
        <IconChartBubble />
        <span>Process</span>
      </Text>
      {!!tools.length && (
        <div className="flex flex-col gap-1">
          <div className="flex items-center justify-between">
            <Text className="font-semibold">Tools</Text>
          </div>
          <div className="flex flex-wrap gap-2">
            {tools.map(({ id, name, notes, priority }) => {
              const color = priority ? toolPriorityColor[priority] : undefined;

              return (
                <Badge
                  key={id}
                  size="lg"
                  className={`rounded-full border border-blue-8/30 ${notes ? 'pr-2' : ''}`}
                  color={color}
                  classNames={{ inner: 'flex gap-1 h-full' }}
                >
                  <Link
                    href={`/tools/${slugit(name)}?tools=${id}`}
                    as={`/tools/${slugit(name)}`}
                    data-activity={`tool-click:${id}`}
                  >
                    {name}
                  </Link>
                  {notes && (
                    <>
                      <div className="h-full border-l border-blue-8/30 "></div>
                      <Popover width={300} withinPortal>
                        <Popover.Target>
                          <UnstyledButton>
                            <IconMessage size={18} className="text-blue-6 dark:text-blue-2" />
                          </UnstyledButton>
                        </Popover.Target>
                        <Popover.Dropdown>
                          <Text size="sm">{notes}</Text>
                        </Popover.Dropdown>
                      </Popover>
                    </>
                  )}
                </Badge>
              );
            })}
          </div>
        </div>
      )}
      {!!techniques.length && (
        <div className="flex flex-col gap-1">
          <div className="flex items-center justify-between">
            <Text className="font-semibold">Techniques</Text>
          </div>
          <ul className="flex list-none flex-col gap-2">
            {techniques.map(({ id, name, notes }) => (
              <li key={id}>
                <Text>{name}</Text>
                {notes && (
                  <LineClamp lineClamp={1} color="dimmed">
                    {notes}
                  </LineClamp>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
    </Card>
  );
}

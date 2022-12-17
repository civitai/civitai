import { ActionIcon, Group, Text, Tooltip } from '@mantine/core';
import { IconPencil, IconTrash } from '@tabler/icons';
import { DomainIcon } from '~/components/DomainIcon/DomainIcon';
import { GetUserLinksResult } from '~/server/controllers/user-link.controller';
import { trpc } from '~/utils/trpc';

export function SocialLink({
  link,
  setSelected,
}: {
  link: GetUserLinksResult[0];
  setSelected: (data: GetUserLinksResult[0]) => void;
}) {
  const utils = trpc.useContext();

  const { mutate, isLoading } = trpc.userLink.delete.useMutation({
    onSuccess: () => {
      utils.userLink.invalidate();
    },
  });

  return (
    <Group noWrap spacing="sm">
      <DomainIcon url={link.url} />
      <Text lineClamp={1} size="sm" style={{ flex: 1 }}>
        {link.url}
      </Text>
      <Group noWrap spacing="xs">
        <Tooltip label="Edit link">
          <ActionIcon onClick={() => setSelected(link)} variant="default" size="md">
            <IconPencil size={14} />
          </ActionIcon>
        </Tooltip>
        <Tooltip label="Delete link">
          <ActionIcon
            color="red"
            onClick={() => mutate({ id: link.id })}
            loading={isLoading}
            variant="outline"
            size="md"
          >
            <IconTrash size={14} />
          </ActionIcon>
        </Tooltip>
      </Group>
    </Group>
  );
}

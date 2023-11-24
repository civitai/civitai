import { Badge, CloseButton, Group, Stack, Text, Divider } from '@mantine/core';

import { createContextModal } from '~/components/Modals/utils/createContextModal';
import { UserBuzz } from '../User/UserBuzz';
import { BuzzPurchase } from '~/components/Buzz/BuzzPurchase';

const { openModal, Modal } = createContextModal<{
  entityId?: number;
  entityType?: 'Model' | 'Article';
  clubId?: number;
}>({
  name: 'manageClubPostModal',
  withCloseButton: false,
  centered: true,
  size: 'lg',
  radius: 'lg',
  zIndex: 400,
  Element: ({ context, props: { entityType, entityId, clubId } }) => {
    // TOOD: fetch club entity.
    // const { data: clubEntity, isLoading } = trpc.club

    const handleClose = () => {
      context.close();
    };

    return (
      <Stack spacing="md">
        <Group position="apart" noWrap>
          <Text size="lg" weight={700}></Text>
          <Group spacing="sm" noWrap>
            <Badge
              radius="xl"
              variant="filled"
              h="auto"
              py={4}
              px={12}
              sx={(theme) => ({
                backgroundColor:
                  theme.colorScheme === 'dark' ? theme.fn.rgba('#000', 0.31) : theme.colors.gray[0],
              })}
            >
              <Group spacing={4} noWrap>
                <Text size="xs" color="dimmed" transform="capitalize" weight={600}>
                  Available Buzz
                </Text>
                <UserBuzz iconSize={16} textSize="sm" withTooltip />
              </Group>
            </Badge>
            <CloseButton radius="xl" iconSize={22} onClick={handleClose} />
          </Group>
        </Group>
        <Divider mx="-lg" />
      </Stack>
    );
  },
});

export const openManageClubPostModal = openModal;
export default Modal;

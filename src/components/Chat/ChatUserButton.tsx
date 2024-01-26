import { Button, ButtonProps, Group, useMantineTheme } from '@mantine/core';
import { IconMessage2 } from '@tabler/icons-react';
import { useChatContext } from '~/components/Chat/ChatProvider';
import { LoginPopover } from '~/components/LoginPopover/LoginPopover';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { UserWithCosmetics } from '~/server/selectors/user.selector';

export function ChatUserButton({
  user,
  ...buttonProps
}: { user: Partial<UserWithCosmetics> } & ButtonProps) {
  const { setState } = useChatContext();
  const theme = useMantineTheme();
  const features = useFeatureFlags();

  const handleClick = () => {
    setState((prev) => ({ ...prev, open: true, existingChatId: undefined, selectedUsers: [user] }));
  };

  if (!features.chat) return <></>;

  return (
    <LoginPopover>
      <Button
        variant={theme.colorScheme === 'dark' ? 'filled' : 'light'}
        color="gray"
        radius="xl"
        pl={8}
        pr={12}
        onClick={handleClick}
        // TODO do we like this color
        sx={{ fontSize: 12, fontWeight: 600, lineHeight: 1.5, color: theme.colors.success[2] }}
        {...buttonProps}
      >
        <Group spacing={4} noWrap>
          <IconMessage2 size={14} />
          Chat
        </Group>
      </Button>
    </LoginPopover>
  );
}

import type { ButtonProps } from '@mantine/core';
import { Button, Group, useComputedColorScheme, useMantineTheme } from '@mantine/core';
import { IconMessage2 } from '@tabler/icons-react';
import { useChatContext } from '~/components/Chat/ChatProvider';
import { LoginPopover } from '~/components/LoginPopover/LoginPopover';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import type { UserWithCosmetics } from '~/server/selectors/user.selector';

export function ChatUserButton({
  user,
  label,
  ...buttonProps
}: {
  user: Partial<UserWithCosmetics>;
  label?: string;
} & ButtonProps) {
  const { setState } = useChatContext();
  const theme = useMantineTheme();
  const features = useFeatureFlags();
  const currentUser = useCurrentUser();
  const colorScheme = useComputedColorScheme('dark');

  const handleClick = () => {
    setState((prev) => ({
      ...prev,
      open: !prev.open,
      isCreating: true,
      existingChatId: undefined,
      selectedUsers: [user],
    }));
  };

  if (!features.chat || user.id === currentUser?.id) return <></>;

  return (
    <LoginPopover>
      <Button
        variant={colorScheme === 'dark' ? 'filled' : 'light'}
        color="gray"
        radius="xl"
        pl={8}
        pr={label ? 12 : 8}
        onClick={handleClick}
        // TODO do we like this color
        style={{ fontSize: 12, fontWeight: 600, lineHeight: 1.5, color: theme.colors.success[2] }}
        {...buttonProps}
      >
        <Group gap={4} wrap="nowrap">
          <IconMessage2 size={14} />
          {label ?? 'Chat'}
        </Group>
      </Button>
    </LoginPopover>
  );
}

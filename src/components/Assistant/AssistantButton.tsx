import type { ButtonProps } from '@mantine/core';
import { Button } from '@mantine/core';
import { IconCat, IconMessageChatbot, IconX } from '@tabler/icons-react';
import { AssistantChat } from '~/components/Assistant/AssistantChat';
import { useAssistantAvailable } from '~/components/Assistant/useAssistantAvailable';
import { IsClient } from '~/components/IsClient/IsClient';
import { useAssistantPanelStore } from '~/store/assistant-panel.store';

const WIDTH = 320;
const HEIGHT = 500;

export function AssistantButton({ ...props }: ButtonProps) {
  const open = useAssistantPanelStore((state) => state.opened);
  const assistant = useAssistantAvailable();

  if (!assistant) return null;

  const Icon = assistant.personality === 'civchan' ? IconCat : IconMessageChatbot;
  const color = assistant.personality === 'civchan' ? 'pink' : 'blue';

  return (
    <IsClient>
      {open && (
        <div className="absolute bottom-full right-0 mb-1">
          <AssistantChat width={WIDTH} height={HEIGHT} />
        </div>
      )}
      <Button
        component="span"
        px="xs"
        {...props}
        color={open ? 'gray' : color}
        onClick={() => useAssistantPanelStore.setState({ opened: !open })}
      >
        {open ? <IconX size={20} stroke={2.5} /> : <Icon size={20} stroke={2.5} />}
      </Button>
    </IsClient>
  );
}

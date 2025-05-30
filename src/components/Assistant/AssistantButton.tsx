import type { ButtonProps } from '@mantine/core';
import { Button } from '@mantine/core';
import { IconCat, IconMessageChatbot, IconX } from '@tabler/icons-react';
import { useState } from 'react';
import { AssistantChat, getAssistantUUID } from '~/components/Assistant/AssistantChat';
import { useCurrentUserSettings } from '~/components/UserSettings/hooks';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { isApril1 } from '~/utils/date-helpers';

const WIDTH = 320;
const HEIGHT = 500;

export function AssistantButton({ ...props }: ButtonProps) {
  const [open, setOpen] = useState(false);
  const features = useFeatureFlags();
  const currentUser = useCurrentUser();
  const { assistantPersonality } = useCurrentUserSettings();

  if (!currentUser || !features.assistant) return null;

  const userPersonality = assistantPersonality ?? 'civbot';
  const gpttUUID = getAssistantUUID(userPersonality);
  if (!gpttUUID) return null;

  const Icon = isApril1() || userPersonality === 'civchan' ? IconCat : IconMessageChatbot;
  const color = isApril1() || userPersonality === 'civchan' ? 'pink' : 'blue';

  return (
    <>
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
        onClick={() => setOpen((o) => !o)}
      >
        {open ? <IconX size={20} stroke={2.5} /> : <Icon size={20} stroke={2.5} />}
      </Button>
    </>
  );
}

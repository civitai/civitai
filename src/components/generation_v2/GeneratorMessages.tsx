/** Mod-authored generator messages, rendered above the submit row. */

import { Alert, Text } from '@mantine/core';
import { IconCoin, IconInfoCircle, IconTool } from '@tabler/icons-react';
import { useEffect, useMemo } from 'react';

import { useGenerationConfig } from '~/components/ImageGeneration/GenerationForm/generation.utils';
import { useIsClient } from '~/providers/IsClientProvider';
import {
  messageDismissId,
  messagesForSelection,
  type GeneratorMessage,
  type MessageKind,
} from '~/shared/generation/messages';
import { generatorMessageDismissals } from '~/store/generator-message-dismissal.store';

import { gateSelectionFrom, type GateSelectionValues } from './gate-block';

const KIND_STYLE: Record<MessageKind, { color: string; Icon: typeof IconInfoCircle }> = {
  pricing: { color: 'yellow', Icon: IconCoin },
  maintenance: { color: 'orange', Icon: IconTool },
  info: { color: 'blue', Icon: IconInfoCircle },
};

function GeneratorMessageAlert({ message }: { message: GeneratorMessage }) {
  const dismissId = messageDismissId(message);
  const dismissed = generatorMessageDismissals.useDismissed().includes(dismissId);
  const isClient = useIsClient();
  const { color, Icon } = KIND_STYLE[message.kind];

  // localStorage-backed, so nothing dismissible may render before `isClient` —
  // server and first client render must agree.
  if (message.dismissible && (!isClient || dismissed)) return null;

  return (
    <Alert
      color={color}
      radius="md"
      py={8}
      icon={<Icon size={20} />}
      // Title-less: Mantine's icon slot is a fixed 20px box in a wrapper with
      // no `align-items`, so the icon hangs above single-line copy without this.
      classNames={{ wrapper: 'items-center' }}
      withCloseButton={message.dismissible}
      closeButtonLabel="Dismiss this message"
      onClose={
        message.dismissible ? () => generatorMessageDismissals.dismiss(dismissId) : undefined
      }
    >
      <Text size="xs">{message.message}</Text>
    </Alert>
  );
}

export function GeneratorMessageAlerts({ selection }: { selection: GateSelectionValues }) {
  const { generatorMessages } = useGenerationConfig();
  const { ecosystem, workflow, versionIds } = gateSelectionFrom(selection);
  const fingerprint = `${ecosystem ?? ''}|${workflow ?? ''}|${versionIds?.join(',') ?? ''}`;

  const matches = useMemo(
    () => messagesForSelection(generatorMessages, { ecosystem, workflow, versionIds }),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- selection is rebuilt each render; compare by value
    [generatorMessages, fingerprint]
  );

  // Not before the config lands: an unresolved query reads as "no messages" and
  // would prune every dismissal away.
  useEffect(() => {
    if (!generatorMessages.length) return;
    generatorMessageDismissals.prune(generatorMessages.map(messageDismissId));
  }, [generatorMessages]);

  if (!matches.length) return null;

  return (
    <div className="flex flex-col gap-2">
      {matches.map((message) => (
        <GeneratorMessageAlert key={message.id} message={message} />
      ))}
    </div>
  );
}

import { Button, Modal, Stack, Text } from '@mantine/core';
import { IconBrandDiscord, IconLink } from '@tabler/icons-react';
import type { ReactNode } from 'react';
import { useDialogContext } from '~/components/Dialog/DialogProvider';
import { dialogStore } from '~/components/Dialog/dialogStore';
import {
  CIVITAI_DISCORD_INVITE,
  DISCORD_LINK_ROLE_HREF,
  type DiscordRoleTier,
} from '~/components/CreatorJourney/discord-claim-guide';

const tierNames: Record<DiscordRoleTier, string> = {
  supernova: 'Supernova',
  legend: 'Legend',
  mythic: 'Mythic',
};

export function DiscordClaimGuideModal({ tier }: { tier: DiscordRoleTier }) {
  const dialog = useDialogContext();
  const name = tierNames[tier];

  return (
    <Modal {...dialog} title={`How to claim your ${name} role on Discord`} centered>
      <ol className="m-0 flex list-none flex-col gap-4 p-0">
        <Step number={1} text="Link your Discord account to Civitai.">
          <Button
            component="a"
            href={DISCORD_LINK_ROLE_HREF}
            size="xs"
            variant="light"
            leftSection={<IconLink size={14} />}
          >
            Link Discord
          </Button>
        </Step>
        <Step number={2} text="Join the Civitai Discord server with that same Discord account.">
          <Button
            component="a"
            href={CIVITAI_DISCORD_INVITE}
            target="_blank"
            rel="noreferrer"
            size="xs"
            leftSection={<IconBrandDiscord size={14} />}
            className="bg-[#5865f2] hover:bg-[#4752c4]"
          >
            Join the server
          </Button>
        </Step>
        <Step
          number={3}
          text={`Your ${name} role is added automatically, usually within 6 hours. We can only add it once you are in the server.`}
        />
        {tier === 'legend' && (
          <Step number={4} text="Then find the #legends channel in the server." />
        )}
      </ol>
    </Modal>
  );
}

function Step({ number, text, children }: { number: number; text: string; children?: ReactNode }) {
  return (
    <li className="flex gap-3">
      <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-gray-2 text-sm font-bold dark:bg-dark-4">
        {number}
      </span>
      <Stack gap={6} align="flex-start" className="min-w-0">
        <Text size="sm">{text}</Text>
        {children}
      </Stack>
    </li>
  );
}

export const openDiscordClaimGuide = (tier: DiscordRoleTier, onClose?: () => void) =>
  dialogStore.trigger({
    id: 'discord-claim-guide',
    component: DiscordClaimGuideModal,
    props: { tier },
    options: { onClose },
  });

import {
  Alert,
  Button,
  Container,
  Group,
  Paper,
  Stack,
  Text,
  ThemeIcon,
  Title,
} from '@mantine/core';
import {
  IconBrandDiscord,
  IconCircleCheck,
  IconExclamationMark,
  IconHome,
} from '@tabler/icons-react';
import { hubLoginUrl } from '@civitai/auth/client';
import { AlertWithIcon } from '~/components/AlertWithIcon/AlertWithIcon';
import { NextLink as Link } from '~/components/NextLink/NextLink';
import { dbRead } from '~/server/db/client';
import { discord } from '~/server/integrations/discord';
import { getUserDiscordMetadata } from '~/server/jobs/push-discord-metadata';
import { createServerSideProps } from '~/server/utils/server-side-helpers';
import { getLoginLink } from '~/utils/login-helpers';
import { env } from '~/env/client';

type Props = {
  linked: boolean;
};

// Re-authorize Discord for the CURRENT user via the hub's account-LINKING flow (auth.civitai.com/login/discord
// ?link=true). The hub requests the `role_connections.write` scope and stores the GRANTED scope on the Account,
// so on return this page's getServerSideProps sees it and pushes the role-connection metadata. Replaces the old
// in-app SocialButton + handleSignIn — the hub owns OAuth + scope storage now.
function connectDiscord() {
  const hub = env.NEXT_PUBLIC_AUTH_HUB_URL;
  if (typeof window === 'undefined' || !hub) return;
  window.location.href = hubLoginUrl(hub, {
    provider: 'discord',
    link: true,
    returnUrl: `${window.location.origin}/discord/link-role`,
  });
}

export const getServerSideProps = createServerSideProps({
  useSession: true,
  resolver: async ({ session }) => {
    if (!session?.user) {
      return {
        redirect: {
          destination: getLoginLink({ reason: 'discord-link' }),
          permanent: false,
        },
      };
    }

    const account = await dbRead.account.findFirst({
      where: { userId: session.user.id, provider: 'discord' },
      select: { scope: true },
    });

    const linked = account?.scope?.includes('role_connections.write') ?? false;
    if (linked) {
      try {
        const metadata = await getUserDiscordMetadata(session.user.id);
        if (metadata) await discord.pushMetadata(metadata);
      } catch (err) {
        console.error(err);
      }
    }

    return {
      props: { linked },
    };
  },
});

export default function LinkRole({ linked }: Props) {
  return (
    <Container size="xs">
      <Paper radius="md" p="xl" withBorder>
        {linked ? (
          <Stack gap="md" align="center">
            <Title ta="center" order={1} lh={1.2}>
              Civitai + Discord = ❤️
            </Title>
            <Alert color="green" my="lg">
              <Group wrap="nowrap">
                <ThemeIcon size={46} color="green">
                  <IconCircleCheck size={30} />
                </ThemeIcon>
                <Text
                  size="xl"
                  lh={1.2}
                >{`We've updated your Discord account with the latest data from Civitai`}</Text>
              </Group>
            </Alert>
            <Button size="lg" leftSection={<IconHome />} component={Link} href="/">
              Back home!
            </Button>
          </Stack>
        ) : (
          <Stack gap="md">
            <Title order={3} lh={1.2}>
              Connect your Discord account to your Civitai account
            </Title>
            <Text>{`Take your Civitai accolades into Discord to get special roles and perks by connecting your account.`}</Text>

            <Button
              size="lg"
              leftSection={<IconBrandDiscord size={20} />}
              onClick={connectDiscord}
              className="bg-[#5865f2] hover:bg-[#4752c4]"
            >
              Connect Discord
            </Button>
            <AlertWithIcon icon={<IconExclamationMark />} color="yellow">
              Even if you have already connected your Discord account, you will need to click the
              button to link your role.
            </AlertWithIcon>
          </Stack>
        )}
      </Paper>
    </Container>
  );
}

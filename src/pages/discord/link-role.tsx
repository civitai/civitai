import {
  Container,
  Paper,
  Stack,
  Text,
  Alert,
  Group,
  ThemeIcon,
  Divider,
  Title,
  Button,
} from '@mantine/core';
import { NextLink as Link } from '~/components/NextLink/NextLink';
import { IconCircleCheck, IconExclamationMark, IconHome } from '@tabler/icons-react';
import { GetServerSideProps, InferGetServerSidePropsType } from 'next';
import { BuiltInProviderType } from 'next-auth/providers';
import { getProviders, signIn } from 'next-auth/react';
import { AlertWithIcon } from '~/components/AlertWithIcon/AlertWithIcon';
import { SocialButton } from '~/components/Social/SocialButton';
import { dbRead } from '~/server/db/client';
import { discord } from '~/server/integrations/discord';
import { getUserDiscordMetadata } from '~/server/jobs/push-discord-metadata';

import { getServerAuthSession } from '~/server/utils/get-server-auth-session';
import { createServerSideProps } from '~/server/utils/server-side-helpers';
import { getLoginLink } from '~/utils/login-helpers';

type NextAuthProviders = AsyncReturnType<typeof getProviders>;
type Props = {
  providers: NextAuthProviders | null;
  linked: boolean;
};

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
    const providers = !linked ? await getProviders() : null;

    return {
      props: { providers, linked },
    };
  },
});

export default function LinkRole({ providers, linked }: Props) {
  return (
    <Container size="xs">
      <Paper radius="md" p="xl" withBorder>
        {linked ? (
          <Stack spacing="md" align="center">
            <Title align="center" order={1} sx={{ lineHeight: 1.2 }}>
              Civitai + Discord = ❤️
            </Title>
            <Alert color="green" my="lg">
              <Group noWrap>
                <ThemeIcon size={46} color="green">
                  <IconCircleCheck size={30} />
                </ThemeIcon>
                <Text
                  size="xl"
                  sx={{ lineHeight: 1.2 }}
                >{`We've updated your Discord account with the latest data from Civitai`}</Text>
              </Group>
            </Alert>
            <Button size="lg" leftIcon={<IconHome />} component={Link} href="/">
              Back home!
            </Button>
          </Stack>
        ) : (
          <Stack spacing="md">
            <Title order={3} sx={{ lineHeight: 1.2 }}>
              Connect your Discord account to your Civitai account
            </Title>
            <Text>{`Take your Civitai accolades into Discord to get special roles and perks by connecting your account.`}</Text>

            {providers?.discord && (
              <SocialButton
                size="lg"
                key={providers.discord.name}
                provider={providers.discord.id as BuiltInProviderType}
                onClick={() => signIn(providers.discord.id, { callbackUrl: '/discord/link-role' })}
              />
            )}
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

import { Group, Paper, PaperProps, Text } from '@mantine/core';
import { DiscordButton, GitHubButton } from '~/components/SocialButtons/SocialButtons';

export default function AuthForm(props: PaperProps) {
  return (
    <Paper radius="md" p="xl" withBorder {...props}>
      <Text size="lg" weight={500}>
        Welcome to Model Share, sign in with
      </Text>

      <Group grow mb="md" mt="md">
        <GitHubButton radius="xl">GitHub</GitHubButton>
        <DiscordButton radius="xl">Discord</DiscordButton>
      </Group>
    </Paper>
  );
}

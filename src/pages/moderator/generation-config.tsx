/**
 * Moderator UI for generator-related runtime config (Redis-backed).
 *
 * All generation gating lives in the **Gate rules** section, which also carries
 * the non-gating `experimental` presentation. Standalone announcements are
 * **Generator messages**, a separate store. Future generator config sections
 * should be added here rather than spawning new pages.
 *
 * The `testers` rule tier resolves via the `generation-testing` Flipt flag —
 * assign users to that flag in Flipt to grant testing access.
 */

import { Container, Divider, Stack, Text, Title } from '@mantine/core';
import { Meta } from '~/components/Meta/Meta';
import { Page } from '~/components/AppLayout/Page';
import { GateRulesSection } from '~/components/Moderation/GenerationConfig/GateRulesSection';
import { GeneratorMessagesSection } from '~/components/Moderation/GenerationConfig/GeneratorMessagesSection';
import {
  GenerationStatusCard,
  SelfHostedGenerationStatusCard,
} from '~/components/Moderation/GenerationStatusCard';
import { createServerSideProps } from '~/server/utils/server-side-helpers';

export const getServerSideProps = createServerSideProps({
  requireModerator: true,
  useSession: true,
  resolver: async ({ session }) => {
    if (!session || !session.user?.isModerator)
      return { redirect: { destination: '/', permanent: false } };
    return { props: {} };
  },
});

function GenerationConfigPage() {
  return (
    <>
      <Meta title="Generation Config" deIndex />
      <Container size="md" py="lg">
        <Stack gap="xl">
          <Stack gap={4}>
            <Title order={2}>Generation Config</Title>
            <Text c="dimmed" size="sm">
              Runtime configuration for the generator. Each rule and message saves on its own.
            </Text>
          </Stack>

          <GenerationStatusCard />

          <Divider />

          <SelfHostedGenerationStatusCard />

          <Divider />

          <GateRulesSection />

          <Divider />

          <GeneratorMessagesSection />
        </Stack>
      </Container>
    </>
  );
}

export default Page(GenerationConfigPage);

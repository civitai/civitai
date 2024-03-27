import { Container, Stack, Title } from '@mantine/core';
import { Meta } from '~/components/Meta/Meta';
import { SupportContent } from '~/components/Support/SupportContent';

export default function SupportPage() {
  return (
    <>
      <Meta
        title="Civitai Support | Get help with Civitai"
        description="Need help? Visit the Civitai support page to get help with using Civitai, report a bug, suggest a feature, and more."
      />
      <Container size="md" py="xl">
        <Stack spacing={32}>
          <Title size={32} weight={600} color="gray.1">
            Let&apos;s pick a support option that works for you
          </Title>
          <SupportContent />
        </Stack>
      </Container>
    </>
  );
}

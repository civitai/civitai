import { Anchor, Text } from '@mantine/core';

/** A training dataset this domain refuses for its rating: say so, and link to it on civitai.red. */
export function OffDomainTrainingDataNotice({
  stub,
  href,
}: {
  stub?: { offDomain: true } | null;
  href: string;
}) {
  if (!stub) return null;
  return (
    <Text size="xs" c="dimmed" data-testid="off-domain-training-data">
      This training data isn&apos;t available on civitai.com.{' '}
      <Anchor href={href} inherit>
        See it on civitai.red
      </Anchor>
    </Text>
  );
}

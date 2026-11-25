import { Anchor, Text } from '@mantine/core';

/** Something this domain will not show for its rating: say so, and link to it on civitai.red. */
export function OffDomainNotice({
  noun,
  href,
  testId,
}: {
  noun: string;
  href: string;
  testId?: string;
}) {
  return (
    <Text size="xs" c="dimmed" data-testid={testId}>
      This {noun} isn&apos;t available on civitai.com.{' '}
      <Anchor href={href} inherit>
        See it on civitai.red
      </Anchor>
    </Text>
  );
}

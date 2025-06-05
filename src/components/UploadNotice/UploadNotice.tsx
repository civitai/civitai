import { Text } from '@mantine/core';
import { ContentPolicyLink } from '~/components/ContentPolicyLink/ContentPolicyLink';

export function UploadNotice({ className }: { className?: string }) {
  return (
    <Text size="xs" align="center" className={className}>
      By posting to Civitai you agree to our <ContentPolicyLink inherit />.
      <br />
      Illegal or exploitative content will be removed and reported.
    </Text>
  );
}

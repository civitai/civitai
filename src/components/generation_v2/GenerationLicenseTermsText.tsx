import { Text } from '@mantine/core';
import type { GenerationLicenseTerms } from '~/shared/constants/generation-license.constants';

export function GenerationLicenseTermsText({ terms }: { terms: GenerationLicenseTerms }) {
  return (
    <div className="flex flex-col gap-2">
      <Text size="xs">{terms.intro}</Text>
      <ul className="list-disc pl-5">
        {terms.restrictions.map((line) => (
          <li key={line}>
            <Text size="xs">{line}</Text>
          </li>
        ))}
      </ul>
      <Text size="xs">
        Read the{' '}
        <Text
          component="a"
          href={terms.licenseUrl}
          target="_blank"
          rel="noopener noreferrer"
          td="underline"
          inherit
        >
          {terms.licenseName}
        </Text>
        .
      </Text>
    </div>
  );
}

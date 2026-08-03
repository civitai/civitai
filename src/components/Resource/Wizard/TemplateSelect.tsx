import { useRouter } from 'next/router';
import { useState } from 'react';
import { Checkbox, Stack, Text } from '@mantine/core';
import { QuickSearchDropdown } from '~/components/Search/QuickSearchDropdown';
import type { TemplateOmittableField } from '~/server/schema/model.schema';

// "Settings only" is one preset over the omit list; a future granular picker can write
// any combination of TemplateOmittableField values to the same templateOmit param.
const SETTINGS_ONLY_OMIT: TemplateOmittableField[] = ['description', 'tags'];

type Props = {
  username: string;
  onSelect: () => void;
};

export function TemplateSelect({ username, onSelect }: Props) {
  const router = useRouter();
  const [settingsOnly, setSettingsOnly] = useState(
    typeof router.query.templateOmit === 'string' && router.query.templateOmit.length > 0
  );

  return (
    <Stack gap={8} p="xs">
      <Text size="sm" fw={600}>
        Your models
      </Text>
      <Checkbox
        size="xs"
        label="Copy settings only"
        description="Leaves out the template's description and tags"
        checked={settingsOnly}
        onChange={(e) => setSettingsOnly(e.currentTarget.checked)}
      />
      <QuickSearchDropdown
        supportedIndexes={['models']}
        startingIndex="models"
        showIndexSelect={false}
        onItemSelected={(item) => {
          router.replace(
            `?templateId=${item.entityId}${
              settingsOnly ? `&templateOmit=${SETTINGS_ONLY_OMIT.join(',')}` : ''
            }`,
            undefined,
            { shallow: true }
          );
          onSelect();
        }}
        filters={`user.username='${username}'`}
        dropdownItemLimit={10}
        placeholder="Search your models..."
      />
    </Stack>
  );
}

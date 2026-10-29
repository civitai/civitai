import { useRouter } from 'next/router';
import { useState } from 'react';
import { Button, Checkbox, Popover, Stack, Text } from '@mantine/core';
import { QuickSearchDropdown } from '~/components/Search/QuickSearchDropdown';
import { quoteMeiliValue } from '~/components/Search/meili-filter';
import type { TemplateOmittableField } from '~/server/schema/model.schema';

// "Settings only" is one preset over the omit list; a future granular picker can write
// any combination of TemplateOmittableField values to the same templateOmit param.
const SETTINGS_ONLY_OMIT: TemplateOmittableField[] = ['description', 'tags'];

type Props = {
  username: string;
  onSelect: () => void;
};

export function TemplatePicker({
  username,
  hasTemplate,
}: {
  username: string;
  hasTemplate: boolean;
}) {
  const [opened, setOpened] = useState(false);

  return (
    <Popover opened={opened} width={400} position="bottom-end" onChange={setOpened} withArrow>
      <Popover.Target>
        <Button variant="subtle" onClick={() => setOpened(true)}>
          {hasTemplate ? 'Swap template' : 'Use a template'}
        </Button>
      </Popover.Target>
      <Popover.Dropdown p={4}>
        <TemplateSelect username={username} onSelect={() => setOpened(false)} />
      </Popover.Dropdown>
    </Popover>
  );
}

function TemplateSelect({ username, onSelect }: Props) {
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
        filters={`user.username = ${quoteMeiliValue(username)}`}
        dropdownItemLimit={10}
        placeholder="Search your models..."
        // Inline: a portaled option is outside the enclosing Popover, so pressing it closes the Popover.
        comboboxProps={{ withinPortal: false }}
      />
    </Stack>
  );
}

import { useRouter } from 'next/router';
import { Stack, Text } from '@mantine/core';
import { QuickSearchDropdown } from '~/components/Search/QuickSearchDropdown';

type Props = {
  username: string;
  onSelect: () => void;
};

export function TemplateSelect({ username, onSelect }: Props) {
  const router = useRouter();

  return (
    <Stack gap={8} p="xs">
      <Text size="sm" fw={600}>
        Your models
      </Text>
      <QuickSearchDropdown
        supportedIndexes={['models']}
        startingIndex="models"
        showIndexSelect={false}
        onItemSelected={(item) => {
          router.replace(`?templateId=${item.entityId}`, undefined, { shallow: true });
          onSelect();
        }}
        filters={`user.username='${username}'`}
        dropdownItemLimit={10}
        placeholder="Search your models..."
      />
    </Stack>
  );
}

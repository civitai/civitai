import { Badge, Card, Group, Modal, Stack, Text } from '@mantine/core';
import { useDialogContext } from '~/components/Dialog/DialogContext';
import { useHiddenPreferencesContext } from '~/components/HiddenPreferences/HiddenPreferencesProvider';
import {
  browsingLevels,
  browsingLevelLabels,
  browsingLevelDescriptions,
} from '~/shared/constants/browsingLevel.constants';

const unsupportedTags = ['incest', 'peeing', 'pg-13', 'r', 'x', 'xxx'];

export default function BrowsingLevelGuide() {
  const dialog = useDialogContext();
  const { moderatedTags } = useHiddenPreferencesContext();

  const filteredTags = moderatedTags.filter((x) => !unsupportedTags.includes(x.name.toLowerCase()));

  return (
    <Modal {...dialog} title="Browsing Level Guide">
      <Stack>
        {browsingLevels.map((browsingLevel) => {
          const tags = filteredTags.filter((x) => x.nsfwLevel === browsingLevel && !x.parentId);
          return (
            <Card withBorder key={browsingLevel}>
              <Card.Section withBorder inheritPadding py="xs">
                <Text fw={500}>{browsingLevelLabels[browsingLevel]}</Text>
              </Card.Section>
              <Card.Section withBorder inheritPadding py="xs">
                <Stack>
                  <Text>{browsingLevelDescriptions[browsingLevel]}</Text>
                  {!!tags.length && (
                    <Group gap="xs">
                      {tags.map((tag) => (
                        <Badge key={tag.id}>{tag.name}</Badge>
                      ))}
                    </Group>
                  )}
                </Stack>
              </Card.Section>
            </Card>
          );
        })}
      </Stack>
    </Modal>
  );
}

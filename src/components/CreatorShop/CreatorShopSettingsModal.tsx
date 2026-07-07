import {
  ActionIcon,
  Button,
  Group,
  Modal,
  Paper,
  Stack,
  Switch,
  Text,
  Textarea,
  ThemeIcon,
} from '@mantine/core';
import { IconChevronDown, IconChevronUp, IconStar } from '@tabler/icons-react';
import { useEffect, useRef, useState } from 'react';
import { dialogStore } from '~/components/Dialog/dialogStore';
import { useDialogContext } from '~/components/Dialog/DialogProvider';
import { CreatorShopFeaturePickerModal } from '~/components/CreatorShop/CreatorShopFeaturePickerModal';
import {
  useMutateCreatorShop,
  useQueryCreatorShopSettings,
} from '~/components/CreatorShop/creator-shop.util';
import {
  creatorShopSectionKeys,
  type CreatorShopSectionKey,
} from '~/server/schema/creator-shop.schema';

type SectionState = { key: CreatorShopSectionKey; visible: boolean };

const sectionLabels: Record<CreatorShopSectionKey, string> = {
  featured: 'Featured',
  cosmetics: 'Cosmetics',
  merch: 'Merch (coming soon)',
  models: 'Models',
};

function seedSections(settings?: {
  showModels?: boolean;
  sections?: { key: CreatorShopSectionKey; visible: boolean }[];
}): SectionState[] {
  const saved = settings?.sections;
  let ordered: SectionState[];
  if (saved?.length) {
    ordered = saved.map((s) => ({ key: s.key, visible: s.visible }));
    for (const key of creatorShopSectionKeys) {
      if (!ordered.some((s) => s.key === key)) ordered.push({ key, visible: true });
    }
  } else {
    ordered = creatorShopSectionKeys.map((key) => ({ key, visible: true }));
  }
  // Models visibility is mirrored by the legacy `showModels` flag.
  return ordered.map((s) =>
    s.key === 'models' ? { ...s, visible: settings?.showModels ?? s.visible } : s
  );
}

export function CreatorShopSettingsModal() {
  const dialog = useDialogContext();
  const { settings } = useQueryCreatorShopSettings();
  const { updateSettings } = useMutateCreatorShop();

  const [sections, setSections] = useState<SectionState[]>(() => seedSections(settings));
  const [description, setDescription] = useState(settings?.description ?? '');
  const seededRef = useRef(!!settings);
  const featuredCount = settings?.featuredItemIds?.length ?? 0;

  useEffect(() => {
    if (!settings || seededRef.current) return;
    seededRef.current = true;
    setSections(seedSections(settings));
    setDescription(settings.description ?? '');
  }, [settings]);

  const toggleVisible = (key: CreatorShopSectionKey) =>
    setSections((prev) => prev.map((s) => (s.key === key ? { ...s, visible: !s.visible } : s)));

  const move = (index: number, dir: -1 | 1) =>
    setSections((prev) => {
      const next = [...prev];
      const target = index + dir;
      if (target < 0 || target >= next.length) return prev;
      [next[index], next[target]] = [next[target], next[index]];
      return next;
    });

  const handleSave = async () => {
    const showModels = sections.find((s) => s.key === 'models')?.visible ?? false;
    await updateSettings.mutateAsync({
      sections,
      showModels,
      description: description.trim() || null,
    });
    dialog.onClose();
  };

  return (
    <Modal {...dialog} size="lg" title="Shop settings">
      <Stack>
        <Stack gap={6}>
          <Text fw={600}>Featured cosmetics</Text>
          <Paper withBorder radius="md" p="sm">
            <Group justify="space-between">
              <Group gap={8}>
                <ThemeIcon variant="light" color="yellow" radius="xl">
                  <IconStar size={16} />
                </ThemeIcon>
                <Text size="sm">
                  {featuredCount} item{featuredCount === 1 ? '' : 's'} featured
                </Text>
              </Group>
              <Button
                variant="default"
                size="xs"
                onClick={() => dialogStore.trigger({ component: CreatorShopFeaturePickerModal })}
              >
                Manage featured
              </Button>
            </Group>
          </Paper>
        </Stack>

        <Stack gap={6}>
          <Text fw={600}>Sections</Text>
          <Text size="xs" c="dimmed">
            Toggle sections on or off and drag their order with the arrows.
          </Text>
          <Stack gap={8}>
            {sections.map((section, index) => (
              <Paper key={section.key} withBorder radius="md" p="sm">
                <Group justify="space-between" wrap="nowrap">
                  <Switch
                    checked={section.visible}
                    onChange={() => toggleVisible(section.key)}
                    label={sectionLabels[section.key]}
                  />
                  <Group gap={4} wrap="nowrap">
                    <ActionIcon
                      variant="default"
                      onClick={() => move(index, -1)}
                      disabled={index === 0}
                      aria-label={`Move ${sectionLabels[section.key]} up`}
                    >
                      <IconChevronUp size={16} />
                    </ActionIcon>
                    <ActionIcon
                      variant="default"
                      onClick={() => move(index, 1)}
                      disabled={index === sections.length - 1}
                      aria-label={`Move ${sectionLabels[section.key]} down`}
                    >
                      <IconChevronDown size={16} />
                    </ActionIcon>
                  </Group>
                </Group>
              </Paper>
            ))}
          </Stack>
        </Stack>

        <Textarea
          label="Shop description"
          value={description}
          onChange={(e) => setDescription(e.currentTarget.value)}
          autosize
          minRows={2}
          maxLength={1000}
          placeholder="Tell shoppers about your shop (optional)"
        />

        <Group justify="flex-end">
          <Button variant="default" onClick={dialog.onClose}>
            Cancel
          </Button>
          <Button loading={updateSettings.isPending} onClick={handleSave}>
            Save changes
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}

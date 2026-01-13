/**
 * FeatureInput
 *
 * A form input for selecting generation features (workflows).
 * Displays inline menu cards for Image and Video features, each opening their own dropdown.
 */

import { Divider, Group, Popover, Stack, Text, UnstyledButton } from '@mantine/core';
import { useDisclosure } from '@mantine/hooks';
import { IconChevronDown, IconCheck, IconPhoto, IconVideo } from '@tabler/icons-react';
import clsx from 'clsx';
import { useMemo } from 'react';

import { getAllFeaturesGrouped } from '~/shared/data-graph/generation-v2/features';

// =============================================================================
// Types
// =============================================================================

export interface FeatureOption {
  id: string;
  label: string;
  compatible: boolean;
}

export interface FeatureCategory {
  category: string;
  label: string;
  features: FeatureOption[];
}

export interface FeatureInputProps {
  value?: string;
  onChange?: (value: string) => void;
  /** Whether the control is disabled */
  disabled?: boolean;
  /** Additional class name for the container */
  className?: string;
}

// =============================================================================
// Helper Functions
// =============================================================================

function getSelectedFeature(
  options: FeatureCategory[],
  value?: string
): { feature: FeatureOption; category: FeatureCategory } | undefined {
  for (const category of options) {
    const feature = category.features.find((f) => f.id === value);
    if (feature) return { feature, category };
  }
  return undefined;
}

// =============================================================================
// Feature Menu Item
// =============================================================================

interface FeatureMenuItemProps {
  feature: FeatureOption;
  isSelected: boolean;
  onSelect: () => void;
}

function FeatureMenuItem({ feature, isSelected, onSelect }: FeatureMenuItemProps) {
  return (
    <UnstyledButton
      onClick={onSelect}
      className={clsx(
        'w-full rounded px-3 py-2 text-left transition-colors',
        'hover:bg-gray-1 dark:hover:bg-dark-5',
        isSelected && 'bg-blue-0 dark:bg-blue-9/20'
      )}
    >
      <Group gap="xs" wrap="nowrap">
        <div className="flex-1">
          <Text size="sm" fw={isSelected ? 600 : 400}>
            {feature.label}
          </Text>
        </div>
        {isSelected && <IconCheck size={16} className="text-blue-6" />}
      </Group>
    </UnstyledButton>
  );
}

// =============================================================================
// Feature Card (Single Menu Card)
// =============================================================================

interface FeatureCardProps {
  icon: React.ReactNode;
  title: string;
  selectedLabel?: string;
  isActive: boolean;
  disabled?: boolean;
  opened: boolean;
  onToggle: () => void;
  onClose: () => void;
  categories: FeatureCategory[];
  selectedValue?: string;
  onSelect: (featureId: string) => void;
}

function FeatureCard({
  icon,
  title,
  selectedLabel,
  isActive,
  disabled,
  opened,
  onToggle,
  onClose,
  categories,
  selectedValue,
  onSelect,
}: FeatureCardProps) {
  const visibleCategories = categories.filter((cat) => cat.features.length > 0);

  return (
    <Popover
      opened={opened}
      onChange={(isOpen) => !isOpen && onClose()}
      position="bottom-start"
      width={240}
      shadow="md"
      withinPortal
    >
      <Popover.Target>
        <UnstyledButton
          onClick={onToggle}
          disabled={disabled}
          className={clsx(
            'flex-1 rounded-md border p-3 transition-colors',
            isActive
              ? 'border-blue-5 bg-blue-0 dark:border-blue-6 dark:bg-blue-9/20'
              : 'border-gray-3 bg-white hover:border-gray-4 dark:border-dark-4 dark:bg-dark-6 dark:hover:border-dark-3',
            disabled && 'cursor-not-allowed opacity-50',
            opened && 'ring-2 ring-blue-5/20'
          )}
        >
          <Group gap="sm" wrap="nowrap">
            <div
              className={clsx(
                'rounded-md p-2',
                isActive
                  ? 'bg-blue-5 text-white'
                  : 'bg-gray-1 text-gray-6 dark:bg-dark-5 dark:text-gray-4'
              )}
            >
              {icon}
            </div>
            <div className="flex-1 text-left">
              <Text size="xs" c="dimmed">
                {title}
              </Text>
              <Text size="sm" fw={600} truncate>
                {selectedLabel ?? 'Select...'}
              </Text>
            </div>
            <IconChevronDown
              size={16}
              className={clsx(
                'text-gray-5 transition-transform',
                opened && 'rotate-180'
              )}
            />
          </Group>
        </UnstyledButton>
      </Popover.Target>

      <Popover.Dropdown p={0}>
        <Stack gap={0}>
          {visibleCategories.map((category, index) => (
            <div key={category.category}>
              {index > 0 && <Divider />}
              {visibleCategories.length > 1 && (
                <div className="px-3 py-2">
                  <Text size="xs" c="dimmed" fw={600} tt="uppercase">
                    {category.label}
                  </Text>
                </div>
              )}
              <Stack gap={0} py={visibleCategories.length > 1 ? 0 : 'xs'} pb="xs">
                {category.features.map((feature) => (
                  <FeatureMenuItem
                    key={feature.id}
                    feature={feature}
                    isSelected={feature.id === selectedValue}
                    onSelect={() => onSelect(feature.id)}
                  />
                ))}
              </Stack>
            </div>
          ))}
        </Stack>
      </Popover.Dropdown>
    </Popover>
  );
}

// =============================================================================
// Component
// =============================================================================

export function FeatureInput({
  value,
  onChange,
  disabled,
  className,
}: FeatureInputProps) {
  const [imageOpened, { close: closeImage, toggle: toggleImage }] = useDisclosure(false);
  const [videoOpened, { close: closeVideo, toggle: toggleVideo }] = useDisclosure(false);

  // Get all features grouped by category (static - no ecosystem filtering)
  const options = useMemo(() => getAllFeaturesGrouped(), []);
  const selected = getSelectedFeature(options, value);

  // Separate image and video categories
  const imageCategories = options.filter(
    (cat) => cat.category === 'text-to-image' || cat.category === 'image-to-image'
  );
  const videoCategories = options.filter(
    (cat) =>
      cat.category === 'text-to-video' ||
      cat.category === 'image-to-video' ||
      cat.category === 'video-enhancements'
  );

  // Check if current selection is image or video
  const isImageFeature =
    selected &&
    (selected.category.category === 'text-to-image' ||
      selected.category.category === 'image-to-image');
  const isVideoFeature =
    selected &&
    (selected.category.category === 'text-to-video' ||
      selected.category.category === 'image-to-video' ||
      selected.category.category === 'video-enhancements');

  // Get display labels
  const imageLabel = isImageFeature ? selected.feature.label : undefined;
  const videoLabel = isVideoFeature ? selected.feature.label : undefined;

  const handleImageSelect = (featureId: string) => {
    onChange?.(featureId);
    closeImage();
  };

  const handleVideoSelect = (featureId: string) => {
    onChange?.(featureId);
    closeVideo();
  };

  // Check if video features are available
  const hasVideoFeatures = videoCategories.some((cat) => cat.features.length > 0);

  return (
    <Group gap="sm" className={className} grow>
      <FeatureCard
        icon={<IconPhoto size={20} />}
        title="Image"
        selectedLabel={imageLabel}
        isActive={isImageFeature ?? false}
        disabled={disabled}
        opened={imageOpened}
        onToggle={() => {
          closeVideo();
          toggleImage();
        }}
        onClose={closeImage}
        categories={imageCategories}
        selectedValue={value}
        onSelect={handleImageSelect}
      />

      {hasVideoFeatures && (
        <FeatureCard
          icon={<IconVideo size={20} />}
          title="Video"
          selectedLabel={videoLabel}
          isActive={isVideoFeature ?? false}
          disabled={disabled}
          opened={videoOpened}
          onToggle={() => {
            closeImage();
            toggleVideo();
          }}
          onClose={closeVideo}
          categories={videoCategories}
          selectedValue={value}
          onSelect={handleVideoSelect}
        />
      )}
    </Group>
  );
}

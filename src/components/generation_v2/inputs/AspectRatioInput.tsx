import type { InputWrapperProps } from '@mantine/core';
import {
  Button,
  Center,
  Group,
  Input,
  Modal,
  Paper,
  SegmentedControl,
  SimpleGrid,
  Stack,
  Text,
  UnstyledButton,
} from '@mantine/core';
import { useDisclosure } from '@mantine/hooks';
import { IconDots, IconLibraryPlus } from '@tabler/icons-react';
import clsx from 'clsx';

// =============================================================================
// Types
// =============================================================================

export interface AspectRatioOption {
  /** Aspect ratio string (e.g., "16:9", "1:1") */
  value: string;
  /** Optional width for display purposes */
  width?: number;
  /** Optional height for display purposes */
  height?: number;
}

/** Value type for AspectRatioInput - includes resolved dimensions */
export interface AspectRatioValue {
  value: string;
  width: number;
  height: number;
}

export interface AspectRatioInputProps extends Omit<InputWrapperProps, 'children' | 'onChange'> {
  value?: AspectRatioValue;
  onChange?: (value: AspectRatioValue) => void;
  options: AspectRatioOption[];
  disabled?: boolean;
  /** Maximum number of options to show before displaying "More" button (default: 5) */
  maxVisible?: number;
  /** Priority aspect ratio values to show before "More" button. When set, these values are shown instead of the first N options. */
  priorityOptions?: string[];
}

// =============================================================================
// Helpers
// =============================================================================

function parseRatio(ratio: string): { width: number; height: number } {
  const [w, h] = ratio.split(':').map(Number);
  return { width: w || 1, height: h || 1 };
}

function getAspectRatioStyle(option: AspectRatioOption): string {
  if (option.width && option.height) {
    return `${option.width}/${option.height}`;
  }
  const { width, height } = parseRatio(option.value);
  return `${width}/${height}`;
}

function getDimensionsLabel(option: AspectRatioOption): string | null {
  if (option.width && option.height) {
    return `${option.width}x${option.height}`;
  }
  return null;
}

// =============================================================================
// Option Display Component
// =============================================================================

interface AspectRatioOptionDisplayProps {
  option: AspectRatioOption;
  showDimensions?: boolean;
}

function AspectRatioOptionDisplay({
  option,
  showDimensions = true,
}: AspectRatioOptionDisplayProps) {
  const dimensions = getDimensionsLabel(option);

  return (
    <Stack gap={2}>
      <Center>
        <Paper
          withBorder
          style={{ borderWidth: 2, aspectRatio: getAspectRatioStyle(option), height: 20 }}
        />
      </Center>
      <Stack gap={0}>
        <Text size="xs">{option.value}</Text>
        {showDimensions && dimensions && (
          <Text fz={10} c="dimmed">
            {dimensions}
          </Text>
        )}
      </Stack>
    </Stack>
  );
}

// =============================================================================
// Modal Option Component
// =============================================================================

interface ModalOptionProps {
  option: AspectRatioOption;
  selected: boolean;
  onClick: () => void;
  disabled?: boolean;
}

function ModalOption({ option, selected, onClick, disabled }: ModalOptionProps) {
  const dimensions = getDimensionsLabel(option);

  return (
    <UnstyledButton
      onClick={onClick}
      disabled={disabled}
      className={clsx(
        'flex flex-col items-center gap-2 rounded-md border-2 p-3 transition-colors',
        selected
          ? 'border-blue-6 bg-blue-1 dark:bg-blue-9/20'
          : 'border-gray-3 hover:border-gray-4 dark:border-dark-4 dark:hover:border-dark-3',
        disabled && 'cursor-not-allowed opacity-50'
      )}
    >
      <Paper
        withBorder
        style={{ borderWidth: 2, aspectRatio: getAspectRatioStyle(option), height: 40 }}
      />
      <Stack gap={0} align="center">
        <Text size="sm" fw={selected ? 600 : 400}>
          {option.value}
        </Text>
        {dimensions && (
          <Text fz="xs" c="dimmed">
            {dimensions}
          </Text>
        )}
      </Stack>
    </UnstyledButton>
  );
}

// =============================================================================
// Component
// =============================================================================

const DEFAULT_MAX_VISIBLE = 5;

/** Helper to convert an option to an AspectRatioValue */
function optionToValue(option: AspectRatioOption): AspectRatioValue {
  const parsed = parseRatio(option.value);
  return {
    value: option.value,
    width: option.width ?? parsed.width,
    height: option.height ?? parsed.height,
  };
}

export function AspectRatioInput({
  value,
  onChange,
  options,
  label,
  disabled,
  maxVisible = DEFAULT_MAX_VISIBLE,
  priorityOptions,
  ...inputWrapperProps
}: AspectRatioInputProps) {
  const [modalOpened, { open: openModal, close: closeModal }] = useDisclosure(false);

  // Extract the value string from the value object
  const selectedAspectRatio = value?.value;

  // Determine visible options based on priorityOptions or default slicing
  const visibleOptions = (() => {
    if (priorityOptions && priorityOptions.length > 0) {
      // Use priority options - filter to only include valid values from options
      const prioritySet = new Set(priorityOptions);
      return options.filter((opt) => prioritySet.has(opt.value));
    }
    // Default: show first N-1 options (leaving room for "More" button)
    if (options.length > maxVisible) {
      return options.slice(0, maxVisible - 1);
    }
    return options;
  })();

  const showMoreButton = options.length > visibleOptions.length;
  const selectedOption = options.find((opt) => opt.value === selectedAspectRatio);
  const isSelectedHidden =
    showMoreButton && !visibleOptions.find((opt) => opt.value === selectedAspectRatio);

  const segmentedData = visibleOptions.map((option) => ({
    label: <AspectRatioOptionDisplay option={option} />,
    value: option.value,
  }));

  // Add "More" option if needed
  if (showMoreButton) {
    const dimensionLabel = isSelectedHidden ? getDimensionsLabel(selectedOption!) : undefined;
    segmentedData.push({
      label: (
        <Stack gap={2} onClick={openModal}>
          {isSelectedHidden && (
            <Text c="dimmed" className="absolute right-0.5 top-0.5">
              <IconLibraryPlus size={18} />
            </Text>
          )}
          <Center>
            <Paper
              withBorder
              style={{
                borderWidth: 2,
                aspectRatio: isSelectedHidden ? getAspectRatioStyle(selectedOption!) : '1/1',
                height: 20,
              }}
            />
          </Center>
          <Stack gap={0}>
            <Text size="xs">{isSelectedHidden ? selectedOption?.value : 'More'}</Text>
            <Text fz={10} c="dimmed">
              {dimensionLabel ? dimensionLabel : <IconDots size={16} className="mx-auto" />}
            </Text>
          </Stack>
        </Stack>
      ),
      value: '__more__',
    });
  }

  const handleSegmentedChange = (newValue: string) => {
    if (newValue === '__more__') {
      openModal();
    } else {
      const option = options.find((opt) => opt.value === newValue);
      if (option) {
        onChange?.(optionToValue(option));
      }
    }
  };

  const handleModalSelect = (newValue: string) => {
    const option = options.find((opt) => opt.value === newValue);
    if (option) {
      onChange?.(optionToValue(option));
    }
    closeModal();
  };

  return (
    <>
      <Input.Wrapper {...inputWrapperProps} label={label}>
        <SegmentedControl
          value={isSelectedHidden ? '__more__' : selectedAspectRatio ?? ''}
          onChange={handleSegmentedChange}
          data={segmentedData}
          disabled={disabled}
          fullWidth
          classNames={{ label: 'relative', innerLabel: 'static' }}
        />
      </Input.Wrapper>

      <Modal opened={modalOpened} onClose={closeModal} title="Select Aspect Ratio" size="md">
        <Stack gap="md">
          <SimpleGrid cols={3} spacing="sm">
            {options.map((option) => (
              <ModalOption
                key={option.value}
                option={option}
                selected={option.value === selectedAspectRatio}
                onClick={() => handleModalSelect(option.value)}
                disabled={disabled}
              />
            ))}
          </SimpleGrid>
          <Group justify="flex-end">
            <Button variant="subtle" onClick={closeModal}>
              Cancel
            </Button>
          </Group>
        </Stack>
      </Modal>
    </>
  );
}

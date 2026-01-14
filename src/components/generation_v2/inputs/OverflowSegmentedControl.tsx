/**
 * OverflowSegmentedControl
 *
 * A wrapper around Mantine's SegmentedControl that handles overflow gracefully.
 * When there are more options than can be displayed, it shows a "More" button
 * that opens a modal with all options.
 *
 * Features:
 * - Uses ResizeObserver to dynamically adjust visible items based on container width
 * - Shows options in priority order (via priorityOptions) or natural order
 * - When selected item is hidden, it replaces the last visible option
 * - Built-in modal for selecting from all options
 */

import { Button, Group, Modal, SegmentedControl, Stack } from '@mantine/core';
import { IconDots } from '@tabler/icons-react';
import { useCallback, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';

// =============================================================================
// Types
// =============================================================================

export interface OverflowSegmentedControlOption<T extends string = string> {
  value: T;
  label: ReactNode;
}

export interface OverflowSegmentedControlProps<T extends string = string> {
  value?: T;
  onChange?: (value: T) => void;
  options: OverflowSegmentedControlOption<T>[];
  disabled?: boolean;
  /** Maximum number of items to display (including "more" button if present) */
  maxVisible?: number;
  /** Priority option values to show. When set, these are shown instead of first N options. */
  priorityOptions?: T[];
  /**
   * Custom render for the "More" button content.
   * If not provided, defaults to a dots icon.
   */
  renderMoreButton?: () => ReactNode;
  /**
   * Render an option in the modal grid.
   * If not provided, uses a default card-style rendering with the option's label.
   * @param option - The option to render
   * @param selected - Whether this option is currently selected
   */
  renderModalOption?: (option: OverflowSegmentedControlOption<T>, selected: boolean) => ReactNode;
  /** Title for the modal. Defaults to "Select Option" */
  modalTitle?: string;
  className?: string;
}

// =============================================================================
// Constants
// =============================================================================

/** Estimated width per item for initial calculation */
const ESTIMATED_ITEM_WIDTH = 70;
/** Padding inside the container */
const CONTAINER_PADDING = 8;
/** Special value for the "more" option */
const MORE_VALUE = '__more__';

// =============================================================================
// Default More Button
// =============================================================================

function DefaultMoreButton() {
  return (
    <div className="flex items-center justify-center">
      <IconDots size={18} />
    </div>
  );
}

// =============================================================================
// Default Modal Option
// =============================================================================

interface DefaultModalOptionProps {
  label: ReactNode;
  selected: boolean;
}

function DefaultModalOption({ label }: DefaultModalOptionProps) {
  return (
    <div className="flex items-center justify-center px-3 py-2 text-sm font-medium">{label}</div>
  );
}

// =============================================================================
// Modal Grid Component
// =============================================================================

interface ModalGridProps<T extends string> {
  options: OverflowSegmentedControlOption<T>[];
  value?: T;
  disabled?: boolean;
  onSelect: (value: T) => void;
  renderModalOption?: (option: OverflowSegmentedControlOption<T>, selected: boolean) => ReactNode;
}

function ModalGrid<T extends string>({
  options,
  value,
  disabled,
  onSelect,
  renderModalOption,
}: ModalGridProps<T>) {
  const gridRef = useRef<HTMLDivElement>(null);
  const [columnCount, setColumnCount] = useState(1);

  // Track actual column count from grid layout
  useLayoutEffect(() => {
    const grid = gridRef.current;
    if (!grid) return;

    const updateColumnCount = () => {
      const gridStyle = window.getComputedStyle(grid);
      const columns = gridStyle.gridTemplateColumns.split(' ').length;
      setColumnCount(columns);
    };

    updateColumnCount();

    const observer = new ResizeObserver(updateColumnCount);
    observer.observe(grid);
    return () => observer.disconnect();
  }, []);

  const totalItems = options.length;
  const rowCount = Math.ceil(totalItems / columnCount);

  return (
    <div
      ref={gridRef}
      className="grid overflow-hidden rounded-md bg-gray-1 dark:bg-[#141517]"
      style={{
        gridTemplateColumns: 'repeat(auto-fill, minmax(100px, 1fr))',
      }}
    >
      {options.map((option, index) => {
        const selected = option.value === value;
        const column = index % columnCount;
        const row = Math.floor(index / columnCount);
        const isLastColumn = column === columnCount - 1;
        const isLastRow = row === rowCount - 1;

        return (
          <div
            key={option.value}
            onClick={() => !disabled && onSelect(option.value)}
            className="relative cursor-pointer"
          >
            {/* Right separator - inset from top/bottom, hidden on last column */}
            {!isLastColumn && (
              <div className="absolute inset-y-2 right-0 w-px bg-gray-3 dark:bg-dark-4" />
            )}
            {/* Bottom separator - inset from left/right, hidden on last row */}
            {!isLastRow && (
              <div className="absolute inset-x-2 bottom-0 h-px bg-gray-3 dark:bg-dark-4" />
            )}
            {/* Content with background - uses negative margin to cover adjacent separators */}
            <div
              className={`relative z-10 -m-px transition-colors ${
                selected
                  ? 'bg-white text-black shadow-sm dark:bg-dark-5 dark:text-white'
                  : 'text-gray-6 hover:bg-gray-3 hover:text-gray-7 dark:text-dark-1 dark:hover:bg-dark-4 dark:hover:text-dark-0'
              }`}
            >
              {renderModalOption ? (
                renderModalOption(option, selected)
              ) : (
                <DefaultModalOption label={option.label} selected={selected} />
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// =============================================================================
// Component
// =============================================================================

export function OverflowSegmentedControl<T extends string = string>({
  value,
  onChange,
  options,
  disabled,
  maxVisible: maxVisibleProp,
  priorityOptions,
  renderMoreButton,
  renderModalOption,
  modalTitle = 'Select Option',
  className,
}: OverflowSegmentedControlProps<T>) {
  // Default maxVisible to the number of options
  const maxVisible = maxVisibleProp ?? options.length;

  const containerRef = useRef<HTMLDivElement>(null);
  const [visibleCount, setVisibleCount] = useState(maxVisible);
  const [modalOpened, setModalOpened] = useState(false);

  // Calculate how many items can fit based on container width
  const calculateVisibleCount = useCallback(() => {
    const container = containerRef.current;
    if (!container) return;

    const containerWidth = container.offsetWidth - CONTAINER_PADDING;
    const fittingCount = Math.max(1, Math.floor(containerWidth / ESTIMATED_ITEM_WIDTH));
    const count = Math.min(fittingCount, maxVisible, options.length);

    setVisibleCount(count);
  }, [maxVisible, options.length]);

  // Run calculation on mount and resize
  useLayoutEffect(() => {
    calculateVisibleCount();

    const observer = new ResizeObserver(calculateVisibleCount);
    if (containerRef.current) {
      observer.observe(containerRef.current);
    }
    return () => observer.disconnect();
  }, [calculateVisibleCount]);

  // Determine which options to show
  const { visibleOptions, showMoreButton } = useMemo(() => {
    // Check if we need a More button (can't fit all options in visible count)
    const needsMoreButton = options.length > visibleCount;

    // Calculate available slots (reserve 1 for More button if needed)
    const availableSlots = needsMoreButton ? visibleCount - 1 : visibleCount;

    // Determine base options to consider (priority or all)
    let baseOptions = options;
    if (priorityOptions && priorityOptions.length > 0) {
      const prioritySet = new Set(priorityOptions);
      baseOptions = options.filter((opt) => prioritySet.has(opt.value));
    }

    // Take first N options
    let visible = baseOptions.slice(0, Math.max(1, availableSlots));

    // If selected value is not in visible options, replace the last one with it
    if (needsMoreButton && value) {
      const isSelectedInVisible = visible.some((opt) => opt.value === value);
      if (!isSelectedInVisible) {
        const selectedOption = options.find((opt) => opt.value === value);
        if (selectedOption && visible.length > 0) {
          // Replace the last visible option with the selected one
          visible = [...visible.slice(0, -1), selectedOption];
        }
      }
    }

    return {
      visibleOptions: visible,
      showMoreButton: needsMoreButton,
    };
  }, [options, value, visibleCount, priorityOptions]);

  // Build segmented control data
  const segmentedData = useMemo(() => {
    const data = visibleOptions.map((opt) => ({
      value: opt.value,
      label: opt.label,
    }));

    // Add "More" option if needed
    if (showMoreButton) {
      data.push({
        value: MORE_VALUE as T,
        label: renderMoreButton ? renderMoreButton() : <DefaultMoreButton />,
      });
    }

    return data;
  }, [visibleOptions, showMoreButton, renderMoreButton]);

  // Use the actual value (not MORE_VALUE since selection is now in visible options)
  const controlValue = value ?? '';

  const handleChange = (newValue: string) => {
    if (newValue === MORE_VALUE) {
      // Open the modal when More is clicked
      setModalOpened(true);
    } else {
      onChange?.(newValue as T);
    }
  };

  const handleModalSelect = (optionValue: T) => {
    onChange?.(optionValue);
    setModalOpened(false);
  };

  return (
    <>
      <div ref={containerRef} className={className}>
        <SegmentedControl
          value={controlValue}
          onChange={handleChange}
          data={segmentedData}
          disabled={disabled}
          fullWidth
          classNames={{ label: 'relative', innerLabel: 'static' }}
        />
      </div>

      <Modal
        opened={modalOpened}
        onClose={() => setModalOpened(false)}
        title={modalTitle}
        size="md"
      >
        <Stack gap="md">
          {/* Grid with inset separators that don't extend to edges */}
          <ModalGrid
            options={options}
            value={value}
            disabled={disabled}
            onSelect={handleModalSelect}
            renderModalOption={renderModalOption}
          />
          <Group justify="flex-end">
            <Button variant="subtle" onClick={() => setModalOpened(false)}>
              Cancel
            </Button>
          </Group>
        </Stack>
      </Modal>
    </>
  );
}

/**
 * OverflowSegmentedControl
 *
 * A wrapper around Mantine's SegmentedControl that handles overflow gracefully.
 * When there are more options than can be displayed, it shows a "More" button
 * that opens a popover with all options.
 *
 * Features:
 * - Uses ResizeObserver to dynamically adjust visible items based on container width
 * - Shows options in priority order (via priorityOptions) or natural order
 * - When selected item is hidden, it replaces its nearest visible neighbour, in order
 * - Built-in popover for selecting from all options; a bottom sheet on a phone
 */

import { Popover, ScrollArea, SegmentedControl, Text } from '@mantine/core';
import { IconDots } from '@tabler/icons-react';
import { useCallback, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { MobileMenuDrawer } from '~/components/Drawer/MobileMenuDrawer';
import { useIsMobile } from '~/hooks/useIsMobile';

// =============================================================================
// Types
// =============================================================================

export interface OverflowSegmentedControlOption<T extends string = string> {
  value: T;
  label: ReactNode;
  /**
   * The heading this option sits under in the "More" list. Consecutive options with
   * the same section share one heading; with none set the list has no headings.
   */
  section?: string;
  /**
   * Listed under "More" only, never as a segment — even when the row has room for
   * every option, which would otherwise leave no More at all.
   */
  overflowOnly?: boolean;
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
   * Render an option in the popover grid.
   * If not provided, uses a default card-style rendering with the option's label.
   * @param option - The option to render
   * @param selected - Whether this option is currently selected
   * @param inSheet - True in the phone bottom sheet, where rows want bigger touch targets
   */
  renderOption?: (
    option: OverflowSegmentedControlOption<T>,
    selected: boolean,
    inSheet: boolean
  ) => ReactNode;
  /**
   * Number of columns in the grid layout for the popover.
   * If not provided, defaults to 1 (single column).
   */
  gridColumns?: number;
  /** Title of the bottom sheet "More" opens on a phone, where the popover is replaced. */
  drawerTitle?: ReactNode;
  /**
   * A click on the segment that is already selected. Mantine's SegmentedControl
   * reports nothing for it (the radio doesn't change), so a segment that opens
   * something — Custom's size modal — would otherwise open only once.
   */
  onReselect?: (value: T) => void;
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
  inSheet: boolean;
}

function DefaultModalOption({ label, inSheet }: DefaultModalOptionProps) {
  return (
    <div
      className={`flex items-center justify-center px-3 font-medium ${
        inSheet ? 'py-3.5 text-base' : 'py-2 text-sm'
      }`}
    >
      {label}
    </div>
  );
}

// =============================================================================
// Option Grid Component
// =============================================================================

interface OptionGridProps<T extends string> {
  options: OverflowSegmentedControlOption<T>[];
  value?: T;
  disabled?: boolean;
  onSelect: (value: T) => void;
  renderOption?: OverflowSegmentedControlProps<T>['renderOption'];
  gridColumns?: number;
  inSheet?: boolean;
}

/** The "More" list: one grid per section, each under its heading when sections are set. */
function OptionGrid<T extends string>(props: OptionGridProps<T>) {
  const sections: { title?: string; options: OverflowSegmentedControlOption<T>[] }[] = [];
  for (const option of props.options) {
    const last = sections[sections.length - 1];
    if (last && last.title === option.section) last.options.push(option);
    else sections.push({ title: option.section, options: [option] });
  }
  if (sections.length === 1 && !sections[0]!.title) return <OptionGridSection {...props} />;

  return (
    <div className="flex flex-col gap-2 p-2">
      {sections.map((section) => (
        <div key={section.title ?? ''} className="flex flex-col gap-1">
          {section.title && (
            <Text size="xs" fw={600} c="dimmed" tt="uppercase" px={4}>
              {section.title}
            </Text>
          )}
          <OptionGridSection {...props} options={section.options} />
        </div>
      ))}
    </div>
  );
}

function OptionGridSection<T extends string>({
  options,
  value,
  disabled,
  onSelect,
  renderOption,
  gridColumns = 1,
  inSheet = false,
}: OptionGridProps<T>) {
  const totalItems = options.length;
  const rowCount = Math.ceil(totalItems / gridColumns);

  return (
    <div
      className="grid overflow-hidden rounded-md bg-gray-1 dark:bg-[#141517]"
      style={{
        gridTemplateColumns: `repeat(${gridColumns}, minmax(0, 1fr))`,
      }}
    >
      {options.map((option, index) => {
        const selected = option.value === value;
        const column = index % gridColumns;
        const row = Math.floor(index / gridColumns);
        const isLastColumn = column === gridColumns - 1;
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
              className={`relative z-10 -m-px flex justify-center text-center transition-colors ${
                selected
                  ? 'bg-white text-black shadow-sm dark:bg-dark-5 dark:text-white'
                  : 'text-gray-6 hover:bg-gray-3 hover:text-gray-7 dark:text-dark-1 dark:hover:bg-dark-4 dark:hover:text-dark-0'
              }`}
            >
              {renderOption ? (
                renderOption(option, selected, inSheet)
              ) : (
                <DefaultModalOption label={option.label} selected={selected} inSheet={inSheet} />
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
  renderOption,
  gridColumns = 1,
  drawerTitle,
  onReselect,
  className,
}: OverflowSegmentedControlProps<T>) {
  const mobile = useIsMobile({ type: 'media' });
  // Default maxVisible to the number of options
  const maxVisible = maxVisibleProp ?? options.length;

  const containerRef = useRef<HTMLDivElement>(null);
  const [visibleCount, setVisibleCount] = useState(maxVisible);
  const [popoverOpened, setPopoverOpened] = useState(false);

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
    // Overflow-only options never take a segment, so they alone call for More.
    const rowOptions = options.filter((opt) => !opt.overflowOnly);
    // Check if we need a More button (can't fit all options in visible count)
    const needsMoreButton = options.length > visibleCount || rowOptions.length < options.length;

    // Calculate available slots (reserve 1 for More button if needed)
    const availableSlots = needsMoreButton ? visibleCount - 1 : visibleCount;

    // Determine base options to consider (priority or all)
    let baseOptions = rowOptions;
    if (priorityOptions && priorityOptions.length > 0) {
      const prioritySet = new Set(priorityOptions);
      baseOptions = rowOptions.filter((opt) => prioritySet.has(opt.value));
    }

    // Take first N options
    let visible = baseOptions.slice(0, Math.max(1, availableSlots));

    // If the selected value is not visible, swap it in for its nearest visible
    // neighbour in `options` order and keep the row in that order — replacing the
    // LAST slot put a tall pick at the wide end of the row.
    if (needsMoreButton && value) {
      const isSelectedInVisible = visible.some((opt) => opt.value === value);
      const selectedIndex = options.findIndex((opt) => opt.value === value);
      if (!isSelectedInVisible && selectedIndex !== -1 && visible.length > 0) {
        const indexOf = (opt: OverflowSegmentedControlOption<T>) => options.indexOf(opt);
        // On a tie, give up the slot nearer the row's END: the middle of a
        // widest-first aspect row is 1:1, which a 3:4 pick must not evict.
        const centre = (visible.length - 1) / 2;
        const rank = (opt: OverflowSegmentedControlOption<T>) => [
          Math.abs(indexOf(opt) - selectedIndex),
          -Math.abs(visible.indexOf(opt) - centre),
        ];
        const nearest = visible.reduce((best, opt) => {
          const [d, edge] = rank(opt);
          const [bestD, bestEdge] = rank(best);
          return d < bestD || (d === bestD && edge < bestEdge) ? opt : best;
        });
        visible = [...visible.filter((opt) => opt !== nearest), options[selectedIndex]!].sort(
          (a, b) => indexOf(a) - indexOf(b)
        );
      }
    }

    return {
      visibleOptions: visible,
      showMoreButton: needsMoreButton,
    };
  }, [options, value, visibleCount, priorityOptions]);

  // Build segmented control data (includes "More" button if needed)
  const segmentedData = useMemo(() => {
    const data = visibleOptions.map((opt) => ({
      value: opt.value,
      label: opt.label,
    }));

    if (showMoreButton) {
      data.push({
        value: MORE_VALUE as T,
        label: renderMoreButton ? renderMoreButton() : <DefaultMoreButton />,
      });
    }

    return data;
  }, [visibleOptions, showMoreButton, renderMoreButton]);

  const controlValue = value ?? '';

  const handleChange = (newValue: string) => {
    if (newValue === MORE_VALUE) {
      setPopoverOpened((o) => !o);
    } else {
      onChange?.(newValue as T);
    }
  };

  const handlePopoverSelect = (optionValue: T) => {
    onChange?.(optionValue);
    setPopoverOpened(false);
  };

  // Create a key based on visible option values and popover state to force re-render
  const segmentedKey = useMemo(
    () => `${segmentedData.map((d) => d.value).join(',')}-${popoverOpened}`,
    [segmentedData, popoverOpened]
  );

  return (
    <div
      ref={containerRef}
      className={`relative ${className ?? ''}`}
      onClick={(event) => {
        if (!onReselect || !value || disabled) return;
        // A segment is a <label> beside its radio, so one click arrives twice: on the
        // label, then forwarded to the radio. Act on the radio's only — reacting to both
        // opened Custom's modal twice.
        const radio = event.target;
        if (radio instanceof HTMLInputElement && radio.type === 'radio' && radio.value === value)
          onReselect(value);
      }}
    >
      <SegmentedControl
        key={segmentedKey}
        value={controlValue}
        onChange={handleChange}
        data={segmentedData}
        disabled={disabled}
        fullWidth
        classNames={{ label: 'relative', innerLabel: 'static' }}
      />
      {showMoreButton && mobile && (
        <MobileMenuDrawer
          opened={popoverOpened}
          onClose={() => setPopoverOpened(false)}
          title={drawerTitle && <Text fw={600}>{drawerTitle}</Text>}
        >
          <OptionGrid
            options={options}
            value={value}
            disabled={disabled}
            onSelect={handlePopoverSelect}
            renderOption={renderOption}
            gridColumns={gridColumns}
            inSheet
          />
        </MobileMenuDrawer>
      )}
      {showMoreButton && !mobile && (
        <Popover
          opened={popoverOpened}
          onChange={setPopoverOpened}
          position="bottom-end"
          withArrow
          arrowPosition="center"
          arrowSize={12}
          withinPortal
          shadow="md"
          closeOnClickOutside
        >
          <Popover.Target>
            <span className="absolute bottom-0 right-0 top-0 w-px" />
          </Popover.Target>
          <Popover.Dropdown p={0}>
            {/* Saved sizes can make the list taller than the screen: it scrolls. */}
            <ScrollArea.Autosize mah="min(60vh, 480px)" type="auto">
              <OptionGrid
                options={options}
                value={value}
                disabled={disabled}
                onSelect={handlePopoverSelect}
                renderOption={renderOption}
                gridColumns={gridColumns}
              />
            </ScrollArea.Autosize>
          </Popover.Dropdown>
        </Popover>
      )}
    </div>
  );
}

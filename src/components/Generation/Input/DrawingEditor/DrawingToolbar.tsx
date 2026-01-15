import {
  ActionIcon,
  Tooltip,
  Popover,
  Slider,
  ColorPicker,
  TextInput,
  Text,
  Stack,
  Group,
  Kbd,
  Menu,
} from '@mantine/core';
import {
  IconBrush,
  IconEraser,
  IconArrowBackUp,
  IconTrash,
  IconSquare,
  IconCircle,
  IconArrowNarrowRight,
  IconTypography,
  IconPointer,
  IconDownload,
  IconKeyboard,
  IconDotsVertical,
  IconCategory,
} from '@tabler/icons-react';
import clsx from 'clsx';
import type { DrawingToolbarProps, DrawingTool } from './drawing.types';
import { EXTENDED_COLOR_SWATCHES, MIN_BRUSH_SIZE, MAX_BRUSH_SIZE } from './drawing.utils';
import styles from './DrawingEditor.module.scss';
import { useOs } from '@mantine/hooks';

/** Shapes popover for mobile - 2x2 grid of shape tools */
function ShapesPopover({
  currentTool,
  onToolChange,
}: {
  currentTool: DrawingTool;
  onToolChange: (tool: DrawingTool) => void;
}) {
  const shapeTools: { tool: DrawingTool; icon: React.ReactNode; label: string }[] = [
    { tool: 'rectangle', icon: <IconSquare size={18} />, label: 'Rectangle' },
    { tool: 'circle', icon: <IconCircle size={18} />, label: 'Circle' },
    { tool: 'arrow', icon: <IconArrowNarrowRight size={18} />, label: 'Arrow' },
    { tool: 'text', icon: <IconTypography size={18} />, label: 'Text' },
  ];

  const isShapeActive = ['rectangle', 'circle', 'arrow', 'text'].includes(currentTool);
  const activeShape = shapeTools.find((s) => s.tool === currentTool);

  return (
    <Popover position="top" withArrow shadow="md" radius="md">
      <Popover.Target>
        <Tooltip label={activeShape?.label || 'Shapes'} withArrow>
          <button className={clsx(styles.toolButton, isShapeActive && styles.toolButtonActive)}>
            {activeShape?.icon || <IconCategory size={18} />}
          </button>
        </Tooltip>
      </Popover.Target>
      <Popover.Dropdown p={0}>
        <div className={styles.shapesGrid}>
          {shapeTools.map(({ tool, icon, label }) => (
            <button
              key={tool}
              onClick={() => onToolChange(tool)}
              className={clsx(
                styles.shapeGridButton,
                currentTool === tool && styles.shapeGridButtonActive
              )}
            >
              {icon}
              <span className={styles.shapeGridLabel}>{label}</span>
            </button>
          ))}
        </div>
      </Popover.Dropdown>
    </Popover>
  );
}

/** Actions overflow menu for mobile - contains Download and Clear */
function ActionsOverflowMenu({
  onDownload,
  onClear,
}: {
  onDownload?: () => void;
  onClear: () => void;
}) {
  return (
    <Menu withinPortal withArrow shadow="md" radius="md" position="top">
      <Menu.Target>
        <Tooltip label="More actions" withArrow>
          <ActionIcon variant="subtle" size="lg" radius="md">
            <IconDotsVertical size={20} />
          </ActionIcon>
        </Tooltip>
      </Menu.Target>
      <Menu.Dropdown>
        {onDownload && (
          <Menu.Item leftSection={<IconDownload size={16} />} onClick={onDownload}>
            Download
          </Menu.Item>
        )}
        <Menu.Item leftSection={<IconTrash size={16} />} onClick={onClear} color="red">
          Clear all
        </Menu.Item>
      </Menu.Dropdown>
    </Menu>
  );
}

export function DrawingToolbar({
  tool,
  onToolChange,
  brushSize,
  onBrushSizeChange,
  brushColor,
  onBrushColorChange,
  onClear,
  onUndo,
  canUndo,
  onDownload,
  isMobile = false,
}: DrawingToolbarProps) {
  // Show colors for all tools except eraser and select
  const showColors = tool !== 'eraser' && tool !== 'select';
  // Show size slider for stroke-based tools (not text or select)
  const showSizeSlider = tool !== 'text' && tool !== 'select';

  const os = useOs();
  const isDesktop = os === 'windows' || os === 'macos' || os === 'linux';

  // Mobile layout - compact with collapsible groups
  if (isMobile) {
    return (
      <div className={styles.toolbar}>
        <div className={clsx(styles.toolbarInner, styles.toolbarInnerMobile)}>
          {/* Primary tools - always visible */}
          <div className={styles.toolbarSection}>
            <ToolButton
              icon={<IconPointer size={18} />}
              label="Select"
              active={tool === 'select'}
              onClick={() => onToolChange('select')}
            />
            <ToolButton
              icon={<IconBrush size={18} />}
              label="Brush"
              active={tool === 'brush'}
              onClick={() => onToolChange('brush')}
            />
            <ToolButton
              icon={<IconEraser size={18} />}
              label="Eraser"
              active={tool === 'eraser'}
              onClick={() => onToolChange('eraser')}
            />
          </div>

          {/* Shapes popover - 2x2 grid */}
          <div className={styles.toolbarSection}>
            <ShapesPopover currentTool={tool} onToolChange={onToolChange} />
          </div>

          {/* Brush Size with Visual Preview - show for stroke-based tools */}
          {showSizeSlider && (
            <Popover
              width={200}
              position="top"
              withArrow
              shadow="md"
              radius="md"
              classNames={{ dropdown: styles.sizePopover }}
            >
              <Popover.Target>
                <div className={styles.toolbarSectionPadded}>
                  <Tooltip label={`Size: ${brushSize}px`} withArrow>
                    <button className={styles.sizeButton}>
                      <div
                        className="rounded-full"
                        style={{
                          width: Math.max(4, Math.min(24, brushSize * 0.6)),
                          height: Math.max(4, Math.min(24, brushSize * 0.6)),
                          backgroundColor:
                            tool === 'eraser' ? 'var(--mantine-color-gray-5)' : brushColor,
                        }}
                      />
                    </button>
                  </Tooltip>
                </div>
              </Popover.Target>
              <Popover.Dropdown>
                <div className={styles.sizePopoverContent}>
                  <div className={styles.sizePopoverHeader}>
                    <span className={styles.sizePopoverLabel}>Stroke Size</span>
                    <span className={styles.sizePopoverValue}>{brushSize}px</span>
                  </div>
                  <Slider
                    value={brushSize}
                    onChange={onBrushSizeChange}
                    min={MIN_BRUSH_SIZE}
                    max={MAX_BRUSH_SIZE}
                    step={1}
                    size="sm"
                    color="blue"
                  />
                  <div className={styles.sizePresets}>
                    {[5, 15, 25, 40].map((size) => (
                      <button
                        key={size}
                        onClick={() => onBrushSizeChange(size)}
                        className={clsx(
                          styles.sizePresetButton,
                          brushSize === size && styles.sizePresetButtonActive
                        )}
                      >
                        <div
                          className="rounded-full bg-current"
                          style={{
                            width: Math.max(3, size * 0.4),
                            height: Math.max(3, size * 0.4),
                          }}
                        />
                      </button>
                    ))}
                  </div>
                </div>
              </Popover.Dropdown>
            </Popover>
          )}

          {/* Color Selection - show for all tools except eraser */}
          {showColors && (
            <div className={styles.colorSection}>
              <Popover
                position="top"
                shadow="md"
                radius="md"
                classNames={{ dropdown: styles.colorPickerPopover }}
                withArrow
              >
                <Popover.Target>
                  <Tooltip label="Pick color" withArrow>
                    <button
                      className={styles.customColorButton}
                      style={{ backgroundColor: brushColor }}
                    />
                  </Tooltip>
                </Popover.Target>
                <Popover.Dropdown>
                  <div className={styles.colorPickerContent}>
                    <div className={styles.colorPickerHeader}>
                      <span className={styles.colorPickerLabel}>Color</span>
                      <TextInput
                        defaultValue={brushColor.toUpperCase()}
                        onChange={(e) => {
                          let value = e.target.value.toUpperCase();
                          if (!value.startsWith('#')) {
                            value = '#' + value;
                          }
                          if (/^#([0-9A-F]{3}|[0-9A-F]{4}|[0-9A-F]{6})$/i.test(value)) {
                            onBrushColorChange(value);
                          }
                        }}
                        onBlur={(e) => {
                          e.target.value = brushColor.toUpperCase();
                        }}
                        size="xs"
                        maxLength={6}
                        classNames={{ input: styles.hexInput }}
                      />
                    </div>
                    <ColorPicker
                      format="hex"
                      value={brushColor}
                      onChange={onBrushColorChange}
                      swatches={EXTENDED_COLOR_SWATCHES}
                      swatchesPerRow={6}
                      size="sm"
                    />
                  </div>
                </Popover.Dropdown>
              </Popover>
            </div>
          )}

          {/* Actions - Undo visible, rest in overflow menu */}
          <div className={styles.actions}>
            <Tooltip label="Undo" withArrow>
              <ActionIcon
                variant="subtle"
                size="lg"
                radius="md"
                onClick={onUndo}
                disabled={!canUndo}
              >
                <IconArrowBackUp size={20} />
              </ActionIcon>
            </Tooltip>
            <ActionsOverflowMenu onDownload={onDownload} onClear={onClear} />
          </div>
        </div>
      </div>
    );
  }

  // Desktop layout - unchanged
  return (
    <div className={styles.toolbar}>
      <div className={styles.toolbarInner}>
        {/* Selection Tool */}
        <div className={styles.toolbarSection}>
          <ToolButton
            icon={<IconPointer size={18} />}
            label="Select (move/resize)"
            active={tool === 'select'}
            onClick={() => onToolChange('select')}
          />
        </div>

        {/* Drawing Tools Section */}
        <div className={styles.toolbarSection}>
          <ToolButton
            icon={<IconBrush size={18} />}
            label="Brush"
            active={tool === 'brush'}
            onClick={() => onToolChange('brush')}
          />
          <ToolButton
            icon={<IconEraser size={18} />}
            label="Eraser"
            active={tool === 'eraser'}
            onClick={() => onToolChange('eraser')}
          />
        </div>

        {/* Shape Tools Section */}
        <div className={styles.toolbarSection}>
          <ToolButton
            icon={<IconSquare size={18} />}
            label="Rectangle"
            active={tool === 'rectangle'}
            onClick={() => onToolChange('rectangle')}
          />
          <ToolButton
            icon={<IconCircle size={18} />}
            label="Circle"
            active={tool === 'circle'}
            onClick={() => onToolChange('circle')}
          />
          <ToolButton
            icon={<IconArrowNarrowRight size={18} />}
            label="Arrow"
            active={tool === 'arrow'}
            onClick={() => onToolChange('arrow')}
          />
          <ToolButton
            icon={<IconTypography size={18} />}
            label="Text"
            active={tool === 'text'}
            onClick={() => onToolChange('text')}
          />
        </div>

        {/* Brush Size with Visual Preview - show for stroke-based tools */}
        {showSizeSlider && (
          <Popover
            width={200}
            position="top"
            withArrow
            shadow="md"
            radius="md"
            classNames={{ dropdown: styles.sizePopover }}
          >
            <Popover.Target>
              <div className={styles.toolbarSectionPadded}>
                <Tooltip label={`Size: ${brushSize}px`} withArrow>
                  <button className={styles.sizeButton}>
                    {/* Visual size preview circle */}
                    <div
                      className="rounded-full"
                      style={{
                        width: Math.max(4, Math.min(24, brushSize * 0.6)),
                        height: Math.max(4, Math.min(24, brushSize * 0.6)),
                        backgroundColor:
                          tool === 'eraser' ? 'var(--mantine-color-gray-5)' : brushColor,
                      }}
                    />
                  </button>
                </Tooltip>
              </div>
            </Popover.Target>
            <Popover.Dropdown>
              <div className={styles.sizePopoverContent}>
                <div className={styles.sizePopoverHeader}>
                  <span className={styles.sizePopoverLabel}>Stroke Size</span>
                  <span className={styles.sizePopoverValue}>{brushSize}px</span>
                </div>
                <Slider
                  value={brushSize}
                  onChange={onBrushSizeChange}
                  min={MIN_BRUSH_SIZE}
                  max={MAX_BRUSH_SIZE}
                  step={1}
                  size="sm"
                  color="blue"
                />
                {/* Size presets */}
                <div className={styles.sizePresets}>
                  {[5, 15, 25, 40].map((size) => (
                    <button
                      key={size}
                      onClick={() => onBrushSizeChange(size)}
                      className={clsx(
                        styles.sizePresetButton,
                        brushSize === size && styles.sizePresetButtonActive
                      )}
                    >
                      <div
                        className="rounded-full bg-current"
                        style={{
                          width: Math.max(3, size * 0.4),
                          height: Math.max(3, size * 0.4),
                        }}
                      />
                    </button>
                  ))}
                </div>
              </div>
            </Popover.Dropdown>
          </Popover>
        )}

        {/* Color Selection - show for all tools except eraser */}
        {showColors && (
          <div className={styles.colorSection}>
            {/* Color picker button */}
            <Popover
              position="top"
              shadow="md"
              radius="md"
              classNames={{ dropdown: styles.colorPickerPopover }}
              withArrow
            >
              <Popover.Target>
                <Tooltip label="Pick color" withArrow>
                  <button
                    className={styles.customColorButton}
                    style={{ backgroundColor: brushColor }}
                  />
                </Tooltip>
              </Popover.Target>
              <Popover.Dropdown>
                <div className={styles.colorPickerContent}>
                  <div className={styles.colorPickerHeader}>
                    <span className={styles.colorPickerLabel}>Color</span>
                    <TextInput
                      defaultValue={brushColor.toUpperCase()}
                      onChange={(e) => {
                        let value = e.target.value.toUpperCase();
                        // Ensure it starts with #
                        if (!value.startsWith('#')) {
                          value = '#' + value;
                        }
                        // Only update if it's a valid hex color (3, 4 or 6 chars after #)
                        if (/^#([0-9A-F]{3}|[0-9A-F]{4}|[0-9A-F]{6})$/i.test(value)) {
                          onBrushColorChange(value);
                        }
                      }}
                      onBlur={(e) => {
                        // On blur, reset to current valid color if invalid
                        e.target.value = brushColor.toUpperCase();
                      }}
                      size="xs"
                      maxLength={6}
                      classNames={{ input: styles.hexInput }}
                    />
                  </div>
                  <ColorPicker
                    format="hex"
                    value={brushColor}
                    onChange={onBrushColorChange}
                    swatches={EXTENDED_COLOR_SWATCHES}
                    swatchesPerRow={6}
                    size="sm"
                  />
                </div>
              </Popover.Dropdown>
            </Popover>
          </div>
        )}

        {/* Actions */}
        <div className={styles.actions}>
          <Tooltip label="Undo (Ctrl+Z)" withArrow>
            <ActionIcon variant="subtle" size="lg" radius="md" onClick={onUndo} disabled={!canUndo}>
              <IconArrowBackUp size={20} />
            </ActionIcon>
          </Tooltip>
          {isDesktop && (
            <Popover position="top" withArrow shadow="md" radius="md" width={250}>
              <Popover.Target>
                <Tooltip label="Keyboard shortcuts" withArrow>
                  <ActionIcon variant="subtle" size="lg" radius="md">
                    <IconKeyboard size={20} />
                  </ActionIcon>
                </Tooltip>
              </Popover.Target>
              <Popover.Dropdown>
                <Stack gap="xs">
                  <Text size="sm" fw={600}>
                    Keyboard Shortcuts
                  </Text>
                  <Stack gap="xs">
                    <Group justify="space-between">
                      <Text size="sm">Undo</Text>
                      {os === 'macos' ? <Kbd size="xs">⌘ + Z</Kbd> : <Kbd size="xs">Ctrl + Z</Kbd>}
                    </Group>
                    <Group justify="space-between">
                      <Text size="sm">Redo</Text>
                      {os === 'macos' ? (
                        <Kbd size="xs">⌘ + Shift + Z</Kbd>
                      ) : (
                        <Kbd size="xs">Ctrl + Shift + Z</Kbd>
                      )}
                    </Group>
                    <Group justify="space-between">
                      <Text size="sm">Delete selected</Text>
                      <Kbd size="xs">Backspace</Kbd>
                    </Group>
                    <Group justify="space-between">
                      <Text size="sm">Confirm text</Text>
                      {os === 'macos' ? (
                        <Kbd size="xs">⌘ + Enter</Kbd>
                      ) : (
                        <Kbd size="xs">Ctrl + Enter</Kbd>
                      )}
                    </Group>
                    <Group justify="space-between">
                      <Text size="sm">Cancel text</Text>
                      <Kbd size="xs">Esc</Kbd>
                    </Group>
                  </Stack>
                </Stack>
              </Popover.Dropdown>
            </Popover>
          )}
          {onDownload && (
            <Tooltip label="Download" withArrow>
              <ActionIcon variant="subtle" size="lg" radius="md" onClick={onDownload}>
                <IconDownload size={18} />
              </ActionIcon>
            </Tooltip>
          )}
          <Tooltip label="Clear all" withArrow>
            <ActionIcon variant="subtle" size="lg" radius="md" onClick={onClear} color="red">
              <IconTrash size={18} />
            </ActionIcon>
          </Tooltip>
        </div>
      </div>
    </div>
  );
}

/** Individual tool button with active state */
function ToolButton({
  icon,
  label,
  active,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <Tooltip label={label} withArrow>
      <button
        onClick={onClick}
        className={clsx(styles.toolButton, active && styles.toolButtonActive)}
      >
        {icon}
      </button>
    </Tooltip>
  );
}

import { ActionIcon, Tooltip, Popover, Slider, ColorPicker, TextInput } from '@mantine/core';
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
} from '@tabler/icons-react';
import clsx from 'clsx';
import type { DrawingToolbarProps } from './drawing.types';
import { EXTENDED_COLOR_SWATCHES, MIN_BRUSH_SIZE, MAX_BRUSH_SIZE } from './drawing.utils';
import styles from './DrawingEditor.module.scss';

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
}: DrawingToolbarProps) {
  // Show colors for all tools except eraser and select
  const showColors = tool !== 'eraser' && tool !== 'select';
  // Show size slider for stroke-based tools (not text or select)
  const showSizeSlider = tool !== 'text' && tool !== 'select';

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

        {/* Eraser indicator when eraser is selected */}
        {tool === 'eraser' && (
          <div className={styles.eraserIndicator}>
            <span>Eraser mode</span>
          </div>
        )}

        {/* Actions */}
        <div className={styles.actions}>
          <Tooltip label="Undo (Ctrl+Z)" withArrow>
            <ActionIcon variant="subtle" size="lg" radius="md" onClick={onUndo} disabled={!canUndo}>
              <IconArrowBackUp size={20} />
            </ActionIcon>
          </Tooltip>
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

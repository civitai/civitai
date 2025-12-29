import { ActionIcon, Tooltip, Popover, Slider, ColorSwatch } from '@mantine/core';
import { IconBrush, IconEraser, IconArrowBackUp, IconTrash, IconCheck } from '@tabler/icons-react';
import clsx from 'clsx';
import type { DrawingToolbarProps } from './drawing.types';
import { DRAWING_COLORS, MIN_BRUSH_SIZE, MAX_BRUSH_SIZE } from './drawing.utils';
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
  return (
    <div className={styles.toolbar}>
      <div className={styles.toolbarInner}>
        {/* Tool Selection */}
        <div className={styles.toolbarSection}>
          <ToolButton
            icon={<IconBrush size={18} />}
            label="Brush"
            active={tool === 'brush'}
            onClick={() => onToolChange('brush')}
            activeColor={brushColor}
          />
          <ToolButton
            icon={<IconEraser size={18} />}
            label="Eraser"
            active={tool === 'eraser'}
            onClick={() => onToolChange('eraser')}
          />
        </div>

        {/* Brush Size with Visual Preview */}
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
                        tool === 'brush' ? brushColor : 'var(--mantine-color-gray-5)',
                    }}
                  />
                </button>
              </Tooltip>
            </div>
          </Popover.Target>
          <Popover.Dropdown>
            <div className={styles.sizePopoverContent}>
              <div className={styles.sizePopoverHeader}>
                <span className={styles.sizePopoverLabel}>Brush Size</span>
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

        {/* Color Selection */}
        {tool === 'brush' && (
          <div className={styles.colorSwatches}>
            {DRAWING_COLORS.map(({ color, label }) => {
              const isSelected = brushColor === color;
              const isLight = color === '#FFFFFF' || color === '#FFFF00' || color === '#00FF00';

              return (
                <Tooltip key={color} label={label} withArrow>
                  <ColorSwatch
                    color={color}
                    size={18}
                    radius="xl"
                    onClick={() => onBrushColorChange(color)}
                    withShadow={false}
                    className={clsx(styles.colorSwatch, isSelected && styles.colorSwatchSelected)}
                  >
                    {isSelected && (
                      <IconCheck size={14} stroke={3} color={isLight ? '#000' : '#fff'} />
                    )}
                  </ColorSwatch>
                </Tooltip>
              );
            })}
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
  activeColor,
}: {
  icon: React.ReactNode;
  label: string;
  active: boolean;
  onClick: () => void;
  activeColor?: string;
}) {
  const isLight =
    activeColor === '#FFFFFF' || activeColor === '#FFFF00' || activeColor === '#00FF00';

  return (
    <Tooltip label={label} withArrow>
      <button
        onClick={onClick}
        className={clsx(styles.toolButton, active && styles.toolButtonActive)}
        style={
          active && activeColor
            ? { backgroundColor: activeColor, color: isLight ? '#000' : '#fff' }
            : undefined
        }
      >
        {icon}
      </button>
    </Tooltip>
  );
}

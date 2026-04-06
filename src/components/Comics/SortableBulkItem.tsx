import { ActionIcon, NativeSelect, Text, TextInput } from '@mantine/core';
import { IconGripVertical, IconSparkles, IconX } from '@tabler/icons-react';
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';

export function SortableBulkItem({
  item,
  index,
  onUpdatePrompt,
  onUpdateAspectRatio,
  onRemove,
  aspectRatioLabels,
}: {
  item: { id: string; sourceImage?: { preview: string }; prompt: string; aspectRatio: string };
  index: number;
  onUpdatePrompt: (id: string, prompt: string) => void;
  onUpdateAspectRatio: (id: string, aspectRatio: string) => void;
  onRemove: (id: string) => void;
  aspectRatioLabels: string[];
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: item.id,
  });

  return (
    <div
      ref={setNodeRef}
      className="flex items-start gap-2 rounded-md p-2"
      style={{
        background: 'var(--mantine-color-dark-6)',
        border: '1px solid var(--mantine-color-dark-4)',
        transform: CSS.Transform.toString(transform),
        transition,
        opacity: isDragging ? 0.5 : 1,
      }}
    >
      {/* Drag handle */}
      <div
        {...attributes}
        {...listeners}
        className="flex-shrink-0 flex items-center cursor-grab"
        style={{ marginTop: 18, touchAction: 'none', color: '#909296' }}
      >
        <IconGripVertical size={16} />
      </div>

      {/* Thumbnail or icon */}
      <div
        className="flex-shrink-0 flex items-center justify-center overflow-hidden rounded"
        style={{
          width: 56,
          height: 56,
          background: 'var(--mantine-color-dark-5)',
        }}
      >
        {item.sourceImage ? (
          <img
            src={item.sourceImage.preview}
            alt={`Item ${index + 1}`}
            style={{ width: '100%', height: '100%', objectFit: 'cover' }}
          />
        ) : (
          <IconSparkles size={20} style={{ color: '#fab005' }} />
        )}
      </div>

      {/* Prompt input */}
      <div className="flex-1 min-w-0">
        <Text size="xs" c="dimmed" mb={2}>
          {item.sourceImage
            ? item.prompt.trim()
              ? 'Enhance (costs buzz)'
              : 'Upload only (free)'
            : 'Text-to-image (costs buzz)'}
        </Text>
        <div className="flex gap-2 items-end">
          <TextInput
            size="xs"
            className="flex-1"
            placeholder={
              item.sourceImage ? 'Optional prompt for enhancement...' : 'Describe the scene...'
            }
            value={item.prompt}
            onChange={(e) => onUpdatePrompt(item.id, e.target.value)}
          />
          <NativeSelect
            size="xs"
            value={item.aspectRatio}
            onChange={(e) => onUpdateAspectRatio(item.id, e.target.value)}
            data={aspectRatioLabels}
            style={{ width: 72, flexShrink: 0 }}
          />
        </div>
      </div>

      {/* Remove button */}
      <ActionIcon
        variant="subtle"
        color="gray"
        size="sm"
        onClick={() => onRemove(item.id)}
        style={{ flexShrink: 0, marginTop: 2 }}
      >
        <IconX size={14} />
      </ActionIcon>
    </div>
  );
}

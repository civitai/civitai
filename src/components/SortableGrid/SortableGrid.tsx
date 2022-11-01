import {
  useSensors,
  useSensor,
  PointerSensor,
  KeyboardSensor,
  DndContext,
  closestCenter,
  DndContextProps,
} from '@dnd-kit/core';
import { sortableKeyboardCoordinates, SortableContext, useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { SimpleGrid, SimpleGridProps } from '@mantine/core';
import React, { CSSProperties } from 'react';
import useIsClient from '~/hooks/useIsClient';

export function SortableGrid<T>({
  children,
  items,
  rowKey,
  gridProps,
  disabled = false,
  ...props
}: SortableGridProps<T>) {
  const isClient = useIsClient();
  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: {
        // delay: 0,
        // tolerance: 5,
        distance: 8,
      },
    }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    })
  );

  if (!items.length) return null;
  if (typeof items[0][rowKey] !== 'number' && items[0][rowKey] !== 'string') {
    console.error('invalid row key provided to SortableGrid');
    return null;
  }

  const keys = items.map((item) => item[rowKey] as string | number);

  return isClient ? (
    <DndContext sensors={sensors} collisionDetection={closestCenter} {...props}>
      <SortableContext items={keys}>
        <SimpleGrid {...gridProps}>
          {items.map((item, index) => (
            <SortableItem
              key={item[rowKey] as string | number}
              id={item[rowKey] as string | number}
              disabled={disabled}
            >
              {children(item, index)}
            </SortableItem>
          ))}
        </SimpleGrid>
      </SortableContext>
    </DndContext>
  ) : null;
}

type SortableGridProps<T> = Pick<DndContextProps, 'onDragEnd'> & {
  children: (item: T, index: number) => React.ReactNode;
  items: T[];
  rowKey: keyof T;
  gridProps?: SimpleGridProps;
  disabled?: boolean;
};

function SortableItem({ id, children, disabled = false }: SortableItemProps) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id,
    disabled,
  });
  const style: CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    cursor: isDragging ? 'grabbing' : !disabled ? 'pointer' : 'auto',
  };

  return (
    <div ref={setNodeRef} style={style} {...attributes} {...listeners}>
      {children}
    </div>
  );
}

type SortableItemProps = { id: number | string; children: React.ReactNode; disabled: boolean };

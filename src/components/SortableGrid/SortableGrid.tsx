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
import React from 'react';
import useIsClient from '~/hooks/useIsClient';

export function SortableGrid<T extends BaseEntity = BaseEntity>({
  children,
  items,
  gridProps,
  disabled = false,
  ...props
}: SortableGridProps<T>) {
  const isClient = useIsClient();
  const sensors = useSensors(
    useSensor(PointerSensor),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    })
  );

  const ids = items.map((item) => item.id);

  return isClient ? (
    <DndContext sensors={sensors} collisionDetection={closestCenter} {...props}>
      <SortableContext items={ids}>
        <SimpleGrid {...gridProps}>
          {items.map((item, index) => (
            <SortableItem key={item.id} id={item.id} disabled={disabled}>
              {children(item, index)}
            </SortableItem>
          ))}
        </SimpleGrid>
      </SortableContext>
    </DndContext>
  ) : null;
}

type SortableGridProps<T extends BaseEntity = BaseEntity> = Pick<DndContextProps, 'onDragEnd'> & {
  children: (item: T, index: number) => React.ReactNode;
  items: T[];
  gridProps?: SimpleGridProps;
  disabled?: boolean;
};

function SortableItem({ id, children, disabled = false }: SortableItemProps) {
  const { attributes, listeners, setNodeRef, transform, transition } = useSortable({
    id,
    disabled,
  });
  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
  };

  return (
    <div ref={setNodeRef} style={style} {...attributes} {...listeners}>
      {children}
    </div>
  );
}

type SortableItemProps = { id: string; children: React.ReactNode; disabled: boolean };

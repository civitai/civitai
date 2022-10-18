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
import { CSS, Transform } from '@dnd-kit/utilities';
import { createStyles, Group, SimpleGrid, SimpleGridProps } from '@mantine/core';
import { IconGripVertical, IconZoomIn } from '@tabler/icons';
import React from 'react';
import useIsClient from '~/hooks/useIsClient';

export function SortableGrid<T extends BaseEntity = BaseEntity>({
  children,
  items,
  gridProps,
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
            <SortableItem key={item.id} id={item.id}>
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
};

const useStyles = createStyles(
  (theme, params: { transform: Transform | null; transition: string | undefined }, getRef) => ({
    sortableWrapper: {
      transform: CSS.Transform.toString(params.transform),
      transition: params.transition ?? '',
      cursor: 'pointer',
      position: 'relative',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',

      [`&:hover .${getRef('actionsGroup')}`]: {
        opacity: 1,
        transition: 'all 0.2s ease',
      },
    },

    draggableIcon: {
      position: 'absolute',
      top: '4px',
      right: 0,
    },

    actionsGroup: {
      ref: getRef('actionsGroup'),
      opacity: 0,
      position: 'absolute',
      background: 'rgba(0, 0, 0, 0.6)',
      justifyContent: 'center',
      width: '100%',
      height: '100%',
      top: 0,
      left: 0,
    },
  })
);

function SortableItem({ id, children }: SortableItemProps) {
  const { attributes, listeners, setNodeRef, transform, transition } = useSortable({ id });
  const { classes } = useStyles({ transform, transition });

  return (
    <div ref={setNodeRef} className={classes.sortableWrapper} {...attributes} {...listeners}>
      {children}
      <Group align="center" className={classes.actionsGroup}>
        <IconZoomIn size={32} stroke={1.5} color="white" />
        <IconGripVertical size={24} stroke={1.5} className={classes.draggableIcon} color="white" />
      </Group>
    </div>
  );
}

type SortableItemProps = { id: string; children: React.ReactNode };

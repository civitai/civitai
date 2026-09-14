import type { CSSProperties } from 'react';
import type React from 'react';
import { cloneElement } from 'react';
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import type { UniqueIdentifier } from '@dnd-kit/core';

export function SortableItem({
  disabled,
  children,
  id,
  cursor = 'pointer',
}: {
  disabled?: boolean;
  children: React.ReactElement<React.ComponentPropsWithRef<'div'>>;
  id: UniqueIdentifier;
  cursor?: CSSProperties['cursor'];
}) {
  // `disabled` has to reach dnd-kit, not only the cursor: without it the row stays draggable and
  // reorders while a caller believes it has switched dragging off. `SortableGrid` and the
  // suggested-resources modal both rely on this prop to mean "not reorderable".
  const sortable = useSortable({ id, disabled });

  const { attributes, listeners, isDragging, setNodeRef, transform, transition } = sortable;

  const style: CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    cursor: isDragging ? 'grabbing' : !disabled ? cursor : 'auto',
    zIndex: isDragging ? 1 : undefined,
    touchAction: 'none',
  };

  return cloneElement(children, {
    ref: setNodeRef,
    style: { ...style, ...(children.props?.style || {}) },
    ...attributes,
    ...listeners,
  });
}

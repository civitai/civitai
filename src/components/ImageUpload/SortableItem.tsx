import React, { CSSProperties, cloneElement } from 'react';
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { UniqueIdentifier } from '@dnd-kit/core';

export function SortableImage({
  disabled,
  children,
  id,
}: {
  disabled?: boolean;
  children: React.ReactElement<React.ComponentPropsWithRef<'div'>>;
  id: UniqueIdentifier;
}) {
  const sortable = useSortable({ id });

  const { attributes, listeners, isDragging, setNodeRef, transform, transition } = sortable;

  const style: CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    cursor: isDragging ? 'grabbing' : !disabled ? 'pointer' : 'auto',
  };

  return cloneElement(children, {
    ref: setNodeRef,
    style: { ...style, ...children.props.style },
    ...attributes,
    ...listeners,
  });
}

import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';

export function SortableChapter({
  id,
  disabled,
  children,
}: {
  id: number;
  /**
   * When true, drag listeners are NOT bound. Layout/transform still apply
   * so an active reorder can finish painting, but a click on the card
   * won't initiate a drag — the parent controls when reordering is on.
   */
  disabled?: boolean;
  children: React.ReactNode;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id,
    disabled,
  });
  return (
    <div
      ref={setNodeRef}
      style={{
        transform: CSS.Transform.toString(transform),
        transition,
        opacity: isDragging ? 0.5 : 1,
      }}
      {...(disabled ? {} : attributes)}
      {...(disabled ? {} : listeners)}
    >
      {children}
    </div>
  );
}

import type { ReactNodeViewProps } from '@tiptap/react';
import { useRef, useState } from 'react';
import type { ImageAlign, ImageWidth } from '~/shared/tiptap/image-width';
import { snapImageWidth } from '~/shared/tiptap/image-width';
// The rendered article's frame, so the editor lays an image out exactly as the article does.
import frameClasses from './GuardedBodyMedia.module.scss';
import classes from './ResizableImageFrame.module.scss';

type Side = 'left' | 'right';

/** Set the size, then reselect the image: replacing the node would drop the selection and the handles. */
export function resizeAndKeepSelected(
  {
    editor,
    getPos,
    updateAttributes,
  }: Pick<ReactNodeViewProps, 'editor' | 'getPos' | 'updateAttributes'>,
  size: ImageWidth | null
) {
  updateAttributes({ size });
  const pos = getPos();
  if (typeof pos === 'number') editor.commands.setNodeSelection(pos);
}

/** The width a drag gives, as % of the column. A centred image grows on both sides at once. */
export function draggedWidthPercent({
  startWidth,
  dx,
  side,
  centred,
  columnWidth,
}: {
  startWidth: number;
  dx: number;
  side: Side;
  centred: boolean;
  columnWidth: number;
}) {
  const grow = (side === 'right' ? dx : -dx) * (centred ? 2 : 1);
  return Math.min(100, Math.max(10, ((startWidth + grow) / columnWidth) * 100));
}

export function ResizableImageFrame({
  size,
  align,
  selected,
  onResize,
  children,
}: {
  size: ImageWidth | null;
  align: ImageAlign | null;
  selected: boolean;
  onResize: (size: ImageWidth | null) => void;
  children: React.ReactNode;
}) {
  const frameRef = useRef<HTMLDivElement>(null);
  const [preview, setPreview] = useState<number | null>(null);
  const centred = align === 'center' || (!align && !!size);

  const startDrag = (side: Side) => (e: React.PointerEvent<HTMLElement>) => {
    const frame = frameRef.current;
    // max-width % resolves against the frame's parent: the column, or a list item or quote in it.
    const column = frame?.parentElement;
    if (!frame || !column) return;
    e.preventDefault();
    e.stopPropagation();
    const style = getComputedStyle(column);
    const columnWidth =
      column.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
    const startX = e.clientX;
    const startWidth = frame.getBoundingClientRect().width;
    let percent: number | null = null;

    const move = (ev: PointerEvent) => {
      if (percent === null && Math.abs(ev.clientX - startX) < 3) return;
      percent = draggedWidthPercent({
        startWidth,
        dx: ev.clientX - startX,
        side,
        centred,
        columnWidth,
      });
      setPreview(percent);
    };
    const stop = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', end);
      window.removeEventListener('pointercancel', stop);
      setPreview(null);
    };
    const end = () => {
      stop();
      // A tap measures the shown width, which on a phone is not the stored one: only a drag saves.
      if (percent === null) return;
      const next = snapImageWidth(percent);
      // Back where it started: no change, even where the start doesn't snap (legacy 33, natural size).
      if (next === size || next === snapImageWidth((startWidth / columnWidth) * 100)) return;
      // One attribute change on release, so a drag is a single undo step.
      onResize(next);
    };
    // On window, so the drag keeps going when the pointer leaves the small handle.
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', end);
    window.addEventListener('pointercancel', stop);
  };

  return (
    <div
      ref={frameRef}
      className={frameClasses.root}
      data-width={size ?? undefined}
      data-align={align ?? undefined}
      style={preview !== null ? { maxWidth: `${preview}%` } : undefined}
    >
      {children}
      {selected &&
        (['left', 'right'] as const).map((side) => (
          <span
            key={side}
            data-side={side}
            className={classes.handle}
            contentEditable={false}
            draggable={false}
            aria-label={`Resize from the ${side} edge`}
            onPointerDown={startDrag(side)}
            // ProseMirror starts a node drag or moves the selection on mousedown.
            onMouseDown={(e) => {
              e.preventDefault();
              e.stopPropagation();
            }}
          />
        ))}
    </div>
  );
}

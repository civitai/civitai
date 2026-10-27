/** Drop-target handlers for files, shared by the Data steps. Spread them onto the target. An
 *  enter/leave depth counter, because leave fires for every child crossed, so a plain boolean
 *  flickers; and file drags only, because the targets hold draggable content (preview images,
 *  selectable text) whose in-page drags would otherwise summon the drop state. */
export function fileDrop(
  onDragging: (dragging: boolean) => void,
  onFiles: (files: File[]) => void
) {
  let depth = 0;
  const hasFiles = (e: DragEvent) => !!e.dataTransfer?.types.includes('Files');
  return {
    ondragenter(e: DragEvent) {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth += 1;
      onDragging(true);
    },
    ondragover(e: DragEvent) {
      if (hasFiles(e)) e.preventDefault();
    },
    ondragleave() {
      depth = Math.max(0, depth - 1);
      if (depth === 0) onDragging(false);
    },
    ondrop(e: DragEvent) {
      e.preventDefault();
      depth = 0;
      onDragging(false);
      onFiles([...(e.dataTransfer?.files ?? [])]);
    },
  };
}

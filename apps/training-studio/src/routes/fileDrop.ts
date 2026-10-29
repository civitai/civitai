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

const ZIP_MIMES = new Set(['application/zip', 'application/x-zip-compressed']);
export const isZip = (f: File) => ZIP_MIMES.has(f.type) || f.name.toLowerCase().endsWith('.zip');

/** The files a file input's change event picked. Clears the input, so picking the same file again
 *  (after removing it) still fires a change. */
export function pickedFiles(e: Event): File[] {
  const input = e.currentTarget as HTMLInputElement;
  const files = [...(input.files ?? [])];
  input.value = '';
  return files;
}

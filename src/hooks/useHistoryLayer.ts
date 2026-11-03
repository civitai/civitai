import { useEffect, useRef } from 'react';
import { closeHistoryLayer, openHistoryLayer } from '~/utils/history-layers';

/**
 * While `opened`, the browser's Back closes this layer (calling `onClose`) instead of leaving the
 * page. Closing it any other way goes back over its history entry.
 */
export function useHistoryLayer(opened: boolean, onClose: () => void, enabled = true) {
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const layerRef = useRef<{ id: number; release?: ReturnType<typeof setTimeout> }>();

  useEffect(() => {
    if (!opened || !enabled) return;
    const layer = layerRef.current;
    // Strict mode unmounts and remounts at once: keep the entry rather than go back and push again.
    if (layer?.release) {
      clearTimeout(layer.release);
      layer.release = undefined;
    } else {
      const id = openHistoryLayer(() => {
        layerRef.current = undefined;
        onCloseRef.current();
      });
      layerRef.current = { id };
    }
    return () => {
      const current = layerRef.current;
      if (!current) return; // Back already closed it
      current.release = setTimeout(() => {
        layerRef.current = undefined;
        closeHistoryLayer(current.id);
      });
    };
  }, [opened, enabled]);
}

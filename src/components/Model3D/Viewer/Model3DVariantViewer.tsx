import { Select } from '@mantine/core';
import dynamic from 'next/dynamic';
import { useEffect, useMemo, useState } from 'react';

/**
 * A single in-browser-viewable PolyGen variant. `key` is the unique id used
 * for selection state + React keys; `label` is what shows in the dropdown
 * (e.g., "Base", "Rigged", "Walking"). The viewer only ever loads GLB —
 * callers must filter out non-previewable formats and armature-only files
 * before passing them in.
 */
export type Model3DViewableVariant = {
  key: string;
  label: string;
  url: string;
  format: string;
  sizeKB?: number;
};

type Model3DVariantViewerProps = {
  variants: Model3DViewableVariant[];
  /** Initial selection. Defaults to the first entry. */
  initialKey?: string;
  /** Forwarded to the underlying Model3DViewer — fills its parent container instead of imposing min-h-[480px]. */
  compact?: boolean;
  className?: string;
};

// Dynamic, ssr-disabled import — three.js needs WebGL. Matches the import
// the detail page already uses; collocating it here keeps consumers from
// having to bring their own dynamic wrapper just to mount this component.
const Model3DViewer = dynamic(
  () => import('~/components/Model3D/Viewer/Model3DViewer').then((m) => m.Model3DViewer),
  { ssr: false }
);

/**
 * `Model3DViewer` + a top-left variant picker. When only one variant is
 * available the picker is hidden (so the queue card / detail page get a
 * clean viewer with no chrome unless there's actually a choice to make).
 *
 * The picker drives the viewer URL by re-keying `Model3DViewer`'s `url`
 * prop, which its mount-effect already re-runs on. Embedded glTF
 * animations on the selected file are auto-played by the viewer's
 * `AnimationMixer` — walking/running templates animate on the spot the
 * moment they're selected; rigged/base GLBs are static.
 */
export function Model3DVariantViewer({
  variants,
  initialKey,
  compact,
  className,
}: Model3DVariantViewerProps) {
  const [selectedKey, setSelectedKey] = useState<string | null>(
    initialKey ?? variants[0]?.key ?? null
  );

  // Keep the selection valid as the variant list changes (e.g., the parent
  // swaps from the workflow blob to the saved Model3D files post-save).
  useEffect(() => {
    if (!variants.length) {
      setSelectedKey(null);
      return;
    }
    if (!selectedKey || !variants.some((v) => v.key === selectedKey)) {
      setSelectedKey(initialKey ?? variants[0].key);
    }
  }, [variants, initialKey, selectedKey]);

  const selected = useMemo(
    () => variants.find((v) => v.key === selectedKey) ?? variants[0] ?? null,
    [variants, selectedKey]
  );

  if (!selected) return null;

  return (
    // `size-full` on the wrapper guarantees both the absolutely-positioned
    // picker and the underlying viewer have a defined box to lay out in.
    // In compact mode the inner Model3DViewer's `h-full` only works if its
    // own Stack ancestor has a resolved height — we make sure of that by
    // passing `size-full` through.
    <div className={`relative size-full ${className ?? ''}`}>
      {variants.length > 1 && (
        // Overlay the picker on the viewer rather than reserving layout
        // above it — keeps the viewer's aspect-square box uniform between
        // single- and multi-variant cases. Pointer-events isolated so the
        // OrbitControls beneath don't intercept dropdown clicks.
        <div
          className="pointer-events-auto absolute left-2 top-2 z-20"
          onMouseDown={(e) => e.stopPropagation()}
          onPointerDown={(e) => e.stopPropagation()}
          onWheel={(e) => e.stopPropagation()}
        >
          <Select
            data={variants.map((v) => ({ value: v.key, label: v.label }))}
            value={selectedKey}
            onChange={(value) => value && setSelectedKey(value)}
            size="xs"
            allowDeselect={false}
            withCheckIcon={false}
            comboboxProps={{ withinPortal: true }}
            styles={{
              input: {
                backgroundColor: 'rgba(20, 20, 20, 0.75)',
                backdropFilter: 'blur(4px)',
                color: 'white',
                border: 'none',
                minHeight: 28,
                height: 28,
              },
            }}
            w={140}
          />
        </div>
      )}
      <Model3DViewer
        key={selected.key}
        url={selected.url}
        format={selected.format}
        sizeKB={selected.sizeKB}
        compact={compact}
        // Compact mode's three.js container is `h-full` of its Stack
        // parent; the Stack needs `size-full` itself or it collapses to
        // content height (which is 0 before the GLB resolves) — which is
        // exactly the "toggle visible, viewport empty" bug.
        className={compact ? 'size-full' : undefined}
      />
    </div>
  );
}

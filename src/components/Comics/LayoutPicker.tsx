import { ActionIcon, Modal, Text, Tooltip, UnstyledButton } from '@mantine/core';
import { IconZoomIn } from '@tabler/icons-react';
import clsx from 'clsx';
import { useState } from 'react';

export interface LayoutOption {
  id: string;
  name: string;
  imagePath: string;
}

export const LAYOUT_OPTIONS: LayoutOption[] = [
  { id: '2-panel', name: '2 Panel', imagePath: '/images/comics/layouts/2-panel-layout.png' },
  { id: '3-panel', name: '3 Panel', imagePath: '/images/comics/layouts/3-panel-layout.png' },
  { id: '4-panel-basic', name: '4 Panel Basic', imagePath: '/images/comics/layouts/4-panel-basic-layout.png' },
  { id: '4-panel', name: '4 Panel', imagePath: '/images/comics/layouts/4-panel-layout.png' },
  { id: '4-panel-angled', name: '4 Panel Angled', imagePath: '/images/comics/layouts/4-panel-angled-layout.png' },
  { id: '4-panel-cross', name: '4 Panel Cross', imagePath: '/images/comics/layouts/4-panel-cross-layout.png' },
  { id: '4-panel-geometric', name: '4 Panel Geometric', imagePath: '/images/comics/layouts/4-panel-geometric-layout.png' },
  { id: '4-panel-large-angled', name: '4 Panel Large Angled', imagePath: '/images/comics/layouts/4-panel-large-angled-layout.png' },
];

interface LayoutPickerProps {
  value?: string;
  onChange: (layout: LayoutOption | null) => void;
  layouts?: LayoutOption[];
}

export function LayoutPicker({ value, onChange, layouts = LAYOUT_OPTIONS }: LayoutPickerProps) {
  const [zoomedLayout, setZoomedLayout] = useState<LayoutOption | null>(null);

  return (
    <>
      <div className="flex flex-col gap-1">
        <Text size="sm" fw={500}>
          Layout Reference
        </Text>
        <Text size="xs" c="dimmed">
          Pick a layout to include as a reference image during generation
        </Text>
        <div className="flex gap-2 mt-1 overflow-x-auto pb-1" style={{ scrollbarWidth: 'thin' }}>
          {layouts.map((layout) => {
            const selected = value === layout.id;
            return (
              <div key={layout.id} className="relative flex-shrink-0" style={{ width: 100 }}>
                <UnstyledButton
                  onClick={() => onChange(selected ? null : layout)}
                  className={clsx(
                    'flex flex-col items-center rounded-md border p-1.5 transition-colors w-full',
                    selected
                      ? 'border-blue-500 bg-blue-500/10'
                      : 'border-gray-600 hover:border-gray-400 bg-transparent'
                  )}
                >
                  <div
                    style={{
                      width: '100%',
                      height: 100,
                      borderRadius: 4,
                      background: 'rgba(255,255,255,0.95)',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      padding: 4,
                    }}
                  >
                    <img
                      src={layout.imagePath}
                      alt={layout.name}
                      style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain' }}
                    />
                  </div>
                  <Text size="xs" fw={selected ? 600 : 400} mt={4} ta="center" lineClamp={1}>
                    {layout.name}
                  </Text>
                </UnstyledButton>
                <Tooltip label="Zoom in" withArrow position="top">
                  <ActionIcon
                    variant="filled"
                    color="dark"
                    size="xs"
                    className="absolute top-2 right-2"
                    style={{ zIndex: 1 }}
                    onClick={(e: React.MouseEvent) => {
                      e.stopPropagation();
                      setZoomedLayout(layout);
                    }}
                  >
                    <IconZoomIn size={12} />
                  </ActionIcon>
                </Tooltip>
              </div>
            );
          })}
        </div>
      </div>

      <Modal
        opened={!!zoomedLayout}
        onClose={() => setZoomedLayout(null)}
        title={zoomedLayout?.name}
        size="md"
        centered
      >
        {zoomedLayout && (
          <div
            style={{
              background: 'rgba(255,255,255,0.95)',
              borderRadius: 'var(--mantine-radius-md)',
              padding: 16,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <img
              src={zoomedLayout.imagePath}
              alt={zoomedLayout.name}
              style={{ maxWidth: '100%', borderRadius: 'var(--mantine-radius-sm)' }}
            />
          </div>
        )}
      </Modal>
    </>
  );
}

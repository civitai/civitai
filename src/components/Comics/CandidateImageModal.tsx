import { ActionIcon, Button, Group, Loader, Modal, Text, Tooltip } from '@mantine/core';
import { IconCheck, IconZoomIn } from '@tabler/icons-react';
import { useState } from 'react';
import { getEdgeUrl } from '~/client-utils/cf-images-utils';

interface CandidateImageModalProps {
  opened: boolean;
  onClose: () => void;
  candidates: string[];
  currentImageUrl: string | null;
  onConfirm: (imageKey: string) => void;
  isSelecting: boolean;
}

export function CandidateImageModal({
  opened,
  onClose,
  candidates,
  currentImageUrl,
  onConfirm,
  isSelecting,
}: CandidateImageModalProps) {
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [zoomedKey, setZoomedKey] = useState<string | null>(null);

  // The effective selection: user's pick, or the current panel image, or nothing
  const effectiveSelection = selectedKey ?? currentImageUrl;
  const hasNewSelection = selectedKey != null && selectedKey !== currentImageUrl;

  return (
    <>
      <Modal
        opened={opened && !zoomedKey}
        onClose={onClose}
        title="Choose an image"
        size="lg"
        centered
      >
        <Text size="sm" c="dimmed" mb="md">
          Select an image for this panel. Click the magnifier to zoom in.
        </Text>

        <div
          className="grid gap-3"
          style={{ gridTemplateColumns: `repeat(${Math.min(candidates.length, 4)}, 1fr)` }}
        >
          {candidates.map((key) => {
            const isSelected = key === effectiveSelection;
            return (
              <div key={key} className="relative">
                <button
                  className="relative overflow-hidden rounded-md w-full"
                  style={{
                    aspectRatio: '3/4',
                    border: isSelected
                      ? '3px solid var(--mantine-color-blue-6)'
                      : '3px solid transparent',
                    padding: 0,
                    cursor: isSelecting ? 'wait' : 'pointer',
                    background: '#2C2E33',
                    opacity: isSelecting && !isSelected ? 0.6 : 1,
                    transition: 'border-color 0.15s, opacity 0.15s',
                  }}
                  onClick={() => {
                    if (!isSelecting) setSelectedKey(key);
                  }}
                  disabled={isSelecting}
                >
                  <img
                    src={getEdgeUrl(key, { width: 400 })}
                    alt="Candidate"
                    style={{
                      width: '100%',
                      height: '100%',
                      objectFit: 'cover',
                      borderRadius: 'calc(var(--mantine-radius-md) - 3px)',
                    }}
                  />
                  {isSelected && (
                    <div
                      className="absolute top-2 left-2 flex items-center justify-center rounded-full"
                      style={{
                        width: 24,
                        height: 24,
                        background: 'var(--mantine-color-blue-6)',
                      }}
                    >
                      <IconCheck size={14} color="white" />
                    </div>
                  )}
                  {isSelecting && isSelected && (
                    <div
                      className="absolute inset-0 flex items-center justify-center"
                      style={{ background: 'rgba(0,0,0,0.4)' }}
                    >
                      <Loader size="sm" color="white" />
                    </div>
                  )}
                </button>
                <Tooltip label="Zoom in" withArrow position="top">
                  <ActionIcon
                    variant="filled"
                    color="dark"
                    size="sm"
                    className="absolute top-2 right-2"
                    onClick={(e: React.MouseEvent) => {
                      e.stopPropagation();
                      setZoomedKey(key);
                    }}
                  >
                    <IconZoomIn size={14} />
                  </ActionIcon>
                </Tooltip>
              </div>
            );
          })}
        </div>

        <Group justify="flex-end" mt="md">
          <Button variant="default" onClick={onClose} disabled={isSelecting}>
            Cancel
          </Button>
          <Button
            onClick={() => {
              if (effectiveSelection) onConfirm(effectiveSelection);
            }}
            loading={isSelecting}
            disabled={!hasNewSelection || isSelecting}
          >
            Confirm Selection
          </Button>
        </Group>
      </Modal>

      {/* Zoom modal — full-size image view */}
      <Modal
        opened={!!zoomedKey}
        onClose={() => setZoomedKey(null)}
        size="xl"
        centered
        title="Image Preview"
      >
        {zoomedKey && (
          <img
            src={getEdgeUrl(zoomedKey, { width: 1024 })}
            alt="Zoomed candidate"
            style={{ width: '100%', borderRadius: 'var(--mantine-radius-md)' }}
          />
        )}
        <Group justify="flex-end" mt="md">
          <Button variant="default" onClick={() => setZoomedKey(null)}>
            Back
          </Button>
          <Button
            onClick={() => {
              if (zoomedKey) {
                setSelectedKey(zoomedKey);
                setZoomedKey(null);
              }
            }}
          >
            Select this image
          </Button>
        </Group>
      </Modal>
    </>
  );
}

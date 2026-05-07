import { ActionIcon, Badge, Button, Group, Loader, Modal, Text, Tooltip } from '@mantine/core';
import { IconCheck, IconExternalLink, IconEye, IconZoomIn } from '@tabler/icons-react';
import { useMemo, useState } from 'react';
import { getEdgeUrl } from '~/client-utils/cf-images-utils';
import { Flags } from '~/shared/utils/flags';
import { nsfwBrowsingLevelsFlag } from '~/shared/constants/browsingLevel.constants';

// One candidate slot, in stable orchestrator order. Either:
//  - clean (downloaded to S3, picker may select it), or
//  - locked (mature output that needs an unlock; the URL here is the
//    orchestrator's *transient* blurred preview, never persisted).
//
// `nsfwLevel` is the orchestrator-derived level for the slot. Even clean
// slots can carry a mature level — on red with nsfwEnabled+
// allowMatureContent, the orchestrator hands back R/X/XXX outputs without a
// `blockedReason`. We blur those by default in the picker so they aren't
// rendered uncensored just because they made it past the block gate.
export type CandidateSlot =
  | { key: string; requiresUnlock?: false; nsfwLevel?: number | null }
  | {
      key?: undefined;
      requiresUnlock: true;
      blockedReason: string;
      blurredPreviewUrl?: string | null;
      nsfwLevel?: number | null;
    };

function isCandidateMature(slot: CandidateSlot): boolean {
  // Locked slots always render as mature (they ARE mature — that's why
  // they're locked).
  if (slot.requiresUnlock) return true;
  const level = slot.nsfwLevel;
  if (typeof level !== 'number') return false;
  // Treat any bit in the NSFW flag set (R/X/XXX/Blocked) as mature.
  return Flags.intersects(level, nsfwBrowsingLevelsFlag);
}

interface CandidateImageModalProps {
  opened: boolean;
  onClose: () => void;
  candidates: CandidateSlot[];
  currentImageUrl: string | null;
  onConfirm: (imageKey: string) => void;
  /**
   * In-place yellow-Buzz unlock — only used when a locked slot's
   * `blockedReason === 'canUpgrade'`, which fires off-green.
   */
  onUnlock?: () => void;
  isUnlocking?: boolean;
  /**
   * Redirect URL to civitai.red — used when a locked slot's
   * `blockedReason === 'siteRestricted'` (i.e. the user is on green and
   * has to view the result on the mature-content domain).
   */
  unlockHref?: string | null;
  isSelecting: boolean;
}

export function CandidateImageModal({
  opened,
  onClose,
  candidates,
  currentImageUrl,
  onConfirm,
  onUnlock,
  isUnlocking,
  unlockHref,
  isSelecting,
}: CandidateImageModalProps) {
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [zoomedKey, setZoomedKey] = useState<string | null>(null);

  // The effective selection: user's pick, or the current panel image, or nothing
  // Per-tile reveal toggle for clean-but-mature candidates. The orchestrator
  // can hand back R/X/XXX outputs uncensored on red+nsfwEnabled+
  // allowMatureContent, and we don't want the picker to surface them
  // raw — even a moderator scanning the modal shouldn't see uncensored
  // mature content unless they explicitly click Show on each tile.
  const [revealedKeys, setRevealedKeys] = useState<Set<string>>(() => new Set());
  const reveal = (key: string) =>
    setRevealedKeys((prev) => {
      const next = new Set(prev);
      next.add(key);
      return next;
    });

  const effectiveSelection = selectedKey ?? currentImageUrl;
  const hasNewSelection = selectedKey != null && selectedKey !== currentImageUrl;
  const hasLocked = candidates.some((c) => c.requiresUnlock);
  const hasMature = useMemo(() => candidates.some(isCandidateMature), [candidates]);
  // CTA selection is driven by the parent's domain — `onUnlock` is
  // populated only on red, `unlockHref` only on green. We never combine
  // both: in-place unlock is a red-only flow.
  const showInPlaceUnlock = !!onUnlock;

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
          {hasMature && (
            <>
              {' '}Mature results are blurred — click <em>Show</em> on a tile
              before selecting it.
            </>
          )}
        </Text>
        {hasLocked && (
          <div
            className="rounded-md p-3 mb-md flex flex-col items-center gap-2 mb-2"
            style={{
              border: '1px solid var(--mantine-color-yellow-7)',
              background: 'rgba(250, 176, 5, 0.08)',
            }}
          >
            {showInPlaceUnlock ? (
              <>
                <Text size="sm" c="white" ta="center">
                  Some results contain mature content. Unlock once to reveal
                  every locked result from this generation — the preview is
                  blurred and the full URL is never stored on the panel.
                </Text>
                <Button
                  size="compact-sm"
                  color="yellow"
                  variant="light"
                  radius="xl"
                  loading={isUnlocking}
                  onClick={() => onUnlock?.()}
                >
                  Unlock with yellow Buzz
                </Button>
              </>
            ) : (
              <>
                <Text size="sm" c="white" ta="center">
                  Some results contain mature content and can only be viewed
                  on civitai.red. Open the project there to unlock and pick
                  them.
                </Text>
                {unlockHref ? (
                  <Button
                    component="a"
                    href={unlockHref}
                    target="_blank"
                    rel="noreferrer nofollow"
                    size="compact-sm"
                    color="red"
                    variant="light"
                    radius="xl"
                    leftSection={<IconExternalLink size={14} />}
                  >
                    Open on civitai.red
                  </Button>
                ) : null}
              </>
            )}
          </div>
        )}

        <div
          className="grid gap-3"
          style={{ gridTemplateColumns: `repeat(${Math.min(candidates.length, 4)}, 1fr)` }}
        >
          {candidates.map((slot, idx) => {
            // Locked slot: render the orchestrator's blurred preview behind a
            // dark scrim with a per-slot unlock CTA. The preview URL is
            // ephemeral — it's not in our DB and may rotate between polls.
            if (slot.requiresUnlock) {
              return (
                <div key={`locked-${idx}`} className="relative">
                  <div
                    className="relative overflow-hidden rounded-md w-full"
                    style={{
                      aspectRatio: '3/4',
                      border: '3px solid var(--mantine-color-yellow-6)',
                      background: '#2C2E33',
                    }}
                  >
                    {slot.blurredPreviewUrl && (
                      <img
                        src={slot.blurredPreviewUrl}
                        alt=""
                        style={{
                          width: '100%',
                          height: '100%',
                          objectFit: 'cover',
                          borderRadius: 'calc(var(--mantine-radius-md) - 3px)',
                        }}
                      />
                    )}
                    <div
                      className="absolute inset-0 flex flex-col items-center justify-center gap-2"
                      style={{ background: 'rgba(0,0,0,0.55)', padding: 8 }}
                    >
                      <Badge color="yellow" size="sm" variant="filled">
                        Mature — Locked
                      </Badge>
                      <Text size="xs" c="white" ta="center">
                        Use the unlock button above to reveal.
                      </Text>
                    </div>
                  </div>
                </div>
              );
            }

            const isSelected = slot.key === effectiveSelection;
            const matureClean = isCandidateMature(slot);
            const showBlur = matureClean && !revealedKeys.has(slot.key);
            return (
              <div key={slot.key} className="relative">
                <button
                  className="relative overflow-hidden rounded-md w-full"
                  style={{
                    aspectRatio: '3/4',
                    border: isSelected
                      ? '3px solid var(--mantine-color-blue-6)'
                      : matureClean
                        ? '3px solid var(--mantine-color-yellow-6)'
                        : '3px solid transparent',
                    padding: 0,
                    cursor: isSelecting || showBlur ? 'wait' : 'pointer',
                    background: '#2C2E33',
                    opacity: isSelecting && !isSelected ? 0.6 : 1,
                    transition: 'border-color 0.15s, opacity 0.15s',
                  }}
                  onClick={() => {
                    // Don't let the user pick a tile they haven't unblurred
                    // yet — forces an explicit reveal before commit.
                    if (showBlur || isSelecting) return;
                    setSelectedKey(slot.key);
                  }}
                  disabled={isSelecting}
                >
                  <img
                    src={getEdgeUrl(slot.key, { width: 400 })}
                    alt="Candidate"
                    style={{
                      width: '100%',
                      height: '100%',
                      objectFit: 'cover',
                      borderRadius: 'calc(var(--mantine-radius-md) - 3px)',
                      filter: showBlur ? 'blur(28px)' : undefined,
                      transform: showBlur ? 'scale(1.05)' : undefined,
                    }}
                  />
                  {showBlur && (
                    <div
                      className="absolute inset-0 flex flex-col items-center justify-center gap-2"
                      style={{ background: 'rgba(0,0,0,0.55)', padding: 8 }}
                    >
                      <Badge color="yellow" size="sm" variant="filled">
                        Mature
                      </Badge>
                      {/* On green there is NO in-place reveal — `unlockHref`
                          is the only path. Render a redirect button instead
                          of "Show". On red we expose the standard reveal
                          toggle. */}
                      {showInPlaceUnlock ? (
                        <Button
                          size="compact-xs"
                          color="yellow"
                          variant="light"
                          radius="xl"
                          leftSection={<IconEye size={12} />}
                          onClick={(e: React.MouseEvent) => {
                            e.stopPropagation();
                            reveal(slot.key!);
                          }}
                        >
                          Show
                        </Button>
                      ) : unlockHref ? (
                        <Button
                          component="a"
                          href={unlockHref}
                          target="_blank"
                          rel="noreferrer nofollow"
                          size="compact-xs"
                          color="red"
                          variant="light"
                          radius="xl"
                          leftSection={<IconExternalLink size={12} />}
                          onClick={(e: React.MouseEvent) => e.stopPropagation()}
                        >
                          Open on civitai.red
                        </Button>
                      ) : null}
                    </div>
                  )}
                  {isSelected && !showBlur && (
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
                {/* No zoom for blurred mature slots — would be a backdoor
                    to view uncensored content without an explicit reveal. */}
                {!showBlur && (
                  <Tooltip label="Zoom in" withArrow position="top">
                    <ActionIcon
                      variant="filled"
                      color="dark"
                      size="sm"
                      className="absolute top-2 right-2"
                      onClick={(e: React.MouseEvent) => {
                        e.stopPropagation();
                        setZoomedKey(slot.key!);
                      }}
                    >
                      <IconZoomIn size={14} />
                    </ActionIcon>
                  </Tooltip>
                )}
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

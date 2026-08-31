/**
 * ImageMetadataModal
 *
 * Shows the generation metadata embedded in an image already added to the
 * generation form — the same extraction the img2meta ("Extract Metadata")
 * workflow runs, minus its dropzone — and lets the user push what the active
 * graph can actually take into the generation they are currently editing.
 *
 * Applicability gates the ACTIONS, not the display: everything extracted stays
 * visible (and copyable) so the modal still answers "what made this image?",
 * but nothing is offered that the current workflow has nowhere to put.
 */

import {
  ActionIcon,
  Button,
  Card,
  Checkbox,
  Code,
  CopyButton,
  Group,
  Loader,
  Modal,
  Stack,
  Text,
  ThemeIcon,
  Tooltip,
} from '@mantine/core';
import { IconCheck, IconCopy, IconFileSearch, IconPlus } from '@tabler/icons-react';
import { useEffect, useMemo, useState } from 'react';

import { useDialogContext } from '~/components/Dialog/DialogProvider';
import type { ResourceSelectOptions } from '~/components/ImageGeneration/GenerationForm/resource-select.types';
import {
  getResourceStatus,
  ResourceItemContent,
} from '~/components/generation_v2/inputs/ResourceItemContent';
import type { GenerationResource } from '~/shared/types/generation.types';
import { sourceMetadataStore, useSourceMetadataStore } from '~/store/source-metadata.store';
import { extractSourceMetadata } from '~/utils/metadata/extract-source-metadata';
import { trpc } from '~/utils/trpc';

/**
 * How the surrounding form takes pieces of an image's metadata. Omit for a
 * read-only modal.
 */
export type ImageMetadataApply = {
  /** Whether the active graph has somewhere to put this param. */
  canApply: (key: string) => boolean;
  onApply: (values: Record<string, unknown>) => void;
  /** Add a resource to the current generation. Omit to hide the add action. */
  onAddResource?: (resource: GenerationResource) => void;
  /** Compatibility config from the active graph's resources node. */
  resourceOptions?: ResourceSelectOptions;
};

export type ImageMetadataModalProps = {
  url: string;
  apply?: ImageMetadataApply;
};

/** Prompts lead the list and come pre-selected — taking them is the common case. */
const PROMPT_KEYS = ['prompt', 'negativePrompt'];

/**
 * Params that describe WHICH graph to run rather than a value inside one.
 * Applying these would switch the user's workflow out from under them, which is
 * a deliberate action ("start a new generation from this"), never a checkbox.
 */
const STRUCTURAL_KEYS = new Set([
  'workflow',
  'ecosystem',
  'baseModel',
  'engine',
  'process',
  'model',
  'vae',
  'upscaler',
  'resources',
  'images',
  'sourceImage',
  'quantity',
  'priority',
  'outputFormat',
  'snippets',
  'remixOfId',
]);

const FIELD_LABELS: Record<string, string> = {
  prompt: 'Prompt',
  negativePrompt: 'Negative Prompt',
  cfgScale: 'CFG Scale',
  clipSkip: 'Clip Skip',
  aspectRatio: 'Aspect Ratio',
  steps: 'Steps',
  seed: 'Seed',
  sampler: 'Sampler',
  scheduler: 'Scheduler',
  denoise: 'Denoise',
};

function fieldLabel(key: string) {
  return (
    FIELD_LABELS[key] ?? key.replace(/([A-Z])/g, ' $1').replace(/^./, (char) => char.toUpperCase())
  );
}

function formatValue(value: unknown) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

export function ImageMetadataModal({ url, apply }: ImageMetadataModalProps) {
  const dialog = useDialogContext();

  // The upload path and the images input both write extracted metadata here, so
  // an image added a moment ago usually renders without any parsing at all.
  const cached = useSourceMetadataStore((state) => state.metadataByUrl[url]);
  const [extracting, setExtracting] = useState(false);
  const [showRaw, setShowRaw] = useState(false);

  useEffect(() => {
    if (sourceMetadataStore.getMetadata(url)?.exifExtracted) return;
    let cancelled = false;
    setExtracting(true);
    extractSourceMetadata(url)
      .then((metadata) => {
        if (cancelled) return;
        sourceMetadataStore.setMetadata(url, { ...(metadata ?? {}), exifExtracted: true });
      })
      .finally(() => {
        if (!cancelled) setExtracting(false);
      });
    return () => {
      cancelled = true;
    };
  }, [url]);

  const params = cached?.params;
  const hasParams = !!params && Object.keys(params).length > 0;

  // Resource resolution reads `resources` off the metadata, and extraction
  // splits that array out of `params` — so put it back. `comfy` goes the other
  // way: unused server-side, and a GET carrying the whole ComfyUI graph blows
  // past the header size limit (431).
  const queryMetadata = useMemo(() => {
    if (!params) return {};
    const { comfy: _comfy, ...rest } = params;
    return cached?.resources?.length ? { ...rest, resources: cached.resources } : rest;
  }, [params, cached?.resources]);

  const { data: resolved, isFetching: resolvingResources } =
    trpc.generation.resolveImageMeta.useQuery(
      { metadata: queryMetadata },
      { enabled: hasParams, staleTime: 5 * 60 * 1000 }
    );

  const resources = resolved?.resources ?? [];

  // `resolveImageMeta` runs its params through `mapDataToGraphInput`, so these
  // keys and value formats are the graph's own — which is what lets the
  // applyable set be computed against the active graph instead of hardcoded.
  const applicable = useMemo(() => {
    const graphParams = resolved?.params;
    if (!graphParams || !apply) return [] as { key: string; value: unknown }[];
    return Object.entries(graphParams)
      .filter(([key, value]) => {
        if (STRUCTURAL_KEYS.has(key)) return false;
        if (value === null || value === undefined || value === '') return false;
        return apply.canApply(key);
      })
      .map(([key, value]) => ({ key, value }))
      .sort((a, b) => {
        const aPrompt = PROMPT_KEYS.indexOf(a.key);
        const bPrompt = PROMPT_KEYS.indexOf(b.key);
        if (aPrompt !== bPrompt) return (aPrompt < 0 ? 99 : aPrompt) - (bPrompt < 0 ? 99 : bPrompt);
        return a.key.localeCompare(b.key);
      });
  }, [resolved?.params, apply]);

  // Prompts default on, everything else off — reusing a seed or sampler is a
  // deliberate act, reusing the prompt is why the modal was opened.
  const [overrides, setOverrides] = useState<Record<string, boolean>>({});
  const isSelected = (key: string) => overrides[key] ?? PROMPT_KEYS.includes(key);
  const selectedKeys = applicable.filter(({ key }) => isSelected(key)).map(({ key }) => key);

  const promptFields = applicable.filter(({ key }) => PROMPT_KEYS.includes(key));
  const settingFields = applicable.filter(({ key }) => !PROMPT_KEYS.includes(key));

  // Prompts the image carries but the active graph has no node for: shown as
  // reference text, with no checkbox, because there is nowhere to put them.
  // Held back until resolution lands, or a prompt renders read-only for a beat
  // and then grows a checkbox.
  const referencePrompts = resolvingResources
    ? []
    : PROMPT_KEYS.filter(
        (key) =>
          typeof params?.[key] === 'string' &&
          !!params[key] &&
          !applicable.some((field) => field.key === key)
      ).map((key) => ({ key, value: params?.[key] as string }));

  function handleApply() {
    const values: Record<string, unknown> = {};
    for (const { key, value } of applicable) {
      if (isSelected(key)) values[key] = value;
    }
    apply?.onApply(values);
    dialog.onClose();
  }

  function handleAddResource(resource: GenerationResource) {
    apply?.onAddResource?.(resource);
    dialog.onClose();
  }

  return (
    <Modal {...dialog} title="Image Metadata" size="lg">
      <Stack gap="sm">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={url}
          alt="Selected image"
          className="max-h-[200px] w-full rounded-md object-contain"
        />

        {extracting && (
          <div className="flex items-center gap-2 py-2">
            <Loader size="sm" />
            <Text c="dimmed" size="sm">
              Extracting metadata...
            </Text>
          </div>
        )}

        {!extracting && !hasParams && (
          <Card withBorder p="md">
            <div className="flex items-center gap-2">
              <ThemeIcon variant="light" color="gray" size="lg">
                <IconFileSearch size={18} />
              </ThemeIcon>
              <Text c="dimmed" size="sm">
                No generation metadata found in this image.
              </Text>
            </div>
          </Card>
        )}

        {hasParams && (
          <>
            {promptFields.map(({ key, value }) => (
              <PromptCard
                key={key}
                title={fieldLabel(key)}
                value={formatValue(value)}
                selected={isSelected(key)}
                onSelectedChange={(checked) =>
                  setOverrides((state) => ({ ...state, [key]: checked }))
                }
              />
            ))}
            {referencePrompts.map(({ key, value }) => (
              <PromptCard key={key} title={fieldLabel(key)} value={value} />
            ))}

            {settingFields.length > 0 && (
              <Card withBorder p="sm">
                <Card.Section withBorder>
                  <div className="px-3 py-2">
                    <Text fw={500} size="sm">
                      Generation Settings
                    </Text>
                  </div>
                </Card.Section>
                <Card.Section>
                  <div className="flex flex-col gap-2 p-3">
                    {settingFields.map(({ key, value }) => (
                      <Checkbox
                        key={key}
                        size="xs"
                        checked={isSelected(key)}
                        onChange={(e) => {
                          const { checked } = e.currentTarget;
                          setOverrides((state) => ({ ...state, [key]: checked }));
                        }}
                        label={
                          <Text size="xs">
                            {fieldLabel(key)}:{' '}
                            <Text span c="dimmed">
                              {formatValue(value)}
                            </Text>
                          </Text>
                        }
                      />
                    ))}
                  </div>
                </Card.Section>
              </Card>
            )}

            {resolvingResources && (
              <div className="flex items-center gap-2 py-2">
                <Loader size="sm" />
                <Text c="dimmed" size="sm">
                  Resolving resources...
                </Text>
              </div>
            )}

            {resources.length > 0 && (
              <Card withBorder p="sm">
                <Card.Section withBorder>
                  <div className="px-3 py-2">
                    <Text fw={500} size="sm">
                      Resources ({resources.length})
                    </Text>
                  </div>
                </Card.Section>
                <Card.Section>
                  <div className="p-3">
                    <Stack gap="xs">
                      {resources.map((resource) => {
                        const usable =
                          !!apply?.onAddResource &&
                          getResourceStatus(resource, apply.resourceOptions) !== 'incompatible';
                        return (
                          <ResourceItemContent
                            key={resource.id}
                            resource={resource}
                            options={apply?.resourceOptions}
                            actions={
                              usable ? (
                                <Tooltip label="Add to generation">
                                  <ActionIcon
                                    size="md"
                                    variant="subtle"
                                    onClick={() => handleAddResource(resource)}
                                  >
                                    <IconPlus size={14} />
                                  </ActionIcon>
                                </Tooltip>
                              ) : undefined
                            }
                          />
                        );
                      })}
                    </Stack>
                  </div>
                </Card.Section>
              </Card>
            )}

            <div>
              <Button
                variant="subtle"
                size="compact-xs"
                onClick={() => setShowRaw((state) => !state)}
              >
                {showRaw ? 'Hide all metadata' : 'Show all metadata'}
              </Button>
              {showRaw && (
                <Code block className="mt-2 max-h-[300px] overflow-auto text-xs">
                  {JSON.stringify(params, null, 2)}
                </Code>
              )}
            </div>
          </>
        )}

        <Group justify="flex-end" gap="xs">
          <Button variant="default" onClick={dialog.onClose}>
            Close
          </Button>
          {applicable.length > 0 && (
            <Button disabled={!selectedKeys.length} onClick={handleApply}>
              Apply to generation
            </Button>
          )}
        </Group>
      </Stack>
    </Modal>
  );
}

function PromptCard({
  title,
  value,
  selected,
  onSelectedChange,
}: {
  title: string;
  value: string;
  /** undefined when the active form has nowhere to put this prompt */
  selected?: boolean;
  onSelectedChange?: (checked: boolean) => void;
}) {
  return (
    <Card withBorder p="sm">
      <Card.Section withBorder>
        <div className="flex items-center justify-between gap-2 px-3 py-2">
          {selected !== undefined && onSelectedChange ? (
            <Checkbox
              size="xs"
              checked={selected}
              onChange={(e) => onSelectedChange(e.currentTarget.checked)}
              label={
                <Text fw={500} size="sm">
                  {title}
                </Text>
              }
            />
          ) : (
            <Text fw={500} size="sm">
              {title}
            </Text>
          )}
          <Group gap="xs">
            <CopyButton value={value}>
              {({ copied, copy }) => (
                <Tooltip label={copied ? 'Copied' : 'Copy'} withArrow>
                  <ActionIcon
                    variant="subtle"
                    color={copied ? 'teal' : 'gray'}
                    size="sm"
                    onClick={copy}
                  >
                    {copied ? <IconCheck size={14} /> : <IconCopy size={14} />}
                  </ActionIcon>
                </Tooltip>
              )}
            </CopyButton>
          </Group>
        </div>
      </Card.Section>
      <Card.Section>
        <div className="p-3">
          <Text size="xs" style={{ whiteSpace: 'pre-wrap' }}>
            {value}
          </Text>
        </div>
      </Card.Section>
    </Card>
  );
}

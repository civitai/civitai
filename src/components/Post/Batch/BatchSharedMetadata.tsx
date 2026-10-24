import { Badge, Button, Checkbox, CloseButton, Popover, Text } from '@mantine/core';
import { IconLock, IconPlus } from '@tabler/icons-react';
import { useEffect, useMemo, useState } from 'react';
import { AlwaysOpenCombobox } from '~/components/Combobox/AlwaysOpenComboBox';
import type { ComboboxOption } from '~/components/Combobox/combobox.types';
import { openResourceSelectModal } from '~/components/Dialog/triggers/resource-select';
import { ResourceSelectMultiple } from '~/components/ImageGeneration/GenerationForm/ResourceSelectMultiple';
import { TagPicker } from '~/components/Post/EditV2/EditPostTags';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { useQueryTools } from '~/components/Tool/tools.utils';
import { MAX_MANUAL_RESOURCES_PER_IMAGE, POST_TAG_LIMIT } from '~/server/common/constants';
import type { GenerationResource } from '~/shared/types/generation.types';
import { getDisplayName } from '~/utils/string-helpers';
import { trpc } from '~/utils/trpc';
import type { NamedOption, SharedSettings } from './batch-composer.store';
import { useBatchComposerStore } from './batch-composer.store';
import { PresetSelect } from './BatchPresets';
import { TitleTemplateInput } from './TitleTemplateInput';

const LAST_SHARED_KEY = 'batch-composer:last-shared';

type RememberedShared = Pick<SharedSettings, 'tools' | 'techniques' | 'tags' | 'titleTemplate'>;

export function rememberShared(shared: SharedSettings, userId: number | undefined) {
  const remembered: RememberedShared = {
    tools: shared.tools,
    techniques: shared.techniques,
    tags: shared.tags,
    titleTemplate: shared.titleTemplate,
  };
  try {
    localStorage.setItem(lastSharedKey(userId), JSON.stringify(remembered));
  } catch {
    // Private mode or a full store: remembering is a convenience, not a requirement.
  }
}

function lastSharedKey(userId: number | undefined): string {
  return userId == null ? LAST_SHARED_KEY : `${LAST_SHARED_KEY}:${userId}`;
}

function readRememberedShared(userId: number | undefined): RememberedShared | null {
  try {
    const raw = localStorage.getItem(lastSharedKey(userId));
    return raw ? (JSON.parse(raw) as RememberedShared) : null;
  } catch {
    return null;
  }
}

export function BatchSharedMetadata({
  disabled,
  promoted,
  onPromotedChange,
  titlePreviews,
}: {
  disabled?: boolean;
  /** `locked` when the version came in the URL, so it can only change there. */
  promoted: { id: number; label: string; locked: boolean } | null;
  onPromotedChange: (resource: GenerationResource | null) => void;
  titlePreviews: string[];
}) {
  const [shared, updateShared] = useBatchComposerStore((state) => [
    state.shared,
    state.updateShared,
  ]);
  // Read after mount: the server has no storage, so reading during render would hydrate a button
  // the server never sent.
  const [remembered, setRemembered] = useState<RememberedShared | null>(null);
  const userId = useCurrentUser()?.id;
  useEffect(() => setRemembered(readRememberedShared(userId)), [userId]);
  const presetsEnabled = !!useFeatureFlags().postPresets;
  const isEmpty =
    !shared.tools.length &&
    !shared.techniques.length &&
    !shared.tags.length &&
    !shared.titleTemplate;

  return (
    <fieldset disabled={disabled} className="flex flex-col gap-4 border-0 p-0 disabled:opacity-60">
      {presetsEnabled && <PresetSelect disabled={disabled} />}
      {isEmpty && remembered && (
        <Button
          size="compact-xs"
          variant="subtle"
          className="self-start"
          onClick={() => updateShared(remembered)}
        >
          Use last settings
        </Button>
      )}
      <Field label="Resources">
        <div className="flex flex-wrap items-center gap-2">
          {promoted ? (
            <Badge
              size="lg"
              variant="light"
              leftSection={promoted.locked ? <IconLock size={12} /> : undefined}
              rightSection={
                !promoted.locked && (
                  <CloseButton
                    size="xs"
                    aria-label="Remove promoted version"
                    onClick={() => onPromotedChange(null)}
                  />
                )
              }
              className="normal-case"
              data-testid="batch-promoted"
            >
              {promoted.label}
            </Badge>
          ) : (
            <Button
              size="compact-sm"
              variant="light"
              leftSection={<IconPlus size={14} />}
              disabled={disabled}
              onClick={() =>
                openResourceSelectModal({
                  title: 'Pick a model to promote',
                  selectSource: 'addResource',
                  options: { excludeIds: shared.resources.map((resource) => resource.id) },
                  onSelect: (resource) => onPromotedChange(resource),
                })
              }
              data-testid="batch-pick-promoted"
            >
              Promote a model
            </Button>
          )}
          <ResourceSelectMultiple
            buttonLabel="Add resource"
            modalTitle="Select resource(s)"
            selectSource="addResource"
            limit={MAX_MANUAL_RESOURCES_PER_IMAGE - (promoted ? 1 : 0)}
            value={shared.resources}
            onChange={(resources) =>
              updateShared({ resources: (resources ?? []).filter((x) => x.id !== promoted?.id) })
            }
            options={{ excludeIds: promoted ? [promoted.id] : [] }}
            buttonProps={{ size: 'compact-sm', variant: 'default', disabled }}
            className="flex-1"
          />
        </div>
      </Field>
      <Field label="Tools">
        <OptionPicker
          kind="tools"
          value={shared.tools}
          onChange={(tools) => updateShared({ tools })}
          disabled={disabled}
        />
      </Field>
      <Field label="Techniques">
        <OptionPicker
          kind="techniques"
          value={shared.techniques}
          onChange={(techniques) => updateShared({ techniques })}
          disabled={disabled}
        />
      </Field>
      <Field label="Tags">
        <div className="flex flex-wrap items-center gap-2">
          {shared.tags.map((tag) => (
            <Chip
              key={tag}
              label={tag}
              onRemove={() => updateShared({ tags: shared.tags.filter((x) => x !== tag) })}
            />
          ))}
          {shared.tags.length < POST_TAG_LIMIT && !disabled && (
            <TagPicker
              tags={shared.tags.map((name) => ({ name }))}
              onAdd={(tag) => {
                const name = tag.name.trim();
                if (!name || shared.tags.some((x) => x.toLowerCase() === name.toLowerCase()))
                  return;
                updateShared({ tags: [...shared.tags, name] });
              }}
              autosuggest
            />
          )}
        </div>
      </Field>
      <TitleTemplateInput
        value={shared.titleTemplate}
        onChange={(titleTemplate) => updateShared({ titleTemplate })}
        previews={titlePreviews}
        disabled={disabled}
      />
    </fieldset>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1 sm:flex-row sm:items-start sm:gap-3">
      <Text size="sm" fw={500} className="sm:w-24 sm:shrink-0 sm:pt-1">
        {label}
      </Text>
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}

function Chip({
  label,
  onRemove,
  disabled,
}: {
  label: string;
  onRemove: () => void;
  disabled?: boolean;
}) {
  return (
    <Badge
      size="lg"
      variant="light"
      color="gray"
      className="normal-case"
      rightSection={
        !disabled && <CloseButton size="xs" aria-label={`Remove ${label}`} onClick={onRemove} />
      }
    >
      {label}
    </Badge>
  );
}

function useOptions(kind: 'tools' | 'techniques') {
  const toolsQuery = useQueryTools({
    filters: { include: ['unlisted'] },
    options: { enabled: kind === 'tools' },
  });
  const techniquesQuery = trpc.technique.getAll.useQuery(undefined, {
    enabled: kind === 'techniques',
  });
  const options = useMemo<ComboboxOption[]>(() => {
    if (kind === 'tools')
      return [...toolsQuery.tools]
        .sort((a, b) =>
          a.priority || b.priority
            ? (a.priority ?? 999) - (b.priority ?? 999)
            : a.name.localeCompare(b.name)
        )
        .map((tool) => ({ label: tool.name, value: tool.id, group: getDisplayName(tool.type) }));
    return (techniquesQuery.data ?? []).map((technique) => ({
      label: technique.name,
      value: technique.id,
      group: getDisplayName(technique.type),
    }));
  }, [kind, toolsQuery.tools, techniquesQuery.data]);
  return { options, loading: kind === 'tools' ? toolsQuery.loading : techniquesQuery.isLoading };
}

function OptionPicker({
  kind,
  value,
  onChange,
  disabled,
}: {
  kind: 'tools' | 'techniques';
  value: NamedOption[];
  onChange: (value: NamedOption[]) => void;
  disabled?: boolean;
}) {
  const [opened, setOpened] = useState(false);
  const { options, loading } = useOptions(kind);
  const ids = value.map((x) => x.id);

  return (
    <div className="flex flex-wrap items-center gap-2">
      {value.map((item) => (
        <Chip
          key={item.id}
          label={item.name}
          disabled={disabled}
          onRemove={() => onChange(value.filter((x) => x.id !== item.id))}
        />
      ))}
      <Popover
        opened={opened}
        onChange={setOpened}
        position="bottom-start"
        withinPortal
        shadow="md"
        width={300}
      >
        <Popover.Target>
          <Button
            size="compact-sm"
            variant="default"
            leftSection={<IconPlus size={14} />}
            onClick={() => setOpened((value) => !value)}
            disabled={disabled}
          >
            Add
          </Button>
        </Popover.Target>
        <Popover.Dropdown p={0}>
          <AlwaysOpenCombobox
            value={ids}
            onChange={(next: number[]) =>
              onChange(
                next.map((id) => ({
                  id,
                  name: options.find((option) => option.value === id)?.label ?? String(id),
                }))
              )
            }
            options={options}
            loading={loading}
            renderOption={({ selected, label }) => (
              <>
                <span>{label}</span>
                <Checkbox checked={selected} readOnly tabIndex={-1} />
              </>
            )}
            footer={
              <div className="p-2">
                <Button size="compact-sm" fullWidth onClick={() => setOpened(false)}>
                  Done
                </Button>
              </div>
            }
          />
        </Popover.Dropdown>
      </Popover>
    </div>
  );
}

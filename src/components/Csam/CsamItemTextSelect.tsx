import {
  Badge,
  Button,
  Checkbox,
  Group,
  Input,
  Loader,
  Stack,
  Text,
  TextInput,
} from '@mantine/core';
import { useState } from 'react';
import type { CsamContextSources } from '~/server/schema/csam.schema';
import type { ItemSource, Ticked, Typed } from '~/components/Csam/csam-item-picker';
import {
  badTokens,
  csamPickerState,
  csamPickOrder,
  csamUntick,
  ITEMS,
  parseIds,
} from '~/components/Csam/csam-item-picker';
import {
  CSAM_CONTEXT_ITEM_SELECT_LIMIT,
  csamOutsideFieldsHelp,
} from '~/shared/constants/csam-context.constants';
import { trpc } from '~/utils/trpc';

/** The reported user's own chat messages, models, articles, service offerings and profile. */
export function CsamItemTextSelect({
  userId,
  hasImages,
  value,
  onChange,
}: {
  userId: number;
  hasImages: boolean;
  value: CsamContextSources;
  /** `problem` is set while the selection can't be filed. */
  onChange: (value: CsamContextSources, problem?: string) => void;
}) {
  const [typed, setTyped] = useState<Typed>({
    chatMessageIds: '',
    modelIds: '',
    articleIds: '',
    serviceOfferingIds: '',
  });
  const [ticked, setTicked] = useState<Ticked>({ model: [], article: [], serviceOffering: [] });

  const update = (nextTyped: Typed, nextTicked: Ticked, profile = value.profile) => {
    setTyped(nextTyped);
    setTicked(nextTicked);
    const { lists, problem } = csamPickerState(nextTyped, nextTicked, profile);
    onChange(
      { ...value, ...lists, profile, order: csamPickOrder(value.order, lists, profile) },
      problem
    );
  };
  const { count, problem } = csamPickerState(typed, ticked, value.profile);
  const full = count >= CSAM_CONTEXT_ITEM_SELECT_LIMIT;

  return (
    <Input.Wrapper
      label="Text on the reported user's chat messages, items and profile"
      description={`Only the reported user's own chat messages and items can be attached, at most ${CSAM_CONTEXT_ITEM_SELECT_LIMIT} per report. Their text is copied when you submit, and links in the text are kept as text.`}
    >
      <Stack gap="sm" mt="xs">
        <Text size="xs" c="dimmed">
          {csamOutsideFieldsHelp(hasImages)}
        </Text>
        <Checkbox
          checked={value.profile}
          disabled={full && !value.profile}
          onChange={(e) => update(typed, ticked, e.currentTarget.checked)}
          label="Profile text (bio and message, on both sites). Profile links and images are not included."
        />
        <TextInput
          label="Chat message ids"
          description="Paste the ids of the reported user's text messages, separated by commas or spaces."
          value={typed.chatMessageIds}
          error={badTokens(typed.chatMessageIds).length > 0}
          onChange={(e) => update({ ...typed, chatMessageIds: e.currentTarget.value }, ticked)}
        />
        {ITEMS.map((item) => (
          <ItemList
            key={item.source}
            userId={userId}
            source={item.source}
            label={item.label}
            full={full}
            ticked={ticked[item.source]}
            typed={typed[item.field]}
            onChange={(nextTicked, nextText) =>
              update({ ...typed, [item.field]: nextText }, { ...ticked, [item.source]: nextTicked })
            }
          />
        ))}
        {problem && (
          <Text size="sm" c="red">
            {problem}
          </Text>
        )}
      </Stack>
    </Input.Wrapper>
  );
}

function ItemList({
  userId,
  source,
  label,
  full,
  ticked,
  typed,
  onChange,
}: {
  userId: number;
  source: ItemSource;
  label: string;
  full: boolean;
  ticked: number[];
  typed: string;
  onChange: (ticked: number[], typed: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const { data, isLoading, error } = trpc.csam.getItemContextCandidates.useQuery(
    { userId, source },
    { enabled: open && userId > 0 }
  );
  const typedIds = parseIds(typed);

  return (
    <Stack gap={4}>
      <Group gap="xs">
        <Text size="sm" fw={600}>
          {label}
        </Text>
        {!open && (
          <Button size="compact-xs" variant="light" onClick={() => setOpen(true)}>
            List the reported user&apos;s {label.toLowerCase()}
          </Button>
        )}
      </Group>
      {open &&
        (isLoading ? (
          <Loader size="sm" />
        ) : error ? (
          <Text c="red" size="sm">
            Could not load the list.
          </Text>
        ) : !data?.candidates.length ? (
          <Text size="sm" c="dimmed">
            None.
          </Text>
        ) : (
          data.candidates.map((c) => {
            const checked = ticked.includes(c.id) || typedIds.includes(c.id);
            return (
              <Checkbox
                key={c.id}
                checked={checked}
                disabled={c.unavailable || (full && !checked)}
                onChange={(e) => {
                  if (e.currentTarget.checked) onChange([...ticked, c.id], typed);
                  else {
                    const next = csamUntick(ticked, typed, c.id);
                    onChange(next.ticked, next.typed);
                  }
                }}
                label={
                  <Group gap="xs">
                    <Text size="sm">
                      {c.id}: {c.title}
                    </Text>
                    <Badge size="xs" variant="light">
                      {c.status}
                    </Badge>
                    {c.deleted && (
                      <Badge size="xs" color="gray">
                        deleted
                      </Badge>
                    )}
                    {c.unavailable && (
                      <Badge size="xs" color="gray">
                        can&apos;t be attached
                      </Badge>
                    )}
                  </Group>
                }
              />
            );
          })
        ))}
      {data?.more && (
        <Text size="xs" c="dimmed">
          Only the newest 100 are listed. Give any other id below.
        </Text>
      )}
      <TextInput
        size="xs"
        placeholder={`Other ${label.toLowerCase()} ids, separated by commas or spaces`}
        value={typed}
        error={badTokens(typed).length > 0}
        onChange={(e) => onChange(ticked, e.currentTarget.value)}
      />
    </Stack>
  );
}

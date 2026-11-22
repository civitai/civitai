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
import { trpc } from '~/utils/trpc';

/**
 * Facts the fields below do not hold are not captured. What a moderator does with one is a policy
 * decision kept here so it is said the same way everywhere.
 */
export const CSAM_OUTSIDE_FIELDS_HELP =
  'Facts outside these fields are not captured and are not sent. If one is the reason for this report, file now, then tell [WHO: pending] privately.';

type ItemSource = 'model' | 'article' | 'serviceOffering';
const ITEMS: { source: ItemSource; field: keyof CsamContextSources; label: string }[] = [
  { source: 'model', field: 'modelIds', label: 'Models' },
  { source: 'article', field: 'articleIds', label: 'Articles' },
  { source: 'serviceOffering', field: 'serviceOfferingIds', label: 'Service offerings' },
];

const parseIds = (raw: string) => [
  ...new Set(
    raw
      .split(/[\s,]+/)
      .map(Number)
      .filter((n) => Number.isInteger(n) && n > 0)
  ),
];

/** The reported user's own chat messages, models, articles, service offerings and profile. */
export function CsamItemTextSelect({
  userId,
  value,
  onChange,
}: {
  userId: number;
  value: CsamContextSources;
  onChange: (value: CsamContextSources) => void;
}) {
  return (
    <Input.Wrapper
      label="Text on the reported user's chat messages, items and profile"
      description="Only the reported user's own chat messages and items can be attached. Their text is copied when you submit, and links in the text are kept as text."
    >
      <Stack gap="sm" mt="xs">
        <Text size="xs" c="dimmed">
          {CSAM_OUTSIDE_FIELDS_HELP}
        </Text>
        <Checkbox
          checked={value.profile}
          onChange={(e) => onChange({ ...value, profile: e.currentTarget.checked })}
          label="Profile text (bio and message, on both sites). Profile links and images are not included."
        />
        <TextInput
          label="Chat message ids"
          description="Paste the ids of the reported user's text messages, separated by commas or spaces."
          defaultValue={value.chatMessageIds.join(', ')}
          onChange={(e) => onChange({ ...value, chatMessageIds: parseIds(e.currentTarget.value) })}
        />
        {ITEMS.map((item) => (
          <ItemList
            key={item.source}
            userId={userId}
            {...item}
            ids={value[item.field] as number[]}
            onIds={(ids) => onChange({ ...value, [item.field]: ids })}
          />
        ))}
      </Stack>
    </Input.Wrapper>
  );
}

function ItemList({
  userId,
  source,
  label,
  ids,
  onIds,
}: {
  userId: number;
  source: ItemSource;
  label: string;
  ids: number[];
  onIds: (ids: number[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const [ticked, setTicked] = useState(ids);
  const [typedText, setTypedText] = useState('');
  const { data, isLoading, error } = trpc.csam.getItemContextCandidates.useQuery(
    { userId, source },
    { enabled: open && userId > 0 }
  );
  const update = (nextTicked: number[], nextText: string) => {
    setTicked(nextTicked);
    setTypedText(nextText);
    onIds([...new Set([...nextTicked, ...parseIds(nextText)])]);
  };
  // Unticking also removes the id from the typed box, so nothing unticked is still sent.
  const toggle = (id: number, checked: boolean) => {
    const rest = ticked.filter((x) => x !== id);
    update(
      checked ? [...rest, id] : rest,
      checked
        ? typedText
        : typedText
            .split(/[\s,]+/)
            .filter((token) => token && Number(token) !== id)
            .join(', ')
    );
  };

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
          data.candidates.map((c) => (
            <Checkbox
              key={c.id}
              checked={ids.includes(c.id)}
              onChange={(e) => toggle(c.id, e.currentTarget.checked)}
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
                </Group>
              }
            />
          ))
        ))}
      {data?.more && (
        <Text size="xs" c="dimmed">
          Only the newest 100 are listed. Give any other id below.
        </Text>
      )}
      <TextInput
        size="xs"
        placeholder={`Other ${label.toLowerCase()} ids, separated by commas or spaces`}
        value={typedText}
        onChange={(e) => update(ticked, e.currentTarget.value)}
      />
    </Stack>
  );
}

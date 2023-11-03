import {
  Button,
  Group,
  Input,
  InputWrapperProps,
  LoadingOverlay,
  Paper,
  Stack,
  Text,
  TextInput,
} from '@mantine/core';
import { useState } from 'react';
import { IconTrash, IconUser } from '@tabler/icons-react';
import { useDidUpdate } from '@mantine/hooks';
import { DomainIcon } from '~/components/DomainIcon/DomainIcon';
import { zc } from '~/utils/schema-helpers';
import { isEqual } from 'lodash-es';
import { getAllAvailableProfileSections } from '~/components/Profile/profile.utils';

type InlineSocialLinkInputProps = Omit<InputWrapperProps, 'children' | 'onChange'> & {
  value?: { url: string; id?: number }[];
  onChange?: (value: { url: string; id?: number }[]) => void;
};

export function InlineSocialLinkInput({ value, onChange, ...props }: InlineSocialLinkInputProps) {
  const [error, setError] = useState('');
  const [links, setLinks] = useState<{ url: string; id?: number }[]>(value || []);
  const [createLink, setCreateLink] = useState<string>('');

  useDidUpdate(() => {
    if (links) {
      onChange?.(links);
    }
  }, [links]);

  useDidUpdate(() => {
    if (!isEqual(value, links)) {
      // Value changed outside.
      setLinks(value || []);
    }
  }, [value]);

  const onAddLink = () => {
    const url = createLink;
    const res = zc.safeUrl.safeParse(url);

    if (!res.success) {
      setError('Provided URL appears to be invalid');
      return;
    }

    setLinks((current) => [...current, { url }]);
    setCreateLink('');
  };

  return (
    <Input.Wrapper {...props} error={props.error ?? error}>
      <Stack spacing="xs" mt="sm">
        {links.map((link, index) => (
          <Group key={index} align="center">
            <DomainIcon url={link.url} size={24} />
            <Text size="sm">{link.url}</Text>
            <Button
              variant="light"
              color="red"
              size="xs"
              radius="sm"
              ml="auto"
              onClick={() => {
                setLinks((current) => {
                  const newLinks = current.filter((_, i) => i !== index);
                  return newLinks;
                });
              }}
            >
              <IconTrash size={16} />
            </Button>
          </Group>
        ))}

        <Group>
          <TextInput
            value={createLink}
            onChange={(e) => setCreateLink(e.target.value)}
            radius="sm"
            size="sm"
            placeholder="Add new link"
            styles={{
              root: { flex: 1 },
            }}
          />
          <Button onClick={onAddLink} size="sm" radius="sm">
            Add
          </Button>
        </Group>
      </Stack>
    </Input.Wrapper>
  );
}

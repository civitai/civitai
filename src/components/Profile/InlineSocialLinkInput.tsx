import {
  ActionIcon,
  Button,
  Divider,
  Group,
  Input,
  InputWrapperProps,
  LoadingOverlay,
  Paper,
  Stack,
  Text,
  TextInput,
} from '@mantine/core';
import { Fragment, useState } from 'react';
import { IconPlus, IconTrash } from '@tabler/icons-react';
import { useDidUpdate } from '@mantine/hooks';
import { DomainIcon } from '~/components/DomainIcon/DomainIcon';
import { zc } from '~/utils/schema-helpers';
import { isEqual } from 'lodash-es';
import { LinkType } from '@prisma/client';

type InlineSocialLinkInputProps = Omit<InputWrapperProps, 'children' | 'onChange'> & {
  value?: { url: string; id?: number; type: LinkType }[];
  onChange?: (value: { url: string; id?: number; type: LinkType }[]) => void;
  type: LinkType;
};

export function InlineSocialLinkInput({
  value,
  onChange,
  type,
  ...props
}: InlineSocialLinkInputProps) {
  const [error, setError] = useState('');
  const [links, setLinks] = useState<{ url: string; id?: number; type: LinkType }[]>(value || []);
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

    setLinks((current) => [...current, { url, type }]);
    setCreateLink('');
  };

  return (
    <Input.Wrapper {...props} error={props.error ?? error}>
      <Stack spacing="xs" mt="sm">
        {links.length > 0 && (
          <Paper withBorder p="sm">
            <Stack>
              {links.map((link, index) => {
                const isLast = index === links.length - 1;
                return (
                  <Fragment key={index}>
                    <Group align="center" noWrap>
                      <DomainIcon url={link.url} size={24} />
                      <Text size="sm">{link.url}</Text>
                      <ActionIcon
                        variant="outline"
                        color="red"
                        size="md"
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
                      </ActionIcon>
                    </Group>
                    {!isLast && <Divider />}
                  </Fragment>
                );
              })}
            </Stack>
          </Paper>
        )}

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
          <ActionIcon
            variant="filled"
            color="blue"
            size="lg"
            radius="sm"
            ml="auto"
            onClick={onAddLink}
          >
            <IconPlus size={16} />
          </ActionIcon>
        </Group>
      </Stack>
    </Input.Wrapper>
  );
}

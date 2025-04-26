import { Autocomplete, Badge, Group, TextInput, Box, BoxProps } from '@mantine/core';
import { getHotkeyHandler, useDebouncedValue, useDisclosure } from '@mantine/hooks';
import { IconPlus } from '@tabler/icons-react';
import { useCallback, useState, forwardRef } from 'react';
import { TagTarget } from '~/shared/utils/prisma/enums';
import { getDisplayName } from '~/utils/string-helpers';
import { trpc } from '~/utils/trpc';
import styles from './VotableTagAdd.module.scss';

export interface VotableTagAddProps extends BoxProps {
  addTag: (tag: string) => void;
  excludeTags?: string[];
  autosuggest?: boolean;
  onCreate?: (value: string) => void;
}

export const VotableTagAdd = forwardRef<HTMLDivElement, VotableTagAddProps>((props, ref) => {
  const { addTag, excludeTags, autosuggest, onCreate, className, ...others } = props;

  // Autocomplete logic
  const [search, setSearch] = useState('');
  const [debouncedSearch] = useDebouncedValue(search, 300);
  const [adding, { open, close }] = useDisclosure(false);

  const { data, isFetching } = trpc.tag.getAll.useQuery(
    {
      limit: 10,
      entityType: [TagTarget.Image],
      types: ['UserGenerated', 'Label'],
      query: debouncedSearch.trim().toLowerCase(),
      include: ['nsfwLevel'],
    },
    {
      enabled: autosuggest && debouncedSearch.trim().length > 0,
    }
  );

  const handleClose = useCallback(() => {
    close();
    setSearch('');
  }, [close]);

  const handleSubmit = useCallback(() => {
    const value = search.trim().toLowerCase();
    if (value) addTag(value);

    handleClose();
  }, [addTag, handleClose, search]);

  return (
    <Box
      className={`${styles.badge} ${className}`}
      {...others}
      ref={ref}
    >
      <Group spacing={4}>
        <IconPlus size={14} strokeWidth={2.5} />
        {!adding ? (
          <span>Tag</span>
        ) : autosuggest ? (
          <Autocomplete
            variant="unstyled"
            classNames={{ dropdown: classes.dropdown, input: classes.input }}
            value={search}
            onChange={setSearch}
            data={
              data?.items.map((tag) => ({
                id: tag.id,
                value: tag.name,
                name: getDisplayName(tag.name),
              })) ?? []
            }
            nothingFound={isFetching ? 'Searching...' : 'Nothing found'}
            placeholder="Type to search..."
            onItemSubmit={(item) => {
              addTag(item.value);
              handleClose();
            }}
            onBlur={handleClose}
            withinPortal
            autoFocus
          />
        ) : (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              handleSubmit();
            }}
          >
            <TextInput
              variant="unstyled"
              classNames={{ input: classes.input }}
              value={search}
              onChange={(e) => setSearch(e.currentTarget.value)}
              placeholder="Type your tag"
              onKeyDown={getHotkeyHandler([['Enter', handleSubmit]])}
              onBlur={handleClose}
              autoFocus
            />
          </form>
        )}
      </Group>
    </Badge>
  );
}

type VotableTagAddProps = {
  addTag: (tag: string) => void;
  excludeTags?: string[];
  autosuggest?: boolean;
};



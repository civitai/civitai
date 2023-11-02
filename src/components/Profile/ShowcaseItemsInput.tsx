import {
  AutocompleteItem,
  Button,
  Center,
  createStyles,
  Group,
  Input,
  InputWrapperProps,
  LoadingOverlay,
  Paper,
  Select,
  Stack,
  Text,
  TextInput,
} from '@mantine/core';
import React, { useState } from 'react';
import { useDidUpdate } from '@mantine/hooks';
import { ShowcaseItemSchema } from '~/server/schema/user-profile.schema';
import { QuickSearchDropdown } from '~/components/Search/QuickSearchDropdown';
import { IMAGES_SEARCH_INDEX, MODELS_SEARCH_INDEX } from '~/server/common/constants';

type ShowcaseItemsInputProps = Omit<InputWrapperProps, 'children' | 'onChange'> & {
  value?: ShowcaseItemSchema[];
  onChange?: (value: ShowcaseItemSchema[]) => void;
  username: string;
};

export const ShowcaseItemsInput = ({
  value,
  onChange,
  username,
  ...props
}: ShowcaseItemsInputProps) => {
  const [showcaseItems, setShowcaseItems] = useState<ShowcaseItemSchema[]>(value || []);
  const [error, setError] = useState('');
  // const { } =

  useDidUpdate(() => {
    if (showcaseItems) {
      onChange?.(showcaseItems);
    }
  }, [showcaseItems]);

  const onItemSelected = (item: ShowcaseItemSchema) => {
    setShowcaseItems((current) => [...current, item]);
  };

  return (
    <Input.Wrapper {...props} error={props.error ?? error}>
      <Stack spacing="xs" mt="sm">
        <QuickSearchDropdown
          supportedIndexes={[MODELS_SEARCH_INDEX, IMAGES_SEARCH_INDEX]}
          onItemSelected={onItemSelected}
          filters={`user.username='${username}'`}
        />

        <Paper>
          {showcaseItems.length > 0 ? (
            <Group noWrap>
              {showcaseItems.map((item) => {
                return (
                  <Paper key={`${item.entityType}-${item.entityId}`}>
                    <Stack spacing="xs">
                      <Text>{item.entityType}</Text>
                      <Text>{item.entityId}</Text>
                    </Stack>
                  </Paper>
                );
              })}
            </Group>
          ) : (
            <Center>
              <Text>You have not selected any items.</Text>
            </Center>
          )}
        </Paper>
      </Stack>
    </Input.Wrapper>
  );
};

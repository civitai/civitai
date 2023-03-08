import {
  ActionIcon,
  Autocomplete,
  Badge,
  Center,
  createStyles,
  Group,
  Input,
  InputWrapperProps,
  UnstyledButton,
} from '@mantine/core';
import { getHotkeyHandler, useDebouncedState, useDisclosure } from '@mantine/hooks';
import { TagTarget } from '@prisma/client';
import { IconPlus, IconX } from '@tabler/icons';
import { useMemo } from 'react';
import { PostTag } from '~/server/selectors/post.selector';

type PostCategoryPickerProps = Omit<InputWrapperProps, 'children' | 'onChange'> & {
  value?: PostTag[];
  onChange?: (value: PostTag[]) => void;
  target: TagTarget[];
};

export function PostCategoryPicker() {
  return <></>;
}

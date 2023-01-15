import { InputWrapperProps, Input, Stack, Group } from '@mantine/core';
import { useListState } from '@mantine/hooks';
import { RecipeInput } from '~/server/schema/model-version.schema';

type RecipeInputProps = Omit<InputWrapperProps, 'children' | 'onChange'> & {
  value?: RecipeInput;
  onChange?: (value: RecipeInput) => void;
};

export function RecipeInput({ value, onChange, ...inputWrapperProps }: RecipeInputProps) {
  // const [list, listHandler] = useListState(value);

  return (
    <Input.Wrapper {...inputWrapperProps}>
      <Group></Group>
    </Input.Wrapper>
  );
}

import type { TextareaProps } from '@mantine/core';
import { Textarea } from '@mantine/core';
import { getHotkeyHandler } from '@mantine/hooks';
import type { KeyboardEvent } from 'react';
import { useFormContext } from 'react-hook-form';
import { keyupEditAttention } from '~/components/ImageGeneration/GenerationForm/generation.utils';
import { useCustomFormContext } from '~/libs/form';
import { withController } from '~/libs/form/hoc/withController';

type InputPromptProps = Omit<TextareaProps, 'onKeyDown'>;

export const InputPrompt = withController(function (props: InputPromptProps) {
  const form = useFormContext();
  const { onSubmit } = useCustomFormContext();

  function handleSubmit() {
    if (onSubmit) form.handleSubmit(onSubmit)();
  }

  function handleArrowUpOrDown(event: KeyboardEvent<HTMLElement> | globalThis.KeyboardEvent) {
    if (props.name) {
      const text = keyupEditAttention(event as React.KeyboardEvent<HTMLTextAreaElement>);
      form.setValue(props.name, text ?? '');
    }
  }

  const keyHandler = getHotkeyHandler([
    ['mod+Enter', handleSubmit],
    ['mod+ArrowUp', handleArrowUpOrDown],
    ['mod+ArrowDown', handleArrowUpOrDown],
  ]);

  return <Textarea {...props} onKeyDown={keyHandler} />;
});

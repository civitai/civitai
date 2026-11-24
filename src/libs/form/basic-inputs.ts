import { Chip, Textarea } from '@mantine/core';
import { NumberInputWrapper } from '~/libs/form/components/NumberInputWrapper';
import { TextInputWrapper } from '~/libs/form/components/TextInputWrapper';
import { withController } from '~/libs/form/hoc/withController';

// Plain inputs only: importing this file must not pull in the barrel's rich-text, upload or
// cosmetic inputs (docs/dev/import-cycles.md).

export const InputText = withController(TextInputWrapper);
export const InputNumber = withController(NumberInputWrapper, ({ field, form }) => ({
  // RHF's useController substitutes the field's defaultValue whenever the stored value is
  // undefined, which resurrects the old value in the UI right after the user clears the input.
  // getValues() reads the raw store without that substitution, so a cleared field stays empty.
  // Caveat: with `shouldUnregister: true` (the useForm default), a conditionally-mounted
  // InputNumber that has a defaultValue renders empty on remount while useController silently
  // re-seeds the store — the submit would carry a value the UI doesn't show. Mount such fields
  // unconditionally or set shouldUnregister: false on that form.
  value: form.getValues(field.name),
}));
export const InputTextArea = withController(Textarea);
export const InputChipGroup = withController(Chip.Group);

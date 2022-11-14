import { ImageUpload } from '~/components/ImageUpload/ImageUpload';
import { RichTextEditor } from '~/components/RichTextEditor/RichTextEditor';
import { withController } from '../hoc/withController';
import { TextInputWrapper } from './TextInputWrapper';
import { NumberInputWrapper } from './NumberInputWrapper';
import {
  Autocomplete,
  Checkbox,
  Chip,
  ColorInput,
  ColorPicker,
  FileInput,
  JsonInput,
  PasswordInput,
  Radio,
  Rating,
  SegmentedControl,
  Slider,
  Switch,
  Textarea,
  TransferList,
} from '@mantine/core';
import { SelectWrapper } from '~/libs/form/components/SelectWrapper';
import { MultiSelectWrapper } from '~/libs/form/components/MultiSelectWrapper';
import { DatePicker } from '@mantine/dates';
import { FileInputUpload } from '~/components/FileInputUpload/FileInputUpload';
import { ProfileImageUpload } from '~/components/ProfileImageUpload/ProfileImageUpload';

export * from './Form';

export const InputText = withController(TextInputWrapper);
export const InputNumber = withController(NumberInputWrapper);
export const InputTextArea = withController(Textarea);
export const InputTransferList = withController(TransferList);
export const InputSelect = withController(SelectWrapper);
export const InputMultiSelect = withController(MultiSelectWrapper);
export const InputSegmentedControl = withController(SegmentedControl);
export const InputRadioGroup = withController(Radio.Group);
export const InputCheckboxGroup = withController(Checkbox.Group);
export const InputPasswordInput = withController(PasswordInput);
export const InputJson = withController(JsonInput);
export const InputColorPicker = withController(ColorPicker);
export const InputColorInput = withController(ColorInput);
export const InputChips = withController(Chip.Group);
export const InputAutocomplete = withController(Autocomplete);
export const InputDatePicker = withController(DatePicker);
export const InputRating = withController(Rating);
export const InputSlider = withController(Slider);
export const InputFileInput = withController(FileInput);
export const InputRTE = withController(RichTextEditor);
export const InputImageUpload = withController(ImageUpload);
export const InputFileUpload = withController(FileInputUpload);
export const InputProfileImageUpload = withController(ProfileImageUpload);

export const InputSwitch = withController(Switch, ({ field }) => ({
  checked: field.value ?? false,
}));
export const InputCheckbox = withController(Checkbox, ({ field }) => ({
  checked: field.value ?? false,
}));

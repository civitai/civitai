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
import { withWatcher } from '~/libs/form/hoc/withWatcher';
import { RatingWrapper } from '~/libs/form/components/RatingWrapper';
import { FileList } from '~/components/Model/ModelForm/FileList';

export * from './Form';

export const InputText = withWatcher(withController(TextInputWrapper));
export const InputNumber = withWatcher(withController(NumberInputWrapper));
export const InputTextArea = withWatcher(withController(Textarea));
export const InputTransferList = withWatcher(withController(TransferList));
export const InputSelect = withWatcher(withController(SelectWrapper));
export const InputMultiSelect = withWatcher(withController(MultiSelectWrapper));
export const InputSegmentedControl = withWatcher(withController(SegmentedControl));
export const InputRadioGroup = withWatcher(withController(Radio.Group));
export const InputCheckboxGroup = withWatcher(withController(Checkbox.Group));
export const InputPasswordInput = withWatcher(withController(PasswordInput));
export const InputJson = withWatcher(withController(JsonInput));
export const InputColorPicker = withWatcher(withController(ColorPicker));
export const InputColorInput = withWatcher(withController(ColorInput));
export const InputChips = withWatcher(withController(Chip.Group));
export const InputAutocomplete = withWatcher(withController(Autocomplete));
export const InputDatePicker = withWatcher(withController(DatePicker));
export const InputRating = withWatcher(withController(RatingWrapper));
export const InputSlider = withWatcher(withController(Slider));
export const InputFileInput = withWatcher(withController(FileInput));
export const InputRTE = withWatcher(withController(RichTextEditor));
export const InputImageUpload = withWatcher(withController(ImageUpload));
export const InputFileUpload = withWatcher(withController(FileInputUpload));
export const InputProfileImageUpload = withWatcher(withController(ProfileImageUpload));
export const InputFileList = withWatcher(withController(FileList));

export const InputSwitch = withWatcher(
  withController(Switch, ({ field }) => ({
    checked: field.value ?? false,
  }))
);
export const InputCheckbox = withWatcher(
  withController(Checkbox, ({ field }) => ({
    checked: field.value ?? false,
  }))
);

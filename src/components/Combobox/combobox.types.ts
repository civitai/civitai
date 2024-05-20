import { Key } from 'react';

export type ComboboxOption = {
  group?: string;
  disabled?: boolean;
  label: string;
  value: Key;
};

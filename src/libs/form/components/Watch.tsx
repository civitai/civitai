import type { Control, FieldPath, FieldValues, UseFormGetValues } from 'react-hook-form';
import { FieldPathValues, Path, PathValue, useWatch } from 'react-hook-form';

export function Watch<
  TFieldValues extends FieldValues,
  TFieldNames extends readonly FieldPath<TFieldValues>[]
>({
  control,
  fields,
  getValues,
  children,
}: {
  control: Control<TFieldValues>;
  fields: TFieldNames;
  getValues: UseFormGetValues<TFieldValues>;
  children: (props: TFieldValues) => React.ReactElement;
}) {
  useWatch({ control, name: fields });
  return children(getValues());
}

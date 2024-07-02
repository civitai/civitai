import {
  Control,
  FieldPath,
  FieldPathValues,
  FieldValues,
  Path,
  PathValue,
  UseFormGetValues,
  useWatch,
} from 'react-hook-form';

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

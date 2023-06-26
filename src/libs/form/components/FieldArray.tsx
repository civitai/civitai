import {
  Control,
  FieldArrayPath,
  FieldValues,
  useFieldArray,
  UseFieldArrayReturn,
  useFormContext,
} from 'react-hook-form';

type FieldArrayProps<
  TFieldValues extends FieldValues,
  TFieldArrayName extends FieldArrayPath<TFieldValues>,
  TKeyName extends string = 'id'
> = {
  name: TFieldArrayName;
  keyName?: TKeyName;
  control?: Control<TFieldValues>;
  render: (
    props: UseFieldArrayReturn<TFieldValues, TFieldArrayName, TKeyName>
  ) => JSX.Element | JSX.Element[];
};

export function FieldArray<
  TFieldValues extends FieldValues,
  TFieldArrayName extends FieldArrayPath<TFieldValues>
>({ name, keyName = 'id', render }: FieldArrayProps<TFieldValues, TFieldArrayName>) {
  const { control } = useFormContext<TFieldValues>();
  const { fields, append, prepend, remove, swap, move, insert, update, replace } = useFieldArray<
    TFieldValues,
    TFieldArrayName
  >({
    control, // control props comes from useForm (optional: if you are using FormContext)
    name, // unique name for your Field Array
    keyName, // default to "id", you can change the key name
  });
  return <>{render({ fields, append, prepend, remove, swap, move, insert, update, replace })}</>;
}

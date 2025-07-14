import { useMergedRef } from '@mantine/hooks';
import type { ComponentType } from 'react';
import { forwardRef, useRef } from 'react';
import type {
  ControllerFieldState,
  ControllerRenderProps,
  FieldPath,
  FieldValues,
  UseFormStateReturn,
} from 'react-hook-form';
import { Controller, useFormContext } from 'react-hook-form';

export function withController<
  TComponentProps extends { onChange?: (...events: any[]) => void } & Record<string, any>, //eslint-disable-line
  TFieldValues extends FieldValues = FieldValues,
  TName extends FieldPath<TFieldValues> = FieldPath<TFieldValues>
>(
  BaseComponent:
    | React.ForwardRefExoticComponent<TComponentProps>
    | ((props: TComponentProps) => JSX.Element)
    | ComponentType<TComponentProps>,
  mapper?: ({
    field,
    fieldState,
    formState,
    props,
  }: {
    field: ControllerRenderProps<TFieldValues, TName>;
    fieldState: ControllerFieldState;
    formState: UseFormStateReturn<TFieldValues>;
    props: TComponentProps;
  }) => Partial<TComponentProps>
) {
  const ControlledInput = forwardRef<HTMLElement, TComponentProps & { name: TName }>(
    ({ name, ...props }, ref) => {
      const scopedRef = useRef<HTMLElement | null>(null);
      const mergedRef = useMergedRef(ref, scopedRef);
      const { control, ...form } = useFormContext<TFieldValues>();
      return (
        <Controller
          control={control}
          name={name}
          render={({ field, fieldState, formState }) => {
            const mappedProps = mapper?.({ field, fieldState, formState, props: props as any }); //eslint-disable-line

            const handleChange = (...values: any) => {
              //eslint-disable-line
              props.onChange?.(...values);
              // @ts-ignore
              field.onChange(...values);
            };

            const handleBlur = () => {
              props.onBlur?.();
              field.onBlur();
            };

            const mapped = {
              onChange: handleChange,
              error:
                (fieldState.error && Array.isArray(fieldState.error)
                  ? fieldState.error[0]?.message
                  : fieldState.error?.message) ?? props.error,
              value: field.value ?? '',
              onBlur: handleBlur,
              placeholder:
                props.placeholder ?? (typeof props.label === 'string' ? props.label : undefined),
              ...mappedProps,
            };

            // TODO - instead of passing reset prop, find a way to pass an onReset handler
            return (
              <BaseComponent
                id={`input_${name}`}
                ref={mergedRef}
                {...(props as TComponentProps & { name: TName })}
                {...mapped}
                reset={(form as any).resetCount}
                name={name}
              />
            );
          }}
        />
      );
    }
  );

  ControlledInput.displayName = 'ControlledInput';
  return ControlledInput;
}

import { Input, InputWrapperProps, Rating, RatingProps } from '@mantine/core';

export function RatingWrapper({
  id,
  label,
  description,
  error,
  required,
  withAsterisk,
  labelProps,
  descriptionProps,
  errorProps,
  inputWrapperOrder,
  ...ratingProps
}: Props) {
  const wrapperProps = {
    id,
    label,
    description,
    error,
    required,
    withAsterisk,
    labelProps,
    descriptionProps,
    errorProps,
    inputWrapperOrder,
  };

  return (
    <Input.Wrapper {...wrapperProps}>
      <Rating {...ratingProps} />
    </Input.Wrapper>
  );
}

type Props = RatingProps & Omit<InputWrapperProps, 'children' | 'size'>;

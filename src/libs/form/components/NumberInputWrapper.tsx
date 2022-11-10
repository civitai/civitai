import { NumberInput, NumberInputProps } from '@mantine/core';
import { useMemo } from 'react';
import { numberWithCommas } from '~/utils/number-helpers';

type Props = NumberInputProps & {
  format?: 'default' | 'delimited';
};

export function NumberInputWrapper({ format = 'delimited', ...props }: Props) {
  const { parser, formatter } = useMemo(() => {
    switch (format) {
      case 'delimited':
        return {
          parser: (value?: string) => value && value.replace(/\$\s?|(,*)/g, ''),
          formatter: (value?: string) => numberWithCommas(value),
        };
      default: {
        return {
          parser: undefined,
          formatter: undefined,
        };
      }
    }
  }, [format]);

  return <NumberInput parser={parser} formatter={formatter} {...props} />;
}

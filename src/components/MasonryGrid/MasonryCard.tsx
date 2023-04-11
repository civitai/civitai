import {
  Card,
  CardProps,
  DefaultMantineColor,
  createPolymorphicComponent,
  useMantineTheme,
} from '@mantine/core';
import { getRandom } from '~/utils/array-helpers';
import { forwardRef, useMemo } from 'react';

type MasonryCardProps = CardProps & { height?: number };
// TODO - when children not in view, replace child react nodes with static html
const _MasonryCard = forwardRef<HTMLDivElement, MasonryCardProps>(
  ({ height, children, style, ...props }, ref) => {
    const theme = useMantineTheme();

    const background = useMemo(() => {
      const base = theme.colors[getRandom(mantineColors)];
      const color = theme.colorScheme === 'dark' ? theme.colors.dark[6] : '#fff';
      return theme.fn.gradient({ from: base[9], to: color, deg: 180 });
    }, [theme]);

    return (
      <Card
        ref={ref}
        style={{
          height,
          ...style,
        }}
        sx={{ background }}
        {...props}
      >
        {children}
      </Card>
    );
  }
);
_MasonryCard.displayName = 'MasonryCard';

export const MasonryCard = createPolymorphicComponent<'div', MasonryCardProps>(_MasonryCard);

const mantineColors: DefaultMantineColor[] = [
  'blue',
  'cyan',
  'grape',
  'green',
  'indigo',
  'lime',
  'orange',
  'pink',
  'red',
  'teal',
  'violet',
  'yellow',
];

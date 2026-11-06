import { Indicator } from '@mantine/core';

/**
 * The red count badge on a header button: the bell, chat and account menu all use it, so a count
 * has the same size, shape and corner on each.
 */
export function CountIndicator({
  label,
  disabled,
  children,
}: {
  label: React.ReactNode;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  return (
    <Indicator
      color="red"
      label={label}
      size={16}
      offset={4}
      className="flex items-center text-sm font-bold"
      classNames={{ indicator: 'cursor-pointer h-5' }}
      disabled={disabled}
      withBorder
    >
      {children}
    </Indicator>
  );
}

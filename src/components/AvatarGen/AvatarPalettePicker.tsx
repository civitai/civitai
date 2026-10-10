import { Input, Tooltip, UnstyledButton } from '@mantine/core';
import { IconCheck } from '@tabler/icons-react';
import clsx from 'clsx';
import { avatarPalettes } from '~/shared/constants/avatar-styles.constants';

export function AvatarPalettePicker({
  value,
  onChange,
}: {
  value: string;
  onChange: (palette: string) => void;
}) {
  const selected = avatarPalettes.find((palette) => palette.key === value);

  return (
    <Input.Wrapper
      label={
        <span>
          Colours{' '}
          {selected && (
            <span className="font-normal text-gray-6 dark:text-dark-2">· {selected.label}</span>
          )}
        </span>
      }
    >
      <div className="mt-1 grid grid-cols-6 gap-2" role="radiogroup">
        {avatarPalettes.map((palette) => {
          const isSelected = palette.key === value;
          return (
            <Tooltip key={palette.key} label={palette.label}>
              <UnstyledButton
                role="radio"
                aria-checked={isSelected}
                aria-label={palette.label}
                onClick={() => onChange(palette.key)}
                className={clsx(
                  'relative flex aspect-square overflow-hidden rounded-md',
                  isSelected
                    ? 'ring-4 ring-blue-5 ring-offset-2 dark:ring-offset-dark-7'
                    : 'border border-gray-3 dark:border-dark-4'
                )}
              >
                {palette.colors.length ? (
                  palette.colors.map((color) => (
                    <span key={color} className="flex-1" style={{ backgroundColor: color }} />
                  ))
                ) : (
                  <span className="flex flex-1 items-center justify-center bg-gray-0 text-[10px] font-semibold dark:bg-dark-5">
                    Natural
                  </span>
                )}
                {isSelected && (
                  <span className="absolute right-0.5 top-0.5 rounded-full bg-blue-6 p-0.5 text-white">
                    <IconCheck size={10} />
                  </span>
                )}
              </UnstyledButton>
            </Tooltip>
          );
        })}
      </div>
    </Input.Wrapper>
  );
}

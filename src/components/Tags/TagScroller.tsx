import { Button, useComputedColorScheme } from '@mantine/core';

import { TwScrollX } from '~/components/TwScrollX/TwScrollX';

type TagProps = { id: number; name: string };
export function TagScroller({
  data,
  value = [],
  onChange,
}: {
  data?: TagProps[];
  value?: number[];
  onChange?: (value: number[]) => void;
}) {
  const colorScheme = useComputedColorScheme('dark');

  const handleChange = (tagId: number, shouldAdd: boolean) => {
    const tags = [...value];
    const index = tags.findIndex((id) => id === tagId);
    if (shouldAdd) {
      if (index === -1) tags.push(tagId);
      else tags.splice(index, 1);
      onChange?.(tags);
    } else {
      if (index === -1 || tags.length > 1) onChange?.([tagId]);
      else onChange?.([]);
    }
  };

  if (!data?.length) return null;

  return (
    <TwScrollX className="flex gap-1">
      {data.map((tag) => {
        const active = value.includes(tag.id);
        return (
          <Button
            key={tag.id}
            variant={active ? 'filled' : colorScheme === 'dark' ? 'filled' : 'light'}
            color={active ? 'blue' : 'gray'}
            onClick={(e: React.MouseEvent<HTMLButtonElement>) => {
              const shouldAdd = e.ctrlKey;
              handleChange(tag.id, shouldAdd);
            }}
            className="uppercase"
            size="compact-md"
          >
            {tag.name}
          </Button>
        );
      })}
    </TwScrollX>
  );
}

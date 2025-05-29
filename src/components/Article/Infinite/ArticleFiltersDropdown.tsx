import type { ButtonProps } from '@mantine/core';
import { Button, Divider, Drawer, Indicator, Popover, Stack, useComputedColorScheme, useMantineTheme } from '@mantine/core';
import { MetricTimeframe } from '~/shared/utils/prisma/enums';
import { IconFilter } from '@tabler/icons-react';
import { useCallback, useState } from 'react';
import { PeriodFilter } from '~/components/Filters';
import { useIsMobile } from '~/hooks/useIsMobile';
import { useFiltersContext } from '~/providers/FiltersProvider';
import type { ArticleQueryInput } from '~/server/schema/article.schema';
import { FilterButton } from '~/components/Buttons/FilterButton';

export function ArticleFiltersDropdown({ query, onChange, ...buttonProps }: Props) {
  const theme = useMantineTheme();
  const mobile = useIsMobile();
  const colorScheme = useComputedColorScheme('dark');

  const [opened, setOpened] = useState(false);

  const { filters, setFilters } = useFiltersContext((state) => ({
    filters: state.articles,
    setFilters: state.setArticleFilters,
  }));

  const mergedFilters = query || filters;

  const filterLength =
    mergedFilters.period && mergedFilters.period !== MetricTimeframe.AllTime ? 1 : 0;

  const clearFilters = useCallback(() => {
    const reset = {
      followed: false,
      period: MetricTimeframe.AllTime,
    };

    if (onChange) onChange(reset);
    else setFilters(reset);
  }, [onChange, setFilters]);

  const target = (
    <Indicator
      offset={4}
      label={filterLength ? filterLength : undefined}
      size={16}
      zIndex={10}
      disabled={!filterLength}
      processing
      inline
    >
      <FilterButton icon={IconFilter} onClick={() => setOpened((o) => !o)} active={opened}>
        Filters
      </FilterButton>
    </Indicator>
  );

  const dropdown = (
    <Stack gap="lg">
      <Stack gap="md">
        <Divider
          label="Time period"
          styles={{
            label: {
              fontSize: theme.fontSizes.sm,
              fontWeight: 700,
            },
          }}
        />
        {query?.period && onChange ? (
          <PeriodFilter
            type="articles"
            variant="chips"
            value={query.period}
            onChange={(period) => onChange({ period })}
          />
        ) : (
          <PeriodFilter type="articles" variant="chips" />
        )}
      </Stack>
      {filterLength > 0 && (
        <Button
          color="gray"
          variant={colorScheme === 'dark' ? 'filled' : 'light'}
          onClick={clearFilters}
          fullWidth
        >
          Clear all filters
        </Button>
      )}
    </Stack>
  );

  if (mobile)
    return (
      <>
        {target}
        <Drawer
          opened={opened}
          onClose={() => setOpened(false)}
          size="90%"
          position="bottom"
          closeButtonProps={{
            style: {
              height: 32,
              width: 32,
              '& > svg': {
                width: 24,
                height: 24,
              },
            },
          }}
          styles={{
            content: {
              height: 'auto',
              maxHeight: 'calc(100dvh - var(--header-height))',
              overflowY: 'auto',
            },
            body: { padding: 16, paddingTop: 0, overflowY: 'auto' },
            header: { padding: '4px 8px' },
          }}
        >
          {dropdown}
        </Drawer>
      </>
    );

  return (
    <Popover
      zIndex={200}
      position="bottom-end"
      shadow="md"
      radius={12}
      onClose={() => setOpened(false)}
      middlewares={{ flip: true, shift: true }}
    >
      <Popover.Target>{target}</Popover.Target>
      <Popover.Dropdown maw={468} p="md" w="100%">
        {dropdown}
      </Popover.Dropdown>
    </Popover>
  );
}

type Props = Omit<ButtonProps, 'onClick' | 'children' | 'rightIcon'> & {
  query?: Partial<ArticleQueryInput>;
  onChange?: (params: Partial<ArticleQueryInput>) => void;
};

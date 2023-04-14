import { Divider, Stack, Chip, ChipProps, createStyles, MultiSelect, Button } from '@mantine/core';
import { ImageGenerationProcess } from '@prisma/client';
import { FiltersDropdown } from '~/components/Filters/FiltersDropdown';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { useFiltersContext } from '~/providers/FiltersProviderOld';
import { IconFilterOff } from '@tabler/icons';

export function ImageFiltersDropdown() {
  const currentUser = useCurrentUser();
  const { classes, cx } = useStyles();
  // const showNSFWToggle = !currentUser || currentUser.showNsfw;

  const generation = useFiltersContext((state) => state.image.generation) ?? [];
  // const excludedTags = useFiltersContext((state) => state.image.excludedTags) ?? [];
  const setFilters = useFiltersContext((state) => state.setFilters);

  const count = generation.length;

  // const { data: { items: tags } = { items: [] } } = trpc.tag.getAll.useQuery(
  //   { entityType: ['Image'], categories: false, unlisted: false },
  //   { cacheTime: Infinity, staleTime: Infinity }
  // );

  const clearFilters = () => {
    setFilters({
      image: {
        generation: [],
        // excludedTags: [],
      },
    });
  };

  // if (!showNSFWToggle) return null;

  const chipProps: Partial<ChipProps> = {
    radius: 'sm',
    classNames: { label: classes.label, iconWrapper: classes.iconWrapper },
  };

  return (
    <FiltersDropdown count={count}>
      <Stack spacing={4}>
        {/* {showNSFWToggle && (
          <>
            <Divider label="Browsing Mode" labelProps={{ weight: 'bold' }} />
            <BrowsingModeFilter />
          </>
        )} */}
        <Divider label="Generation process" labelProps={{ weight: 'bold' }} />
        <Chip.Group
          spacing={4}
          value={generation}
          onChange={(generation: ImageGenerationProcess[]) => setFilters({ image: { generation } })}
          multiple
        >
          {Object.values(ImageGenerationProcess).map((type, index) => (
            <Chip key={index} value={type} {...chipProps}>
              {type === 'txt2imgHiRes' ? 'txt2img + hi-res' : type}
            </Chip>
          ))}
        </Chip.Group>
        {/* <Divider label="Excluded tags" labelProps={{ weight: 'bold' }} />
        <MultiSelect
          placeholder="Select tags"
          defaultValue={excludedTags.map(String)}
          data={tags.map((tag) => ({ value: tag.id.toString(), label: tag.name }))}
          onChange={(tags) => setFilters({ image: { excludedTags: tags.map(Number) } })}
          nothingFound="No tags found"
          limit={50}
          clearable
          searchable
        /> */}
        {!!count && (
          <Button mt="xs" compact onClick={clearFilters} leftIcon={<IconFilterOff size={20} />}>
            Clear Filters
          </Button>
        )}
      </Stack>
    </FiltersDropdown>
  );
}

const useStyles = createStyles((theme, _params, getRef) => {
  const ref = getRef('iconWrapper');

  return {
    iconWrapper: { ref },
    label: {
      fontSize: 12,
      fontWeight: 500,
      '&[data-checked]': {
        '&, &:hover': {
          backgroundColor: theme.colors.blue[theme.fn.primaryShade()],
          color: theme.white,
        },

        [`& .${ref}`]: {
          color: theme.white,
        },
      },
    },
  };
});

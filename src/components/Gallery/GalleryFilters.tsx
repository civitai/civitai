import {
  ActionIcon,
  Chip,
  ChipProps,
  createStyles,
  Divider,
  Group,
  Indicator,
  Popover,
  Stack,
} from '@mantine/core';
import { MetricTimeframe } from '@prisma/client';
import { IconFilter, IconChevronDown } from '@tabler/icons';
import { deleteCookie } from 'cookies-next';
import { useRouter } from 'next/router';
import z from 'zod';
import create from 'zustand';
import { immer } from 'zustand/middleware/immer';

import { SelectMenu } from '~/components/SelectMenu/SelectMenu';
import { galleryFilterSchema, useCookies } from '~/providers/CookiesProvider';
import { constants } from '~/server/common/constants';
import { ImageResource, ImageSort, ImageType } from '~/server/common/enums';
import { setCookie } from '~/utils/cookies-helpers';
import { splitUppercase } from '~/utils/string-helpers';

const numberType = z.preprocess((arg) => {
  return !!arg ? Number(arg) : undefined;
}, z.number().optional());

const queryStringSchema = z
  .object({
    modelId: numberType,
    modelVersionId: numberType,
    reviewId: numberType,
    userId: numberType,
    infinite: z.preprocess((arg) => {
      return arg === 'false' ? false : true;
    }, z.boolean()),
  })
  .optional();

type QueryFilterProps = z.infer<typeof queryStringSchema>;
type FilterProps = z.input<typeof galleryFilterSchema>;
type Store = {
  filters: FilterProps;
  setSort: (sort?: ImageSort) => void;
  setPeriod: (period?: MetricTimeframe) => void;
  setHideNsfw: (hide?: boolean) => void;
  setTypes: (types?: ImageType[]) => void;
  setResources: (resources?: ImageResource[]) => void;
  setSingleImageModel: (single?: boolean) => void;
  setSingleImageAlbum: (single?: boolean) => void;
};

const useFiltersStore = create<Store>()(
  immer((set) => ({
    filters: {},
    setSort: (sort) => {
      set((state) => {
        state.filters.sort = sort;
        !!sort ? setCookie('g_sort', sort) : deleteCookie('g_sort');
      });
    },
    setPeriod: (period) => {
      set((state) => {
        state.filters.period = period;
        !!period ? setCookie('g_period', period) : deleteCookie('g_period');
      });
    },
    setHideNsfw: (hide) => {
      set((state) => {
        state.filters.hideNSFW = hide;
        hide ? setCookie('g_hideNSFW', hide) : deleteCookie('g_hideNSFW');
      });
    },
    setTypes: (types) => {
      set((state) => {
        state.filters.types = types;
        !!types?.length ? setCookie('g_types', types) : deleteCookie('g_types');
      });
    },
    setResources: (resources) => {
      set((state) => {
        state.filters.resources = resources;
        !!resources?.length ? setCookie('g_resources', resources) : deleteCookie('g_resources');
      });
    },
    setSingleImageModel: (single) => {
      set((state) => {
        state.filters.singleImageModel = single;
        single ? setCookie('g_singleImageModel', single) : deleteCookie('g_singleImageModel');
      });
    },
    setSingleImageAlbum: (single) => {
      set((state) => {
        state.filters.singleImageAlbum = single;
        single ? setCookie('g_singleImageAlbum', single) : deleteCookie('g_singleImageAlbum');
      });
    },
  }))
);

export const useGalleryFilters = (): Partial<QueryFilterProps> & FilterProps => {
  const router = useRouter();
  const limit = constants.imageFilterDefaults.limit;
  const storeFilters = useFiltersStore((state) => state.filters);
  const filters = { ...storeFilters, limit };
  const result = queryStringSchema.safeParse(router.query);
  return result.success ? { ...result.data, ...filters } : filters;
};

const sortOptions = Object.values(ImageSort);
export function GallerySort() {
  const cookies = useCookies().gallery;
  const setSort = useFiltersStore((state) => state.setSort);
  const sort = useFiltersStore(
    (state) => state.filters.sort ?? cookies.sort ?? constants.imageFilterDefaults.sort
  );

  return (
    <SelectMenu
      label={sort}
      options={sortOptions.map((x) => ({ label: x, value: x }))}
      onClick={(sort) => setSort(sort)}
      value={sort}
    />
  );
}

const periodOptions = Object.values(MetricTimeframe);
export function GalleryPeriod() {
  const cookies = useCookies().gallery;
  const setPeriod = useFiltersStore((state) => state.setPeriod);
  const period = useFiltersStore(
    (state) => state.filters.period ?? cookies.period ?? constants.imageFilterDefaults.period
  );

  return (
    <SelectMenu
      label={period && splitUppercase(period.toString())}
      options={periodOptions.map((option) => ({ label: splitUppercase(option), value: option }))}
      onClick={(period) => setPeriod(period)}
      value={period}
    />
  );
}

export function GalleryFilters() {
  const { classes } = useStyles();
  const cookies = useCookies().gallery;
  const setTypes = useFiltersStore((state) => state.setTypes);
  const types = useFiltersStore((state) => state.filters.types ?? cookies.types ?? []);
  const setResources = useFiltersStore((state) => state.setResources);
  const resources = useFiltersStore((state) => state.filters.resources ?? cookies.resources ?? []);
  const setSingleImageModel = useFiltersStore((state) => state.setSingleImageModel);
  const singleImageModel = useFiltersStore(
    (state) => state.filters.singleImageModel ?? cookies.singleImageModel ?? false
  );
  const setSingleImageAlbum = useFiltersStore((state) => state.setSingleImageAlbum);
  const singleImageAlbum = useFiltersStore(
    (state) => state.filters.singleImageAlbum ?? cookies.singleImageAlbum ?? false
  );

  const filterLength =
    types.length + resources.length + (singleImageModel ? 1 : 0) + (singleImageAlbum ? 1 : 0);

  const chipProps: Partial<ChipProps> = {
    radius: 'sm',
    size: 'sm',
    classNames: classes,
  };

  return (
    <Popover withArrow>
      <Popover.Target>
        <Indicator
          offset={4}
          label={filterLength ? filterLength : undefined}
          showZero={false}
          dot={false}
          size={16}
          inline
          zIndex={10}
        >
          <ActionIcon color="dark" variant="transparent" sx={{ width: 40 }}>
            <IconFilter size={20} stroke={2.5} />
            <IconChevronDown size={16} stroke={3} />
          </ActionIcon>
        </Indicator>
      </Popover.Target>
      <Popover.Dropdown maw={350} w="100%">
        <Stack spacing={4}>
          <Divider label="Generation process" labelProps={{ weight: 'bold' }} />
          <Chip.Group
            spacing={4}
            value={types}
            onChange={(types: ImageType[]) => setTypes(types)}
            multiple
            my={4}
          >
            {Object.values(ImageType).map((type, index) => (
              <Chip key={index} value={type} {...chipProps}>
                {type}
              </Chip>
            ))}
          </Chip.Group>
          <Divider label="Include resources" labelProps={{ weight: 'bold' }} />
          <Chip.Group
            spacing={4}
            value={resources}
            onChange={(resources: ImageResource[]) => setResources(resources)}
            my={4}
          >
            {Object.values(ImageResource).map((resource, index) => (
              <Chip key={index} value={resource} {...chipProps}>
                {resource}
              </Chip>
            ))}
          </Chip.Group>
          <Divider label="Show single image" labelProps={{ weight: 'bold' }} />
          <Group spacing={4}>
            <Chip {...chipProps} checked={singleImageModel} onChange={setSingleImageModel}>
              Per model
            </Chip>
            <Chip {...chipProps} checked={singleImageAlbum} onChange={setSingleImageAlbum}>
              Per album
            </Chip>
          </Group>
        </Stack>
      </Popover.Dropdown>
    </Popover>
  );
}

const useStyles = createStyles((theme, _params, getRef) => {
  const ref = getRef('iconWrapper');

  return {
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

    iconWrapper: {
      ref,
    },
  };
});

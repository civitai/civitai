import { Group, Paper, Switch, createStyles, Text, Stack, Checkbox } from '@mantine/core';
import { useQueryHiddenPreferences, useToggleHiddenPreferences } from '~/hooks/hidden-preferences';
import { toggleableBrowsingCategories } from '~/shared/constants/browsingLevel.constants';

const useStyles = createStyles((theme) => ({
  root: {
    ['& > div']: {
      ['&:hover']: {
        background: theme.colorScheme === 'dark' ? theme.colors.dark[6] : theme.colors.gray[2],
        cursor: 'pointer',
      },
      ['&:not(:last-child)']: {
        borderBottom: `1px ${
          theme.colorScheme === 'dark' ? theme.colors.dark[4] : theme.colors.gray[3]
        } solid`,
      },
    },
  },
  active: {
    background: theme.colorScheme === 'dark' ? theme.colors.dark[5] : theme.colors.gray[1],
  },
}));

export function BrowsingCategories() {
  // const { classes, cx } = useStyles();
  const { data, isLoading } = useQueryHiddenPreferences();

  const toggleHiddenTagsMutation = useToggleHiddenPreferences();

  const toggle = (checked: boolean, tags: { id: number; name: string }[]) => {
    if (isLoading) return;
    toggleHiddenTagsMutation.mutate({ data: tags, kind: 'tag', hidden: checked });
  };

  return (
    <Stack>
      {toggleableBrowsingCategories.map((category) => {
        const checked = category.relatedTags.every((tag) =>
          data.hiddenTags.find((hidden) => hidden.id === tag.id)
        );

        return (
          <Checkbox
            key={category.title}
            checked={checked}
            onChange={(e) => toggle(e.target.checked, category.relatedTags)}
            disabled={isLoading}
            label={<Text weight={500}>{category.title}</Text>}
          />
        );
      })}
    </Stack>
  );

  // return (
  //   <Paper p={0} className={classes.root} withBorder>
  //     {toggleableBrowsingCategories.map((category) => {
  //       const checked = category.relatedTags.every((tag) =>
  //         data.hiddenTags.find((hidden) => hidden.id === tag.id)
  //       );

  //       return (
  //         <Group
  //           position="apart"
  //           key={category.title}
  //           className={cx({ [classes.active]: checked })}
  //           py="sm"
  //           px="md"
  //           onClick={() => toggle(!checked, category.relatedTags)}
  //         >
  //           <Text weight={500}>{category.title}</Text>
  //           <Switch
  //             checked={checked}
  //             onChange={(e) => toggle(e.target.checked, category.relatedTags)}
  //             disabled={isLoading}
  //           />
  //         </Group>
  //       );
  //     })}
  //   </Paper>
  // );
}

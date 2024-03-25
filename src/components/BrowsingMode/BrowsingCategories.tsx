import { Checkbox, Group, Paper, Switch, createStyles, Text } from '@mantine/core';
import { useHiddenPreferencesData, useToggleHiddenPreferences } from '~/hooks/hidden-preferences';
import { HiddenTag } from '~/server/services/user-preferences.service';
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
  itemRoot: { padding: 16 },
  itemLabelWrapper: { order: 1, width: '100%' },
  itemTrack: { order: 2 },
  itemBody: { justifyContent: 'space-between' },
}));

export function BrowsingCategories({ variant = 'checkbox' }: Props) {
  const { hiddenTags } = useHiddenPreferencesData();
  const toggleHiddenTagsMutation = useToggleHiddenPreferences();

  const handleToggle = (tags: HiddenTag[]) => (e: React.ChangeEvent<HTMLInputElement>) => {
    toggleHiddenTagsMutation.mutate({ data: tags, kind: 'tag', hidden: e.target.checked });
  };

  return variant === 'checkbox' ? (
    <CheckboxCategories hiddenTags={hiddenTags} onToggle={handleToggle} />
  ) : (
    <SwitchCategories hiddenTags={hiddenTags} onToggle={handleToggle} />
  );
}

type Props = { variant?: 'checkbox' | 'switch' };

const CheckboxCategories = ({ hiddenTags, onToggle }: SwitchProps) => {
  return (
    <Group spacing={8}>
      {toggleableBrowsingCategories.map((category) => {
        const checked = category.relatedTags.every((tag) =>
          hiddenTags.find((hidden) => hidden.id === tag.id)
        );

        return (
          <Checkbox
            key={category.title}
            label={category.description}
            checked={checked}
            onChange={onToggle(category.relatedTags)}
          />
        );
      })}
    </Group>
  );
};

const SwitchCategories = ({ hiddenTags, onToggle }: SwitchProps) => {
  const { classes, cx } = useStyles();

  return (
    <Paper p={0} className={classes.root} withBorder>
      {toggleableBrowsingCategories.map((category) => {
        const checked = category.relatedTags.every((tag) =>
          hiddenTags.find((hidden) => hidden.id === tag.id)
        );

        return (
          <Switch
            key={category.title}
            className={cx({ [classes.active]: checked })}
            classNames={{
              root: classes.itemRoot,
              labelWrapper: classes.itemLabelWrapper,
              track: classes.itemTrack,
              body: classes.itemBody,
            }}
            checked={checked}
            onChange={onToggle(category.relatedTags)}
            label={
              <div>
                <Text size="md" weight={700}>
                  {category.title}
                </Text>
                <Text size="md">{category.description}</Text>
              </div>
            }
          />
        );
      })}
    </Paper>
  );
};

type SwitchProps = {
  hiddenTags: HiddenTag[];
  onToggle: (tags: HiddenTag[]) => (e: React.ChangeEvent<HTMLInputElement>) => void;
};

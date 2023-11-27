import { BoxProps, createStyles } from '@mantine/core';
import { AssistantButton } from '~/components/Assistant/AssistantButton';
import { ScrollArea } from '~/components/ScrollArea/ScrollArea';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';

export function ScrollAreaMain({ children, ...props }: BoxProps) {
  const flags = useFeatureFlags();
  const { classes } = useStyles();

  return (
    <ScrollArea py="md" {...props}>
      {children}
      {flags.assistant && (
        <div className={classes.assistant}>
          <AssistantButton />
        </div>
      )}
    </ScrollArea>
  );
}

const useStyles = createStyles((theme) => ({
  assistant: {
    position: 'sticky',
    bottom: -4,
    left: '100%',
    display: 'inline-block',
    marginRight: theme.spacing.sm,
  },
}));

import { Badge, createStyles, Group, Stack, Text } from '@mantine/core';
import { IconEyeOff } from '@tabler/icons';
import { useState } from 'react';
import { MediaHash, MediaHashProps } from '~/components/ImageHash/ImageHash';

type SensitiveContentProps = {
  children: React.ReactNode;
  count?: number;
} & MediaHashProps &
  React.ComponentPropsWithoutRef<'div'>;

export function SensitiveContent({
  children,
  count,
  hash,
  height,
  width,
  className,
  ...rootProps
}: SensitiveContentProps) {
  const { classes, cx } = useStyles();
  const [show, setShow] = useState(false);

  return (
    <div className={cx(classes.root, className)} {...rootProps}>
      <Group position="apart" className={classes.header} p="md">
        <Badge
          color="red"
          variant="filled"
          size="sm"
          onClick={(e) => {
            e.stopPropagation();
            setShow((value) => !value);
          }}
        >
          {!show ? 'Show' : 'Hide'}
        </Badge>
        {count && (
          <Badge variant="filled" color="gray" size="sm">
            {count}
          </Badge>
        )}
      </Group>

      {show ? (
        children
      ) : (
        <>
          <MediaHash hash={hash} width={width} height={height} />
          <Stack align="center" spacing={0} className={classes.message}>
            <IconEyeOff size={20} color="white" />
            <Text color="white">Sensitive Content</Text>
            <Text size="xs" color="white" align="center">
              This is marked as NSFW
            </Text>
          </Stack>
        </>
      )}
    </div>
  );
}

const useStyles = createStyles((theme) => ({
  root: {
    position: 'relative',
  },
  header: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    zIndex: 10,
  },
  message: {
    position: 'absolute',
    top: '50%',
    left: '50%',
    transform: 'translate(-50%,-50%)',
  },
}));

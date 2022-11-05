import { Badge, Box, createStyles, Group, Stack, Text } from '@mantine/core';
import { IconEyeOff } from '@tabler/icons';
import { useState } from 'react';
import { MediaHash, MediaHashProps } from '~/components/ImageHash/ImageHash';

type ContentShieldProps = {
  children: React.ReactNode;
  count?: number;
  nsfw?: boolean;
  mediaHash?: MediaHashProps;
} & React.ComponentPropsWithoutRef<'div'>;

//TODO - Create a component that does something like this
/*
  export function ContentShield() {
    if(nsfw) return SensitiveContent
    else return children;
  }
  */
export function ContentShield({
  children,
  count,
  mediaHash,
  className,
  nsfw = false,
  ...rootProps
}: ContentShieldProps) {
  const { classes, cx } = useStyles();
  const [isNsfw, setIsNsfw] = useState(nsfw);

  return (
    <div className={cx(classes.root, className)} {...rootProps}>
      {nsfw && (
        <Box p="md" className={classes.show}>
          <Badge
            component="div"
            color="red"
            variant="filled"
            size="sm"
            onClick={(e) => {
              e.stopPropagation();
              setIsNsfw((value) => !value);
            }}
          >
            {isNsfw ? 'Show' : 'Hide'}
          </Badge>
        </Box>
      )}
      {count && (
        <Box p="md" className={classes.count}>
          <Badge variant="filled" color="gray" size="sm">
            {count}
          </Badge>
        </Box>
      )}

      {!isNsfw ? (
        children
      ) : (
        <>
          {mediaHash && <MediaHash {...mediaHash} />}
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
  show: {
    position: 'absolute',
    top: 0,
    left: 0,
    zIndex: 10,
  },
  count: {
    position: 'absolute',
    top: 0,
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

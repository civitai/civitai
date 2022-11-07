import { Badge, BadgeProps, createStyles, Stack, Text } from '@mantine/core';
import { IconEyeOff } from '@tabler/icons';
import React from 'react';
import { useState } from 'react';
import { MediaHash, MediaHashProps } from '~/components/ImageHash/ImageHash';

const SensitiveContentContext = React.createContext<{
  show: boolean;
  setShow: React.Dispatch<React.SetStateAction<boolean>>;
}>({ show: false, setShow: () => undefined });
const useSensitiveContentContext = () => React.useContext(SensitiveContentContext);

type SensitiveContentProps = {
  controls?: React.ReactNode;
  children: React.ReactNode;
  mediaHash?: MediaHashProps;
} & React.ComponentPropsWithoutRef<'div'>;

export const SensitiveContent = ({
  children,
  controls,
  mediaHash,
  className,
  ...rootProps
}: SensitiveContentProps) => {
  const { classes, cx } = useStyles();
  const [show, setShow] = useState(true);

  return (
    <SensitiveContentContext.Provider value={{ show, setShow }}>
      <div className={cx(classes.root, className)} {...rootProps}>
        <div className={classes.controls}>{controls ?? <SensitiveContentToggle m="md" />}</div>
        {!show ? (
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
        ) : (
          children
        )}
      </div>
    </SensitiveContentContext.Provider>
  );
};

type SensitiveContentToggleProps = BadgeProps;
const SensitiveContentToggle = ({ ...props }: SensitiveContentToggleProps) => {
  const { show, setShow } = useSensitiveContentContext();
  return (
    <Badge
      component="div"
      color="red"
      variant="filled"
      size="sm"
      onClick={(e) => {
        e.stopPropagation();
        setShow((value) => !value);
      }}
      {...props}
    >
      {!show ? 'Show' : 'Hide'}
    </Badge>
  );
};

SensitiveContent.Toggle = SensitiveContentToggle;

const useStyles = createStyles((theme) => ({
  root: {
    position: 'relative',
  },
  controls: {
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

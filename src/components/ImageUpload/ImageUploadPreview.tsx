import { forwardRef, CSSProperties, useState } from 'react';
import {
  Alert,
  Center,
  Group,
  Overlay,
  Paper,
  ActionIcon,
  Text,
  Popover,
  Code,
  Stack,
} from '@mantine/core';
import { EdgeMedia } from '~/components/EdgeMedia/EdgeMedia';
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { UniqueIdentifier } from '@dnd-kit/core';
import { IconArrowsMaximize, IconInfoCircle } from '@tabler/icons-react';
import { MediaType } from '~/shared/utils/prisma/enums';
import styles from './ImageUploadPreview.module.scss';

//TODO - handle what to display when there is an error
type Props = {
  image?: CustomFile;
  children?: React.ReactNode;
  isPrimary?: boolean;
  disabled?: boolean;
  id: UniqueIdentifier;
} & React.ComponentPropsWithoutRef<'div'>;

export const ImageUploadPreview = forwardRef<HTMLDivElement, Props>(
  ({ image, children, isPrimary, disabled, id, ...props }, ref) => {
    const [ready, setReady] = useState(false);

    const sortable = useSortable({ id });

    const { attributes, listeners, isDragging, setNodeRef, transform, transition } = sortable;

    const isDisabled = disabled || image?.status === 'blocked';
    const style: CSSProperties = {
      transform: CSS.Transform.toString(transform),
      transition,
      cursor: isDragging ? 'grabbing' : !isDisabled ? 'pointer' : 'auto',
      touchAction: 'none',
    };

    if (!image) return null;

    const isBlocked = image.status === 'blocked';
    const isError = image.status === 'error';

    return (
      <Paper
        ref={setNodeRef}
        className={`${styles.root} ${isBlocked ? styles.error : ''}`}
        data-faded={isDragging}
        data-primary={isPrimary}
        {...props}
        radius="sm"
        style={{ ...style, ...props.style }}
      >
        {!ready && image.previewUrl ? (
          <EdgeMedia
            src={image.previewUrl}
            type={MediaType.image}
            width={450}
            className={styles.image}
          />
        ) : image.url && image.url != image.previewUrl ? (
          <EdgeMedia
            src={image.url}
            type={MediaType.image}
            width={450}
            className={styles.image}
            onLoad={() => {
              image.onLoad?.();
              setReady(true);
            }}
          />
        ) : null}

        {(isBlocked || isError) && (
          <>
            <Overlay color="#000" zIndex={10} />
            <Alert
              variant="filled"
              color="red"
              sx={{
                position: 'absolute',
                bottom: 0,
                left: 0,
                right: 0,
                textAlign: 'center',
                zIndex: 11,
              }}
              radius={0}
            >
              {isBlocked && (
                <Group spacing={4}>
                  <Popover position="top" withinPortal withArrow>
                    <Popover.Target>
                      <ActionIcon>
                        <IconInfoCircle />
                      </ActionIcon>
                    </Popover.Target>
                    <Popover.Dropdown sx={{ maxWidth: 400 }} pb={14}>
                      <Stack spacing={0}>
                        <Text size="xs" weight={500}>
                          Blocked for
                        </Text>
                        <Code color="red">{image.blockedFor?.join(', ')}</Code>
                      </Stack>
                    </Popover.Dropdown>
                  </Popover>
                  <Text>TOS Violation</Text>
                </Group>
              )}
              {isError && <Text>Error</Text>}
            </Alert>
          </>
        )}

        {!isDisabled && (
          <Center className={styles.draggable} {...listeners} {...attributes}>
            <Paper className={styles.draggableIcon} p="xl" radius={100}>
              <IconArrowsMaximize
                size={48}
                stroke={1.5}
                style={{ transform: 'rotate(45deg)' }}
                color="white"
              />
            </Paper>
          </Center>
        )}
        {children}
      </Paper>
    );
  }
);
ImageUploadPreview.displayName = 'ImagePreview';


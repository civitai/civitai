import { Paper, Checkbox, AspectRatio, Card, ActionIcon, Group, Transition } from '@mantine/core';
import { useDisclosure } from '@mantine/hooks';
import {
  IconArrowsShuffle,
  IconBolt,
  IconInfoCircle,
  IconPlayerPlayFilled,
  IconWindowMaximize,
} from '@tabler/icons-react';
import { EdgeImage } from '~/components/EdgeImage/EdgeImage';
import { ImageMetaPopover } from '~/components/ImageMeta/ImageMeta';

/**
 * TODO.generation:
 * - add action to generate image with the same prompt (play icon)
 * - correctly type the image object
 */
export function FeedItem({ image, selected, onCheckboxClick, onCreateVariantClick }: Props) {
  const [opened, { toggle, close }] = useDisclosure();

  return (
    <Paper
      key={image.id}
      radius="sm"
      sx={(theme) => ({
        position: 'relative',
        // If the item is selected, we want to add an overlay to it
        '&::after': selected
          ? {
              content: '""',
              position: 'absolute',
              top: 0,
              left: 0,
              width: '100%',
              height: '100%',
              backgroundColor: theme.fn.rgba(theme.colors.blue[theme.fn.primaryShade()], 0.3),
            }
          : undefined,
      })}
    >
      <AspectRatio ratio={1}>
        <EdgeImage src={image.url} width={image.width} />
      </AspectRatio>
      <Checkbox
        sx={(theme) => ({
          position: 'absolute',
          top: theme.spacing.xs,
          left: theme.spacing.xs,
          zIndex: 1,
        })}
        checked={selected}
        onChange={(event) => {
          onCheckboxClick({ image, checked: event.target.checked });
          close();
        }}
      />
      {!selected && (
        <Group
          position="apart"
          sx={(theme) => ({
            bottom: 0,
            left: 0,
            padding: theme.spacing.xs,
            position: 'absolute',
            width: '100%',
          })}
        >
          <Card p={0} withBorder>
            <Group spacing={0} noWrap>
              <ActionIcon size="md" variant="light" p={4} onClick={toggle}>
                <IconBolt />
              </ActionIcon>
              <Transition mounted={opened} transition="slide-right">
                {(transitionStyles) => (
                  <Group spacing={0} style={transitionStyles} noWrap>
                    <ActionIcon size="md" p={4} variant="light">
                      <IconPlayerPlayFilled />
                    </ActionIcon>
                    <ActionIcon
                      size="md"
                      p={4}
                      variant="light"
                      onClick={() => onCreateVariantClick(image)}
                    >
                      <IconArrowsShuffle />
                    </ActionIcon>
                    <ActionIcon size="md" p={4} variant="light" disabled>
                      <IconWindowMaximize />
                    </ActionIcon>
                  </Group>
                )}
              </Transition>
            </Group>
          </Card>

          <ImageMetaPopover
            meta={image.meta as any}
            generationProcess={image.generationProcess ?? undefined}
          >
            <ActionIcon variant="transparent" size="md">
              <IconInfoCircle
                color="white"
                filter="drop-shadow(1px 1px 2px rgb(0 0 0 / 50%)) drop-shadow(0px 5px 15px rgb(0 0 0 / 60%))"
                opacity={0.8}
                strokeWidth={2.5}
                size={26}
              />
            </ActionIcon>
          </ImageMetaPopover>
        </Group>
      )}
    </Paper>
  );
}

type Props = {
  image: any;
  selected: boolean;
  onCheckboxClick: (data: { image: any; checked: boolean }) => void;
  onCreateVariantClick: (image: any) => void;
};

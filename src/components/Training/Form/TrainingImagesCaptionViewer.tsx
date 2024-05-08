import {
  Accordion,
  ActionIcon,
  Badge,
  Button,
  Chip,
  createStyles,
  Group,
  Menu,
  Paper,
  Stack,
  Text,
  Textarea,
  TextInput,
  useMantineTheme,
} from '@mantine/core';
import { openConfirmModal } from '@mantine/modals';
import {
  IconChevronDown,
  IconPhoto,
  IconPlus,
  IconReplace,
  IconSearch,
  IconTag,
  IconTrash,
  IconX,
} from '@tabler/icons-react';
import React, { useEffect, useState } from 'react';
import { dialogStore } from '~/components/Dialog/dialogStore';
import { TrainingEditTagsModal } from '~/components/Training/Form/TrainingEditTagsModal';
import { blankTagStr, getCaptionAsList } from '~/components/Training/Form/TrainingImages';
import {
  defaultTrainingState,
  getShortNameFromUrl,
  ImageDataType,
  trainingStore,
  useTrainingImageStore,
} from '~/store/training.store';

const useStyles = createStyles((theme) => ({
  tagOverlay: {
    position: 'relative',
    height: 'auto',
    '&:hover button': {
      display: 'flex',
    },
  },
  trash: {
    display: 'none',
    position: 'absolute',
    width: '100%',
    height: '100%',
    top: 0,
    left: 0,
    border: 0,
    borderRadius: '4px',

    backgroundColor: theme.fn.rgba(
      theme.colorScheme === 'dark' ? theme.colors.dark[5] : theme.colors.gray[2],
      0.9
    ),
  },
}));

export const TrainingImagesCaptions = ({
  imgData,
  modelId,
  selectedTags,
}: {
  imgData: ImageDataType;
  modelId: number;
  selectedTags: string[];
}) => {
  const theme = useMantineTheme();
  const { classes } = useStyles();
  const [addCaptionTxt, setAddCaptionTxt] = useState('');

  const { autoCaptioning } = useTrainingImageStore(
    (state) => state[modelId] ?? { ...defaultTrainingState }
  );
  const { updateImage } = trainingStore;

  const tags = getCaptionAsList(imgData.caption);

  const removeCaption = (tagToRemove: string) => {
    const newTags = tags.filter((c) => c !== tagToRemove);

    updateImage(modelId, {
      matcher: getShortNameFromUrl(imgData),
      caption: newTags.join(', '),
    });
  };

  const addCaptions = () => {
    updateImage(modelId, {
      matcher: getShortNameFromUrl(imgData),
      caption: addCaptionTxt,
      appendCaption: true,
    });
  };

  return (
    <Stack spacing="xs">
      <Paper
        h={100}
        // mih="xl"
        // mah={100}
        p={6}
        shadow="xs"
        radius="sm"
        withBorder
        style={{
          backgroundColor:
            theme.colorScheme === 'dark' ? theme.colors.dark[6] : theme.colors.gray[0],
        }}
        sx={{ overflowY: 'auto', scrollbarWidth: 'thin' }}
      >
        {tags.length > 0 ? (
          <Group spacing={8}>
            {tags.map((cap, index) => (
              <Badge
                key={index}
                variant="outline"
                color={selectedTags.includes(cap) ? 'green' : 'gray'}
                px={6}
                className={classes.tagOverlay}
                styles={{
                  inner: {
                    overflow: 'auto',
                    overflowWrap: 'break-word',
                    whiteSpace: 'normal',
                  },
                }}
              >
                <Text>{cap}</Text>
                <ActionIcon
                  disabled={autoCaptioning.isRunning}
                  size={14}
                  variant="transparent"
                  className={classes.trash}
                  onClick={() => removeCaption(cap)}
                >
                  <IconX size={12} />
                </ActionIcon>
              </Badge>
            ))}
          </Group>
        ) : (
          <Text lh={1} py={3} align="center" size="sm" fs="italic">
            No Captions
          </Text>
        )}
      </Paper>

      <Textarea
        placeholder="Add captions..."
        autosize
        disabled={autoCaptioning.isRunning}
        minRows={1}
        maxRows={4}
        value={addCaptionTxt}
        onChange={(event) => {
          setAddCaptionTxt(event.target.value);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            if (!e.shiftKey) {
              e.preventDefault();
              if (!addCaptionTxt.length) return;
              addCaptions();
              setAddCaptionTxt('');
            }
          }
        }}
        styles={{ input: { scrollbarWidth: 'thin' } }}
        rightSectionWidth={52}
        rightSection={
          <ActionIcon
            h="100%"
            onClick={() => {
              if (!addCaptionTxt.length) return;
              addCaptions();
              setAddCaptionTxt('');
            }}
            // disabled={!addCaptionTxt.length}
            sx={{ borderRadius: 0 }}
          >
            <IconPlus />
          </ActionIcon>
        }
      />
    </Stack>
  );
};

export const TrainingImagesCaptionViewer = ({
  selectedTags,
  setSelectedTags,
  modelId,
  numImages,
}: {
  selectedTags: string[];
  setSelectedTags: React.Dispatch<React.SetStateAction<string[]>>;
  modelId: number;
  numImages: number;
}) => {
  const { setImageList } = trainingStore;

  const { imageList } = useTrainingImageStore(
    (state) => state[modelId] ?? { ...defaultTrainingState }
  );

  const [tagSearchInput, setTagSearchInput] = useState<string>('');
  const [tagList, setTagList] = useState<[string, number][]>([]);

  const removeCaptions = (tags: string[]) => {
    const newImageList = imageList.map((i) => {
      const capts = getCaptionAsList(i.caption).filter((c) => !tags.includes(c));
      return { ...i, caption: capts.join(', ') };
    });
    setImageList(modelId, newImageList);
  };

  useEffect(() => {
    const imageTags = imageList
      .flatMap((i) => getCaptionAsList(i.caption))
      .filter((v) => (tagSearchInput.length > 0 ? v.includes(tagSearchInput) : v));
    const tagCounts = imageTags.reduce(
      (a: { [key: string]: number }, c) => (a[c] ? ++a[c] : (a[c] = 1), a),
      {}
    );
    // .reduce((a, c) => (a[c] = a[c] || 0, a[c]++, a), {})
    const sortedTagCounts = Object.entries(tagCounts).sort(([, a], [, b]) => b - a);

    const uncaptionedImages = imageList.filter((i) => getCaptionAsList(i.caption).length === 0);
    if (uncaptionedImages.length && !tagSearchInput.length) {
      setTagList([[blankTagStr, uncaptionedImages.length], ...sortedTagCounts]);
    } else {
      setTagList(sortedTagCounts);
    }

    setSelectedTags((s) =>
      s.filter((st) => (st === blankTagStr ? uncaptionedImages.length > 0 : imageTags.includes(st)))
    );
  }, [imageList, setSelectedTags, tagSearchInput]);

  const selectedTagsNonBlank = selectedTags.filter((st) => st !== blankTagStr);

  return (
    <Accordion variant="contained" transitionDuration={0}>
      <Accordion.Item value="caption-viewer">
        <Accordion.Control>
          <Group spacing="xs">
            <Text>Caption Viewer</Text>
            {selectedTags.length > 0 && (
              <>
                <Badge color="red" leftSection={<IconTag size={14} />}>
                  {selectedTags.length}
                </Badge>
                <Badge color="indigo" leftSection={<IconPhoto size={14} />}>
                  {numImages}
                </Badge>
              </>
            )}
          </Group>
        </Accordion.Control>
        <Accordion.Panel>
          <Stack>
            <Group>
              <TextInput
                icon={<IconSearch size={16} />}
                placeholder="Search tags"
                value={tagSearchInput}
                onChange={(event) => setTagSearchInput(event.currentTarget.value.toLowerCase())}
                style={{ flexGrow: 1 }}
                rightSection={
                  <ActionIcon
                    onClick={() => {
                      setTagSearchInput('');
                    }}
                    disabled={!tagSearchInput.length}
                  >
                    <IconX size={16} />
                  </ActionIcon>
                }
              />
              <Button
                disabled={!selectedTags.length}
                size="sm"
                variant="light"
                color="red"
                onClick={() => setSelectedTags([])}
              >
                Deselect All
              </Button>
              <Menu withArrow>
                <Menu.Target>
                  <Button disabled={!selectedTagsNonBlank.length} rightIcon={<IconChevronDown />}>
                    Actions
                  </Button>
                </Menu.Target>
                <Menu.Dropdown>
                  <Menu.Item
                    icon={<IconTrash size={14} />}
                    onClick={() =>
                      openConfirmModal({
                        title: 'Remove these captions?',
                        children: (
                          <Stack>
                            <Text>The following captions will be removed from all images:</Text>
                            <Group>
                              {selectedTagsNonBlank.map((st) => (
                                <Badge key={st}>{st}</Badge>
                              ))}
                            </Group>
                          </Stack>
                        ),
                        labels: { cancel: 'Cancel', confirm: 'Confirm' },
                        centered: true,
                        onConfirm: () => removeCaptions(selectedTagsNonBlank),
                      })
                    }
                  >
                    {`Remove tag${selectedTagsNonBlank.length === 1 ? '' : 's'} (${
                      selectedTagsNonBlank.length
                    })`}
                  </Menu.Item>
                  <Menu.Item
                    icon={<IconReplace size={14} />}
                    onClick={() =>
                      dialogStore.trigger({
                        component: TrainingEditTagsModal,
                        props: {
                          selectedTags: selectedTagsNonBlank,
                          imageList,
                          modelId: modelId,
                          setImageList,
                          setSelectedTags,
                        },
                      })
                    }
                  >
                    {`Replace tag${selectedTagsNonBlank.length === 1 ? '' : 's'} (${
                      selectedTagsNonBlank.length
                    })`}
                  </Menu.Item>
                </Menu.Dropdown>
              </Menu>
            </Group>
            {!tagList.length ? (
              <Text size="md" my="sm" align="center">
                No captions to display.
              </Text>
            ) : (
              <Chip.Group
                value={selectedTags}
                onChange={setSelectedTags}
                multiple
                mah={300}
                // mih={40}
                // resize: 'vertical'
                style={{ overflowY: 'auto', rowGap: '6px' }}
              >
                {tagList.map((t) => (
                  <Chip
                    key={t[0]}
                    value={t[0]}
                    styles={{
                      root: { lineHeight: 0, overflow: 'hidden' },
                      label: { display: 'flex' },
                      iconWrapper: { overflow: 'initial', paddingRight: '10px' },
                    }}
                  >
                    <Group h="100%" maw="100%">
                      {/* TODO when switching to m7, change this to a class */}
                      <Text
                        style={{
                          maxWidth: '90%',
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                        }}
                      >
                        {t[0] === blankTagStr ? (
                          <Badge color="red" size="sm" radius={0}>
                            None
                          </Badge>
                        ) : (
                          t[0]
                        )}
                      </Text>
                      <Badge color="gray" variant="outline" radius="xl" size="sm">
                        {t[1]}
                      </Badge>
                    </Group>
                  </Chip>
                ))}
              </Chip.Group>
            )}
          </Stack>
        </Accordion.Panel>
      </Accordion.Item>
    </Accordion>
  );
};

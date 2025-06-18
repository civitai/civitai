import type { DragEndEvent } from '@dnd-kit/core';
import { DndContext, PointerSensor, rectIntersection, useSensor, useSensors } from '@dnd-kit/core';
import { SortableContext, arrayMove, rectSortingStrategy } from '@dnd-kit/sortable';
import {
  Center,
  Container,
  Group,
  Loader,
  Text,
  ThemeIcon,
  Stack,
  Title,
  Button,
  Anchor,
  ActionIcon,
  Paper,
  Badge,
} from '@mantine/core';
import { openConfirmModal } from '@mantine/modals';
import { NextLink as Link } from '~/components/NextLink/NextLink';
import { IconCloudOff, IconEdit, IconPlus, IconTrash } from '@tabler/icons-react';
import { indexOf, isEqual } from 'lodash-es';
import { useEffect, useState } from 'react';
import { BackButton } from '~/components/BackButton/BackButton';
import { ContentClamp } from '~/components/ContentClamp/ContentClamp';
import {
  useMutateCosmeticShop,
  useQueryCosmeticShopSections,
} from '~/components/CosmeticShop/cosmetic-shop.util';
import { ImageGuard2 } from '~/components/ImageGuard/ImageGuard2';
import { MediaHash } from '~/components/ImageHash/ImageHash';
import { ImagePreview } from '~/components/ImagePreview/ImagePreview';
import { SortableItem } from '~/components/ImageUpload/SortableItem';
import { Meta } from '~/components/Meta/Meta';
import { ImageCSSAspectRatioWrap } from '~/components/Profile/ImageCSSAspectRatioWrap';
import { RenderHtml } from '~/components/RenderHtml/RenderHtml';
import { constants } from '~/server/common/constants';
import { showSuccessNotification } from '~/utils/notifications';
import { LegacyActionIcon } from '~/components/LegacyActionIcon/LegacyActionIcon';

export default function CosmeticStoreSections() {
  const { cosmeticShopSections, isLoading: isLoadingSections } = useQueryCosmeticShopSections();
  const [sections, setSections] = useState(cosmeticShopSections ?? []);
  const isLoading = isLoadingSections;
  const {
    updateShopSectionsOrder,
    updatingShopSectionsOrder,
    deleteShopSection,
    deletingShopSection,
  } = useMutateCosmeticShop();

  useEffect(() => {
    if (cosmeticShopSections) {
      const ids = cosmeticShopSections.map((section) => section.id);
      const sorted = [...(cosmeticShopSections ?? [])].sort((a, b) => {
        const aUpdatedPlacement = indexOf(ids, a.id);
        const bUpdatedPlacement = indexOf(ids, b.id);

        return aUpdatedPlacement - bUpdatedPlacement;
      });

      setSections(sorted);
    }
  }, [cosmeticShopSections]);

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 8 } }));

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    if (over && active.id !== over.id) {
      setSections((items) => {
        const ids = items.map((item) => item.id);
        const oldIndex = ids.indexOf(active.id as number);
        const newIndex = ids.indexOf(over.id as number);
        const sorted = arrayMove(items, oldIndex, newIndex);
        return sorted;
      });
    }
  };

  const isDirty = !isEqual(
    sections.map((section) => section.id),
    cosmeticShopSections?.map((section) => section.id) ?? []
  );
  const handleReorder = async () => {
    await updateShopSectionsOrder({
      sortedSectionIds: sections.map((section) => section.id),
    });

    showSuccessNotification({ message: 'Your changes have been saved successfuly' });
  };

  const handleDeleteSection = (id: number) => {
    const onDelete = async () => {
      await deleteShopSection({ id });
      showSuccessNotification({ message: 'Your ' });
    };

    openConfirmModal({
      title: 'Delete Shop Section',
      children: (
        <Stack gap={0}>
          <Text size="sm">Are you sure you want to delete this Shop Section?</Text>
          <Text size="xs" c="dimmed">
            Shop items will not be deleted by performing this action.
          </Text>
        </Stack>
      ),
      groupProps: { justify: 'center' },
      labels: { confirm: 'Delete Shop Section', cancel: "No, don't delete it" },
      confirmProps: { color: 'red' },
      onConfirm: () => onDelete(),
    });
  };

  return (
    <>
      <Meta title="Cosmetic Shop Sections" deIndex />
      <Container size="md">
        <Stack gap={0} mb="xl">
          <Group>
            <BackButton url="/moderator/cosmetic-store" />
            <Title order={1}>Cosmetic Shop Sections</Title>
          </Group>
          <Text size="sm" c="dimmed">
            You can add and manage shop sections here. Products must be created before hand. If you
            have not created any product, please go{' '}
            <Anchor component={Link} href="/moderator/cosmetic-store/products">
              here.
            </Anchor>
          </Text>
        </Stack>
        <Group justify="space-between" mb="md">
          <Group align="flex-end">
            <Button component={Link} href="/moderator/cosmetic-store/sections/create" radius="xl">
              <IconPlus />
              Add Section
            </Button>
          </Group>
        </Group>
        {isLoading ? (
          <Center p="xl">
            <Loader />
          </Center>
        ) : cosmeticShopSections?.length ?? 0 ? (
          <Stack>
            <Text>
              Drag and drop sections to re-order them. Click on the section to edit it. Click on the
              trash icon to delete it. This is the order the store will be displayed at.
            </Text>
            <DndContext
              sensors={sensors}
              collisionDetection={rectIntersection}
              onDragEnd={handleDragEnd}
            >
              <SortableContext
                items={sections.map((item) => item.id)}
                strategy={rectSortingStrategy}
              >
                {sections.map((section) => {
                  const image = section.image;
                  return (
                    <SortableItem key={section.id} id={section.id}>
                      <Paper
                        withBorder
                        radius="md"
                        className="relative z-0 min-h-[100px] overflow-hidden text-black dark:text-white"
                        p="md"
                      >
                        {image && (
                          <ImageCSSAspectRatioWrap
                            aspectRatio={constants.cosmeticShop.sectionImageAspectRatio}
                            style={{ borderRadius: 0 }}
                            className="absolute left-1/2 top-1/2 z-[-1] h-auto w-full -translate-x-1/2 -translate-y-1/2 opacity-20"
                          >
                            <ImageGuard2 image={image}>
                              {(safe) => (
                                <>
                                  <ImageGuard2.BlurToggle
                                    className="absolute left-2 top-2 z-10"
                                    sfwClassName="hidden"
                                  />
                                  {!safe ? (
                                    <MediaHash
                                      {...image}
                                      style={{ width: '100%', height: '100%' }}
                                    />
                                  ) : (
                                    <ImagePreview
                                      image={image}
                                      edgeImageProps={{ width: 450 }}
                                      radius="md"
                                      style={{ width: '100%', height: '100%' }}
                                      aspectRatio={0}
                                    />
                                  )}
                                </>
                              )}
                            </ImageGuard2>
                          </ImageCSSAspectRatioWrap>
                        )}
                        <Group justify="space-between" wrap="nowrap" pos="relative">
                          <Stack gap={0}>
                            <Group>
                              <Text size="lg" fw={700}>
                                {section.title}
                              </Text>
                              <Badge>{section._count.items} Items in section</Badge>
                              {!section.published && <Badge color="yellow">Unpublished</Badge>}
                            </Group>
                            {section.description && (
                              <ContentClamp maxHeight={200}>
                                <RenderHtml html={section.description} />
                              </ContentClamp>
                            )}
                          </Stack>
                          <Group>
                            <LegacyActionIcon
                              component={Link}
                              href={`/moderator/cosmetic-store/sections/${section.id}/edit`}
                            >
                              <IconEdit />
                            </LegacyActionIcon>
                            <LegacyActionIcon
                              onClick={() => handleDeleteSection(section.id)}
                              loading={deletingShopSection}
                            >
                              <IconTrash />
                            </LegacyActionIcon>
                          </Group>
                        </Group>
                      </Paper>
                    </SortableItem>
                  );
                })}
              </SortableContext>
            </DndContext>

            <Button disabled={!isDirty} onClick={handleReorder} loading={updatingShopSectionsOrder}>
              Save Changes
            </Button>
          </Stack>
        ) : (
          <Stack align="center">
            <ThemeIcon size={62} radius={100}>
              <IconCloudOff />
            </ThemeIcon>
            <Text align="center">Looks like no shop items have been created yet. Start now!.</Text>
          </Stack>
        )}
      </Container>
    </>
  );
}

import { ActionIcon, Badge, Group, Stack, Text } from '@mantine/core';
import { IconChevronDown, IconFilter, IconPhoto, IconX } from '@tabler/icons-react';
import { useMemo, useState } from 'react';
import { getEdgeUrl } from '~/client-utils/cf-images-utils';
import { refTypeBadge } from '~/components/Comics/comic-project-constants';

export function ImageSelectionSection({
  mentionedReferences,
  selectedImageIds,
  setSelectedImageIds,
  refImageBudget,
}: {
  mentionedReferences: { id: number; name: string; type?: string; images?: any[] }[];
  selectedImageIds: number[] | null;
  setSelectedImageIds: (ids: number[] | null) => void;
  refImageBudget: number;
}) {
  const [collapsedRefs, setCollapsedRefs] = useState<Set<number>>(new Set());

  // Collect all image IDs from mentioned refs
  const allImageIds = useMemo(() => {
    const ids: number[] = [];
    for (const ref of mentionedReferences) {
      for (const ri of ref.images ?? []) {
        if (ri.image?.id) ids.push(ri.image.id);
      }
    }
    return ids;
  }, [mentionedReferences]);

  // Per-reference image ID sets for toggle all
  const refImageIdMap = useMemo(() => {
    const map = new Map<number, number[]>();
    for (const ref of mentionedReferences) {
      map.set(
        ref.id,
        ((ref.images ?? []) as { image: { id: number } }[]).map((ri) => ri.image.id)
      );
    }
    return map;
  }, [mentionedReferences]);

  const effectiveIds = selectedImageIds ?? allImageIds;
  const selectedCount = effectiveIds.length;

  const toggleImage = (imageId: number) => {
    const current = selectedImageIds ?? [...allImageIds];
    if (current.includes(imageId)) {
      if (current.length <= 1) return;
      setSelectedImageIds(current.filter((id) => id !== imageId));
    } else {
      setSelectedImageIds([...current, imageId]);
    }
  };

  const toggleCollapse = (refId: number) => {
    setCollapsedRefs((prev) => {
      const next = new Set(prev);
      if (next.has(refId)) next.delete(refId);
      else next.add(refId);
      return next;
    });
  };

  const toggleAllForRef = (refId: number) => {
    const refImgIds = refImageIdMap.get(refId) ?? [];
    if (refImgIds.length === 0) return;
    const current = selectedImageIds ?? [...allImageIds];
    const allSelected = refImgIds.every((id) => current.includes(id));
    let next: number[];
    if (allSelected) {
      // Deselect all from this ref
      next = current.filter((id) => !refImgIds.includes(id));
    } else {
      // Select all from this ref
      const toAdd = refImgIds.filter((id) => !current.includes(id));
      next = [...current, ...toAdd];
    }
    // Keep at least 1 image selected globally
    if (next.length === 0) return;
    setSelectedImageIds(next);
  };

  const overBudget = selectedCount > refImageBudget;

  return (
    <div
      style={{
        border: '1px solid var(--mantine-color-dark-4)',
        borderRadius: 8,
        padding: '8px 12px',
      }}
    >
      <Group gap={6} mb={6}>
        <IconFilter size={14} style={{ color: '#909296' }} />
        <Text size="sm" fw={500}>
          Select reference images
        </Text>
      </Group>
      <Text size="xs" c="dimmed" mb={8}>
        Generation is limited to {refImageBudget} reference images. Choose which to include.
      </Text>

      <Stack gap="xs">
        {mentionedReferences.map((ref) => {
          const images = (ref.images ?? []) as { image: { id: number; url: string } }[];
          if (images.length === 0) return null;
          const refImgIds = refImageIdMap.get(ref.id) ?? [];
          const selectedInRef = refImgIds.filter((id) => effectiveIds.includes(id)).length;
          const allSelected = selectedInRef === refImgIds.length;
          const collapsed = collapsedRefs.has(ref.id);

          return (
            <div key={ref.id}>
              <Group gap={6} mb={collapsed ? 0 : 4} wrap="nowrap">
                <ActionIcon
                  variant="subtle"
                  color="gray"
                  size="xs"
                  onClick={() => toggleCollapse(ref.id)}
                >
                  <IconChevronDown
                    size={14}
                    style={{
                      transform: collapsed ? 'rotate(-90deg)' : 'none',
                      transition: 'transform 150ms',
                    }}
                  />
                </ActionIcon>
                <Text
                  size="xs"
                  fw={600}
                  style={{ cursor: 'pointer' }}
                  onClick={() => toggleCollapse(ref.id)}
                >
                  {ref.name}
                </Text>
                {ref.type && ref.type !== 'Character' && refTypeBadge[ref.type] && (
                  <Badge size="xs" variant="light" color={refTypeBadge[ref.type].color}>
                    {refTypeBadge[ref.type].label}
                  </Badge>
                )}
                <Text size="xs" c="dimmed">
                  {selectedInRef}/{images.length}
                </Text>
                <ActionIcon
                  variant="subtle"
                  color={allSelected ? 'yellow' : 'gray'}
                  size="xs"
                  title={allSelected ? 'Deselect all' : 'Select all'}
                  onClick={() => toggleAllForRef(ref.id)}
                >
                  {allSelected ? <IconX size={12} /> : <IconPhoto size={12} />}
                </ActionIcon>
              </Group>
              {!collapsed && (
                <Group gap={6} ml={26}>
                  {images.map((ri) => {
                    const checked = effectiveIds.includes(ri.image.id);
                    return (
                      <div
                        key={ri.image.id}
                        onClick={() => toggleImage(ri.image.id)}
                        style={{
                          width: 52,
                          height: 52,
                          borderRadius: 6,
                          overflow: 'hidden',
                          cursor: 'pointer',
                          border: checked
                            ? '2px solid var(--mantine-color-yellow-5)'
                            : '2px solid var(--mantine-color-dark-4)',
                          opacity: checked ? 1 : 0.4,
                          transition: 'opacity 150ms, border-color 150ms',
                        }}
                      >
                        <img
                          src={getEdgeUrl(ri.image.url, { width: 100 }) ?? ri.image.url}
                          alt=""
                          style={{
                            width: '100%',
                            height: '100%',
                            objectFit: 'cover',
                            display: 'block',
                          }}
                        />
                      </div>
                    );
                  })}
                </Group>
              )}
            </div>
          );
        })}
      </Stack>

      <Group justify="space-between" mt={8}>
        <Text size="xs" fw={500} c={overBudget ? 'yellow' : 'dimmed'}>
          {selectedCount} / {refImageBudget} image slots used
        </Text>
        {overBudget && (
          <Text size="xs" c="yellow">
            Exceeds limit — extra images will be truncated
          </Text>
        )}
      </Group>
    </div>
  );
}

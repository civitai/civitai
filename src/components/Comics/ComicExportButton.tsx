import { ActionIcon, Menu, Tooltip } from '@mantine/core';
import { IconDownload, IconFileTypePdf, IconFileZip } from '@tabler/icons-react';
import { useState } from 'react';
import { getEdgeUrl } from '~/client-utils/cf-images-utils';
import { useChapterPermission } from '~/components/Comics/comic-chapter.utils';
import {
  showErrorNotification,
  showSuccessNotification,
} from '~/utils/notifications';

interface ChapterExportButtonProps {
  projectName: string;
  chapterName: string;
  panels: { imageUrl: string | null }[];
}

async function fetchPanelBlobs(panels: { imageUrl: string | null }[]) {
  const results: { blob: Blob; ext: string }[] = [];
  for (const panel of panels) {
    if (!panel.imageUrl) continue;
    const url = getEdgeUrl(panel.imageUrl, { original: true });
    try {
      const response = await fetch(url);
      if (!response.ok) continue;
      const blob = await response.blob();
      const ext = blob.type.includes('png')
        ? 'png'
        : blob.type.includes('webp')
          ? 'webp'
          : 'jpg';
      results.push({ blob, ext });
    } catch {
      // Skip panels that fail to fetch
    }
  }
  return results;
}

async function getSaveAs() {
  const fileSaver = await import('file-saver');
  return fileSaver.saveAs ?? fileSaver.default?.saveAs ?? fileSaver.default;
}

function safeName(name: string) {
  return name
    .replace(/[^a-zA-Z0-9_\- ]/g, '')
    .replace(/\s+/g, '-')
    .toLowerCase();
}

export function ChapterExportButton({
  projectName,
  chapterName,
  panels,
}: ChapterExportButtonProps) {
  const [exporting, setExporting] = useState(false);

  const filename = `${safeName(projectName)}_${safeName(chapterName)}`;

  const handleExportCBZ = async () => {
    try {
      setExporting(true);
      const JSZip = (await import('jszip')).default;
      const saveAs = await getSaveAs();
      const zip = new JSZip();

      const images = await fetchPanelBlobs(panels);
      for (let i = 0; i < images.length; i++) {
        zip.file(`${String(i + 1).padStart(3, '0')}.${images[i].ext}`, images[i].blob);
      }

      const content = await zip.generateAsync({ type: 'blob' });
      saveAs(content, `${filename}.cbz`);
      showSuccessNotification({ message: 'CBZ file downloaded' });
    } catch (err) {
      showErrorNotification({
        title: 'Export failed',
        error: err instanceof Error ? err : new Error('Failed to export CBZ'),
      });
    } finally {
      setExporting(false);
    }
  };

  const handleExportPDF = async () => {
    try {
      setExporting(true);
      const { pdf, Document, Page, Image, StyleSheet } = await import(
        '@react-pdf/renderer'
      );
      const saveAs = await getSaveAs();
      const React = await import('react');

      const styles = StyleSheet.create({
        page: {
          backgroundColor: '#000',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
        },
        panelImage: { objectFit: 'contain', maxWidth: '100%', maxHeight: '100%' },
      });

      // Fetch all images as data URLs for react-pdf
      const dataUrls: string[] = [];
      for (const panel of panels) {
        if (!panel.imageUrl) continue;
        const url = getEdgeUrl(panel.imageUrl, { original: true });
        try {
          const response = await fetch(url);
          if (!response.ok) continue;
          const blob = await response.blob();
          const dataUrl = await new Promise<string>((resolve, reject) => {
            const reader = new FileReader();
            reader.onloadend = () => resolve(reader.result as string);
            reader.onerror = () => reject(new Error('Failed to read image'));
            reader.readAsDataURL(blob);
          });
          dataUrls.push(dataUrl);
        } catch {
          // Skip panels that fail to fetch
        }
      }

      if (dataUrls.length === 0) {
        showErrorNotification({
          title: 'Export failed',
          error: new Error('No panels to export'),
        });
        return;
      }

      const doc = React.createElement(
        Document,
        { title: `${projectName} - ${chapterName}`, author: 'Civitai Comics' },
        ...dataUrls.map((dataUrl, i) =>
          React.createElement(
            Page,
            { key: i, size: 'A4', style: styles.page },
            React.createElement(Image, { src: dataUrl, style: styles.panelImage })
          )
        )
      );

      const blob = await pdf(doc).toBlob();
      saveAs(blob, `${filename}.pdf`);
      showSuccessNotification({ message: 'PDF file downloaded' });
    } catch (err) {
      showErrorNotification({
        title: 'Export failed',
        error: err instanceof Error ? err : new Error('Failed to export PDF'),
      });
    } finally {
      setExporting(false);
    }
  };

  return (
    <Menu position="bottom-end" withinPortal>
      <Menu.Target>
        <Tooltip label={`Download ${chapterName}`}>
          <ActionIcon variant="subtle" color="gray" loading={exporting} size="sm">
            <IconDownload size={16} />
          </ActionIcon>
        </Tooltip>
      </Menu.Target>
      <Menu.Dropdown>
        <Menu.Label>Download as</Menu.Label>
        <Menu.Item
          leftSection={<IconFileTypePdf size={16} />}
          onClick={handleExportPDF}
          disabled={exporting}
        >
          PDF
        </Menu.Item>
        <Menu.Item
          leftSection={<IconFileZip size={16} />}
          onClick={handleExportCBZ}
          disabled={exporting}
        >
          CBZ (Comic Book Archive)
        </Menu.Item>
      </Menu.Dropdown>
    </Menu>
  );
}

/**
 * Permission-aware wrapper — handles EA access checks internally so callers
 * don't need hooks. Renders nothing if the user can't download.
 */
export function ChapterDownloadButton({
  projectName,
  projectUserId,
  chapter,
}: {
  projectName: string;
  projectUserId: number;
  chapter: {
    id: number;
    name: string;
    earlyAccessEndsAt?: Date | string | null;
    panels: { imageUrl: string | null }[];
  };
}) {
  const { canDownload } = useChapterPermission({
    chapterId: chapter.id,
    projectUserId,
    earlyAccessEndsAt: chapter.earlyAccessEndsAt,
  });

  if (!canDownload) return null;

  return (
    <span onClick={(e) => { e.preventDefault(); e.stopPropagation(); }}>
      <ChapterExportButton
        projectName={projectName}
        chapterName={chapter.name}
        panels={chapter.panels}
      />
    </span>
  );
}

import type { ImageOptions } from '@tiptap/extension-image';
import ImageExtension from '@tiptap/extension-image';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import type { ReactNodeViewProps } from '@tiptap/react';
import { NodeViewWrapper, ReactNodeViewRenderer } from '@tiptap/react';
import { Loader } from '@mantine/core';
import { hideNotification, showNotification } from '@mantine/notifications';
import { useEffect, useRef } from 'react';
import { getEdgeUrl, useEdgeUrl } from '~/client-utils/cf-images-utils';
import { useCFImageUpload } from '~/hooks/useCFImageUpload';
import { constants } from '~/server/common/constants';
import { getExtensionsFromMimeTypes, IMAGE_MIME_TYPE } from '~/shared/constants/mime-types';
import { fetchBlobAsFile } from '~/utils/file-utils';
import { formatBytes } from '~/utils/number-helpers';
import { showErrorNotification, showWarningNotification } from '~/utils/notifications';

type CustomImageOptions = ImageOptions & {
  maxFileSize: number;
  accept: string[];
};

const getUploadNotificationId = (url: string) => `upload-image-${url}`;

export const CustomImage = ImageExtension.configure({ inline: true }).extend<CustomImageOptions>({
  draggable: true,

  addOptions() {
    return {
      ...this.parent?.(),
      ...constants.richTextEditor,
      accept: IMAGE_MIME_TYPE,
    } as CustomImageOptions;
  },

  addAttributes() {
    return {
      ...this.parent?.(),
      filename: { default: null },
    };
  },

  addNodeView() {
    return ReactNodeViewRenderer(CustomImageEditComponent, { as: 'span' });
  },

  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: new PluginKey('imageUpload'),
        props: {
          handlePaste: (view, event) => {
            const items = event.clipboardData?.items;
            if (!items) return false;

            let handled = false;
            for (const item of items) {
              if (!this.options.accept.includes(item.type)) continue;

              const file = item.getAsFile();
              if (!file) continue;
              if (file.size > this.options.maxFileSize) {
                showWarningNotification({
                  message: `File is too big. Max file size is ${formatBytes(
                    this.options.maxFileSize
                  )}`,
                });
                continue;
              }

              const blobUrl = URL.createObjectURL(file);
              this.editor.commands.insertContent({
                type: this.name,
                attrs: { src: blobUrl, filename: file.name },
              });
              handled = true;
            }

            return handled;
          },
          handleDrop: (view, event) => {
            const files = event.dataTransfer?.files;
            if (!files) return false;

            for (const file of files) {
              if (!file.type.startsWith('image')) continue;
              if (!this.options.accept.includes(file.type)) {
                showWarningNotification({
                  message: `Unsupported file type. Supported types: ${getExtensionsFromMimeTypes(
                    this.options.accept
                  )}`,
                });
                return false;
              }
              if (file.size > this.options.maxFileSize) {
                showWarningNotification({
                  message: `File is too big. Max file size is ${formatBytes(
                    this.options.maxFileSize
                  )}`,
                });
                return false;
              }

              const blobUrl = URL.createObjectURL(file);
              this.editor.commands.insertContent({
                type: this.name,
                attrs: { src: blobUrl, filename: file.name },
              });
            }

            return true;
          },
        },
      }),
    ];
  },
});

function CustomImageEditComponent({ node, updateAttributes }: ReactNodeViewProps<HTMLElement>) {
  const { src, alt, title, filename } = node.attrs;
  const { uploadToCF } = useCFImageUpload();
  const isBlobUrl = src?.startsWith('blob');
  const uploadingRef = useRef(false);
  const { url: displaySrc } = useEdgeUrl(src, { original: true });

  useEffect(() => {
    if (isBlobUrl && !uploadingRef.current) {
      uploadingRef.current = true;
      const notificationId = getUploadNotificationId(src);
      showNotification({
        id: notificationId,
        loading: true,
        withCloseButton: false,
        autoClose: false,
        message: 'Uploading image...',
      });
      const handleUploadError = () => {
        hideNotification(notificationId);
        URL.revokeObjectURL(src);
        updateAttributes({ src: '' });
        showErrorNotification({
          title: 'Upload Failed',
          error: new Error('Failed to upload image. Please try again'),
        });
      };

      fetchBlobAsFile(src, filename)
        .then((file) => {
          if (!file) return handleUploadError();
          uploadToCF(file)
            .then((result) => {
              URL.revokeObjectURL(src);
              hideNotification(notificationId);
              updateAttributes({ src: getEdgeUrl(result.id, { original: true }) });
            })
            .catch(handleUploadError);
        })
        .catch(handleUploadError);
    }
  }, [src, isBlobUrl]);

  if (!src) return null;

  return (
    <NodeViewWrapper as="span" style={{ display: 'inline-block' }}>
      {isBlobUrl ? (
        <Loader type="dots" />
      ) : (
        // eslint-disable-next-line jsx-a11y/alt-text, @next/next/no-img-element
        <img src={displaySrc} alt={alt} title={title} />
      )}
    </NodeViewWrapper>
  );
}

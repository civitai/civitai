import { Node } from '@tiptap/core';
import type { ReactNodeViewProps } from '@tiptap/react';
import { NodeViewWrapper, ReactNodeViewRenderer, mergeAttributes } from '@tiptap/react';
import { EdgeMedia, EdgeMedia2 } from '~/components/EdgeMedia/EdgeMedia';
import type { MediaType } from '~/shared/utils/prisma/enums';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { formatBytes } from '~/utils/number-helpers';

import { constants } from '~/server/common/constants';
import { useEffect, useRef } from 'react';
import { useCFImageUpload } from '~/hooks/useCFImageUpload';
import { blobToFile, fetchBlobAsFile } from '~/utils/file-utils';
import { Loader } from '@mantine/core';
import { hideNotification, showNotification } from '@mantine/notifications';
import { MEDIA_TYPE } from '~/shared/constants/mime-types';

type NodeOptions = {
  uploadFile: (file: File) => Promise<UploadResult>;
};

interface SetMediaOptions {
  url: string;
  type: MediaType;
  filename?: string;
}

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    media: {
      addMedia: (file: File) => ReturnType;
    };
  }
}

export const EdgeMediaNode = Node.create<NodeOptions>({
  name: 'media',
  atom: true,
  draggable: true,
  group: 'block',

  addAttributes() {
    return {
      url: {
        default: null,
      },
      type: {
        default: null,
      },
      filename: {
        default: null,
      },
    };
  },

  addOptions() {
    return {
      uploadFile: async () => {
        console.warn('"uploadFile" has not been configured in the EdgeMediaNode');
        return {} as UploadResult;
      },
    };
  },

  parseHTML() {
    return [
      {
        tag: 'edge-media',
      },
    ];
  },
  renderHTML({ HTMLAttributes }) {
    return ['edge-media', mergeAttributes(HTMLAttributes)];
  },
  addNodeView() {
    return ReactNodeViewRenderer(EdgeMediaWrapper);
  },
  addCommands() {
    return {
      addMedia:
        (file) =>
        ({ commands }) => {
          return commands.insertContent({
            type: this.name,
            attrs: {
              url: URL.createObjectURL(file),
              type: MEDIA_TYPE[file.type],
              filename: file.name,
            },
          });
        },
    };
  },

  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: new PluginKey('mediaUpload'),
        props: {
          handlePaste: (view, event) => {
            console.log({ event });
            const items = event.clipboardData?.items;
            if (!items) return false;

            for (const item of items) {
              if (!(constants.richTextEditor.accept as string[]).includes(item.type)) return false;

              const file = item.getAsFile();
              if (file) this.editor.commands.addMedia(file);
            }

            return true;
          },
          handleDrop: (view, event) => {
            console.log({ event });
            const files = event.dataTransfer?.files;
            if (!files) return false;

            for (const file of files) {
              this.editor.commands.addMedia(file);
            }
            return true;
          },
        },
      }),
    ];
  },
});

const UPLOAD_NOTIFICATION_ID = 'upload-image-notification';

function EdgeMediaWrapper({
  node,
  selected,
  ref,
  view,
  updateAttributes,
  editor,
}: ReactNodeViewProps<HTMLDivElement>) {
  const { url, type, filename } = node.attrs as SetMediaOptions;
  const { uploadToCF } = useCFImageUpload();
  const isObjectUrl = url?.startsWith('blob');
  const uploadingRef = useRef(false);

  // useEffect(() => console.log({ url }), [url]);

  useEffect(() => {
    if (isObjectUrl && !uploadingRef.current) {
      uploadingRef.current = true;
      showNotification({
        id: UPLOAD_NOTIFICATION_ID,
        loading: true,
        withCloseButton: false,
        autoClose: false,
        message: `Uploading ${type}...`,
      });
      fetchBlobAsFile(url, filename).then((file) => {
        if (!file) return;
        uploadToCF(file)
          .then((result) => {
            updateAttributes({
              url: result.id,
              type,
              filename,
            });
            hideNotification(UPLOAD_NOTIFICATION_ID);
          })
          .catch(() => window.alert(`Failed to upload ${type}. Please try again`));
      });
    }
  }, [url, isObjectUrl]);

  if (!url) return null;

  return (
    <NodeViewWrapper className="edge-media">
      <div ref={ref as any} data-drag-handle>
        {isObjectUrl ? (
          <Loader type="dots" />
        ) : (
          <EdgeMediaNodePreview url={url} type={type} filename={filename} />
        )}
      </div>
    </NodeViewWrapper>
  );
}

export function EdgeMediaNodePreview({ url, type, filename }: SetMediaOptions) {
  return <EdgeMedia2 src={url} type={type} name={filename} />;
}

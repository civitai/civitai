import ImageExtension, { ImageOptions } from '@tiptap/extension-image';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { getEdgeUrl } from '~/client-utils/cf-images-utils';
import { constants } from '~/server/common/constants';
import { formatBytes } from '~/utils/number-helpers';

type CustomImageOptions = ImageOptions & {
  uploadImage: (file: File) => Promise<UploadResult>;
  maxFileSize: number;
  accept: string[];
  onUploadStart?: () => void;
  onUploadEnd?: () => void;
};

export const CustomImage = ImageExtension.extend<CustomImageOptions>({
  draggable: true,
  addOptions() {
    return {
      ...this.parent?.(),
      ...constants.richTextEditor,
    };
  },
  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: new PluginKey('imageUpload'),
        props: {
          handlePaste: (view, event) => {
            const items = event.clipboardData?.items;
            if (!items) return false;

            for (const item of items) {
              if (!this.options.accept.includes(item.type)) return false;

              const file = item.getAsFile();
              if (!file) return false;
              if (file.size > this.options.maxFileSize) {
                window.alert(
                  `File is too big. Max file size is ${formatBytes(this.options.maxFileSize)}`
                );
                return false;
              }

              // TODO.rte: add loading state while uploading

              this.options.onUploadStart?.();
              this.options
                .uploadImage(file)
                .then(({ id }) => {
                  this.options.onUploadEnd?.();
                  // pre-load image
                  const src = getEdgeUrl(id, { width: 525 });
                  const img = new Image();
                  img.src = src;
                  img.onload = () => {
                    const { schema } = view.state;
                    const image = schema.nodes.image.create({ src });
                    const transaction = view.state.tr.replaceSelectionWith(image);
                    return view.dispatch(transaction);
                  };
                })
                .catch(() => window.alert(`Failed to upload image. Please try again`));
            }

            return true;
          },
          handleDrop: (view, event) => {
            const files = event.dataTransfer?.files;
            if (!files) return false;

            for (const file of files) {
              if (!file.type.startsWith('image')) continue;
              if (!this.options.accept.includes(file.type)) {
                window.alert(
                  `Unsupported file type. Supported types: ${this.options.accept.join(', ')}`
                );
                return false;
              }
              if (file.size > this.options.maxFileSize) {
                window.alert(
                  `File is too big. Max file size is ${formatBytes(this.options.maxFileSize)}`
                );
                return false;
              }

              this.options.onUploadStart?.();
              this.options
                .uploadImage(file)
                .then(({ id }) => {
                  this.options.onUploadEnd?.();
                  // pre-load image
                  const src = getEdgeUrl(id, { width: 525 });
                  const img = new Image();
                  img.src = src;
                  img.onload = () => {
                    const { schema } = view.state;
                    const image = schema.nodes.image.create({ src });
                    const transaction = view.state.tr.replaceSelectionWith(image);
                    return view.dispatch(transaction);
                  };
                })
                .catch(() => window.alert(`Failed to upload image. Please try again`));
            }

            return true;
          },
        },
      }),
    ];
  },
});

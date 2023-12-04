import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';
import { FileUpload } from '~/utils/file-upload/file-upload';

/* THIS IS A WORK IN PROGRESS */

type ModelFileUpload = {
  type: 'model';
  modelId: number;
  modelVersionId: number;
  fileUpload: FileUpload;
};

type FileUploadUnion = ModelFileUpload;

type ModelFileUploadState = {
  fileUploads: Array<FileUploadUnion>;
  addFileUpload: (data: FileUploadUnion) => void;
  removeFileUpload: (uuid: string) => void;
};

const useFileUploadStore = create<ModelFileUploadState>()(
  immer((set, get) => {
    const removeFileUpload = (uuid: string) => {
      set((state) => {
        const index = state.fileUploads.findIndex((x) => x.fileUpload.uuid === uuid);
        if (index > -1) state.fileUploads.splice(index, 1);
      });
    };

    const removeOnComplete = (fileUpload: FileUpload) => {
      fileUpload.on('complete', () => removeFileUpload(fileUpload.uuid));
    };

    return {
      fileUploads: [],
      addFileUpload: (data) => {
        removeOnComplete(data.fileUpload);
        set((state) => {
          state.fileUploads.push(data);
        });
      },
      removeFileUpload,
    };
  })
);

const store = useFileUploadStore.getState();
export const fileUploadStore = {
  add: store.addFileUpload,
  remove: store.removeFileUpload,
};

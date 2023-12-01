import { v4 as uuidv4 } from 'uuid';

/* THIS IS A WORK IN PROGRESS */

type EventType = 'progress' | 'complete' | 'abort' | 'error';

export type CustomProgressEvent = {
  progress: number;
  uploaded: number;
  size: number;
  speed: number;
  timeRemaining: number;
};

export type UploadCompleteEvent = {
  url: string;
  key: string;
  bucket: string;
};

type EventTypeArgsMap = {
  progress: CustomProgressEvent;
  complete: UploadCompleteEvent;
  abort?: undefined;
  error?: undefined;
};

export type FileUploadOptions = {
  onComplete?: (args: UploadCompleteEvent) => void;
  onProgress?: (args: CustomProgressEvent) => void;
  onError?: () => void;
  onAbort?: () => void;
};

export class FileUpload extends EventTarget {
  private _uploadProgress = new CustomEvent('upload-progress');
  private _uploadComplete = new CustomEvent('upload-complete');
  private _uploadAbort = new CustomEvent('upload-abort');
  private _uploadError = new CustomEvent('upload-error');

  uuid: string;
  filename: string;
  size: number;

  on<T extends EventType>(type: T, cb: (e: CustomEvent<EventTypeArgsMap[T]>) => void) {
    this.addEventListener(`upload-${type}`, cb as EventListener);
  }

  off<T extends EventType>(type: T, cb: (e: CustomEvent<EventTypeArgsMap[T]>) => void) {
    this.removeEventListener(`upload-${type}`, cb as EventListener);
  }

  abort() {
    console.error('abort is undefined');
  }

  dispatch<T extends EventType>(type: T, detail: EventTypeArgsMap[T]) {
    this.dispatchEvent(new CustomEvent(`upload-${type}`, { detail }));
  }

  constructor(file: File, options?: FileUploadOptions) {
    super();
    this.uuid = uuidv4();
    this.filename = file.name;
    this.size = file.size;

    const { onComplete, onProgress, onError, onAbort } = options ?? {};
    if (onComplete) this.on('complete', ({ detail }) => onComplete(detail));
    if (onProgress) this.on('progress', ({ detail }) => onProgress(detail));
    if (onError) this.on('error', () => onError());
    if (onAbort) this.on('abort', () => onAbort());
  }
}

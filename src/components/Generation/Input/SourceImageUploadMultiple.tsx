import {
  Alert,
  Button,
  TextInput,
  useMantineTheme,
  useComputedColorScheme,
  Text,
  createSafeContext,
  Card,
  ActionIcon,
  Loader,
  Tooltip,
} from '@mantine/core';
import type { Dispatch, DragEvent, SetStateAction } from 'react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  isOrchestratorUrl,
  maxOrchestratorImageFileSize,
  maxUpscaleSize,
  minUploadSize,
} from '~/server/common/constants';
import { withController } from '~/libs/form/hoc/withController';
import { fetchBlobAsFile } from '~/utils/file-utils';
import { SIGN_IN_TO_UPLOAD_MESSAGE, uploadConsumerBlob } from '~/utils/consumer-blob-upload';
import type { SourceImageProps } from '~/server/orchestrator/infrastructure/base.schema';
import {
  ImagePrepError,
  imageToJpegBlob,
  prepStage,
  resizeImage,
} from '~/shared/utils/canvas-utils';
import { getImageDimensions } from '~/utils/image-utils';
import { ExifParser } from '~/utils/metadata';
import clsx from 'clsx';
import { almostEqual, formatBytes } from '~/utils/number-helpers';
import { Dropzone } from '@mantine/dropzone';
import { IMAGE_MIME_TYPE } from '~/shared/constants/mime-types';
import { IconFileSearch, IconPalette, IconPhoto, IconUpload, IconX } from '@tabler/icons-react';
import { getRandomId } from '~/utils/string-helpers';
import { dialogStore } from '~/components/Dialog/dialogStore';
import { ImageCropModal } from '~/components/Generation/Input/ImageCropModal';
import { openSignInToUpload, useSignInToUpload } from '~/components/Login/useSignInToUpload';
import { DrawingEditorModal } from './DrawingEditor/DrawingEditorModal';
import { ImageMetadataModal, type ImageMetadataApply } from './ImageMetadataModal';
import type { DrawingElement, DrawingElementSchema } from './DrawingEditor/drawing.types';
import { create } from 'zustand';
import { isAndroidDevice } from '~/utils/device-helpers';
import { isMobileDevice } from '~/hooks/useIsMobile';
import { sourceMetadataStore, useSourceMetadataStore } from '~/store/source-metadata.store';
import { remixProvenanceStore } from '~/store/remix-provenance.store';
import { recentSourceImagesStore, sourceImageKey } from '~/store/recent-source-images.store';
import { isConsumerBlobUrl } from '~/shared/orchestrator/blob-url';
import {
  extractSourceMetadata,
  extractSourceMetadataFromUrl,
} from '~/utils/metadata/extract-source-metadata';
import { isDefined } from '~/utils/type-guards';
import { reportApplicationError } from '~/utils/application-error';
import { boundedFileFields, splitUnreadablePicks } from '~/utils/unreadable-pick';
import { UnreadablePickAlert } from '~/components/ImageUpload/UnreadablePickAlert';
import { isMediaHost } from '~/shared/utils/media-host';
import { isCivitaiSiteUrl } from '~/utils/civitai-url';
import { env } from '~/env/client';

type AspectRatio = `${number}:${number}`;

/** Tracks original image info for images that have been annotated (drawn on) */
export type ImageAnnotation = {
  originalUrl: string;
  originalWidth: number;
  originalHeight: number;
  compositeUrl: string;
  lines: DrawingElementSchema[];
};

/** Configuration for a single image slot */
export type ImageSlot = {
  /** Label displayed above the slot */
  label: string;
  /** Whether this slot is required */
  required?: boolean;
  /** When true, the slot cannot be interacted with (upload or remove) */
  disabled?: boolean;
};

type SourceImageUploadProps = {
  value?: SourceImageProps[] | null;
  onChange?: (value: SourceImageProps[] | null) => void;
  /**
   * Render function for custom layouts (multi-image mode).
   * If not provided and max=1, uses single-image VideoInput-style layout.
   */
  children?: (previewItems: ImagePreview[]) => React.ReactNode;
  /**
   * Named slots for fixed-position images (e.g., first/last frame).
   * When provided, renders side-by-side dropzones with labels.
   * Value array indices map to slot indices.
   */
  slots?: ImageSlot[];
  max?: number;
  warnOnMissingAiMetadata?: boolean;
  aspect?: 'square' | 'video';
  cropToFirstImage?: boolean;
  aspectRatios?: AspectRatio[];
  error?: string;
  id?: string;
  /** Enable drawing overlay tools */
  enableDrawing?: boolean;
  /** Called when user completes a drawing overlay */
  onDrawingComplete?: (value: SourceImageProps, index: number, elements: DrawingElement[]) => void;
  /** Annotations tracking original images for composites (used for re-editing) */
  annotations?: ImageAnnotation[] | null;
  /** Called when an image is removed (for annotation cleanup) */
  onRemove?: (removedImage: SourceImageProps, index: number) => void;
  /** Whether the input is disabled */
  disabled?: boolean;
  /** Show a per-image action that opens the extracted-metadata modal */
  enableMetadataExtraction?: boolean;
  /** How the form takes prompts pulled out of an image. Omit to make the modal read-only. */
  metadataApply?: ImageMetadataApply;
};

type ImageComplete = {
  status: 'complete';
  url: string;
  width: number;
  height: number;
  id?: string;
  linkToId?: string;
  /** Slot index for slots mode */
  slotIndex?: number;
};

type ImageCrop = { status: 'cropping'; url: string; id: string; slotIndex?: number };

/** `queued`: picked, upload not started yet. `uploading`: in flight. */
type UploadCard = {
  status: 'queued' | 'uploading';
  url: string;
  id: string;
  slotIndex?: number;
};

type ImagePreview =
  | ImageCrop
  | UploadCard
  | {
      status: 'error';
      url: string;
      src: string | Blob | File;
      error: string;
      id: string;
      slotIndex?: number;
    }
  | ImageComplete;

type SourceImageUploadContext = {
  previewItems: ImagePreview[];
  setError: Dispatch<SetStateAction<string | null>>;
  setUploads: Dispatch<SetStateAction<ImagePreview[]>>;
  max: number;
  missingAiMetadata: Record<string, boolean>;
  removeItem: (index: number) => void;
  aspect: 'square' | 'video';
  cropToFirstImage: boolean;
  aspectRatios?: AspectRatio[];
  onChange: (value: (string | File)[]) => void;
  enableDrawing?: boolean;
  handleDrawingUpload: (
    index: number,
    drawingBlob: Blob,
    elements: DrawingElement[]
  ) => Promise<void>;
  annotations?: ImageAnnotation[] | null;
  disabled?: boolean;
  slots?: ImageSlot[];
  /** Upload files or URLs to specific slots (for slots mode) */
  handleSlotUpload?: (entries: { slotIndex: number; src: File | string }[]) => Promise<void>;
  /** Remove image from a specific slot */
  removeSlotItem?: (slotIndex: number) => void;
  enableMetadataExtraction?: boolean;
  metadataApply?: ImageMetadataApply;
};

const [Provider, useContext] = createSafeContext<SourceImageUploadContext>(
  'missing SourceImageUploadContext'
);

/** Opens the extracted-metadata modal for one image. Rendered inside a `relative` preview card. */
function MetadataAction({ url, apply }: { url: string; apply?: ImageMetadataApply }) {
  return (
    <Tooltip label="View image metadata" withinPortal>
      <ActionIcon
        variant="light"
        color="dark"
        size="sm"
        className="absolute left-1 top-1 z-30"
        onClick={() =>
          dialogStore.trigger({
            id: `image-metadata-modal-${url}`,
            component: ImageMetadataModal,
            props: { url, apply },
          })
        }
      >
        <IconFileSearch size={16} />
      </ActionIcon>
    </Tooltip>
  );
}

const iconSize = 18;
const maxSizeFormatted = formatBytes(maxOrchestratorImageFileSize);

const IMAGE_LOAD_ERROR = "Couldn't read this image. Try a different file or a screenshot.";
/** A local preparation step failed: the browser's own text ("failed to load image blob", …) is not shown. */
const IMAGE_PREP_ERROR =
  "Couldn't read this image on your device. Try a different file or a screenshot.";
const IMAGE_PREP_TIMEOUT_ERROR =
  "Couldn't process this image on your device. Try a smaller photo or a screenshot.";
const IMAGE_NETWORK_TIMEOUT_ERROR =
  "Couldn't load this image. Check your connection and try again.";
/** Bound on each local step of preparing a source image (read, decode, encode, metadata). */
export const IMAGE_PREP_STAGE_TIMEOUT_MS = 30_000;

const REPORTED_ERROR_NAMES = [
  'Error',
  'TypeError',
  'DOMException',
  'NotReadableError',
  'EncodingError',
  'NotFoundError',
  'SecurityError',
  'AbortError',
  'TimeoutError',
  'InvalidStateError',
];

type PickedFileInfo = { type: string; size: number };
/** Whether a url was already in the form value, or arrived as a new card. */
type ImageOrigin = 'value' | 'card';

const isRemoteUrl = (src: string | Blob | File) => typeof src === 'string' && /^https?:/i.test(src);

// Order matters: orchestrator hosts also satisfy the image-cdn and site-host checks.
function imageHostClass(url: string) {
  if (isOrchestratorUrl(url)) return 'orchestrator';
  if (isMediaHost(url, env.NEXT_PUBLIC_IMAGE_LOCATION)) return 'image-cdn';
  if (isCivitaiSiteUrl(url)) return 'site-page';
  return 'other';
}

/** The text for a failed preparation step. A remote image that timed out loading is a network problem. */
function prepFailureText(error: ImagePrepError, src: string | Blob | File, otherwise: string) {
  if (!error.timedOut) return otherwise;
  return isRemoteUrl(src) && (error.stage === 'dims' || error.stage === 'read-blob')
    ? IMAGE_NETWORK_TIMEOUT_ERROR
    : IMAGE_PREP_TIMEOUT_ERROR;
}

/**
 * Reports a source image that could not be prepared on the device, with bounded fields only: the
 * stage, where the image came from, a picked file's type (from a short list) and size bucket, the
 * underlying error's name (from a short list), and for a url its origin and a host class from a
 * fixed list. Never a url, file name or error text.
 */
function reportImagePrepFailure(
  error: ImagePrepError,
  src: string | Blob | File,
  file?: PickedFileInfo,
  origin?: ImageOrigin
) {
  const source =
    typeof src !== 'string'
      ? src instanceof File
        ? 'picked-file'
        : 'blob'
      : src.startsWith('blob:')
      ? 'picked-file'
      : src.startsWith('data:')
      ? 'data-url'
      : /^https?:/i.test(src)
      ? 'url'
      : 'other';
  const info = typeof src !== 'string' ? src : file;
  const { type, size } = info ? boundedFileFields(info) : { type: undefined, size: undefined };
  const cause = error.cause;
  const causeName = cause instanceof Error || cause instanceof DOMException ? cause.name : 'Error';
  const errorName = REPORTED_ERROR_NAMES.includes(causeName) ? causeName : 'other';
  const urlFields =
    source === 'url' && typeof src === 'string'
      ? [origin && `origin:${origin}`, `host:${imageHostClass(src)}`]
      : [];
  void reportApplicationError(
    new Error(`source image prep failed: ${error.stage}${error.timedOut ? ':timeout' : ''}`),
    {
      name: 'source-image-prep',
      message: [
        source,
        type,
        size,
        error.timedOut ? undefined : errorName,
        ...urlFields,
        // Whether the Files fallback was offered for it (Android only).
        error.stage === 'pick-unreadable' ? `android:${isAndroidDevice()}` : undefined,
      ]
        .filter(Boolean)
        .join(' '),
      resolveStack: false,
    }
  );
}

export function SourceImageUploadMultiple({
  value: rawValue,
  onChange,
  children,
  slots,
  max = 1,
  warnOnMissingAiMetadata = false,
  aspect = 'square',
  cropToFirstImage = false,
  aspectRatios,
  error: initialError,
  id,
  enableDrawing = false,
  onDrawingComplete,
  annotations,
  onRemove,
  disabled = false,
  enableMetadataExtraction = false,
  metadataApply,
}: SourceImageUploadProps) {
  // Normalize: graph can pass null (e.g. txt2img persisted state) — treat as undefined
  const value = Array.isArray(rawValue) ? rawValue : undefined;
  const theme = useMantineTheme();
  const colorScheme = useComputedColorScheme('dark');
  const isSlotsMode = !!slots?.length;
  const isSingleMode = max === 1 && !children && !isSlotsMode;
  const [uploads, setUploads] = useState<ImagePreview[]>([]);
  const [error, setError] = useState<string | null>(null);
  const { signedOut, requireSignIn } = useSignInToUpload();
  // Set when an image arrived without a user gesture (a data: url in the value) while signed out.
  const [signInRequired, setSignInRequired] = useState(false);
  // Set when picked files could not be read; a slot pick keeps their slots, in pick order, for the
  // Files fallback.
  const [unreadablePick, setUnreadablePick] = useState<{
    count: number;
    slotIndices?: number[];
  } | null>(null);
  // Picks whose files are being probed for readability, before anything is queued for them.
  const [picksProbing, setPicksProbing] = useState(0);
  const [missingAiMetadata, setMissingAiMetadata] = useState<Record<string, boolean>>({});
  const isCroppingRef = useRef(false);
  // Counts crop sessions that ended, so the crop/upload effect can start a card queued while the
  // modal was open, even when the session ended without changing anything else it re-runs on.
  const [cropsEnded, setCropsEnded] = useState(0);
  const endCropping = () => {
    isCroppingRef.current = false;
    setCropsEnded((n) => n + 1);
  };
  // Track which ids/urls this component has marked as uploading/verifying in the
  // global store, so we can force-clear them on unmount. Otherwise a workflow
  // switch that unmounts mid-flight (e.g., img2vid → txt2vid while a slot upload
  // is in progress, or after a crop modal dismiss) leaves the Generate button
  // stuck in its loading state.
  const trackedUploadingIdsRef = useRef(new Set<string>());
  const trackedVerifyingUrlsRef = useRef(new Set<string>());
  // Type and size of picked files by preview url, for the load-failure report only.
  const pickedFilesRef = useRef(new Map<string, PickedFileInfo>());
  const reportedLoadFailuresRef = useRef(new Set<string>());
  // Urls whose dimensions could not be read. They no longer hold back the crop/upload effect, which
  // otherwise waits on every url in play and would never start any other card.
  const [unreadableUrls, setUnreadableUrls] = useState<ReadonlySet<string>>(new Set());
  // Always-current value ref for use in async callbacks to avoid stale closures
  const valueRef = useRef(value);
  valueRef.current = value;

  useEffect(() => {
    const uploadingIds = trackedUploadingIdsRef.current;
    const verifyingUrls = trackedVerifyingUrlsRef.current;
    return () => {
      for (const id of uploadingIds) setImageUploading(id, false);
      for (const url of verifyingUrls) setImageVerifying(url, false);
      uploadingIds.clear();
      verifyingUrls.clear();
    };
  }, []);

  // Remember images that reach value so they can be re-picked from another workflow.
  // Consumer blobs only: blob:/data: previews die with the page, and any other url
  // can neither be refreshed nor confirmed gone, so it would sit in storage forever.
  // Recorded once per image per mount so a re-render doesn't churn the store.
  const recordedKeysRef = useRef(new Set<string>());
  useEffect(() => {
    const fresh = (value ?? []).filter(
      (img) =>
        img?.url &&
        img.width &&
        img.height &&
        isConsumerBlobUrl(img.url) &&
        !recordedKeysRef.current.has(sourceImageKey(img.url))
    );
    if (!fresh.length) return;
    for (const img of fresh) recordedKeysRef.current.add(sourceImageKey(img.url));
    recentSourceImagesStore.record(fresh.map(({ url, width, height }) => ({ url, width, height })));
  }, [value]);

  const previewImages = useMemo(() => {
    if (!value) return [];
    const images: ImageComplete[] = value.map((val) => ({ status: 'complete', ...val }));
    for (const item of uploads.filter(
      (x) => x.status === 'complete' || x.status === 'cropping'
    ) as ImageComplete[]) {
      const lastIndex = images.findLastIndex((x) => x.url === item.url && !x.linkToId);
      if (lastIndex > -1) images[lastIndex].linkToId = item.id;
    }
    return images;
  }, [value, uploads]);

  // Build previewItems deterministically: for each value entry, show the
  // associated upload in place if a matching cropping/complete upload exists.
  //  - 'cropping' substitution hides the original behind the loading card while
  //    a re-crop is in progress (Kling → Veo3 workflow switch flow).
  //  - 'complete' substitution dedupes the upload entry against the value entry
  //    once the upload finishes and the orchestrator URL has been written into
  //    value, so we don't render two cards for the same image.
  //  - 'uploading' uploads are NOT substituted: slots mode eagerly writes
  //    value[slot]=blobUrl before its uploads finish, and substituting would
  //    cause the handle-update-value effect to see completed.length=0 and
  //    clear the eager value back to empty.
  // Anything not consumed by substitution is appended as an orphan card —
  // covers new in-progress uploads (non-slot dropzone), errored uploads, and
  // value entries with no matching upload.
  const previewItems = useMemo<ImagePreview[]>(() => {
    const items: ImagePreview[] = [];
    const consumedUploadIds = new Set<string>();

    // Narrow to a tuple with a definitely-present id so TS is happy downstream.
    type IdentifiedUpload = ImagePreview & { id: string };
    const substitutableByUrl = new Map<string, IdentifiedUpload>();
    for (const item of uploads) {
      if (
        item.id &&
        (item.status === 'complete' || item.status === 'cropping') &&
        !substitutableByUrl.has(item.url)
      ) {
        substitutableByUrl.set(item.url, item as IdentifiedUpload);
      }
    }

    for (const val of value ?? []) {
      const upload = substitutableByUrl.get(val.url);
      if (upload && !consumedUploadIds.has(upload.id)) {
        items.push(upload);
        consumedUploadIds.add(upload.id);
      } else {
        items.push({ status: 'complete', ...val });
      }
    }

    for (const item of uploads) {
      if (!item.id || !consumedUploadIds.has(item.id)) items.push(item);
    }

    return items;
  }, [value, uploads]);

  useEffect(() => {
    if (uploads.length > 0 && uploads.every((x) => x.status === 'complete')) setUploads([]);
  }, [uploads]);

  const getShouldCrop = useCallback(
    (previewImages: { width: number; height: number }[]) => {
      if (!previewImages.length) return false;
      if (cropToFirstImage) {
        const { width, height } = previewImages[0];
        const ratio = width / height;
        const allMatch = previewImages.every(({ width, height }) =>
          almostEqual(ratio, width / height, 0.01)
        );
        return !allMatch;
      } else if (!!aspectRatios?.length) {
        const ratios = aspectRatios.map((ratio) => {
          const [w, h] = ratio.split(':').map(Number);
          return w / h;
        });
        // All images must share the same allowed aspect ratio
        const allSameAllowedRatio = ratios.some((r) =>
          previewImages.every(({ width, height }) => almostEqual(r, width / height, 0.01))
        );
        return !allSameAllowedRatio;
      }
      return false;
    },
    [cropToFirstImage, aspectRatios]
  );

  // Queued and in-flight cards for the crop/upload effect (exclude slot uploads —
  // those are managed by handleSlotUpload's own flow)
  const pendingUploads = useMemo(
    () =>
      uploads.filter(
        (u): u is UploadCard =>
          (u.status === 'queued' || u.status === 'uploading') && u.slotIndex === undefined
      ),
    [uploads]
  );
  const pendingUploadUrls = useMemo(() => pendingUploads.map((u) => u.url), [pendingUploads]);
  const queuedCardIds = pendingUploads
    .filter((u) => u.status === 'queued')
    .map((u) => u.id)
    .join(',');
  // Only while cards wait: a crop session ending with none queued must not re-run the effect, or a
  // cancelled re-crop of the value's own images would reopen the modal straight away.
  const cropEndedWithQueued = queuedCardIds ? cropsEnded : 0;

  // Holds the generator from the pick until the image is in the value, under one key per mount that
  // no upload id can take. The per-upload marker set inside uploadOrchestratorImage starts after an
  // await and ends before the value write, and each gap reads as "nothing pending" (the cost box
  // flickers to its idle state). It starts at the pick itself: while a pick's files are probed for
  // readability (card or slot) nothing is in `uploads` yet, so `picksProbing` covers that window,
  // and the probe's end and the first `uploads` write land in one render. Otherwise derived from
  // card `uploads`, so every way a card stops being pending — in the value, errored, removed, crop
  // cancelled, unreadable — releases it; unmount clears it below.
  const cardsPendingKey = useMemo(() => `cards:${getRandomId()}`, []);
  const cardsPending =
    picksProbing > 0 ||
    uploads.some(
      (u) =>
        u.slotIndex === undefined &&
        (u.status === 'queued' ||
          u.status === 'uploading' ||
          u.status === 'cropping' ||
          (u.status === 'complete' && !value?.some((v) => v.url === u.url)))
    );
  useEffect(() => {
    setImageUploading(cardsPendingKey, cardsPending);
    if (cardsPending) trackedUploadingIdsRef.current.add(cardsPendingKey);
    else trackedUploadingIdsRef.current.delete(cardsPendingKey);
  }, [cardsPending, cardsPendingKey]);

  // All image URLs currently in play (value + pending uploads)
  const allImageUrls = useMemo(
    () => [...(value?.map((v) => v.url) ?? []), ...pendingUploadUrls],
    [value, pendingUploadUrls]
  );

  // Reactive: re-evaluates when sourceMetadataStore updates (e.g., after dim resolution)
  const allDimsResolved = useSourceMetadataStore(
    (state) =>
      allImageUrls.length > 0 &&
      allImageUrls.every((url) => {
        const meta = state.metadataByUrl[url];
        return (meta?.width && meta?.height) || unreadableUrls.has(url);
      })
  );

  // Crop analysis & upload effect:
  // Once all images have dimensions resolved, check if cropping is needed.
  // If no crop needed, trigger upload for pending images.
  // If crop needed, open crop modal.
  // Also handles existing value images that need re-cropping (e.g., after page refresh).
  useEffect(() => {
    if (isCroppingRef.current) return;
    if (!allDimsResolved) return;

    // Build dimensioned image list for crop check
    const allImages = allImageUrls.flatMap((url) => {
      const fromValue = value?.find((v) => v.url === url);
      if (fromValue?.width && fromValue?.height) return [fromValue];
      const meta = sourceMetadataStore.getMetadata(url);
      // An unreadable url has no dimensions to check against.
      return meta?.width && meta?.height ? [{ url, width: meta.width, height: meta.height }] : [];
    });

    if (!getShouldCrop(allImages)) {
      // No crop needed — start the queued cards. In-flight ones are already started.
      for (const card of pendingUploads) if (card.status === 'queued') handleUpload(card);
    } else {
      // Crop needed — open crop modal with all dimensioned images
      const withAspectRatio = allImages.map((img) => ({
        ...img,
        aspectRatio: img.width / img.height,
      }));
      openCropModal(withAspectRatio, pendingUploads);
    }
    // Keyed on the queued cards too: a card queued for a url already in play (a data: url swapped
    // out of the value for its upload) changes neither the url count nor dimension readiness.
  }, [allDimsResolved, allImageUrls.length, getShouldCrop, queuedCardIds, cropEndedWithQueued]); // eslint-disable-line react-hooks/exhaustive-deps

  function removeItem(index: number) {
    const item = previewItems[index];

    // Call onRemove callback if this is a complete image (for annotation cleanup)
    if (item.status === 'complete') {
      onRemove?.({ url: item.url, width: item.width, height: item.height }, index);
      // Remove source metadata from store
      sourceMetadataStore.removeMetadata(item.url);
    }

    if (item.id) {
      setImageUploading(item.id, false);
      setUploads((state) => state.filter((x) => x.id !== item.id));
      const linkedIdIndex = previewImages?.findIndex((x) => x.linkToId === item.id);
      if (value && linkedIdIndex > -1) {
        const copy = [...value];
        copy.splice(linkedIdIndex, 1);
        onChange?.(copy);
      }
    } else if (value) {
      const copy = [...value];
      copy.splice(index, 1);
      onChange?.(copy);
    }
  }

  // handle update value
  useEffect(() => {
    if (isCroppingRef.current) return;
    const completed = previewItems.filter((x) => x.status === 'complete') as ImageComplete[];
    if (!completed.length) onChange?.(null);
    else if (completed.length !== value?.length) {
      onChange?.(
        completed.map(({ url, width, height }) => ({ url, width, height })) as SourceImageProps[]
      );
    }
  }, [previewItems]);

  // handle missing ai metadata
  useEffect(() => {
    if (warnOnMissingAiMetadata && value) {
      for (const { url } of value) {
        if (!missingAiMetadata[url]) {
          fetchBlobAsFile(url).then(async (file) => {
            if (file) {
              const parser = await ExifParser(file);
              const meta = await parser.getMetadata();
              setMissingAiMetadata((state) => ({
                ...state,
                [url]: !Object.keys(meta).length && !parser.isMadeOnSite(),
              }));
            }
          });
        }
      }
    }
  }, [value, warnOnMissingAiMetadata]);

  // Resolve dimensions for any image (from value or uploads) missing dims in sourceMetadataStore.
  // Caches results via setMetadata which triggers useSourceMetadataStore subscribers.
  // Also corrects value entries that have missing/wrong dimensions.
  useEffect(() => {
    // Collect all image URLs from value + pending uploads
    const valueUrls = value?.map((v) => v.url) ?? [];
    const uploadUrls = uploads
      .filter((u) => u.status === 'queued' || u.status === 'uploading')
      .map((u) => u.url);
    const allUrls = [...valueUrls, ...uploadUrls];

    // Read any url without cached dimensions, unless a read of it is already in flight. Keyed on
    // the cache rather than on "read once": an entry the store evicts must be read again, or the
    // crop/upload effect waits on it forever and no new card starts.
    const unresolved = allUrls.filter((url) => {
      if (trackedVerifyingUrlsRef.current.has(url)) return false;
      const cached = sourceMetadataStore.getMetadata(url);
      return !cached?.width || !cached?.height;
    });

    if (!unresolved.length) return;

    // Track verifying state so FormFooter can show loading
    for (const url of unresolved) {
      setImageVerifying(url, true);
      trackedVerifyingUrlsRef.current.add(url);
    }

    const snapshot = value;
    const failures = new Map<string, ImagePrepError>();
    Promise.all(
      unresolved.map((url) =>
        prepStage(
          'dims',
          () => getImageDimensions(url, { loadRetries: 2 }),
          IMAGE_PREP_STAGE_TIMEOUT_MS
        )
          .then(({ width, height }) => ({ url, width, height }))
          .catch((e: ImagePrepError) => {
            // Nothing is cached for a failed load, so it is retried on the next change; otherwise
            // the dimensions it was meant to correct are submitted as-is for the life of this mount.
            failures.set(url, e);
            return null;
          })
          .finally(() => {
            setImageVerifying(url, false);
            trackedVerifyingUrlsRef.current.delete(url);
          })
      )
    ).then((results) => {
      const verified = results.filter(
        (r): r is { url: string; width: number; height: number } => r !== null
      );

      // A url the browser cannot read never gets dimensions, so its queued cards would never
      // start: end them on an error the user can act on. The url stays retryable (above).
      const unreadable = new Set(failures.keys());
      for (const [url, error] of failures) {
        // Once per url: a url already in the value is retried on every change.
        if (reportedLoadFailuresRef.current.has(url)) continue;
        reportedLoadFailuresRef.current.add(url);
        const origin = snapshot?.some((v) => v.url === url) ? 'value' : 'card';
        reportImagePrepFailure(error, url, pickedFilesRef.current.get(url), origin);
      }
      if (unreadable.size) {
        // Only when a queued card is affected: a new array re-runs this effect, which retries the
        // url, which would fail again, without end, for an unreadable image already in the value.
        setUploads((items) => {
          let changed = false;
          const next = items.map((x): ImagePreview => {
            if (x.status !== 'queued' || x.slotIndex !== undefined) return x;
            const error = failures.get(x.url);
            if (!error) return x;
            changed = true;
            const message = prepFailureText(error, x.url, IMAGE_LOAD_ERROR);
            return { status: 'error', url: x.url, src: x.url, error: message, id: x.id };
          });
          return changed ? next : items;
        });
      }
      setUnreadableUrls((prev) => {
        const next = new Set(prev);
        for (const url of unreadable) next.add(url);
        for (const { url } of verified) next.delete(url);
        return next.size === prev.size && [...next].every((u) => prev.has(u)) ? prev : next;
      });

      // Cache verified dims in the store
      for (const { url, width, height } of verified) {
        sourceMetadataStore.setMetadata(url, { width, height });
      }

      // Correct value entries that have missing/wrong dimensions
      if (snapshot?.length) {
        const corrections = verified.filter((r) => {
          const orig = snapshot.find((v) => v.url === r.url);
          return orig && (orig.width !== r.width || orig.height !== r.height);
        });
        if (corrections.length) {
          onChange?.(
            snapshot.map((img) => {
              const fix = corrections.find((c) => c.url === img.url);
              return fix ? { ...img, width: fix.width, height: fix.height } : img;
            })
          );
        }
      }
    });
  }, [value, uploads]); // eslint-disable-line react-hooks/exhaustive-deps

  // Extract generation metadata for images we haven't tried yet. Use the `exifExtracted`
  // sentinel on the store entry (persisted to sessionStorage) so we don't refetch+reparse
  // across remounts/navigation. Checking the store for `params/resources` alone wouldn't
  // work — the dimension-resolution effect above writes dim-only entries, and images
  // without generation EXIF would re-trigger extraction on every value change.
  useEffect(() => {
    if (!value?.length) return;
    for (const { url } of value) {
      if (sourceMetadataStore.getMetadata(url)?.exifExtracted) continue;
      extractSourceMetadataFromUrl(url).then((metadata) => {
        sourceMetadataStore.setMetadata(url, { ...(metadata ?? {}), exifExtracted: true });
      });
    }
  }, [value]);

  // Auto-upload data: URLs (e.g., base64 from metadata extraction)
  // Treat them as if they were dropped in the dropzone.
  const processedDataUrls = useRef(new Set<string>());
  useEffect(() => {
    if (!value) return;
    const dataUrlItems = value.filter(
      (v) => v.url.startsWith('data:') && !processedDataUrls.current.has(v.url)
    );
    if (dataUrlItems.length === 0) return;

    // Mark as processed so we don't re-trigger
    for (const item of dataUrlItems) processedDataUrls.current.add(item.url);

    // Remove data: URLs from value and feed them through the upload pipeline
    const remaining = value.filter((v) => !v.url.startsWith('data:'));
    onChange?.(remaining.length > 0 ? remaining : null);
    handleChange(
      dataUrlItems.map((v) => v.url),
      { userStarted: false }
    );
  }, [value]); // eslint-disable-line react-hooks/exhaustive-deps

  // TODO - better error messaging

  const imagesMissingMetadataCount = previewImages.filter((x) => missingAiMetadata[x.url]).length;
  const _error = initialError ?? error;

  // Starts a queued card. Every update finds the card by id: two cards can share a url.
  async function handleUpload({ id, url }: UploadCard) {
    // Both updates return the same array when the card is not in the expected state (removed, or
    // already moved on), so they never hand the effects keyed on `uploads` a change that isn't one.
    setUploads((items) =>
      items.some((x) => x.id === id && x.status === 'queued')
        ? items.map((x) =>
            x.id === id && x.status === 'queued' ? { ...x, status: 'uploading' as const } : x
          )
        : items
    );
    // uploadOrchestratorImage marks `id` itself; tracked so an unmount mid-upload clears it too.
    trackedUploadingIdsRef.current.add(id);
    const response = await uploadOrchestratorImage(url, id, undefined, {
      file: pickedFilesRef.current.get(url),
      origin: 'card',
    });
    trackedUploadingIdsRef.current.delete(id);
    setUploads((items) => {
      if (!items.some((x) => x.id === id && x.status === 'uploading')) return items;
      return items.map((x): ImagePreview => {
        if (x.id !== id || x.status !== 'uploading') return x;
        if (response.blockedReason || !response.available || !response.url)
          return {
            status: 'error',
            url,
            src: url,
            error: response.blockedReason ?? 'Unexpected image upload error',
            id,
          };
        return {
          status: 'complete',
          url: response.url,
          width: response.width,
          height: response.height,
          id,
        };
      });
    });
  }

  // Open crop modal with already-dimensioned images. pending are the cards that
  // need orchestrator upload: non-slot picks, which are not in value until their
  // upload lands. In slots mode it is empty (slot picks go through handleSlotUpload).
  function openCropModal(
    images: { url: string; width: number; height: number; aspectRatio: number }[],
    pending: UploadCard[]
  ) {
    isCroppingRef.current = true;
    const pendingUrlSet = new Set(pending.map((u) => u.url));
    // Cleared from the uploading markers when the crop modal confirms/cancels
    const earlyUploadIds = pending.map((u) => u.id);
    const isPendingCard = (x: ImagePreview) => !!x.id && earlyUploadIds.includes(x.id);

    function cancelCrop() {
      // Clear early uploading markers
      for (const id of earlyUploadIds) {
        setImageUploading(id, false);
        trackedUploadingIdsRef.current.delete(id);
      }

      // Remove pending upload indicators
      setUploads((prev) => prev.filter((x) => !isPendingCard(x)));

      // Remove the pending URLs from value
      const latest = valueRef.current;
      if (latest) {
        const reverted = latest.filter((img) => !pendingUrlSet.has(img.url));
        onChange?.(reverted.length > 0 ? reverted : null);
      }

      endCropping();
    }

    dialogStore.trigger({
      id: 'image-crop-modal',
      component: ImageCropModal,
      props: {
        images,
        onConfirm: async (output) => {
          // Clear early uploading markers — new upload IDs take over below
          for (const id of earlyUploadIds) {
            setImageUploading(id, false);
            trackedUploadingIdsRef.current.delete(id);
          }

          // Determine what needs uploading:
          // - Cropped images always need upload
          // - Uncropped images that aren't orchestrator URLs need upload
          // - Uncropped orchestrator URLs stay as-is
          const toUpload: {
            index: number;
            src: Blob | string;
            originalUrl: string;
            id: string;
          }[] = [];

          for (let i = 0; i < output.length; i++) {
            const { cropped, src } = output[i];
            if (cropped) {
              toUpload.push({ index: i, src: cropped, originalUrl: src, id: getRandomId() });
            } else if (!isOrchestratorUrl(src)) {
              toUpload.push({ index: i, src, originalUrl: src, id: getRandomId() });
            }
          }

          // A crop of an image already in the value can open without a pick, so this confirm can be
          // the first upload a signed-out user starts.
          if (toUpload.length && requireSignIn()) return cancelCrop();

          if (toUpload.length) {
            // Show cropping indicators, preserving any unrelated uploads.
            // Status 'cropping' (rather than 'uploading') so previewImages links
            // these entries to the matching value image by URL — this hides the
            // original image behind the loading card instead of rendering both.
            setUploads((prev) => [
              ...prev.filter((x) => !isPendingCard(x)),
              ...toUpload.map(({ id, index, originalUrl }) => ({
                status: 'cropping' as const,
                url: originalUrl,
                id,
                slotIndex: isSlotsMode ? index : undefined,
              })),
            ]);

            // Upload in parallel, collect results, and apply a single onChange at
            // the end. Per-upload onChanges would race: concurrent callbacks read
            // a stale valueRef before React has committed the previous update.
            // Flushing once after Promise.all reads the fully-settled value once.
            // We also defer the setUploads cleanup to a single atomic call after
            // onChange, so the cropping cards stay in place until the new value
            // lands — otherwise per-upload cleanup would briefly unhide the
            // original value image behind each linked cropping card as its entry
            // is removed before the batched value swap.
            const toUploadIds = new Set(toUpload.map((u) => u.id));
            let failure: string | undefined;
            const uploadResults = await Promise.all(
              toUpload.map(async ({ src, id, originalUrl }) => {
                const origin = valueRef.current?.some((v) => v.url === originalUrl)
                  ? 'value'
                  : 'card';
                const response = await uploadOrchestratorImage(src, id, originalUrl, { origin });
                if (response.url && response.available) {
                  return {
                    originalUrl,
                    result: {
                      url: response.url,
                      width: response.width,
                      height: response.height,
                    },
                  };
                }
                failure ??= response.blockedReason ?? 'Unexpected image upload error';
                return null;
              })
            );
            // The cropping cards are cleared below, so a failure has to be reported here.
            if (failure) setError(failure);

            const successful = uploadResults.filter(isDefined);
            if (successful.length > 0) {
              // Preload all result URLs in parallel before committing the swap,
              // so when the cropping cards flip to the new images they render
              // immediately from the browser cache instead of popping in one by
              // one as each orchestrator fetch lands.
              await Promise.all(
                successful.map(
                  ({ result }) =>
                    new Promise<void>((resolve) => {
                      const img = new Image();
                      img.onload = () => resolve();
                      img.onerror = () => resolve();
                      img.src = result.url;
                    })
                )
              );

              // Swap in slots/re-crop mode (originalUrl already in value), append
              // otherwise (non-slot new uploads whose previewUrl wasn't in value).
              const next = [...(valueRef.current ?? [])];
              for (const { originalUrl, result } of successful) {
                const idx = next.findIndex((img) => img.url === originalUrl);
                if (idx >= 0) next[idx] = result;
                else next.push(result);
              }
              onChange?.(next);
            }
            // Clear all cropping entries in one go after the value swap has been
            // emitted. Any entries that errored out are also removed here.
            setUploads((prev) => prev.filter((x) => !x.id || !toUploadIds.has(x.id)));

            endCropping();
          } else {
            // Nothing to upload: every image came back uncropped and is already an orchestrator
            // url. Pending picks go into the value as they are (what the no-crop path does for the
            // same url), and their cards are cleared rather than left queued with nothing to start
            // them, which would hold the generator.
            const latest = valueRef.current ?? [];
            const ready = images
              .filter((img) => pendingUrlSet.has(img.url) && !latest.some((v) => v.url === img.url))
              .map(({ url, width, height }) => ({ url, width, height }));
            if (ready.length) onChange?.([...latest, ...ready]);
            setUploads((prev) => prev.filter((x) => !isPendingCard(x)));
            endCropping();
          }
        },
        onCancel: cancelCrop,
        aspectRatios,
      },
    });
  }

  // handle adding new urls or files — just show previews, effects handle the rest.
  // `userStarted: false` is an image that arrived without a gesture (a data: url in the value).
  function handleChange(items: (string | File)[], { userStarted = true } = {}) {
    // Signed out, nothing is queued: no upload starts and no card holds the generator.
    if (signedOut) {
      if (userStarted) requireSignIn();
      else setSignInRequired(true);
      return;
    }
    const files = items.filter((src): src is File => typeof src !== 'string');
    if (!files.length) return queueItems(items);
    setPicksProbing((n) => n + 1);
    return splitUnreadablePicks(files).then(({ unreadable }) => {
      setPicksProbing((n) => n - 1);
      const rejected = rejectUnreadablePicks(unreadable);
      queueItems(items.filter((src) => typeof src === 'string' || !rejected.has(src)));
    });
  }

  /**
   * Reports picked files the browser cannot read and shows the unreadable-pick alert for them (with
   * the Files fallback on Android); a pick with none clears it. Returns the rejected files, which
   * are not queued.
   */
  function rejectUnreadablePicks(
    unreadable: { file: File; error: DOMException }[],
    slotIndices?: number[]
  ) {
    for (const { file, error } of unreadable)
      reportImagePrepFailure(
        new ImagePrepError('pick-unreadable', false, error.message, { cause: error }),
        file
      );
    setUnreadablePick(unreadable.length ? { count: unreadable.length, slotIndices } : null);
    return new Set<File>(unreadable.map(({ file }) => file));
  }

  function queueItems(items: (string | File)[]) {
    if (!items.length) return;
    // A new pick of a url whose read failed before is a new attempt: it is read again and goes
    // through the crop check like any pick (not started as "unreadable"), and a failure is reported.
    const urls = new Set(items.filter((src): src is string => typeof src === 'string'));
    if (urls.size) {
      for (const url of urls) reportedLoadFailuresRef.current.delete(url);
      setUnreadableUrls((prev) =>
        [...urls].some((url) => prev.has(url))
          ? new Set([...prev].filter((url) => !urls.has(url)))
          : prev
      );
    }
    setUploads((prev) => [
      ...prev,
      ...items.map((src) => {
        const url = typeof src !== 'string' ? URL.createObjectURL(src) : src;
        if (typeof src !== 'string')
          pickedFilesRef.current.set(url, { type: src.type, size: src.size });
        return { status: 'queued' as const, url, id: getRandomId() };
      }),
    ]);
  }

  // handle drawing upload for individual images
  async function handleDrawingUpload(index: number, drawingBlob: Blob, elements: DrawingElement[]) {
    if (requireSignIn()) return;
    const response = await uploadOrchestratorImage(drawingBlob, getRandomId());

    if (response.url && response.available) {
      const newImage = { url: response.url, width: response.width, height: response.height };
      onDrawingComplete?.(newImage, index, elements);
    }
  }

  // Slots mode: upload one or more images to specific slots.
  // Tracks slot positions internally and only commits to value once the
  // orchestrator URLs are ready — never writes blob URLs into value.
  // The crop modal (when applicable) operates on blob URLs in its own state
  // without touching value. Slot dropzone loading state is rendered from the
  // `uploads` list (matched by slotIndex), not from value.
  async function handleSlotUpload(pickedEntries: { slotIndex: number; src: File | string }[]) {
    if (requireSignIn()) return;
    // Validate file sizes
    for (const { src } of pickedEntries) {
      if (src instanceof File && src.size > maxOrchestratorImageFileSize) {
        setError(`Images should not exceed ${maxSizeFormatted}`);
        return;
      }
    }

    setError(null);

    let entries = pickedEntries;
    const files = entries.flatMap(({ src }) => (src instanceof File ? [src] : []));
    if (files.length) {
      // Counted as pending from here: the slot's own uploading marker is set only after the probe.
      setPicksProbing((n) => n + 1);
      const { unreadable } = await splitUnreadablePicks(files);
      setPicksProbing((n) => n - 1);
      const unreadableSlots = entries
        .filter(({ src }) => unreadable.some(({ file }) => file === src))
        .map(({ slotIndex }) => slotIndex);
      const rejected = rejectUnreadablePicks(unreadable, unreadableSlots);
      entries = entries.filter(({ src }) => typeof src === 'string' || !rejected.has(src));
      if (!entries.length) return;
    }

    const items = entries.map(({ slotIndex, src }) => ({
      slotIndex,
      src,
      previewUrl: typeof src === 'string' ? src : URL.createObjectURL(src),
      uploadId: getRandomId(),
    }));
    const itemIds = new Set(items.map((x) => x.uploadId));

    // Mark as uploading immediately so useImagesUploadingOrVerifying blocks
    // the whatIf query before any value changes happen.
    for (const { uploadId } of items) {
      setImageUploading(uploadId, true);
      trackedUploadingIdsRef.current.add(uploadId);
    }

    // Show upload indicators in slots. The slot renderer keys off
    // `uploads.find(u => u.slotIndex === slotIndex)` so this is sufficient
    // to display loading state without writing anything to value.
    setUploads((prev) => {
      const slotIndices = new Set(items.map((x) => x.slotIndex));
      return [
        ...prev.filter((x) => x.slotIndex === undefined || !slotIndices.has(x.slotIndex)),
        ...items.map(({ previewUrl, uploadId, slotIndex }) => ({
          status: 'uploading' as const,
          url: previewUrl,
          id: uploadId,
          slotIndex,
        })),
      ];
    });

    const cleanupTracking = () => {
      for (const { uploadId } of items) {
        setImageUploading(uploadId, false);
        trackedUploadingIdsRef.current.delete(uploadId);
      }
    };

    try {
      // Resolve dimensions (cache-first) so we can detect whether cropping is needed.
      const dimensioned = await Promise.all(
        items.map(async (item) => {
          const cached = sourceMetadataStore.getMetadata(item.previewUrl);
          const dims =
            cached?.width && cached?.height
              ? { width: cached.width, height: cached.height }
              : await prepStage('dims', () => getImageDimensions(item.previewUrl));
          if (!cached?.width || !cached?.height) {
            sourceMetadataStore.setMetadata(item.previewUrl, dims);
          }
          return { ...item, width: dims.width, height: dims.height };
        })
      );

      // If cropping is required, open the crop modal and await the user's
      // crops as a promise. The crop modal operates entirely on blob URLs in
      // its own props — value is never touched.
      type CropResult = { slotIndex: number; src: Blob | File | string; uploadId: string };
      let toUpload: CropResult[];

      if (getShouldCrop(dimensioned)) {
        isCroppingRef.current = true;
        const cropResult = await new Promise<CropResult[] | null>((resolve) => {
          dialogStore.trigger({
            id: 'image-crop-modal',
            component: ImageCropModal,
            props: {
              images: dimensioned.map((d) => ({
                url: d.previewUrl,
                width: d.width,
                height: d.height,
                aspectRatio: d.width / d.height,
              })),
              aspectRatios,
              onConfirm: (output: { src: string; cropped?: Blob }[]) => {
                resolve(
                  output.map((o, i) => ({
                    slotIndex: dimensioned[i].slotIndex,
                    src: o.cropped ?? dimensioned[i].src,
                    uploadId: dimensioned[i].uploadId,
                  }))
                );
              },
              onCancel: () => resolve(null),
            },
          });
        });
        endCropping();

        if (!cropResult) {
          // Cancelled — clear upload indicators and tracking, leave value alone.
          setUploads((prev) => prev.filter((x) => !x.id || !itemIds.has(x.id)));
          cleanupTracking();
          return;
        }
        toUpload = cropResult;
      } else {
        toUpload = dimensioned.map((d) => ({
          slotIndex: d.slotIndex,
          src: d.src,
          uploadId: d.uploadId,
        }));
      }

      // Upload all in parallel and collect successful results with their slot.
      const uploadResults = await Promise.all(
        toUpload.map(async ({ slotIndex, src, uploadId }) => {
          const response = await uploadOrchestratorImage(src, uploadId, undefined, {
            origin: 'card',
          });
          if (response.blockedReason || !response.available || !response.url) {
            const previewUrl = items.find((x) => x.uploadId === uploadId)?.previewUrl ?? '';
            setUploads((prev) =>
              prev.map((item) =>
                item.id === uploadId
                  ? {
                      status: 'error' as const,
                      url: previewUrl,
                      src,
                      error: response.blockedReason ?? 'Upload failed',
                      id: uploadId,
                      slotIndex,
                    }
                  : item
              )
            );
            return null;
          }
          return {
            slotIndex,
            uploadId,
            result: {
              url: response.url,
              width: response.width,
              height: response.height,
            },
          };
        })
      );

      const successful = uploadResults.filter(isDefined);
      if (successful.length > 0) {
        // Build the new value with successful uploads placed at their slot
        // positions. This is the only place handleSlotUpload calls onChange.
        const next = valueRef.current ? [...valueRef.current] : [];
        for (const { slotIndex, result } of successful) {
          while (next.length <= slotIndex) {
            next.push(undefined as unknown as SourceImageProps);
          }
          next[slotIndex] = result;
        }
        onChange?.(next.filter(Boolean) as SourceImageProps[]);
      }

      // Clear uploading entries for successful uploads (errored entries stay
      // visible so the user can see the error message).
      const successfulIds = new Set(successful.map((s) => s.uploadId));
      setUploads((prev) => prev.filter((x) => !x.id || !successfulIds.has(x.id)));
      cleanupTracking();
    } catch (e) {
      // The browser's own text for an image it could not read is not shown.
      setError(e instanceof ImagePrepError ? IMAGE_PREP_ERROR : (e as Error).message);
      setUploads((prev) => prev.filter((x) => !x.id || !itemIds.has(x.id)));
      cleanupTracking();
    }
  }

  // Slots mode: remove image from a specific slot
  function removeSlotItem(slotIndex: number) {
    if (!value) return;

    // Get the image at this slot index
    const imageAtSlot = value[slotIndex];
    if (imageAtSlot) {
      onRemove?.(imageAtSlot, slotIndex);
      // Remove source metadata from store
      sourceMetadataStore.removeMetadata(imageAtSlot.url);
    }

    const newValue = [...value];
    newValue.splice(slotIndex, 1);
    onChange?.(newValue.length > 0 ? newValue : null);

    // Clear any upload state for this slot
    setUploads((items) => items.filter((x) => x.slotIndex !== slotIndex));
  }

  // Files picked through the fallback go to the slots, in order, or the card list the unreadable pick
  // was meant for. The alert has already refused a selection with a file of the wrong type or size,
  // so the alert is cleared only for a selection that is taken.
  function handleUnreadableFallback(files: File[]) {
    const target = unreadablePick;
    setUnreadablePick(null);
    setError(null);
    const slotIndices = target?.slotIndices;
    if (slotIndices?.length)
      return handleSlotUpload(
        files.slice(0, slotIndices.length).map((src, i) => ({ slotIndex: slotIndices[i], src }))
      );
    const remaining = Math.max(0, max - previewItems.length);
    return handleChange(files.slice(0, remaining));
  }

  // Single mode render - VideoInput-style layout
  const renderSingleMode = () => {
    const firstImage = previewItems.find((item) => item.status === 'complete') as
      | ImageComplete
      | undefined;
    const isUploading = previewItems.some(
      (item) =>
        item.status === 'queued' || item.status === 'uploading' || item.status === 'cropping'
    );

    if (firstImage) {
      // Calculate aspect ratio to prevent layout shift during image load
      const aspectRatio =
        firstImage.width && firstImage.height ? firstImage.width / firstImage.height : undefined;

      // Show the image preview
      return (
        <Card withBorder padding={0} className="relative overflow-hidden">
          <div
            className="relative w-full"
            style={{
              // Use aspect-ratio to reserve space and prevent layout shift
              aspectRatio: aspectRatio,
              maxHeight: 200,
            }}
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={firstImage.url} alt="Uploaded image" className="size-full object-contain" />
          </div>

          {!firstImage.width || !firstImage.height ? (
            <div className="absolute inset-0 flex items-center justify-center bg-dark-9/30">
              <Loader size="sm" />
            </div>
          ) : (
            <SourceImageUploadMultiple.Dimensions
              width={firstImage.width}
              height={firstImage.height}
            />
          )}
          {enableMetadataExtraction && (
            <MetadataAction url={firstImage.url} apply={metadataApply} />
          )}
          <SourceImageUploadMultiple.CloseButton
            onClick={() => removeItem(0)}
            disabled={disabled}
          />
        </Card>
      );
    }

    if (isUploading) {
      // Show loading state
      return (
        <div className="flex min-h-[200px] items-center justify-center rounded border border-dashed border-gray-4 dark:border-dark-4">
          <Loader size="md" />
        </div>
      );
    }

    // Show the dropzone
    return (
      <Dropzone
        onDrop={async (files) => {
          setError(null);
          const toUpload = files
            .filter((file) => {
              const tooLarge = file.size > maxOrchestratorImageFileSize;
              if (tooLarge) setError(`Images should not exceed ${maxSizeFormatted}`);
              return !tooLarge;
            })
            .slice(0, 1);
          if (toUpload.length > 0) await handleChange(toUpload);
        }}
        onDropCapture={async (e: DragEvent) => {
          setError(null);
          const url = e.dataTransfer.getData('text/uri-list');
          if (url?.length) await handleChange([url]);
        }}
        accept={IMAGE_MIME_TYPE}
        maxFiles={1}
        disabled={disabled}
        className="cursor-pointer"
        useFsAccessApi={!isAndroidDevice()}
      >
        <div className="flex flex-col items-center justify-center gap-2 py-8">
          <Dropzone.Accept>
            <IconUpload
              size={50}
              stroke={1.5}
              color={theme.colors[theme.primaryColor][colorScheme === 'dark' ? 4 : 6]}
            />
          </Dropzone.Accept>
          <Dropzone.Reject>
            <IconX
              size={50}
              stroke={1.5}
              color={theme.colors.red[colorScheme === 'dark' ? 4 : 6]}
            />
          </Dropzone.Reject>
          <Dropzone.Idle>
            <IconPhoto size={50} stroke={1.5} />
          </Dropzone.Idle>
          <Text size="sm" c="dimmed" ta="center">
            Drag an image here or click to select
          </Text>
          <Text size="xs" c="dimmed">
            PNG, JPG, WebP supported (max {maxSizeFormatted})
          </Text>
        </div>
      </Dropzone>
    );
  };

  // Slots mode render - side-by-side dropzones with labels
  const renderSlot = (slot: ImageSlot, slotIndex: number) => {
    const imageAtSlot = value?.[slotIndex];
    const uploadForSlot = uploads.find((u) => u.slotIndex === slotIndex);
    const isUploading = uploadForSlot?.status === 'uploading';
    const uploadError = uploadForSlot?.status === 'error' ? uploadForSlot.error : null;
    const isSlotDisabled = disabled || slot.disabled;

    return (
      <div
        key={slotIndex}
        className={`flex flex-1 flex-col gap-1${slot.disabled ? ' opacity-50' : ''}`}
      >
        {isUploading ? (
          // Show loading state (with image preview underneath if available)
          <Card withBorder padding={0} className="relative overflow-hidden">
            {imageAtSlot ? (
              <>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={imageAtSlot.url}
                  alt={slot.label}
                  className="max-h-[200px] w-full object-contain opacity-50"
                />
                <Text size="xs" c="dimmed" ta="center" className="py-1">
                  {slot.label}
                </Text>
              </>
            ) : (
              <div className="flex min-h-[150px] flex-col items-center justify-center">
                <Text size="xs" c="dimmed" ta="center" mt={8}>
                  {slot.label}
                </Text>
              </div>
            )}
            <div className="absolute inset-0 flex items-center justify-center bg-dark-9/30">
              <Loader size="sm" />
            </div>
          </Card>
        ) : imageAtSlot ? (
          // Show image preview
          <Card withBorder padding={0} className="relative overflow-hidden">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={imageAtSlot.url}
              alt={slot.label}
              className="max-h-[200px] w-full object-contain"
            />
            <Text size="xs" c="dimmed" ta="center" className="py-1">
              {slot.label}
            </Text>
            {!imageAtSlot.width || !imageAtSlot.height ? (
              <div className="absolute inset-0 flex items-center justify-center bg-dark-9/30">
                <Loader size="sm" />
              </div>
            ) : (
              <SourceImageUploadMultiple.Dimensions
                width={imageAtSlot.width}
                height={imageAtSlot.height}
              />
            )}
            {enableMetadataExtraction && (
              <MetadataAction url={imageAtSlot.url} apply={metadataApply} />
            )}
            <SourceImageUploadMultiple.CloseButton
              onClick={() => removeSlotItem(slotIndex)}
              disabled={isSlotDisabled}
            />
          </Card>
        ) : (
          // Show dropzone
          <Dropzone
            onDrop={async (files) => {
              if (!files.length || !slots) return;
              // Distribute files across empty slots starting from this slot
              const emptySlotIndices = slots
                .map((s, i) => ({ i, s }))
                .filter(({ i, s }) => i >= slotIndex && !s.disabled && !value?.[i])
                .map(({ i }) => i);
              const entries = files
                .slice(0, emptySlotIndices.length)
                .map((file, idx) => ({ slotIndex: emptySlotIndices[idx], src: file }));
              if (entries.length) await handleSlotUpload(entries);
            }}
            onDropCapture={async (e: DragEvent) => {
              const url = e.dataTransfer.getData('text/uri-list');
              if (url?.length) await handleSlotUpload([{ slotIndex, src: url }]);
            }}
            accept={IMAGE_MIME_TYPE}
            disabled={isSlotDisabled}
            className="cursor-pointer"
            useFsAccessApi={!isAndroidDevice()}
          >
            <div className="flex flex-col items-center justify-center gap-2 py-6">
              <Dropzone.Accept>
                <IconUpload
                  size={32}
                  stroke={1.5}
                  color={theme.colors[theme.primaryColor][colorScheme === 'dark' ? 4 : 6]}
                />
              </Dropzone.Accept>
              <Dropzone.Reject>
                <IconX
                  size={32}
                  stroke={1.5}
                  color={theme.colors.red[colorScheme === 'dark' ? 4 : 6]}
                />
              </Dropzone.Reject>
              <Dropzone.Idle>
                <IconPhoto size={32} stroke={1.5} />
              </Dropzone.Idle>
              <Text size="xs" c="dimmed" ta="center">
                {slot.label}
              </Text>
            </div>
          </Dropzone>
        )}
        {uploadError && (
          <Text size="xs" c="red" ta="center">
            {uploadError}
          </Text>
        )}
      </div>
    );
  };

  const renderSlotsMode = () => {
    if (!slots) return null;
    return <div className="flex gap-2">{slots.map((slot, index) => renderSlot(slot, index))}</div>;
  };

  const unreadablePickAlert = unreadablePick && (
    <UnreadablePickAlert
      accept={IMAGE_MIME_TYPE}
      count={unreadablePick.count}
      maxSize={maxOrchestratorImageFileSize}
      multiple={
        unreadablePick.slotIndices?.length ? unreadablePick.slotIndices.length > 1 : max > 1
      }
      disabled={disabled}
      onFiles={handleUnreadableFallback}
    />
  );

  // Only while still signed out: a session that resolves signed-in in place drops the message.
  const signInAlert = signInRequired && signedOut && (
    <Alert color="blue">
      <div className="flex items-center justify-between gap-2">
        <Text size="sm">{SIGN_IN_TO_UPLOAD_MESSAGE}</Text>
        <Button size="compact-sm" onClick={openSignInToUpload}>
          Sign in
        </Button>
      </div>
    </Alert>
  );

  return (
    <Provider
      value={{
        previewItems,
        setError,
        setUploads,
        max: isSlotsMode ? slots!.length : max,
        missingAiMetadata,
        removeItem,
        aspect,
        cropToFirstImage,
        aspectRatios,
        onChange: (items) => handleChange(items),
        enableDrawing,
        handleDrawingUpload,
        annotations,
        disabled,
        slots,
        handleSlotUpload,
        removeSlotItem,
        enableMetadataExtraction,
        metadataApply,
      }}
    >
      {isSlotsMode ? (
        <div className="flex w-full flex-col gap-2" id={id}>
          {renderSlotsMode()}
          {_error && <Alert color="red">{_error}</Alert>}
          {unreadablePickAlert}
          {signInAlert}
          {imagesMissingMetadataCount > 0 && (
            <Alert color="yellow" title="We couldn't detect valid metadata in one or more images.">
              Outputs based on these images must be PG, PG-13, or they will be blocked and you will
              not be refunded.
            </Alert>
          )}
        </div>
      ) : isSingleMode ? (
        <div className="flex w-full flex-col gap-2" id={id}>
          {renderSingleMode()}
          {_error && <Alert color="red">{_error}</Alert>}
          {unreadablePickAlert}
          {signInAlert}
          {imagesMissingMetadataCount > 0 && (
            <Alert color="yellow" title="We couldn't detect valid metadata in this image.">
              Outputs based on this image must be PG, PG-13, or they will be blocked and you will
              not be refunded.
            </Alert>
          )}
        </div>
      ) : (
        <div className="flex flex-col gap-3" id={id}>
          {children?.(previewItems)}

          {_error && <Alert color="red">{_error}</Alert>}
          {unreadablePickAlert}
          {signInAlert}
          {imagesMissingMetadataCount > 0 && (
            <Alert
              color="yellow"
              title={`We couldn't detect valid metadata in ${
                imagesMissingMetadataCount > 1 ? 'these images' : 'this image'
              }.`}
            >
              {`Outputs based on ${
                imagesMissingMetadataCount > 1 ? 'these images' : 'this image'
              } must be PG, PG-13, or they will be blocked and you will not be refunded.`}
            </Alert>
          )}
        </div>
      )}
    </Provider>
  );
}

// =============================================================================
// Shared Sub-components
// =============================================================================

/** Shared close button for image cards */
SourceImageUploadMultiple.CloseButton = function CloseButton({
  onClick,
  disabled,
}: {
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <ActionIcon
      className="absolute right-0 top-0 z-30"
      variant="filled"
      color="red"
      size="sm"
      onClick={onClick}
      disabled={disabled}
    >
      <IconX size={16} />
    </ActionIcon>
  );
};

/** Shared dimensions overlay for image cards */
SourceImageUploadMultiple.Dimensions = function Dimensions({
  width,
  height,
}: {
  width: number;
  height: number;
}) {
  return (
    <div className="absolute bottom-0 right-0 rounded-br-md rounded-tl-md bg-dark-9/70 px-2 py-0.5 text-xs text-white">
      {width} x {height}
    </div>
  );
};

SourceImageUploadMultiple.Dropzone = function ImageDropzone({
  className,
  children,
}: {
  className?: string;
  children?: React.ReactNode;
}) {
  const theme = useMantineTheme();
  const colorScheme = useComputedColorScheme('dark');
  const { previewItems, setError, max, aspect, onChange, disabled } = useContext();
  const canAddFiles = previewItems.length < max && !disabled;

  async function handleDrop(files: File[]) {
    setError(null);
    const remaining = max - previewItems.length;
    const toUpload = files
      .filter((file) => {
        const tooLarge = file.size > maxOrchestratorImageFileSize;
        if (tooLarge) setError(`Images should not exceed ${maxSizeFormatted}`);
        return !tooLarge;
      })
      .splice(0, remaining);
    await onChange(toUpload);
  }

  async function handleDropCapture(e: DragEvent) {
    setError(null);
    const url = e.dataTransfer.getData('text/uri-list');
    if (!!url?.length && previewItems.length < max) await onChange([url]);
  }

  if (!canAddFiles) return null;
  return (
    <Dropzone
      accept={IMAGE_MIME_TYPE}
      disabled={!canAddFiles}
      onDrop={handleDrop}
      onDropCapture={handleDropCapture}
      className={clsx(
        'flex items-center justify-center',
        !children && (aspect === 'square' ? 'aspect-square' : 'aspect-video'),
        {
          ['bg-gray-0 dark:bg-dark-6 border-gray-2 dark:border-dark-5 cursor-not-allowed [&_*]:text-gray-5 [&_*]:dark:text-dark-3']:
            !canAddFiles,
        },
        className
      )}
      useFsAccessApi={!isAndroidDevice()}
    >
      {children ?? (
        <div className="pointer-events-none flex items-center justify-center gap-2">
          <Dropzone.Accept>
            <IconUpload
              size={iconSize}
              stroke={1.5}
              color={theme.colors[theme.primaryColor][colorScheme === 'dark' ? 4 : 6]}
            />
          </Dropzone.Accept>
          <Dropzone.Reject>
            <IconX
              size={iconSize}
              stroke={1.5}
              color={theme.colors.red[colorScheme === 'dark' ? 4 : 6]}
            />
          </Dropzone.Reject>
          <Dropzone.Idle>
            <IconUpload size={iconSize} stroke={1.5} />
          </Dropzone.Idle>

          <Text>{max === 1 ? 'Image' : 'Images'}</Text>
        </div>
      )}
    </Dropzone>
  );
};

/**
 * URL-input variant of the dropzone. Renders a text input + "Choose..." button
 * inside a dashed-border drop target. Supports file drops, URL drags, URL paste,
 * and Enter key submission. Uses the same upload pipeline as the standard Dropzone.
 *
 * Uses native HTML5 drag/drop + hidden file input instead of Mantine Dropzone
 * because Dropzone's inner wrapper sets pointer-events:none which blocks
 * interaction with the TextInput.
 */
SourceImageUploadMultiple.UrlDropzone = function UrlDropzone({
  className,
  placeholder = 'Add a file or provide a URL',
  hint,
  size = 'xs',
}: {
  className?: string;
  placeholder?: string;
  hint?: string;
  size?: 'xs' | 'sm' | 'md';
}) {
  const { previewItems, setError, max, onChange, disabled } = useContext();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [urlValue, setUrlValue] = useState('');
  const [isDragOver, setIsDragOver] = useState(false);
  const canAddFiles = previewItems.length < max && !disabled;

  async function handleFiles(files: File[]) {
    setError(null);
    const remaining = max - previewItems.length;
    const toUpload = files
      .filter((file) => {
        if (!IMAGE_MIME_TYPE.includes(file.type as (typeof IMAGE_MIME_TYPE)[number])) return false;
        const tooLarge = file.size > maxOrchestratorImageFileSize;
        if (tooLarge) setError(`Images should not exceed ${maxSizeFormatted}`);
        return !tooLarge;
      })
      .slice(0, remaining);
    if (toUpload.length > 0) await onChange(toUpload);
  }

  function handleNativeDragOver(e: React.DragEvent) {
    e.preventDefault();
    setIsDragOver(true);
  }

  function handleNativeDragLeave(e: React.DragEvent) {
    e.preventDefault();
    setIsDragOver(false);
  }

  async function handleNativeDrop(e: React.DragEvent) {
    e.preventDefault();
    setIsDragOver(false);

    // Check for URL drops first
    const url = e.dataTransfer.getData('text/uri-list');
    if (url?.length) {
      setError(null);
      await onChange([url]);
      return;
    }

    // File drops
    const files = Array.from(e.dataTransfer.files);
    if (files.length > 0) await handleFiles(files);
  }

  function handleFileInputChange(e: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files ?? []);
    if (files.length > 0) handleFiles(files);
    e.target.value = ''; // Reset so same file can be re-selected
  }

  function submitUrl(url: string) {
    const trimmed = url.trim();
    if (!trimmed) return;
    setError(null);
    setUrlValue('');
    onChange([trimmed]);
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter') {
      e.preventDefault();
      submitUrl(urlValue);
    }
  }

  function handlePaste(e: React.ClipboardEvent<HTMLInputElement>) {
    const pasted = e.clipboardData.getData('text/plain').trim();
    if (pasted.startsWith('http://') || pasted.startsWith('https://')) {
      e.preventDefault();
      submitUrl(pasted);
    }
  }

  if (!canAddFiles) return null;

  return (
    <div
      onDragOver={handleNativeDragOver}
      onDragLeave={handleNativeDragLeave}
      onDrop={handleNativeDrop}
      className={clsx(
        'rounded-md border border-dashed p-3',
        isDragOver
          ? 'border-blue-5 bg-blue-0 dark:border-blue-7 dark:bg-blue-9/20'
          : 'border-gray-4 dark:border-dark-4',
        className
      )}
    >
      <input
        ref={fileInputRef}
        type="file"
        className="hidden"
        accept={IMAGE_MIME_TYPE.join(',')}
        multiple
        onChange={handleFileInputChange}
      />
      <div className="flex flex-col gap-2">
        <div className="flex items-center gap-2">
          <TextInput
            className="flex-1"
            placeholder={placeholder}
            value={urlValue}
            onChange={(e) => setUrlValue(e.target.value)}
            onKeyDown={handleKeyDown}
            onPaste={handlePaste}
            size={size}
            disabled={!canAddFiles}
          />
          <Button
            variant="default"
            size={size}
            onClick={() => fileInputRef.current?.click()}
            disabled={!canAddFiles}
          >
            Choose...
          </Button>
        </div>
        {hint && (
          <Text size="xs" c="dimmed">
            {hint}
          </Text>
        )}
      </div>
    </div>
  );
};

SourceImageUploadMultiple.Image = function ImagePreview({
  className,
  index,
  ...previewItem
}: ImagePreview & { className?: string; index: number }) {
  const {
    missingAiMetadata,
    removeItem,
    aspect,
    setError,
    enableDrawing,
    handleDrawingUpload,
    annotations,
    disabled,
    enableMetadataExtraction,
    metadataApply,
  } = useContext();
  const [drawingLines, setDrawingLines] = useState<DrawingElement[]>([]);
  const isMobile = isMobileDevice();

  // Check if this image is a composite (has been annotated)
  const annotation = annotations?.find((a) => a.compositeUrl === previewItem.url);
  const isAnnotated = !!annotation;

  function handleRemoveItem() {
    removeItem(index);
  }

  function handleError() {
    handleRemoveItem();
    setError('Failed to load image');
  }

  async function handleDrawingComplete(drawingBlob: Blob, elements: DrawingElement[]) {
    setDrawingLines(elements);
    await handleDrawingUpload(index, drawingBlob, elements);
  }

  // Get initial lines from annotation if this is an annotated image, otherwise from local state
  const initialLines = isAnnotated ? annotation.lines : drawingLines;

  function handleOpenDrawingEditor() {
    if (previewItem.status !== 'complete') return;

    // If this is a composite, use the original image for the drawing editor
    const sourceImage = isAnnotated
      ? {
          url: annotation.originalUrl,
          width: annotation.originalWidth,
          height: annotation.originalHeight,
        }
      : {
          url: previewItem.url,
          width: previewItem.width,
          height: previewItem.height,
        };

    dialogStore.trigger({
      id: `drawing-editor-modal-${index}`,
      component: DrawingEditorModal,
      props: {
        sourceImage,
        onConfirm: handleDrawingComplete,
        initialLines,
      },
    });
  }

  return (
    <Card
      withBorder
      p={0}
      className={clsx(
        // `isolate` makes this card a stacking-context root so the internal
        // `z-30` CloseButton (which needs to sit above the `z-20` hover
        // overlay) doesn't escape and render over the sticky GenerationFooter
        // (which is only `z-10`).
        'relative isolate overflow-hidden',
        {
          ['border-2 border-solid border-yellow-4 ']: missingAiMetadata[previewItem.url],
        },
        className
      )}
    >
      <Card.Section p={0} m={0} withBorder>
        <div
          className={clsx(
            'group relative flex items-center justify-center',
            aspect === 'square' ? 'aspect-square' : 'aspect-video'
          )}
        >
          {(previewItem.status === 'queued' ||
            previewItem.status === 'uploading' ||
            previewItem.status === 'cropping') && <Loader size="sm" />}
          {previewItem.status === 'complete' && (
            <>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={previewItem.url}
                className="size-full object-contain"
                alt="image"
                onError={handleError}
              />
              {!previewItem.width || !previewItem.height ? (
                <div className="absolute inset-0 flex items-center justify-center bg-dark-9/30">
                  <Loader size="sm" />
                </div>
              ) : (
                <SourceImageUploadMultiple.Dimensions
                  width={previewItem.width}
                  height={previewItem.height}
                />
              )}
              {enableMetadataExtraction && (
                <MetadataAction url={previewItem.url} apply={metadataApply} />
              )}
              {enableDrawing &&
                (isMobile ? (
                  // Mobile: Large prominent button bottom-left
                  <ActionIcon
                    variant="white"
                    color="dark"
                    size="lg"
                    className="absolute bottom-1 left-1 m-0 rounded-md shadow-lg"
                    onClick={handleOpenDrawingEditor}
                  >
                    <IconPalette size={24} />
                  </ActionIcon>
                ) : (
                  // Desktop: Full hover overlay
                  <div
                    className="absolute inset-0 z-20 flex cursor-pointer items-center justify-center bg-black/50 opacity-0 transition-opacity group-hover:opacity-100"
                    onClick={handleOpenDrawingEditor}
                  >
                    <div className="flex items-center gap-2 rounded-md bg-white/90 px-3 py-2 text-dark-9">
                      <IconPalette size={20} />
                      <span className="text-sm font-medium">Sketch Edit</span>
                    </div>
                  </div>
                ))}
            </>
          )}
          {previewItem.status === 'error' && (
            <Text c="red" size="sm" align="center">
              {previewItem.error}
            </Text>
          )}
        </div>
      </Card.Section>
      <SourceImageUploadMultiple.CloseButton onClick={handleRemoveItem} disabled={disabled} />
    </Card>
  );
};

export async function uploadOrchestratorImage(
  src: string | Blob | File,
  id: string,
  /**
   * Where to read generation metadata from, when that isn't `src` itself — the
   * crop flow uploads a re-encoded Blob and only the pre-crop url still has EXIF.
   */
  metadataSource?: string | File,
  /** For the failure report only: the picked file behind a `blob:` src, and where a url came from. */
  report: { file?: PickedFileInfo; origin?: ImageOrigin } = {}
) {
  let originalSize = { width: 0, height: 0 };
  const timeoutMs = IMAGE_PREP_STAGE_TIMEOUT_MS;
  try {
    // Inside the try: callers render a failed upload from `blockedReason`, and a throw here
    // would leave their card loading forever.
    originalSize = await prepStage('dims', () => getImageDimensions(src), timeoutMs);

    // If already an orchestrator URL, return it directly
    if (typeof src === 'string' && isOrchestratorUrl(src)) {
      return {
        url: src,
        ...originalSize,
        available: true,
        type: 'image',
        id: '',
      };
    }

    setImageUploading(id, true);

    // Read the source's generation metadata before the resize + JPEG re-encode
    // below drops its EXIF — otherwise the uploaded URL has nothing left to read
    // back and the image-metadata modal comes up empty for local files.
    const metadataSrc =
      metadataSource ?? (typeof src === 'string' || src instanceof File ? src : undefined);
    const sourceMetadata = metadataSrc
      ? extractSourceMetadata(metadataSrc).catch(() => undefined)
      : undefined;

    // Resize and convert to JPEG blob
    const resized = await resizeImage(src, {
      maxHeight: maxUpscaleSize,
      maxWidth: maxUpscaleSize,
      minWidth: minUploadSize,
      minHeight: minUploadSize,
      stageTimeoutMs: timeoutMs,
    });
    const jpegBlob = await imageToJpegBlob(resized, { stageTimeoutMs: timeoutMs });

    // Get dimensions after resizing
    const resizedSize = await prepStage(
      'dims-after-encode',
      () => getImageDimensions(jpegBlob),
      timeoutMs
    );

    // Upload using presigned URL
    const blob = await uploadConsumerBlob(jpegBlob);
    setImageUploading(id, false);

    const uploadedUrl = blob.url;

    // Carry a remix provenance token across the re-upload.
    //
    // This function replaces an `image.civitai.com` URL with a fresh orchestrator
    // blob (resize + JPEG re-encode above), and the server's URL-derived
    // provenance can only resolve the on-site form — so without this move, every
    // remix that came in through a remix entry point arrives at submit with its
    // link already destroyed. The token itself is server-sealed, so moving it is
    // not the client asserting anything.
    //
    // `metadataSource` is the fallback for the same reason it exists: the crop
    // flow uploads a re-encoded Blob and only the pre-crop url identifies what
    // the user started from. Cropping a remix is still that remix.
    const provenanceFrom =
      typeof src === 'string'
        ? src
        : typeof metadataSource === 'string'
        ? metadataSource
        : undefined;
    if (provenanceFrom && uploadedUrl) remixProvenanceStore.transfer(provenanceFrom, uploadedUrl);

    // Cached before the url reaches the value, so the dimension check does not download it again.
    if (uploadedUrl) sourceMetadataStore.setMetadata(uploadedUrl, resizedSize);

    if (sourceMetadata && uploadedUrl) {
      sourceMetadata.then((metadata) => {
        if (metadata)
          sourceMetadataStore.setMetadata(uploadedUrl, { ...metadata, exifExtracted: true });
      });
    }

    return { ...blob, ...resizedSize };
  } catch (e) {
    setImageUploading(id, false);
    const error = e as Error;
    // Local preparation failures only: the upload itself reports its own (consumer-blob-upload),
    // and a size requirement is a validation message, not a failure.
    if (error instanceof ImagePrepError)
      reportImagePrepFailure(error, src, report.file, report.origin);

    return {
      url: typeof src === 'string' ? src : URL.createObjectURL(src),
      ...originalSize,
      available: false,
      // A local preparation failure shows fixed text; the upload's own failures and size
      // validation keep their messages.
      blockedReason:
        error instanceof ImagePrepError
          ? prepFailureText(error, src, IMAGE_PREP_ERROR)
          : error.message,
    };
  }
}

export const InputSourceImageUploadMultiple = withController(SourceImageUploadMultiple);

export const useImagesUploadingStore = create<{
  uploading: string[];
  verifying: string[];
}>(() => ({ uploading: [], verifying: [] }));
function setImageUploading(id: string, uploading: boolean) {
  if (uploading) {
    useImagesUploadingStore.setState((state) => ({ uploading: [...state.uploading, id] }));
  } else {
    useImagesUploadingStore.setState((state) => ({
      uploading: state.uploading.filter((uploadId) => uploadId !== id),
    }));
  }
}
function setImageVerifying(url: string, verifying: boolean) {
  if (verifying) {
    useImagesUploadingStore.setState((state) => ({ verifying: [...state.verifying, url] }));
  } else {
    useImagesUploadingStore.setState((state) => ({
      verifying: state.verifying.filter((u) => u !== url),
    }));
  }
}

export function useImagesUploadingOrVerifying() {
  return useImagesUploadingStore(
    (state) => state.uploading.length > 0 || state.verifying.length > 0
  );
}

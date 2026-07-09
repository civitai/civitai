import { Alert, Box, Button, SegmentedControl, Stack, Text, Tooltip } from '@mantine/core';
import {
  IconAlertTriangle,
  IconCubeOff,
  IconDownload,
  IconRefresh,
  IconWand,
} from '@tabler/icons-react';
import clsx from 'clsx';
import { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { env } from '~/env/client';
import { useCFImageUpload } from '~/hooks/useCFImageUpload';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { generationGraphPanel, generationGraphStore } from '~/store/generation-graph.store';
import { showErrorNotification } from '~/utils/notifications';

/**
 * Model3DViewer
 *
 * Renders a 3D model (GLB primary, others fall back to a "download to view" panel)
 * using raw three.js + GLTFLoader + OrbitControls. Intended to be dynamic-imported
 * with `ssr: false` by consumers, e.g.:
 *
 *   const Model3DViewer = dynamic(
 *     () => import('~/components/Model3D/Viewer/Model3DViewer').then(m => m.Model3DViewer),
 *     { ssr: false }
 *   );
 *
 * One WebGL context per mounted instance. Do not mount this on feed/queue cards —
 * use the static thumbnail there. The WebGL context is disposed on unmount.
 */

export type Model3DViewerProps = {
  url: string;
  format: string;
  sizeKB?: number;
  className?: string;
  /**
   * Compact mode — hides the in-viewer overlays (background picker +
   * "Generate with this image" CTA). Used by the feed card preview where
   * the parent card already renders Open / Close controls that the
   * picker would otherwise overlap. Default `false` (detail-page mount).
   */
  compact?: boolean;
};

const LARGE_FILE_KB = 100_000; // 100 MB
const SUPPORTED_PREVIEW_FORMATS = ['glb', 'gltf'];

// -----------------------------------------------------------------------------
// Background presets
// -----------------------------------------------------------------------------
// `transparent` is special: we still set a solid scene.background so the user
// gets a visible backdrop while orbiting, but the snapshot path swaps to a
// fully transparent clear before grabbing the frame so the resulting PNG has
// alpha (which is what we want as a generator reference image).

type BackgroundOption = 'plain' | 'studio' | 'light' | 'transparent';

const BACKGROUND_OPTIONS: { value: BackgroundOption; label: string }[] = [
  { value: 'plain', label: 'Plain' },
  { value: 'studio', label: 'Studio' },
  { value: 'light', label: 'Light' },
  { value: 'transparent', label: 'Transparent' },
];

const PLAIN_COLOR = 0x1a1a1a;
const LIGHT_COLOR = 0xf1f3f5;

function makeStudioTexture(): THREE.Texture {
  // Simple vertical gradient drawn into a canvas, used as scene.background.
  // Studio look: brighter at the top, falling off to a deep grey at the bottom.
  const size = 256;
  const canvas = document.createElement('canvas');
  canvas.width = 2;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (ctx) {
    const gradient = ctx.createLinearGradient(0, 0, 0, size);
    gradient.addColorStop(0, '#3a3f47');
    gradient.addColorStop(1, '#0f1115');
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, 2, size);
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

/**
 * Apply a background option to the live three.js scene/renderer.
 * Splits "what the user sees" (scene.background + clearAlpha) from snapshot
 * concerns — when grabbing a still we temporarily force 'transparent' regardless
 * of the current selection.
 */
function applyBackground(
  scene: THREE.Scene,
  renderer: THREE.WebGLRenderer,
  option: BackgroundOption,
  studioTexture: THREE.Texture
) {
  switch (option) {
    case 'plain':
      scene.background = new THREE.Color(PLAIN_COLOR);
      renderer.setClearAlpha(1);
      break;
    case 'light':
      scene.background = new THREE.Color(LIGHT_COLOR);
      renderer.setClearAlpha(1);
      break;
    case 'studio':
      scene.background = studioTexture;
      renderer.setClearAlpha(1);
      break;
    case 'transparent':
      scene.background = null;
      renderer.setClearAlpha(0);
      break;
  }
}

function isPreviewable(format: string) {
  return SUPPORTED_PREVIEW_FORMATS.includes(format.toLowerCase());
}

/** Convert a `data:image/png;base64,...` URL into a `File` for upload. */
function dataUrlToFile(dataUrl: string, filename: string): File {
  const [meta, b64] = dataUrl.split(',');
  const mimeMatch = meta.match(/data:([^;]+)/);
  const mime = mimeMatch?.[1] ?? 'image/png';
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new File([bytes], filename, { type: mime });
}

/**
 * Build the public delivery URL for a freshly-uploaded CF image id. Mirrors
 * what `getEdgeUrl` returns for `original=true` but without the optional
 * width-snap path — we always want the full-res capture as the generator
 * reference. Schema (`sourceImageSchema`) accepts any `image.civitai.*` host.
 */
function buildEdgeUrlForId(id: string, filename: string): string {
  const base = env.NEXT_PUBLIC_IMAGE_LOCATION;
  return [base, id, 'original=true', filename].filter(Boolean).join('/');
}

export function Model3DViewer({
  url,
  format,
  sizeKB,
  className,
  compact = false,
}: Model3DViewerProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const sceneStateRef = useRef<{
    renderer: THREE.WebGLRenderer;
    scene: THREE.Scene;
    camera: THREE.PerspectiveCamera;
    controls: OrbitControls;
    initialCameraPos: THREE.Vector3;
    initialTarget: THREE.Vector3;
    animationId: number;
    resizeObserver: ResizeObserver;
    studioTexture: THREE.Texture;
  } | null>(null);

  const [loadState, setLoadState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  // Background preference is session-scoped — no zustand/localStorage needed.
  const [background, setBackground] = useState<BackgroundOption>('plain');
  const [snapshotting, setSnapshotting] = useState(false);

  const currentUser = useCurrentUser();
  const { uploadToCF } = useCFImageUpload();

  const previewable = isPreviewable(format);
  const isLarge = sizeKB !== undefined && sizeKB > LARGE_FILE_KB;

  useEffect(() => {
    if (!previewable) {
      // eslint-disable-next-line no-console
      console.warn(
        `[Model3DViewer] Format "${format}" is not previewable in-browser. Showing fallback panel.`
      );
      return;
    }

    const container = containerRef.current;
    if (!container) return;

    const width = container.clientWidth || 1;
    const height = container.clientHeight || 1;

    const scene = new THREE.Scene();

    const camera = new THREE.PerspectiveCamera(50, width / height, 0.1, 1000);
    camera.position.set(2, 2, 3);

    // `preserveDrawingBuffer: true` is what makes `canvas.toDataURL()` reliable
    // for the snapshot CTA — without it, the drawing buffer is cleared after
    // present on most browsers and the capture comes back blank. There is a
    // perf cost (an extra GPU copy per frame) but the viewer renders a single
    // static model so it's acceptable. Re-rendering synchronously right before
    // `toDataURL` is also done as belt-and-suspenders, but the flag is the real
    // fix.
    const renderer = new THREE.WebGLRenderer({
      antialias: true,
      alpha: true,
      preserveDrawingBuffer: true,
    });
    renderer.setPixelRatio(window.devicePixelRatio);
    renderer.setSize(width, height);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    container.appendChild(renderer.domElement);

    const studioTexture = makeStudioTexture();
    applyBackground(scene, renderer, 'plain', studioTexture);

    const ambient = new THREE.AmbientLight(0xffffff, 0.6);
    scene.add(ambient);
    const directional = new THREE.DirectionalLight(0xffffff, 0.9);
    directional.position.set(5, 10, 7);
    scene.add(directional);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.1;
    controls.target.set(0, 0, 0);

    const initialCameraPos = camera.position.clone();
    const initialTarget = controls.target.clone();

    let cancelled = false;
    let animationId = 0;

    // Animation playback. Walking / running / animated GLBs from Meshy ship
    // with the animation embedded as a glTF `AnimationClip` referencing the
    // mesh's skeleton. The `mixer` is built on-demand inside the loader
    // callback (we don't know until then whether the file has any clips);
    // `clock.getDelta()` drives time forward each render frame.
    const clock = new THREE.Clock();
    let mixer: THREE.AnimationMixer | null = null;

    const animate = () => {
      animationId = requestAnimationFrame(animate);
      const delta = clock.getDelta();
      mixer?.update(delta);
      controls.update();
      renderer.render(scene, camera);
    };

    const loader = new GLTFLoader();
    loader.load(
      url,
      (gltf) => {
        if (cancelled) return;
        const model = gltf.scene;
        // Start the first embedded animation (if any). Meshy ships a single
        // clip per animated GLB — picking index 0 covers the present cases
        // and is forward-compatible: an enhancement could later switch
        // between clips here without changing the loader/mixer wiring.
        if (gltf.animations.length > 0) {
          mixer = new THREE.AnimationMixer(model);
          mixer.clipAction(gltf.animations[0]).play();
        }
        // Center the model and fit it to the camera
        const box = new THREE.Box3().setFromObject(model);
        const size = box.getSize(new THREE.Vector3());
        const center = box.getCenter(new THREE.Vector3());
        model.position.sub(center);

        const maxDim = Math.max(size.x, size.y, size.z) || 1;
        const fitDistance = maxDim / (2 * Math.tan((Math.PI * camera.fov) / 360));
        const cameraPos = new THREE.Vector3(fitDistance, fitDistance, fitDistance * 1.5);
        camera.position.copy(cameraPos);
        camera.near = maxDim / 100;
        camera.far = maxDim * 100;
        camera.updateProjectionMatrix();

        controls.target.set(0, 0, 0);
        controls.update();

        // Update stored "initial" pose so Reset returns to the fitted view
        initialCameraPos.copy(camera.position);
        initialTarget.copy(controls.target);

        scene.add(model);
        setLoadState('ready');
      },
      undefined,
      (err) => {
        if (cancelled) return;
        // eslint-disable-next-line no-console
        console.error('[Model3DViewer] Failed to load model:', err);
        setErrorMessage(err instanceof Error ? err.message : 'Failed to load 3D model');
        setLoadState('error');
      }
    );

    animate();

    const resizeObserver = new ResizeObserver(() => {
      const w = container.clientWidth || 1;
      const h = container.clientHeight || 1;
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      renderer.setSize(w, h);
    });
    resizeObserver.observe(container);

    sceneStateRef.current = {
      renderer,
      scene,
      camera,
      controls,
      initialCameraPos,
      initialTarget,
      animationId,
      resizeObserver,
      studioTexture,
    };

    return () => {
      cancelled = true;
      cancelAnimationFrame(animationId);
      resizeObserver.disconnect();
      controls.dispose();
      studioTexture.dispose();
      // Dispose of every geometry / material / texture in the scene
      scene.traverse((object) => {
        if ((object as THREE.Mesh).isMesh) {
          const mesh = object as THREE.Mesh;
          mesh.geometry?.dispose();
          const material = mesh.material;
          if (Array.isArray(material)) {
            material.forEach((m) => m.dispose());
          } else if (material) {
            material.dispose();
          }
        }
      });
      renderer.dispose();
      // Force the WebGL context to be released
      const gl = renderer.getContext();
      const loseExt = gl.getExtension('WEBGL_lose_context');
      loseExt?.loseContext();
      if (renderer.domElement.parentElement === container) {
        container.removeChild(renderer.domElement);
      }
      sceneStateRef.current = null;
    };
  }, [url, format, previewable]);

  // Apply background changes whenever the user toggles a different option.
  // Kept separate from the mount effect so we don't tear down the scene on
  // every selection change.
  useEffect(() => {
    const state = sceneStateRef.current;
    if (!state) return;
    applyBackground(state.scene, state.renderer, background, state.studioTexture);
  }, [background]);

  const handleReset = () => {
    const state = sceneStateRef.current;
    if (!state) return;
    state.camera.position.copy(state.initialCameraPos);
    state.controls.target.copy(state.initialTarget);
    state.controls.update();
  };

  const handleGenerateFromSnapshot = async () => {
    const state = sceneStateRef.current;
    if (!state) return;
    if (!currentUser) {
      showErrorNotification({
        title: 'Login required',
        error: new Error('Please log in to send this image to the generator.'),
      });
      return;
    }
    setSnapshotting(true);
    try {
      // Force transparent for the capture so the model lands on a clean alpha
      // background — much better as an i2i reference than whatever backdrop the
      // user picked. Restore the user's choice immediately after.
      applyBackground(state.scene, state.renderer, 'transparent', state.studioTexture);
      // Render once synchronously so the drawing buffer holds the frame we
      // want before reading it out.
      state.renderer.render(state.scene, state.camera);

      const canvas = state.renderer.domElement;
      const dataUrl = canvas.toDataURL('image/png');
      const captureWidth = canvas.width;
      const captureHeight = canvas.height;

      // Restore user-selected background before we hand off — even if upload
      // fails, the viewer should look unchanged when control returns.
      applyBackground(state.scene, state.renderer, background, state.studioTexture);

      const filename = `model3d-snapshot-${Date.now()}.png`;
      const file = dataUrlToFile(dataUrl, filename);

      const upload = await uploadToCF(file);
      if (!upload?.id) {
        throw new Error('Image upload did not return an id.');
      }

      const imageUrl = buildEdgeUrlForId(upload.id, filename);

      // Seed the v2 generator with `img2img:edit` (the canonical "Image to
      // Image" workflow used by the modern ecosystems — Qwen, Flux Kontext,
      // etc.) plus the captured frame as the source. The plain `img2img` key
      // is the legacy "Image Variations" path on SD-family models — not what
      // we want here. We deliberately omit `ecosystem`/`model` — the user
      // picks those in the form. Empty resources avoids dragging in stale
      // checkpoint selections.
      //
      // `runType: 'append'` so the GenerationFormProvider's append branch
      // dedups by URL and merges the snapshot into any existing img2img:edit
      // images (either from the live snapshot or persisted localStorage)
      // — handy when the user wants to combine multiple captures or stack
      // a 3D frame on top of an existing reference set instead of replacing.
      generationGraphStore.setData({
        params: {
          workflow: 'img2img:edit',
          images: [{ url: imageUrl, width: captureWidth, height: captureHeight }],
        },
        resources: [],
        runType: 'append',
      });

      // `setData` only flips the panel's *view* setting; it doesn't actually
      // open a closed side panel. Explicit `open()` so the user sees the
      // generator side panel pop in with their snapshot already loaded.
      void generationGraphPanel.open();
    } catch (e) {
      // Best effort: also restore in the error path in case we threw between
      // the capture and the restore above.
      const restoreState = sceneStateRef.current;
      if (restoreState) {
        applyBackground(
          restoreState.scene,
          restoreState.renderer,
          background,
          restoreState.studioTexture
        );
      }
      showErrorNotification({
        title: 'Snapshot failed',
        error: e instanceof Error ? e : new Error('Failed to capture viewer snapshot.'),
      });
    } finally {
      setSnapshotting(false);
    }
  };

  return (
    <Stack gap="xs" className={className}>
      {isLarge && (
        <Alert
          icon={<IconAlertTriangle size={18} />}
          color="yellow"
          variant="light"
          title="Large file"
        >
          This model is{' '}
          {sizeKB ? `${(sizeKB / 1024).toFixed(1)} MB` : 'larger than 100 MB'} — the viewer may be
          slow on lower-end devices. Consider downloading the file instead.
        </Alert>
      )}

      {!previewable ? (
        <Box className="relative flex min-h-[320px] items-center justify-center rounded-md bg-gray-1 p-6 dark:bg-dark-7">
          <Stack align="center" gap="xs" maw={420} ta="center">
            <IconCubeOff size={48} stroke={1.5} />
            <Text fw={600}>This format isn&apos;t previewable</Text>
            <Text size="sm" c="dimmed">
              In-browser preview is only available for GLB / glTF. Download the{' '}
              <Text span fw={600} tt="uppercase">
                {format}
              </Text>{' '}
              file to view it locally in your modeling tool of choice.
            </Text>
            <Button
              component="a"
              href={url}
              download
              leftSection={<IconDownload size={16} />}
              variant="light"
              mt="xs"
            >
              Download {format.toUpperCase()}
            </Button>
          </Stack>
        </Box>
      ) : (
        <Box className={clsx('relative', compact && 'h-full w-full')}>
          {/* `group` lets the overlays fade in on hover without intercepting
              orbit gestures — controls themselves stay pointer-interactive.

              Compact callers (Model3DCard's preview overlay, the generator
              queue card) already constrain the viewer to a smaller box —
              `min-h-[480px]` would overflow that container, the parent's
              `overflow: hidden` would clip the bottom, and the camera-fit
              math (which targets the actual canvas dimensions, not the
              visible region) would land the model below the visible area.
              In compact mode the container fills its parent instead. */}
          <div
            ref={containerRef}
            className={clsx(
              'group relative w-full overflow-hidden rounded-md bg-dark-7',
              compact ? 'h-full' : 'min-h-[480px]',
              loadState === 'loading' && 'opacity-50'
            )}
          >
            {loadState === 'ready' && !compact && (
              <>
                {/* Background picker — top-right, fades in on hover/focus.
                    Suppressed in `compact` mode (feed card preview) where the
                    parent already renders Open / Close controls on top of the
                    viewer and the picker would otherwise overlap them. */}
                <div
                  className={clsx(
                    'pointer-events-auto absolute right-2 top-2 z-10',
                    'opacity-0 transition-opacity duration-150 group-hover:opacity-100 focus-within:opacity-100'
                  )}
                  // OrbitControls listen on the canvas; stopping propagation
                  // here keeps clicks on the picker from being misread as
                  // orbit drags. Pointer events (used by OrbitControls) bubble
                  // through React's onMouseDown too, so we cover both.
                  onMouseDown={(e) => e.stopPropagation()}
                  onPointerDown={(e) => e.stopPropagation()}
                  onWheel={(e) => e.stopPropagation()}
                >
                  <SegmentedControl
                    size="xs"
                    value={background}
                    onChange={(v) => setBackground(v as BackgroundOption)}
                    data={BACKGROUND_OPTIONS}
                    styles={{
                      root: {
                        backgroundColor: 'rgba(20, 20, 20, 0.75)',
                        backdropFilter: 'blur(4px)',
                      },
                    }}
                  />
                </div>

                {/* Bottom-right action group — Reset view + Generate-with-this-image
                    CTA. Same hover/focus fade as the picker so they don't crowd
                    the scene by default. Reset sits left of Generate so the
                    primary CTA stays in the canonical bottom-right slot. */}
                <div
                  className={clsx(
                    'pointer-events-auto absolute bottom-2 right-2 z-10 flex items-center gap-2',
                    'opacity-0 transition-opacity duration-150 group-hover:opacity-100 focus-within:opacity-100'
                  )}
                  onMouseDown={(e) => e.stopPropagation()}
                  onPointerDown={(e) => e.stopPropagation()}
                  onWheel={(e) => e.stopPropagation()}
                >
                  <Tooltip label="Reset the camera to the initial fitted view." withArrow>
                    <Button
                      size="xs"
                      variant="filled"
                      color="dark"
                      leftSection={<IconRefresh size={14} />}
                      onClick={handleReset}
                    >
                      Reset view
                    </Button>
                  </Tooltip>
                  <Tooltip
                    label="Capture the current view and send it to the generator as an img2img reference."
                    multiline
                    w={240}
                    withArrow
                  >
                    <Button
                      size="xs"
                      variant="filled"
                      color="blue"
                      leftSection={<IconWand size={14} />}
                      onClick={handleGenerateFromSnapshot}
                      loading={snapshotting}
                    >
                      Generate with this image
                    </Button>
                  </Tooltip>
                </div>
              </>
            )}
          </div>
          {loadState === 'loading' && (
            <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
              <Text size="sm" c="dimmed">
                Loading 3D model…
              </Text>
            </div>
          )}
          {loadState === 'error' && (
            <div className="pointer-events-none absolute inset-0 flex items-center justify-center p-4">
              <Alert color="red" variant="light" title="Failed to load 3D model">
                {errorMessage ?? 'The 3D model file could not be loaded.'}
              </Alert>
            </div>
          )}
        </Box>
      )}
    </Stack>
  );
}

export default Model3DViewer;

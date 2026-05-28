import { Alert, Box, Button, Group, Stack, Text } from '@mantine/core';
import { IconAlertTriangle, IconCubeOff, IconDownload, IconRefresh } from '@tabler/icons-react';
import clsx from 'clsx';
import { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';

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
};

const LARGE_FILE_KB = 100_000; // 100 MB
const SUPPORTED_PREVIEW_FORMATS = ['glb', 'gltf'];

function isPreviewable(format: string) {
  return SUPPORTED_PREVIEW_FORMATS.includes(format.toLowerCase());
}

export function Model3DViewer({ url, format, sizeKB, className }: Model3DViewerProps) {
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
  } | null>(null);

  const [loadState, setLoadState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

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
    scene.background = new THREE.Color(0x1a1a1a);

    const camera = new THREE.PerspectiveCamera(50, width / height, 0.1, 1000);
    camera.position.set(2, 2, 3);

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(window.devicePixelRatio);
    renderer.setSize(width, height);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    container.appendChild(renderer.domElement);

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

    const animate = () => {
      animationId = requestAnimationFrame(animate);
      controls.update();
      renderer.render(scene, camera);
    };

    const loader = new GLTFLoader();
    loader.load(
      url,
      (gltf) => {
        if (cancelled) return;
        const model = gltf.scene;
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
    };

    return () => {
      cancelled = true;
      cancelAnimationFrame(animationId);
      resizeObserver.disconnect();
      controls.dispose();
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

  const handleReset = () => {
    const state = sceneStateRef.current;
    if (!state) return;
    state.camera.position.copy(state.initialCameraPos);
    state.controls.target.copy(state.initialTarget);
    state.controls.update();
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
        <Box className="relative">
          <div
            ref={containerRef}
            className={clsx(
              'relative min-h-[480px] w-full overflow-hidden rounded-md bg-dark-7',
              loadState === 'loading' && 'opacity-50'
            )}
          />
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
          <Group gap="xs" justify="flex-end" mt="xs">
            <Button
              size="xs"
              variant="light"
              leftSection={<IconRefresh size={14} />}
              onClick={handleReset}
              disabled={loadState !== 'ready'}
            >
              Reset view
            </Button>
          </Group>
        </Box>
      )}
    </Stack>
  );
}

export default Model3DViewer;

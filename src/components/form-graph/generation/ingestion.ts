import { useEffect, useRef } from 'react';
import { readIntentValue } from 'form-graph';

import {
  openCompatibilityConfirmModal,
  buildWorkflowPendingChange,
} from '~/components/generation_v2/CompatibilityConfirmModal';
import { toResourceData } from '~/components/generation_v2/GenerationFormProvider';
import {
  decodeGenerationHandoff,
  GENERATION_HANDOFF_PARAM,
} from '~/components/generation_v2/utils/generation-url-handoff';
import {
  ecosystemByKey,
  ecosystemById,
  getEcosystem,
  areResourcesCompatible,
  filterCompatibleResources,
  getBaseModelsByEcosystemId,
  MODEL3D_ECOSYSTEM_KEYS,
} from '~/shared/constants/basemodel.constants';
import {
  workflowConfigByKey,
  isWorkflowAvailable,
  getEcosystemsForWorkflow,
} from '~/shared/data-graph/generation/config/workflows';
import type { ResourceData, SnippetsNodeValue } from '~/shared/data-graph/generation/common';
import { splitResourcesByType } from '~/shared/utils/resource.utils';
import {
  useGenerationGraphStore,
  generationGraphStore,
  generationGraphPanel,
} from '~/store/generation-graph.store';
import { workflowPreferences } from '~/store/workflow-preferences.store';

import type { GenerationStore } from './store';

/**
 * The new lane's ingestion: everything that pushes data INTO the generator
 * from outside — Remix buttons site-wide, preset apply, the cross-domain
 * `?gen=` handoff, wildcard loads, image append. A transcription of v1
 * GenerationFormProvider's state machine onto the form-graph store: same
 * run-types, same policies, `graph.reset/set/getSnapshot` becoming
 * `store.reset/set/getSnapshot().state`. The one storage read (append's
 * per-workflow images) goes through the store's own intent record instead of
 * v1's per-workflow localStorage keys.
 */
export function useGenerationIngestion(store: GenerationStore) {
  // Cross-domain handoff: a `?gen=...` param means another domain (typically
  // .com → .red via the yellow-buzz upsell) sent us its current form
  // snapshot. Decode it, push into the graph store as a remix, and strip the
  // param so refresh/back doesn't re-trigger. Runs before the applyStoreData
  // effect below so the queued data is picked up by its initial mount run.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const url = new URL(window.location.href);
    const handoff = url.searchParams.get(GENERATION_HANDOFF_PARAM);
    if (!handoff) return;

    const decoded = decodeGenerationHandoff(handoff);

    url.searchParams.delete(GENERATION_HANDOFF_PARAM);
    window.history.replaceState(null, '', url.pathname + url.search + url.hash);

    if (!decoded) return;

    generationGraphStore.setData({
      params: decoded.params,
      resources: decoded.resources,
      runType: 'remix',
    });
  }, []);

  // `/generate?modelVersionId=…` deep link. Scoped to the generate route on
  // purpose: model pages use the same param to pick a version, and the panel
  // mounts there too — without the guard, opening a model page would yank the
  // generator open. Yields to a `?gen=` handoff, which has already queued
  // data by the time this runs.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (!window.location.pathname.startsWith('/generate')) return;

    const url = new URL(window.location.href);
    const raw = url.searchParams.get('modelVersionId');
    if (!raw) return;

    url.searchParams.delete('modelVersionId');
    window.history.replaceState(null, '', url.pathname + url.search + url.hash);

    if (useGenerationGraphStore.getState().data) return;

    const id = Number(raw);
    if (!Number.isInteger(id) || id <= 0) return;

    generationGraphPanel.open({ type: 'modelVersion', id });
  }, []);

  // Sync generation graph store data into the form
  // - Remix/Replay: full override (reset + set)
  // - Run/Patch: partial update (set only)
  const prevCounterRef = useRef(0);
  useEffect(() => {
    function applyStoreData() {
      const { data, counter } = useGenerationGraphStore.getState();
      if (!data || counter === prevCounterRef.current) return;
      prevCounterRef.current = counter;
      applyGenerationData(store, data);
    }

    // Check on mount (data may arrive before component mounts)
    applyStoreData();

    // Subscribe to future changes
    return useGenerationGraphStore.subscribe(applyStoreData);
  }, [store]);
}

type GenerationData = NonNullable<ReturnType<typeof useGenerationGraphStore.getState>['data']>;

/** The run-type policy, pure over the store — exported for the parity tests. */
export function applyGenerationData(store: GenerationStore, data: GenerationData) {
  const state = () => store.getSnapshot().state as Record<string, unknown>;

  // Params are already mapped via mapDataToGraphInput (workflow,
  // ecosystem, aspectRatio, etc.); split flat resources into
  // model/resources/vae for the form's fields.
  const split = splitResourcesByType(data.resources.map(toResourceData));

  if (data.runType === 'remix' || data.runType === 'replay') {
    // Exclude output settings from remixed params so they don't override current values
    const { quantity, priority, outputFormat, ...paramsWithoutOutputSettings } = data.params;
    void quantity;
    void priority;
    void outputFormat;

    const remixEcosystemKey = paramsWithoutOutputSettings.ecosystem as string | undefined;
    const incomingWorkflow = paramsWithoutOutputSettings.workflow as string | undefined;

    // PolyGen short-circuit: detect a 3D-model remix from either the
    // ecosystem key or the workflow key, before any "unknown-workflow
    // fallback" can rewrite it to `txt2img`.
    const isPolyGenRemix =
      (!!remixEcosystemKey && MODEL3D_ECOSYSTEM_KEYS.has(remixEcosystemKey)) ||
      incomingWorkflow === 'txt2model3d' ||
      incomingWorkflow === 'img2model3d';

    const model3dEcosystem =
      remixEcosystemKey && MODEL3D_ECOSYSTEM_KEYS.has(remixEcosystemKey)
        ? remixEcosystemKey
        : 'PolyGen';

    let resolvedWorkflow: string;
    if (isPolyGenRemix) {
      // 3D path: keep an incoming 3D workflow verbatim; only PolyGen has
      // a text branch, so consult `process` for it.
      resolvedWorkflow =
        incomingWorkflow === 'txt2model3d' || incomingWorkflow === 'img2model3d'
          ? incomingWorkflow
          : model3dEcosystem !== 'PolyGen' ||
            paramsWithoutOutputSettings.process === 'imageTo3D' ||
            paramsWithoutOutputSettings.process === 'multiImageTo3D'
          ? 'img2model3d'
          : 'txt2model3d';
    } else if (incomingWorkflow && workflowConfigByKey.has(incomingWorkflow)) {
      resolvedWorkflow = incomingWorkflow;
    } else {
      // Workflow unknown — infer output type from the workflow key prefix or ecosystem
      const isVideoWorkflow =
        incomingWorkflow?.includes('2vid') || incomingWorkflow?.startsWith('vid2');
      const remixEcoEntry = remixEcosystemKey ? ecosystemByKey.get(remixEcosystemKey) : undefined;
      const isVideoEco =
        remixEcoEntry &&
        getBaseModelsByEcosystemId(remixEcoEntry.id).some((m) =>
          Array.isArray(m.type) ? m.type.includes('video') : m.type === 'video'
        );
      resolvedWorkflow = isVideoWorkflow || isVideoEco ? 'txt2vid' : 'txt2img';
    }

    const remixEco = remixEcosystemKey ? ecosystemByKey.get(remixEcosystemKey) : undefined;
    const ecosystemSupportsWorkflow = isPolyGenRemix
      ? true
      : remixEco
      ? isWorkflowAvailable(resolvedWorkflow, remixEco.id)
      : !remixEcosystemKey;

    const remixValues = {
      ...paramsWithoutOutputSettings,
      ...(isPolyGenRemix ? { ecosystem: model3dEcosystem } : {}),
      workflow: resolvedWorkflow,
      model: split.model,
      upscaler: split.upscaler,
      resources: split.resources,
      vae: split.vae,
    };

    if (!ecosystemSupportsWorkflow && remixEcosystemKey) {
      openCompatibilityConfirmModal({
        pendingChange: buildWorkflowPendingChange({
          workflowId: resolvedWorkflow,
          currentEcosystem: remixEcosystemKey,
        }),
        onConfirm: (selectedEcosystemKey) => {
          if (selectedEcosystemKey) {
            store.reset({ exclude: ['quantity', 'priority', 'outputFormat'] });
            store.set({ ...remixValues, ecosystem: selectedEcosystemKey });
          }
        },
      });
    } else {
      store.reset({ exclude: ['quantity', 'priority', 'outputFormat'] });
      // Two-stage set for 3D remixes: switch the discriminators first so
      // every PolyGen-specific value lands in the ACTIVE subgraph (a
      // single set can evaluate child keys before the branch switched).
      if (
        isPolyGenRemix &&
        (resolvedWorkflow === 'txt2model3d' || resolvedWorkflow === 'img2model3d')
      ) {
        store.set({ ecosystem: model3dEcosystem, workflow: resolvedWorkflow });
      }
      store.set(remixValues);
    }
  } else if (data.runType === 'wildcard') {
    // Add a wildcard set id to the snippets node, preserving the user's
    // existing mode/batchCount/targets/seed. Idempotent.
    const wildcardSetId = data.params.wildcardSetId as number | undefined;
    if (wildcardSetId != null) {
      const existing = state().snippets as SnippetsNodeValue | undefined;
      if (!existing?.wildcardSetIds.includes(wildcardSetId)) {
        const nextSnippets: SnippetsNodeValue = existing
          ? { ...existing, wildcardSetIds: [...existing.wildcardSetIds, wildcardSetId] }
          : { wildcardSetIds: [wildcardSetId], mode: 'random', batchCount: 1, targets: {} };
        store.set({ snippets: nextSnippets });
      }
    }
  } else if (data.runType === 'append') {
    // Append: merge incoming images with existing, dedup by URL.
    const snap = state();
    const targetWorkflow = data.params.workflow as string;
    let existingImages: Array<{ url: string }> = [];
    if (snap.workflow === targetWorkflow) {
      existingImages = ((snap.images ?? []) as Array<{ url: string }>) || [];
    } else {
      // Switching workflows — read the TARGET workflow's stored images
      // from the store's own intent record (images are workflow-scoped).
      existingImages =
        (readIntentValue(store.getIntent(), 'images', targetWorkflow) as Array<{
          url: string;
        }>) ?? [];
    }
    const incomingImages =
      ((data.params.images ?? []) as Array<{ url: string; width: number; height: number }>) || [];

    const existingUrls = new Set(existingImages.map((img) => img.url));
    const newImages = incomingImages.filter((img) => !existingUrls.has(img.url));
    const mergedImages = [...existingImages, ...newImages];

    store.set({ workflow: targetWorkflow, images: mergedImages });
  } else {
    // Run/Patch: model/vae overwrite, resources merge with existing
    const snap = state();
    const existingResources = (snap.resources ?? []) as ResourceData[];
    const incomingIds = new Set(split.resources.map((r) => r.id));

    // Preserve the current ecosystem when ALL incoming resources are
    // compatible with it; switch only on a truly incompatible resource.
    const currentEcosystem = snap.ecosystem as string | undefined;
    const currentEco = currentEcosystem ? ecosystemByKey.get(currentEcosystem) : undefined;
    const allCompatible = currentEco && areResourcesCompatible(currentEco.id, data.resources);

    const incomingEcosystem = data.params.ecosystem as string | undefined;

    const currentWorkflow = snap.workflow as string | undefined;
    const currentWorkflowConfig = currentWorkflow
      ? workflowConfigByKey.get(currentWorkflow)
      : undefined;
    let targetWorkflow = data.params.workflow as string | undefined;

    // Upscaler models always switch to the upscale workflow
    if (split.upscaler) {
      targetWorkflow = 'img2img:upscale';
    }

    if (
      !targetWorkflow &&
      currentWorkflowConfig &&
      currentWorkflowConfig.ecosystemIds.length === 0
    ) {
      // Current workflow has no ecosystems (e.g. img2meta) — land on the
      // user's last used workflow that fits the resource's ecosystem.
      const resourceWithBaseModel =
        split.resources.find((r) => r.model.type === 'Checkpoint') ??
        split.resources.find((r) => r.baseModel);
      const resourceEcosystem = resourceWithBaseModel?.baseModel
        ? getEcosystem(resourceWithBaseModel.baseModel)
        : undefined;

      if (resourceEcosystem) {
        const lastUsed = workflowPreferences.getLastUsedWorkflowForEcosystem(resourceEcosystem.id);
        targetWorkflow = lastUsed?.workflow ?? 'txt2img';
      } else {
        const lastUsed = workflowPreferences.getLastUsedWorkflow();
        targetWorkflow = lastUsed?.workflow ?? 'txt2img';
      }
    }

    // No current ecosystem and incoming resources fit several — let the
    // user choose rather than silently picking one.
    if (!currentEco && !allCompatible) {
      const resolvedWorkflow = targetWorkflow ?? currentWorkflow ?? 'txt2img';
      const workflowEcosystemIds = getEcosystemsForWorkflow(resolvedWorkflow);
      const compatibleEcosystemIds = workflowEcosystemIds.filter((ecoId) =>
        areResourcesCompatible(ecoId, data.resources)
      );

      if (compatibleEcosystemIds.length > 1) {
        const lastUsed = workflowPreferences.getLastUsedWorkflow();
        const lastUsedEco = lastUsed?.ecosystem
          ? ecosystemByKey.get(lastUsed.ecosystem)
          : undefined;
        const lastUsedIsCompatible = lastUsedEco && compatibleEcosystemIds.includes(lastUsedEco.id);

        const resolvedDefault =
          (lastUsedIsCompatible ? lastUsed!.ecosystem : undefined) ??
          (compatibleEcosystemIds[0]
            ? ecosystemById.get(compatibleEcosystemIds[0])?.key
            : undefined) ??
          '';

        openCompatibilityConfirmModal({
          pendingChange: {
            type: 'workflow',
            value: resolvedWorkflow,
            optionId: resolvedWorkflow,
            currentEcosystem: incomingEcosystem ?? '',
            compatibleEcosystemIds,
            defaultEcosystemKey: resolvedDefault,
          },
          onConfirm: (selectedEcosystemKey) => {
            if (selectedEcosystemKey) {
              // Step 1: switch workflow+ecosystem so the store restores
              // that branch's remembered resources from its buckets.
              const { ecosystem: _, ...restParams } = data.params;
              void _;
              store.set({
                ...restParams,
                ecosystem: selectedEcosystemKey,
                workflow: resolvedWorkflow,
              });
              // Step 2: merge incoming on top of the restored resources.
              const restoredResources = (state().resources ?? []) as ResourceData[];
              const selectedEco = ecosystemByKey.get(selectedEcosystemKey);
              const filtered = selectedEco
                ? filterCompatibleResources(selectedEco.id, restoredResources, incomingIds)
                : restoredResources.filter((r) => !incomingIds.has(r.id));
              const merged = [...filtered, ...split.resources];
              store.set({
                resources: merged,
                ...(split.model && { model: split.model }),
                ...(split.vae && { vae: split.vae }),
              });
            }
          },
        });
        generationGraphStore.clearData();
        return;
      }
    }

    const effectiveEcosystemKey = allCompatible ? currentEcosystem : incomingEcosystem;
    const effectiveEcosystem = effectiveEcosystemKey
      ? ecosystemByKey.get(effectiveEcosystemKey)
      : undefined;

    const compatibleExisting = effectiveEcosystem
      ? filterCompatibleResources(effectiveEcosystem.id, existingResources, incomingIds)
      : existingResources.filter((r) => !incomingIds.has(r.id));

    const mergedResources = [...compatibleExisting, ...split.resources];

    const { ecosystem: _incomingEco, ...paramsWithoutEcosystem } = data.params;
    void _incomingEco;
    const values = {
      ...(allCompatible ? paramsWithoutEcosystem : data.params),
      ...(targetWorkflow && { workflow: targetWorkflow }),
      resources: mergedResources,
      ...(split.model && { model: split.model }),
      ...(split.upscaler && { upscaler: split.upscaler }),
      ...(split.vae && { vae: split.vae }),
    };
    store.set(values);
  }

  generationGraphStore.clearData();
}

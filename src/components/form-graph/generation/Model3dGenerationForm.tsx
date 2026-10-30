import { Checkbox, NumberInput, Stack, Textarea } from '@mantine/core';
import { FieldCorrectionNote } from './FieldCorrectionNote';
import { AccordionLayout } from '~/components/generation_v2/AccordionLayout';
import { Controller } from 'form-graph/react';

import { GenerationTextEditor } from '~/components/Generate/Input/GenerationTextEditor';
import { ImageUploadMultipleInput } from '~/components/generation_v2/inputs/ImageUploadMultipleInput';
import { SeedInput } from '~/components/generation_v2/inputs/SeedInput';
import { SliderInput } from '~/components/generation_v2/inputs/SliderInput';
import { ButtonGroupInput } from '~/libs/form/components/ButtonGroupInput';
import { model3dHub } from '~/shared/form-graph/generation/model3d/hub.graph';
import { model3dFieldLabels as labels } from '~/shared/form-graph/generation/model3d/model3d-params';

import { ControllerLabel, PromptLabel } from './form-helpers';
import { GateRuleWarnings } from './GateRuleWarnings';
import type { GenerationStore } from './store';

/**
 * The MODEL3D generation form — one `<Controller graph={model3dHub}>` per
 * field. The graph decides visibility (PolyGen v6/v7 vs Tripo v2.5/H3.1 vs the comfy
 * pipelines), so this holds the superset of 3D fields.
 */

function OptionButtons({
  label,
  info,
  value,
  options,
  onChange,
}: {
  label: string;
  info?: string;
  value: string;
  options: readonly { label: string; value: string }[] | undefined;
  onChange: (v: string) => void;
}) {
  return (
    <div className="flex flex-col gap-1">
      <ControllerLabel label={label} info={info} />
      <ButtonGroupInput
        value={value}
        onChange={onChange}
        data={(options ?? []).map((o) => ({ label: o.label, value: o.value }))}
      />
    </div>
  );
}

export function Model3dGenerationForm({ store }: { store: GenerationStore }) {
  return (
    <Stack gap="sm">
      <GateRuleWarnings />
      <Controller
        graph={model3dHub}
        name="version"
        render={({ value, meta, onChange }) =>
          (meta?.options.length ?? 0) < 2 ? null : (
            <OptionButtons
              label={labels.version}
              info={meta?.info}
              value={value}
              options={meta?.options}
              onChange={(v) => {
                const snap = store.getSnapshot().state as { workflow?: string };
                const picked = meta?.options.find((o) => o.value === v);
                if (picked && 'imageOnly' in picked && snap.workflow === 'txt2model3d') {
                  store.set({ workflow: 'img2model3d', version: v as typeof value });
                  return;
                }
                onChange(v as typeof value);
              }}
            />
          )
        }
      />
      <Controller
        graph={model3dHub}
        name="mode"
        render={({ value, meta, onChange }) => (
          <OptionButtons
            label={labels.mode}
            info={meta?.info}
            value={value}
            options={meta?.options}
            onChange={(v) => onChange(v as typeof value)}
          />
        )}
      />
      <Controller
        graph={model3dHub}
        name="prompt"
        render={({ value, meta, onChange, error }) => (
          <GenerationTextEditor
            value={value}
            onChange={onChange}
            label={
              <PromptLabel
                store={store}
                prompt={value}
                label={labels.prompt}
                info={meta?.info}
                required={meta && 'required' in meta ? meta.required : undefined}
              />
            }
            placeholder={meta?.placeholder}
            error={error?.message}
          />
        )}
      />
      <Controller
        graph={model3dHub}
        name="enablePromptExpansion"
        render={({ value, onChange }) => (
          <Checkbox
            label={labels.enablePromptExpansion}
            description="Let Meshy expand the prompt with extra descriptive detail"
            checked={value}
            onChange={(e) => onChange(e.currentTarget.checked)}
          />
        )}
      />
      <Controller
        graph={model3dHub}
        name="images"
        render={({ value, meta, onChange, error }) => (
          <ImageUploadMultipleInput
            label={meta && (meta.max ?? 1) > 1 ? 'Starting images' : 'Starting image'}
            value={value}
            onChange={onChange}
            max={meta?.max}
            error={error?.message}
          />
        )}
      />
      <Controller
        graph={model3dHub}
        name="shouldTexture"
        render={({ value, onChange }) => (
          <Checkbox
            label={labels.shouldTexture}
            description="Apply automatic texture to the generated mesh"
            checked={value}
            onChange={(e) => onChange(e.currentTarget.checked)}
          />
        )}
      />
      <Controller
        graph={model3dHub}
        name="targetPolycount"
        render={({ value, meta, onChange }) => (
          <SliderInput
            label={
              <ControllerLabel
                label={labels.targetPolycount}
                info="Final triangle count target. Higher means more detail in the generated mesh."
              />
            }
            value={value}
            onChange={onChange}
            min={meta?.min ?? 100}
            max={meta?.max ?? 300_000}
            step={meta?.step ?? 100}
            presets={meta?.presets}
          />
        )}
      />
      <Controller
        graph={model3dHub}
        name="topology"
        render={({ value, meta, onChange }) => (
          <OptionButtons
            label={labels.topology}
            info="Choose triangles for hard-surface and game-ready meshes; choose quads for organic shapes and downstream sculpting."
            value={value}
            options={meta?.options}
            onChange={(v) => onChange(v as typeof value)}
          />
        )}
      />
      <Controller
        graph={model3dHub}
        name="symmetryMode"
        render={({ value, meta, onChange }) => (
          <OptionButtons
            label={labels.symmetryMode}
            info="Auto detects bilateral symmetry from the prompt or source image. Use On to force a symmetric mesh, or Off to disable for asymmetric subjects."
            value={value}
            options={meta?.options}
            onChange={(v) => onChange(v as typeof value)}
          />
        )}
      />
      <Controller
        graph={model3dHub}
        name="poseMode"
        render={({ value, meta, onChange }) => (
          <OptionButtons
            label={labels.poseMode}
            info="Force the character into an A-pose or T-pose, which rigs and animates more reliably. Auto lets Meshy keep the pose from your image."
            value={value}
            options={meta?.options}
            onChange={(v) => onChange(v as typeof value)}
          />
        )}
      />
      <Controller
        graph={model3dHub}
        name="modelType"
        render={({ value, meta, onChange }) => (
          <OptionButtons
            label={labels.modelType}
            info="Low poly produces a stylized, game-ready mesh and ignores the polycount, topology and remesh controls."
            value={value}
            options={meta?.options}
            onChange={(v) => onChange(v as typeof value)}
          />
        )}
      />
      <Controller
        graph={model3dHub}
        name="ultraMode"
        render={({ value, onChange }) => (
          <Checkbox
            label={labels.ultraMode}
            description="Higher-fidelity geometry with finer surface detail (slower and more expensive)"
            checked={value}
            onChange={(e) => onChange(e.currentTarget.checked)}
          />
        )}
      />
      <Controller
        graph={model3dHub}
        name="texture"
        render={({ value, meta, onChange }) => (
          <OptionButtons
            label={labels.texture}
            info="Texture quality. Standard is balanced; HD produces higher-resolution textures; None skips texturing for a bare mesh."
            value={value}
            options={meta?.options}
            onChange={(v) => onChange(v as typeof value)}
          />
        )}
      />
      <Controller
        graph={model3dHub}
        name="geometryQuality"
        render={({ value, meta, onChange }) => (
          <OptionButtons
            label={labels.geometryQuality}
            info="Detailed produces finer geometry and costs more."
            value={value}
            options={meta?.options}
            onChange={(v) => onChange(v as typeof value)}
          />
        )}
      />
      <Controller
        graph={model3dHub}
        name="textureAlignment"
        render={({ value, meta, onChange }) => (
          <OptionButtons
            label={labels.textureAlignment}
            info="Align textures to the original image or to the generated geometry."
            value={value}
            options={meta?.options}
            onChange={(v) => onChange(v as typeof value)}
          />
        )}
      />
      <Controller
        graph={model3dHub}
        name="orientation"
        render={({ value, meta, onChange }) => (
          <OptionButtons
            label={labels.orientation}
            info="Use Align to image to rotate the mesh to match the source image's viewpoint."
            value={value}
            options={meta?.options}
            onChange={(v) => onChange(v as typeof value)}
          />
        )}
      />
      <Controller
        graph={model3dHub}
        name="quad"
        render={({ value, onChange }) => (
          <Checkbox
            label={labels.quad}
            description="Output quad-based topology (exported as FBX instead of GLB)."
            checked={value}
            onChange={(e) => onChange(e.currentTarget.checked)}
          />
        )}
      />
      <Controller
        graph={model3dHub}
        name="autoSize"
        render={({ value, onChange }) => (
          <Checkbox
            label={labels.autoSize}
            description="Automatically scale the mesh to real-world proportions."
            checked={value}
            onChange={(e) => onChange(e.currentTarget.checked)}
          />
        )}
      />
      <Controller
        graph={model3dHub}
        name="faceLimit"
        render={({ value, meta, onChange }) => (
          <NumberInput
            label={
              <ControllerLabel
                label={labels.faceLimit}
                info="Maximum number of faces in the generated mesh. Leave blank to let Tripo choose automatically."
              />
            }
            value={value ?? ''}
            onChange={(v) => onChange(typeof v === 'number' ? v : undefined)}
            min={meta?.min}
            max={meta?.max}
            step={1000}
            placeholder={meta?.placeholder ?? 'Auto'}
            allowDecimal={false}
          />
        )}
      />
      <Controller
        graph={model3dHub}
        name="textureSeed"
        render={({ value, meta, onChange }) => (
          <SeedInput value={value} onChange={onChange} label={labels.textureSeed} max={meta?.max} />
        )}
      />
      <Controller
        graph={model3dHub}
        name="steps"
        render={({ value, meta, onChange }) => (
          <SliderInput
            label={<ControllerLabel label={labels.steps} info={meta?.info} />}
            value={value}
            onChange={onChange}
            min={meta?.min ?? 10}
            max={meta?.max ?? 50}
            step={meta?.step ?? 1}
          />
        )}
      />
      <Controller
        graph={model3dHub}
        name="cfgScale"
        render={({ value, meta, onChange }) => (
          <SliderInput
            label={<ControllerLabel label={labels.cfgScale} info={meta?.info} />}
            value={value}
            onChange={onChange}
            min={meta?.min ?? 0}
            max={meta?.max ?? 20}
            step={meta?.step ?? 0.5}
          />
        )}
      />
      <Controller
        graph={model3dHub}
        name="octreeResolution"
        render={({ value, meta, onChange }) => (
          <OptionButtons
            label={labels.octreeResolution}
            info={meta?.info}
            value={String(value)}
            options={meta?.options?.map((o) => ({ label: o.label, value: String(o.value) }))}
            onChange={(v) => onChange(Number(v) as typeof value)}
          />
        )}
      />
      <AccordionLayout label="Advanced" storeKey="form-graph-model3d-advanced">
        <Controller
          graph={model3dHub}
          name="texturePrompt"
          render={({ value, meta, onChange }) => (
            <Textarea
              label={
                <ControllerLabel
                  label={labels.texturePrompt}
                  info="Optional. Describe the material, finish, or style for the generated texture. Leave blank to let Meshy infer from the main prompt."
                />
              }
              placeholder={meta?.placeholder ?? 'Weathered oak with bronze fittings…'}
              value={value ?? ''}
              onChange={(e) => onChange(e.currentTarget.value)}
              autosize
              minRows={2}
              maxLength={meta?.maxLength}
            />
          )}
        />
        <Controller
          graph={model3dHub}
          name="shouldRemesh"
          render={({ value, onChange }) => (
            <Checkbox
              label={labels.shouldRemesh}
              description="Re-tessellate the mesh for cleaner topology"
              checked={value}
              onChange={(e) => onChange(e.currentTarget.checked)}
            />
          )}
        />
        <Controller
          graph={model3dHub}
          name="enablePbr"
          render={({ value, onChange }) => (
            <Checkbox
              label={labels.enablePbr}
              description="Generate physically-based rendering textures (albedo, normal, roughness)"
              checked={value}
              onChange={(e) => onChange(e.currentTarget.checked)}
            />
          )}
        />
        <Controller
          graph={model3dHub}
          name="enableAnimation"
          render={({ value, onChange }) => (
            <Checkbox
              label={labels.enableAnimation}
              description="Generate a rigged, animated mesh (skeleton + idle animation)"
              checked={value}
              onChange={(e) => onChange(e.currentTarget.checked)}
            />
          )}
        />
        <Controller
          graph={model3dHub}
          name="riggingHeightMeters"
          render={({ value, meta, onChange }) => (
            <SliderInput
              label={
                <ControllerLabel
                  label={labels.riggingHeightMeters}
                  info="Approximate real-world height of the character, used to scale the skeleton."
                />
              }
              value={value}
              onChange={onChange}
              min={meta?.min ?? 0.1}
              max={meta?.max ?? 10}
              step={meta?.step ?? 0.1}
              precision={1}
            />
          )}
        />
        <Controller
          graph={model3dHub}
          name="animationActionId"
          render={({ value, meta, onChange }) => (
            <NumberInput
              label={
                <ControllerLabel
                  label={labels.animationActionId}
                  info="Id from Meshy's animation library. 0 is Idle; see https://docs.meshy.ai/en/api/animation-library for the full list."
                />
              }
              value={value ?? ''}
              onChange={(v) => onChange(typeof v === 'number' ? v : undefined)}
              min={meta?.min}
              max={meta?.max}
              placeholder={meta?.placeholder ?? '0 (Idle)'}
              allowDecimal={false}
            />
          )}
        />
        <Controller
          graph={model3dHub}
          name="seed"
          render={({ value, meta, onChange, note }) => (
            <div className="flex flex-col gap-1">
              <SeedInput value={value} onChange={onChange} label={labels.seed} max={meta?.max} />
              <FieldCorrectionNote note={note} />
            </div>
          )}
        />
      </AccordionLayout>
    </Stack>
  );
}

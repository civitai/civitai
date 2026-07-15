# Reve 2.1 — Model version baseModel + description update

Data updates for the mirrored **Reve** model on the `CivitaiOfficial` account. These
are plain `UPDATE`s against existing rows (not a Prisma migration) and must be
**applied manually** to each target environment (preview / staging / prod) — we do
not run `prisma migrate deploy`.

## Target rows (confirmed on the replica)

| Field               | Value                                                                               |
| ------------------- | ----------------------------------------------------------------------------------- |
| ModelVersion id     | `3133202` (version name `v2.1`)                                                     |
| Current `baseModel` | `SD 1.5` (placeholder) → **`Reve`**                                                 |
| Model id            | `2781889` (name `Reve`, type `Checkpoint`, owner `CivitaiOfficial`, status `Draft`) |

`Reve` matches the new `BaseModelRecord.name` added in
[basemodel.constants.ts](../src/shared/constants/basemodel.constants.ts), so the
version resolves to the new `Reve` ecosystem once this branch ships. The base-model
name is intentionally the generic brand (not `Reve 2.1`) so a future **Reve 2.2**
is just another `ModelVersion` under the same ecosystem — mirroring HappyHorse
(one `HappyHorse` base model, multiple versions selected in the graph).

> Apply the code change (this branch) and the SQL together. The `baseModel` string
> only resolves to a real ecosystem after the constants change is deployed.

## 1. ModelVersion.baseModel

```sql
UPDATE "ModelVersion"
SET "baseModel" = 'Reve'
WHERE id = 3133202;
```

## 2. Model.description

Dollar-quoted (`$md$…$md$`) so the HTML's single/double quotes need no escaping.

```sql
UPDATE "Model"
SET description = $md$<h2>Reve 2.1</h2>
<p><strong>Reve 2.1</strong> is a controllable text-to-image generation and editing model from <a href="https://reve.com" rel="noopener nofollow" target="_blank">Reve AI</a>, an independent foundation-model lab. It is built on the idea that images should be composed like code — as hierarchical, structured regions — so that layout and control are core to the model rather than an afterthought.</p>
<h3>Highlights</h3>
<ul>
<li><strong>Native 4K output.</strong> Renders dense scenes, fine text, and intricate structure directly at 4K (16&nbsp;megapixels), preserving detail through iterative refinement.</li>
<li><strong>Layout planning.</strong> Reasons about structure, hierarchy, and spatial relationships before rendering, so it holds up on complicated, densely populated scenes.</li>
<li><strong>Editability.</strong> Every element is addressable — a single region can be changed and re-rendered without redoing the whole image.</li>
<li><strong>Multilingual text.</strong> Renders legible typography, including foreign scripts embedded directly in the image.</li>
</ul>
<p>Reve 2.1 ranks as a top 4K model on the Arena and Design Arena leaderboards while using a fraction of the compute of comparably ranked models.</p>
<p><em>Model and imagery are the property of Reve AI, Inc. Learn more in the <a href="https://blog.reve.com/posts/launching-reve-2.1/" rel="noopener nofollow" target="_blank">Reve 2.1 launch announcement</a>. Use is subject to the <a href="https://app.reve.com/terms" rel="noopener nofollow" target="_blank">Reve AI Terms of Service</a>.</em></p>$md$
WHERE id = 2781889;
```

## Verify

```sql
SELECT mv.id AS version_id, mv."baseModel", m.id AS model_id, left(m.description, 60) AS desc_preview
FROM "ModelVersion" mv
JOIN "Model" m ON m.id = mv."modelId"
WHERE mv.id = 3133202;
```

Expect `baseModel = 'Reve'` and the description preview starting with `<h2>Reve 2.1</h2>`.

## Notes

- **License URL** on the new license record (`id 38`, `Reve AI Terms of Service`) is
  `https://app.reve.com/terms` — confirm this resolves for your Reve account; adjust
  the constant + the description link if Reve publishes a different canonical terms URL.
- The description credits Reve AI and links the launch post per our mirrored-model
  convention (the model lives on `CivitaiOfficial`).

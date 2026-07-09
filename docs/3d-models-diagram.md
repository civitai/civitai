# 3D Models — Schema & Flow Diagrams

Companion to `docs/3d-models-plan.md` (rev 9 — open questions resolved; ready to implement). Visual reference for the new entities, their relationships to existing Civitai tables, and the key user flows.

Diagrams are Mermaid — render inline on GitHub, VS Code (with the **Markdown Preview Mermaid Support** extension), or any modern Markdown viewer.

---

## 1. Entity Relationship Diagram

**Legend**: blue = new tables, grey = existing tables we touch. Cardinality follows Mermaid's `||`, `|o`, `}o`, `}|` notation.

```mermaid
erDiagram
    Model3D                ||--o{ Model3DFile        : "has files (1 per format)"
    Model3D                ||--o{ TagsOnModel3D      : "tagged with"
    Model3D                ||--o{ Model3DEngagement  : "engaged by"
    Model3D                ||--o{ Model3DReport      : "reports"
    Model3D                ||--o{ Model3DReview      : "reviews"
    Model3D                ||--o| Model3DMetric      : "metric"
    Model3D                ||--o| Thread             : "1 discussion thread"
    Model3D                ||--o{ Post               : "creator + community Posts"
    Model3DReview          ||--o| Post               : "review image attachments"
    Model3D                ||--o{ CollectionItem     : "in collections"
    Model3D                }o--|| Model3DLicense     : "uses license"
    Model3D                }o--o| Image              : "thumbnail (from generator)"
    Model3D                }o--o| Image              : "source (image-to-3D)"
    Model3D                }o--|| User               : "creator"

    Tag                    ||--o{ TagsOnModel3D      : "tag of"
    User                   ||--o{ Model3DEngagement  : "engages"
    User                   ||--o{ Model3DReview      : "writes"
    Report                 ||--o| Model3DReport      : "discriminator"
    Report                 ||--o| Model3DReviewReport: "discriminator"
    Model3DReview          ||--o| Thread             : "review comments"
    Thread                 ||--o{ CommentV2          : "comments"

    Model3D {
        int           id              PK
        citext        name
        text          description
        int           userId          FK
        int           thumbnailImageId FK "nullable @unique SetNull"
        int           licenseId       FK
        text          licenseDetails  "free-text when isCustom"
        text          workflowId      UK "orchestrator; NULL = future upload"
        int           sourceImageId   FK "image-to-3D source"
        json          generationParams "PolyGen input snapshot"
        Model3DStatus status
        bool          nsfw
        bool          tosViolation
        bool          poi
        bool          minor
        bool          unlisted
        text_array    lockedProperties
        Availability  availability
        int           nsfwLevel
        datetime      publishedAt
    }

    Model3DFile {
        int            id        PK
        int            model3dId FK
        text           name
        text           url
        float          sizeKB    "no cap in v1"
        text           format    "lowercased glb fbx obj usdz stl"
        bool           isPrimary "at most one per Model3D"
        json           metadata
        ScanResultCode virusScanResult
        json           rawScanResult
    }

    Model3DLicense {
        int  id                   PK
        text name                 UK
        text description
        bool allowCommercialUse
        bool allowPrintFarm       "CHECK requires commercial"
        bool allowDerivatives
        bool allowRedistribution
        bool requireAttribution
        bool isCustom
    }

    Model3DReview {
        int      id          PK
        int      model3dId   FK
        int      userId      FK
        int      rating      "CHECK 1..5"
        bool     recommended
        text     details
        bool     nsfw
        bool     tosViolation
        bool     exclude
    }

    Model3DReport {
        int model3dId FK
        int reportId  FK
    }

    Model3DReviewReport {
        int model3dReviewId FK
        int reportId        FK
    }

    Model3DEngagement {
        int                   userId    PK
        int                   model3dId PK
        Model3DEngagementType type      "Favorite Hide Notify"
    }

    Model3DMetric {
        int           model3dId        PK
        int           downloadCount    "sourced from ClickHouse"
        int           commentCount
        int           collectedCount
        int           tippedCount
        int           tippedAmountCount
        int           ratingCount
        float         ratingAvg
        int           recommendedCount
        int           reactionCount    "denormalized from thumbnail ImageMetric"
        int           earnedAmount
        int           nsfwLevel        "denormalized from Model3D"
        int           userId           "denormalized"
        Model3DStatus status           "denormalized"
        Availability  availability     "denormalized"
        bool          poi              "denormalized"
        bool          minor            "denormalized"
    }

    TagsOnModel3D {
        int      model3dId PK
        int      tagId     PK
        datetime createdAt
    }
```

**What's NOT here** (intentional omissions from rev 5):
- ~~`Model3DReaction`~~ — users react to the thumbnail `Image` (which is an existing `Image` row, reusing `ImageReaction`).
- ~~`Model3DDownloadHistory`~~ — download events go to ClickHouse; the rollup denormalizes into `Model3DMetric.downloadCount`.
- ~~`Model3DVersion`~~ — no versioning in v1.

---

## 2. Existing-table touch points

```mermaid
flowchart LR
    Model3D[(Model3D)]:::new
    Model3DFile[(Model3DFile)]:::new
    Model3DLicense[(Model3DLicense)]:::new
    Model3DReview[(Model3DReview)]:::new

    User[User]:::existing
    Image[Image]:::existing
    Tag[Tag]:::existing
    Post[Post]:::existing
    Thread[Thread]:::existing
    CommentV2[CommentV2]:::existing
    Report[Report]:::existing
    CollectionItem[CollectionItem]:::existing
    BuzzTip[BuzzTip]:::existing
    ImageReaction[ImageReaction]:::existing
    Meilisearch[(Meilisearch model3d index)]:::external
    ClickHouse[(ClickHouse events)]:::external
    S3[(S3 3d/ prefix)]:::external
    Orchestrator[(Orchestrator PolyGen)]:::external

    Orchestrator -- "submitWorkflow PolyGenStep async" --> Model3D
    Orchestrator -- "model.url, fbxModel.url" --> S3
    S3 -- "url" --> Model3DFile

    User -- "creator FK" --> Model3D
    Image -- "thumbnailImageId FK" --> Model3D
    Image -- "sourceImageId FK (image-to-3D)" --> Model3D
    ImageReaction -. "reactions ride on thumbnail Image" .-> Model3D
    Model3DLicense -- "licenseId FK" --> Model3D
    Model3D -- "files" --> Model3DFile

    Tag -- "TagsOnModel3D join" --> Model3D
    Model3D -- "model3dId column" --> Thread
    Thread -- "comments" --> CommentV2
    Model3D -- "model3dId column" --> Post
    Model3D -- "Model3DReport discriminator" --> Report
    Model3DReview -- "Model3DReviewReport discriminator" --> Report
    Model3D -- "model3dId column + unique extended" --> CollectionItem
    BuzzTip -. "entityType='Model3D' in schema enum" .-> Model3D
    Model3D -. "indexed" .-> Meilisearch
    ClickHouse -. "download events aggregated into Model3DMetric.downloadCount" .-> Model3D

    classDef new       fill:#1d4ed8,stroke:#1e3a8a,color:#fff;
    classDef existing  fill:#374151,stroke:#1f2937,color:#fff;
    classDef external  fill:#7c2d12,stroke:#431407,color:#fff,stroke-dasharray:3 3;
```

Key points:

- **Reactions reuse `ImageReaction`** on the thumbnail Image — no Model3D-specific reaction table.
- **Downloads go to ClickHouse** as events, not a Postgres table. `Model3DMetric.downloadCount` is a denormalized aggregate.
- **Source of v1 content** is the orchestrator's PolyGen recipe — no upload path in v1.
- **`Image` has two FKs into `Model3D`**: thumbnail (from PolyGen output) and source (for image-to-3D inputs).

---

## 3. Generate + publish lifecycle

```mermaid
flowchart TD
    Start([User opens Generate panel, picks 3D Model]) --> A1[Form: textTo3D or imageTo3D<br/>+ Meshy params: prompt, topology,<br/>polycount, symmetry, PBR, seed]
    A1 --> A1a{Image-to-3D?}
    A1a -- yes --> A1b[Ingest source image as Image row first<br/>mirroring Sora sourceImageSchema]
    A1a -- no --> A2
    A1b --> A2[Submit via submitWorkflow + PolyGenStep<br/>type='polyGen' async]
    A2 --> A3[Orchestrator runs Meshy via Fal<br/>user sees queue card with status]
    A3 --> A4[Workflow result handler fires server-side:<br/>PolyGenOutput model GLB + optional FBX + thumbnail]

    A4 --> B1[Copy blobs to S3 3d/ prefix<br/>handle nullable url + expiry]
    B1 --> B2[Ingest thumbnail as Image row<br/>NSFW + CSAM scan via standard pipeline]
    B2 --> B3[Create Model3D Draft<br/>workflowId set UNIQUE<br/>generationParams snapshot]
    B3 --> B4[Create Model3DFile rows<br/>one per normalized format<br/>GLB isPrimary]
    B4 --> B5[Queue card now shows thumbnail<br/>not inline WebGL]

    B5 --> C1{User clicks 'Post from Generation'?}
    C1 -- no --> Stay([Model3D stays Draft<br/>no public surface])
    C1 -- yes --> D1[Mutation creates empty Post<br/>redirect to /posts/:id/edit]
    D1 --> D2[Edit page hosts Post + Model3D fields:<br/>name description tags license NSFW]
    D2 --> D3[Publish: Model3D.status = Published<br/>Post.model3dId set + flipped to public]
    D3 --> D4[Meilisearch indexed<br/>Model3DMetric initialized]
    D4 --> End([/3d-models/:id live])

    style A2 fill:#1d4ed8,color:#fff
    style B3 fill:#1d4ed8,color:#fff
    style D1 fill:#1d4ed8,color:#fff
    style End fill:#15803d,color:#fff
```

---

## 4. Detail page read path

```mermaid
flowchart LR
    Req([GET /3d-models/:id]) --> SVC[model3d.service.getById]

    SVC --> Q1[Model3D + license + thumbnailImage + sourceImage]
    SVC --> Q2[Model3DFile rows ordered isPrimary first]
    SVC --> Q3[Model3DMetric]
    SVC --> Q4[TagsOnModel3D + Tag]
    SVC --> Q5[Thread + paginated CommentV2]
    SVC --> Q6[Post where model3dId = :id<br/>creator + community 'Makes/Uses']
    SVC --> Q7[Model3DReview count + avg rating]

    Q1 --> Render[Detail page render]
    Q2 --> Render
    Q3 --> Render
    Q4 --> Render
    Q5 --> Render
    Q6 --> Render
    Q7 --> Render

    Render --> V1[3D Viewer<br/>three.js + GLTFLoader<br/>dynamic-imported, GLB primary]
    Render --> V2[Files dropdown<br/>signed URLs<br/>download events to ClickHouse]
    Render --> V3[Generation Details panel<br/>prompt, topology, polycount, seed]
    Render --> V4[Comments + reactions on thumbnail]
    Render --> V5[Makes & Uses rail]
    Render --> V6[Reviews summary<br/>link to /3d-models/:id/reviews]
```

---

## 5. Cross-reference

| Entity                    | Existing analog        | Difference                                                            |
| ------------------------- | ---------------------- | --------------------------------------------------------------------- |
| `Model3D`                 | `Model`                | No `baseModel`/`ecosystem`/`ModelType`/versioning. Has `workflowId`. |
| `Model3DFile`             | `ModelFile`            | `format String` (not enum), `isPrimary`, `(model3dId, format)` unique |
| `Model3DLicense`          | `License`              | Adds `allowPrintFarm`, `allowRedistribution`, `isCustom`              |
| `Model3DReview`           | `ResourceReview`       | Scoped to `model3dId` (no `modelVersionId`)                           |
| `Model3DReport`           | `ModelReport`          | Identical shape                                                       |
| `Model3DEngagement`       | `ModelEngagement`      | Drops `Mute` from the enum                                            |
| `Model3DMetric`           | `ModelMetric`          | `downloadCount` sourced from ClickHouse; adds rating fields           |
| `TagsOnModel3D`           | `TagsOnModels`         | Identical shape                                                       |
| `Model3D` ↔ `Thread`      | `Model` ↔ `Thread`     | Wide-FK columns added (`model3dId` + `model3dReviewId`)               |
| `Model3D` ↔ `Post`        | `ModelVersion` ↔ `Post`| Wide-FK column added (`Post.model3dId`)                               |
| `Model3D` ↔ `CollectionItem` | `Model` ↔ `CollectionItem` | New FK column + extended unique constraint                  |
| ~~`Model3DReaction`~~     | ~~`ImageReaction`~~    | **Removed** — react on the thumbnail Image instead                    |
| ~~`Model3DDownloadHistory`~~ | ~~`DownloadHistory`~~ | **Removed** — ClickHouse events; rollup in `Model3DMetric`            |
| ~~`Model3DFileType` enum~~| ~~`ModelFile.type`~~   | **Removed** — `format String` for flexibility                         |

---

**Source of truth**: `prisma/schema.full.prisma` (the actual editable Prisma schema; `prisma/schema.prisma` is auto-generated from it via `scripts/generate-slim-schema.js`). Migration SQL is hand-written in `prisma/migrations/20260526120000_add_3d_models/migration.sql` to mirror the schema changes; per CLAUDE.md, it's applied manually rather than via `prisma migrate deploy`. If diagrams drift from the schema, the schema wins.

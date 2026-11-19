package v1models

import (
	"context"
	"math"

	"github.com/civitai/civitai/apps/feed-go/internal/hydrate"
	"github.com/civitai/civitai/apps/feed-go/internal/superjson"
)

// versionStats is readModelsWithVersionsStats' four reads: the linked VAE versions, the model and
// version metrics, and the versions' meta.
type versionStats struct {
	vaeOf   map[int]int // host version -> linked VAE version (the last linking row wins, as Map.set)
	model   map[int]superjson.Object
	version map[int]map[string]int
	meta    map[int]map[string]any
}

func (d *Deps) versionStats(ctx context.Context, modelIDs, versionIDs []int) (*versionStats, error) {
	s := &versionStats{
		vaeOf: map[int]int{}, model: map[int]superjson.Object{}, version: map[int]map[string]int{},
		meta: map[int]map[string]any{},
	}
	g := d.group(ctx)
	if len(versionIDs) > 0 {
		g.Go(func(ctx context.Context) error {
			rows, err := queryRows(ctx, d.DB, `SELECT "sourceId", "resourceId", settings FROM "RecommendedResource"
    WHERE "sourceId" = ANY($1::int[]) AND settings -> 'isLinkedComponent' = 'true'::jsonb`, versionIDs)
			if err != nil {
				return err
			}
			for _, r := range rows {
				settings := jsonObject(r["settings"])
				src, ok := intOf(r["sourceId"])
				if !ok || src == 0 || settings["componentType"] != "VAE" {
					continue
				}
				res, _ := intOf(r["resourceId"])
				s.vaeOf[src] = res
			}
			return nil
		})
		g.Go(func(ctx context.Context) error {
			rows, err := queryRows(ctx, d.DB, `SELECT "modelVersionId", "downloadCount", "thumbsUpCount", "thumbsDownCount"
    FROM "ModelVersionMetric" WHERE "modelVersionId" = ANY($1::int[])`, versionIDs)
			if err != nil {
				return err
			}
			for _, r := range rows {
				id, ok := intOf(r["modelVersionId"])
				if !ok {
					continue
				}
				if _, dup := s.version[id]; dup {
					continue // `.find`: the first row
				}
				m := map[string]int{}
				for _, k := range []string{"downloadCount", "thumbsUpCount", "thumbsDownCount"} {
					m[k], _ = intOf(r[k])
				}
				s.version[id] = m
			}
			return nil
		})
		g.Go(func(ctx context.Context) error {
			rows, err := queryRows(ctx, d.DB, `SELECT id, meta FROM "ModelVersion" WHERE id = ANY($1::int[])`, versionIDs)
			if err != nil {
				return err
			}
			for _, r := range rows {
				if id, ok := intOf(r["id"]); ok {
					s.meta[id] = jsonObject(r["meta"])
				}
			}
			return nil
		})
	}
	g.Go(func(ctx context.Context) error {
		rows, err := queryRows(ctx, d.DB, `SELECT "modelId", "downloadCount", "thumbsUpCount", "thumbsDownCount", "commentCount", "tippedAmountCount"
    FROM "ModelMetric" WHERE "modelId" = ANY($1::int[])`, modelIDs)
		if err != nil {
			return err
		}
		for _, r := range rows {
			id, ok := intOf(r["modelId"])
			if !ok {
				continue
			}
			if _, dup := s.model[id]; dup {
				continue
			}
			o := superjson.Object{}
			for _, k := range []string{"downloadCount", "thumbsUpCount", "thumbsDownCount", "commentCount", "tippedAmountCount"} {
				n, _ := intOf(r[k])
				o = append(o, superjson.Field{Key: k, Val: int64(n)})
			}
			s.model[id] = o
		}
		return nil
	})
	if err := g.Wait(); err != nil {
		return nil, err
	}
	return s, nil
}

// vaeFileColumns is modelFileSelect plus modelVersionId, in select order (getVaeFiles' row shape).
var vaeFileColumns = []string{
	"id", "url", "sizeKB", "name", "overrideName", "type", "visibility", "metadata", "pickleScanResult",
	"pickleScanMessage", "virusScanResult", "virusScanMessage", "scannedAt", "modelVersionId",
}

// vaeFiles is getVaeFiles: the primary `Model` files of the linked versions, typed `VAE`, by version.
func (d *Deps) vaeFiles(ctx context.Context, vaeIDs []int) (map[int][]superjson.Object, error) {
	rows, err := queryRows(ctx, d.DB, `SELECT id, url, "sizeKB", name, "overrideName", type, visibility, metadata,
    "pickleScanResult", "pickleScanMessage", "virusScanResult", "virusScanMessage", "scannedAt", "modelVersionId"
    FROM "ModelFile" WHERE "modelVersionId" = ANY($1::int[]) AND type = 'Model'`, vaeIDs)
	if err != nil {
		return nil, err
	}
	out := map[int][]superjson.Object{}
	if len(rows) == 0 {
		return out, nil
	}
	fileIDs := make([]int, 0, len(rows))
	for _, r := range rows {
		if id, ok := intOf(r["id"]); ok {
			fileIDs = append(fileIDs, id)
		}
	}
	hashRows, err := queryRows(ctx, d.DB, `SELECT "fileId", type, hash FROM "ModelFileHash" WHERE "fileId" = ANY($1::int[])`, fileIDs)
	if err != nil {
		return nil, err
	}
	hashes := map[int][]any{}
	for _, h := range hashRows {
		id, _ := intOf(h["fileId"])
		hashes[id] = append(hashes[id], superjson.Object{
			{Key: "type", Val: enumText(h["type"])},
			{Key: "hash", Val: textOrNil(h["hash"])},
		})
	}
	for _, r := range rows {
		o := make(superjson.Object, 0, len(vaeFileColumns)+1)
		for _, c := range vaeFileColumns {
			var v any
			switch c {
			case "type":
				v = "VAE"
			case "metadata":
				v = wireJSON(r[c])
			case "visibility", "pickleScanResult", "virusScanResult":
				v = textOrNil(r[c])
			case "scannedAt":
				if t, ok := timeOf(r[c]); ok {
					v = t
				}
			case "id", "modelVersionId":
				n, _ := intOf(r[c])
				v = int64(n)
			default:
				v = wireScalar(r[c])
			}
			o = append(o, superjson.Field{Key: c, Val: v})
		}
		id, _ := intOf(r["id"])
		hs := hashes[id]
		if hs == nil {
			hs = []any{}
		}
		o = append(o, superjson.Field{Key: "hashes", Val: hs})
		vid, _ := intOf(r["modelVersionId"])
		out[vid] = append(out[vid], o)
	}
	return out, nil
}

func textOrNil(v any) any {
	switch t := v.(type) {
	case nil:
		return nil
	case string:
		return t
	case []byte:
		return string(t)
	}
	return enumText(v)
}

// wireScalar is a column value as superjson.Plain writes it.
func wireScalar(v any) any {
	switch t := v.(type) {
	case float32:
		return float64(t)
	case []byte:
		return string(t)
	}
	return hydrate.Wire(v)
}

// wireJSON is a decoded jsonb value as an ordered value (map keys sorted: a jsonb object's own
// order is Postgres's, which its text form shows by key length then bytes; only scalar members are
// read from file metadata, so the order is not on the wire).
func wireJSON(v any) any {
	return hydrate.Wire(v)
}

// metricVisibility is getMetaMetricVisibility: a meta blob's explicit per-metric settings.
func metricVisibility(meta map[string]any) map[string]string {
	out := map[string]string{}
	vis, _ := meta["metricVisibility"].(map[string]any)
	legacy := map[string]string{"buzz": "hideBuzz", "downloads": "hideDownloads", "generations": "hideGenerations"}
	for _, k := range []string{"buzz", "downloads", "generations"} {
		if e, _ := vis[k].(string); e == "hide" || e == "show" {
			out[k] = e
		} else if truthyJS(meta[legacy[k]]) {
			out[k] = "hide"
		}
	}
	return out
}

type hidden struct{ buzz, downloads, generations bool }

func anyHidden(h hidden) bool { return h.buzz || h.downloads || h.generations }

// metaHidden is getMetaMetricPrivacy.
func metaHidden(meta map[string]any) hidden {
	v := metricVisibility(meta)
	return hidden{v["buzz"] == "hide", v["downloads"] == "hide", v["generations"] == "hide"}
}

// userHidden is getUserMetricPrivacyDefaults over the cached triple.
func userHidden(p map[string]bool) hidden {
	return hidden{p["hideModelBuzz"], p["hideModelDownloads"], p["hideModelGenerations"]}
}

// nearestExplicit: the nearest level with an explicit setting decides; with none, the default.
func nearestExplicit(levels []map[string]string, def hidden) hidden {
	resolve := func(k string, d bool) bool {
		for _, l := range levels {
			if s, ok := l[k]; ok {
				return s == "hide"
			}
		}
		return d
	}
	return hidden{resolve("buzz", def.buzz), resolve("downloads", def.downloads), resolve("generations", def.generations)}
}

// item assembles one getModelsWithVersions item from a getModelsRaw item and the page's reads.
func (p *versionParts) item(r *rawItem, coverageNext bool) *item {
	owner := r.row.UserID
	member := p.membership[owner]
	defaults := userHidden(p.privacy[owner])
	modelVis := metricVisibility(r.row.Meta)
	var modelHidden hidden
	if member {
		modelHidden = nearestExplicit([]map[string]string{modelVis}, defaults)
	}

	versions := make([]superjson.Object, 0, len(r.versions))
	supportsGeneration := false
	for _, v := range r.versions {
		col := "covered"
		if coverageNext {
			col = "coveredNext"
		}
		if truthyAny(getVal(v, col)) {
			supportsGeneration = true
		}
		vid, _ := intOf(getVal(v, "id"))
		var verHidden hidden
		if member {
			verHidden = nearestExplicit([]map[string]string{metricVisibility(p.verMeta[vid]), modelVis}, defaults)
		}
		files := make([]any, 0, len(p.files[vid])+len(p.vaeFiles[vid]))
		for _, f := range p.files[vid] {
			files = append(files, toAPIModelFile(f))
		}
		for _, f := range p.vaeFiles[vid] {
			files = append(files, toAPIModelFile(f))
		}
		var paid any
		var deadline any = superjson.Undefined{}
		if dto, ok := p.paid[vid]; ok {
			paid = dto
			if e := getVal(dto, "endsAt"); e != nil {
				deadline = e
			}
		}
		vs := p.verStats[vid]
		var dl any = int64(vs["downloadCount"])
		if verHidden.downloads {
			dl = nil
		}
		stats := superjson.Object{
			{Key: "downloadCount", Val: dl},
			{Key: "thumbsUpCount", Val: int64(vs["thumbsUpCount"])},
			{Key: "thumbsDownCount", Val: int64(vs["thumbsDownCount"])},
		}
		images := []any{}
		for _, img := range p.images[vid] {
			if p.showsImage(img) {
				images = append(images, omit(img, "modelVersionId", "name", "userId", "sizeKB", "availability", "metadata", "tags"))
			}
		}
		nv := omit(v, "trainingStatus", "earlyAccessTimeFrame")
		nv.Set("files", files)
		nv.Set("earlyAccessDeadline", deadline)
		nv.Set("paidAccess", paid)
		nv.Set("stats", stats)
		nv.Set("images", images)
		versions = append(versions, nv)
	}

	ms := p.modelStats[r.row.ID]
	stat := func(k string) int64 {
		if v, ok := ms.Get(k); ok {
			n, _ := v.(int64)
			return n
		}
		return 0
	}
	var dl any = stat("downloadCount")
	if modelHidden.downloads {
		dl = nil
	}
	var tipped any = stat("tippedAmountCount")
	if modelHidden.buzz {
		tipped = nil
	}
	stats := superjson.Object{
		{Key: "downloadCount", Val: dl},
		{Key: "thumbsUpCount", Val: stat("thumbsUpCount")},
		{Key: "thumbsDownCount", Val: stat("thumbsDownCount")},
		{Key: "commentCount", Val: stat("commentCount")},
		{Key: "tippedAmountCount", Val: tipped},
	}
	tagNames := make([]any, len(r.tags))
	for i, t := range r.tags {
		tagNames[i] = t.name
	}
	return &item{
		base:     baseObject(r, supportsGeneration, stats),
		versions: versions,
		tagNames: tagNames,
		creator:  r.creator,
		typ:      r.row.Type,
		mode:     r.row.Mode,
	}
}

// truthyAny is `!!v` for a cached value.
func truthyAny(v any) bool {
	switch t := v.(type) {
	case nil:
		return false
	case bool:
		return t
	case float64:
		return t != 0 && !math.IsNaN(t)
	case string:
		return t != ""
	}
	if n, ok := intOf(v); ok {
		return n != 0
	}
	return true
}

// toAPIModelFile is toApiModelFile: the file with `metadata` moved last and narrowed to the five
// published fields (each undefined when absent).
func toAPIModelFile(f superjson.Object) superjson.Object {
	meta, _ := getVal(f, "metadata").(superjson.Object)
	get := func(k string) any {
		if meta == nil {
			return superjson.Undefined{}
		}
		if v, ok := meta.Get(k); ok {
			return v
		}
		return superjson.Undefined{}
	}
	out := omit(f, "metadata")
	out = append(out, superjson.Field{Key: "metadata", Val: superjson.Object{
		{Key: "format", Val: get("format")},
		{Key: "size", Val: get("size")},
		{Key: "fp", Val: get("fp")},
		{Key: "quantType", Val: get("quantType")},
		{Key: "isRequired", Val: get("isRequired")},
	}})
	return out
}

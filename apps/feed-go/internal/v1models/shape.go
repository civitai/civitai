package v1models

import (
	"strconv"

	"github.com/civitai/civitai/apps/feed-go/internal/fallback"
	"github.com/civitai/civitai/apps/feed-go/internal/feed"
	"github.com/civitai/civitai/apps/feed-go/internal/superjson"
)

// The two REST shapers over a getModelsWithVersions item: buildPublicModelResponse
// (src/pages/api/v1/models/[id].ts) and runModelSearch's (src/server/services/model-search.service.ts).

// shapeOptions are what differs between the two.
type shapeOptions struct {
	level int
	// detail: the `[id]` shaper (removeEmpty per version, removeEmpty file metadata, pinned per-file
	// download URLs, images without `id`, includeImages by TakenDown only).
	detail bool
	// downloadBase prefixes the download URLs: getBaseUrl() on `[id]`, the request origin on the list.
	downloadBase string
	// nsfwImagePassthrough: every image passes (the list's `?nsfw=true` outside a restricted region).
	nsfwImagePassthrough bool
	// primaryFileOnly: the list's file trim.
	primaryFileOnly bool
	imageLocation   string
}

// creatorObject is `{ username, image: publicAvatarUrl(user, level) }`.
func creatorObject(c creator, level int, location string) any {
	if c.hidden {
		return superjson.Undefined{}
	}
	var image any
	if p := c.picture; p != nil {
		lvl, _ := intOf(getVal(p, "nsfwLevel"))
		// avatarAtLevel: rated, and every bit of its rating inside the level.
		if lvl != 0 && level|lvl == level {
			url, _ := getVal(p, "url").(string)
			opts := feed.EdgeOptions{Width: 96}
			if s, ok := c.username.(string); ok {
				opts.Name = &s
			}
			if t, ok := getVal(p, "type").(string); ok {
				opts.Type = t
			}
			image = feed.EdgeURL(location, url, opts)
		}
	}
	return superjson.Object{{Key: "username", Val: c.username}, {Key: "image", Val: image}}
}

// shapeModel is the shaper's `{ ...model, mode, creator, tags, modelVersions }` for one item.
func shapeModel(it *item, o shapeOptions) (superjson.Object, error) {
	out := cloneObject(it.base)
	if it.mode == nil {
		out.Set("mode", superjson.Undefined{})
	}
	out.Set("creator", creatorObject(it.creator, o.level, o.imageLocation))
	out.Set("tags", it.tagNames)
	mode := ""
	if it.mode != nil {
		mode = *it.mode
	}
	versions := make([]any, 0, len(it.versions))
	name, _ := getVal(it.base, "name").(string)
	model := nameModel{name: name, typ: it.typ}
	for _, v := range it.versions {
		// The list's `supportsGeneration` filter is a fallback upstream, so only the status filters.
		if s, _ := getVal(v, "status").(string); s != "Published" {
			continue
		}
		sv, err := shapeVersion(v, model, mode, o)
		if err != nil {
			return nil, err
		}
		if sv != nil {
			versions = append(versions, sv)
		}
	}
	out.Set("modelVersions", versions)
	return out, nil
}

// fileView is one version file as both shapers read it.
type fileView struct {
	obj      superjson.Object
	id       int
	typ      string
	vis      string
	owner    any // modelVersionId
	metadata superjson.Object
}

func viewFile(f superjson.Object) fileView {
	v := fileView{obj: f}
	v.id, _ = intOf(getVal(f, "id"))
	v.typ, _ = getVal(f, "type").(string)
	v.vis, _ = getVal(f, "visibility").(string)
	v.owner = getVal(f, "modelVersionId")
	v.metadata, _ = getVal(f, "metadata").(superjson.Object)
	return v
}

func (f fileView) nameFile() nameFile {
	n := nameFile{id: f.id, hasID: true, typ: f.typ}
	n.name, _ = getVal(f.obj, "name").(string)
	n.overrideName, _ = getVal(f.obj, "overrideName").(string)
	if f.metadata != nil {
		n.size = getVal(f.metadata, "size")
		n.fp = getVal(f.metadata, "fp")
		n.qt = getVal(f.metadata, "quantType")
	}
	return n
}

// primaryFile is getPrimaryFile with the default preferences (format SafeTensor, size pruned, fp
// fp16, quantType Q4_K_M): the highest score, ties broken by serving precision within one type.
func primaryFile(files []fileView) int {
	if len(files) == 0 {
		return -1
	}
	preferred := map[string]string{"format": "SafeTensor", "size": "pruned", "fp": "fp16", "quantType": "Q4_K_M"}
	weights := []struct {
		key string
		w   float64
	}{{"format", 100}, {"size", 10}, {"fp", 1}, {"quantType", 0.5}}
	score := func(f fileView) float64 {
		s := 1000.0
		// Object.entries(metadata): every published key toApiModelFile set, undefined ones included
		// (an undefined value is not the preference, so it subtracts).
		for _, w := range weights {
			if f.metadata == nil {
				continue
			}
			v, present := f.metadata.Get(w.key)
			if !present {
				continue
			}
			if str, ok := v.(string); ok && str == preferred[w.key] {
				s += w.w
			} else {
				s -= w.w
			}
		}
		if primaryModelFileTypes[f.typ] {
			s += 1000
		}
		return s
	}
	best, bestScore := 0, score(files[0])
	for i := 1; i < len(files); i++ {
		sc := score(files[i])
		if sc > bestScore || (sc == bestScore && preferredPrecision(files[i], files[best])) {
			best, bestScore = i, sc
		}
	}
	return best
}

var fpServing = map[string]int{
	"fp8": 1, "fp8_scaled": 2, "fp8_mixed": 3, "bf16": 4, "fp16": 5, "fp32": 6, "int8": 7, "mxfp8": 8,
	"nvfp4": 9, "nf4": 10, "int4": 11,
}

func preferredPrecision(candidate, incumbent fileView) bool {
	if candidate.typ != incumbent.typ {
		return false
	}
	fp := func(f fileView) (string, bool) {
		if f.metadata == nil {
			return "", false
		}
		s, ok := getVal(f.metadata, "fp").(string)
		return s, ok && s != ""
	}
	a, aok := fp(candidate)
	b, bok := fp(incumbent)
	if aok == bok && a == b {
		return false
	}
	rank := func(s string, ok bool) int {
		if !ok {
			return 1 << 53
		}
		if r, known := fpServing[s]; known {
			return r
		}
		return 1 << 53
	}
	return rank(a, aok) < rank(b, bok)
}

// hashesObject is hashesAsObject: `{ [type]: hash }` in row order (a repeated type keeps its first
// position, its last value).
func hashesObject(v any) superjson.Object {
	out := superjson.Object{}
	list, _ := v.([]any)
	for _, h := range list {
		o, ok := h.(superjson.Object)
		if !ok {
			continue
		}
		t, _ := getVal(o, "type").(string)
		out.Set(t, getVal(o, "hash"))
	}
	return out
}

// downloadURL is createModelFileDownloadUrl: `/api/download/models/<version>` with the file's
// discriminators unless it is the primary file (or pinned by id).
func downloadURL(versionID int, typ any, meta superjson.Object, primary bool, fileID int) string {
	var params []feed.QueryParam
	add := func(k string, v any) {
		switch t := v.(type) {
		case nil, superjson.Undefined:
			return
		case string:
			if t != "" {
				params = append(params, feed.QueryParam{Key: k, Values: []string{t}})
			}
		case bool:
			params = append(params, feed.QueryParam{Key: k, Values: []string{strconv.FormatBool(t)}})
		case int64:
			params = append(params, feed.QueryParam{Key: k, Values: []string{strconv.FormatInt(t, 10)}})
		case float64:
			params = append(params, feed.QueryParam{Key: k, Values: []string{superjson.FormatNumber(t)}})
		}
	}
	m := func(k string) any {
		if meta == nil {
			return nil
		}
		return getVal(meta, k)
	}
	if fileID != 0 {
		add("fileId", int64(fileID))
	}
	soft := !primary && fileID == 0
	if soft {
		add("type", typ)
		if typ != "Training Data" {
			add("format", m("format"))
		}
		add("size", m("size"))
		add("fp", m("fp"))
		add("quantType", m("quantType"))
	}
	qs := feed.QSStringify(params)
	u := "/api/download/models/" + strconv.Itoa(versionID)
	if qs != "" {
		u += "?" + qs
	}
	return u
}

// removeEmpty drops nil and undefined members and empty arrays (lodash omitBy, top level).
func removeEmpty(o superjson.Object) superjson.Object {
	out := make(superjson.Object, 0, len(o))
	for _, f := range o {
		switch t := f.Val.(type) {
		case nil, superjson.Undefined:
			continue
		case []any:
			if len(t) == 0 {
				continue
			}
		}
		out = append(out, f)
	}
	return out
}

// shapeVersion is the per-version map of the shaper; nil when the version has no primary file.
func shapeVersion(v superjson.Object, model nameModel, mode string, o shapeOptions) (any, error) {
	vid, _ := intOf(getVal(v, "id"))
	rawFiles, _ := getVal(v, "files").([]any)
	files := make([]fileView, 0, len(rawFiles))
	for _, f := range rawFiles {
		if obj, ok := f.(superjson.Object); ok {
			files = append(files, viewFile(obj))
		}
	}
	pi := primaryFile(files)
	if pi < 0 {
		return nil, nil
	}
	primary := files[pi]
	if !o.detail && o.primaryFileOnly {
		files = []fileView{primary}
	}
	includeDownloadURL := mode != "Archived"
	includeImages := mode != "TakenDown"

	var version superjson.Object
	if o.detail {
		version = omit(v, "images", "files")
	} else {
		version = omit(v, "status", "files", "images", "createdAt", "covered")
	}
	ver := nameVersion{}
	ver.name, _ = getVal(version, "name").(string)
	if tw, ok := getVal(version, "trainedWords").([]any); ok {
		for _, w := range tw {
			s, _ := w.(string)
			ver.trainedWords = append(ver.trainedWords, s)
		}
	}
	nameFiles := make([]nameFile, len(files))
	for i, f := range files {
		nameFiles[i] = f.nameFile()
	}

	outFiles := []any{}
	if includeDownloadURL {
		for _, f := range files {
			if f.vis != "Public" {
				continue
			}
			if f.typ == "Training Data" {
				// trainingDataListing reads the replica (legal hold, CSAM reports, content flags,
				// scan state): not ported.
				return nil, fallback.New("v1-models-training-data")
			}
			isPrimary := f.id == primary.id
			fileName, err := resolveFileName(model, ver, f.nameFile(), nameFiles)
			if err != nil {
				return nil, err
			}
			rest := omit(f.obj, "hashes", "metadata", "modelVersionId")
			var meta any = superjson.Object{}
			if f.metadata != nil {
				meta = f.metadata
			}
			var url string
			if o.detail {
				meta = removeEmpty(meta.(superjson.Object))
				owner, _ := intOf(f.owner)
				if f.owner != nil && owner == vid {
					url = downloadURL(vid, nil, nil, false, f.id)
				} else {
					url = downloadURL(vid, f.typ, f.metadata, isPrimary, 0)
				}
			} else {
				rest = omit(f.obj, "hashes", "modelVersionId")
				url = downloadURL(vid, f.typ, f.metadata, isPrimary, 0)
			}
			out := rest
			out.Set("metadata", meta)
			out.Set("name", fileName)
			out.Set("hashes", hashesObject(getVal(f.obj, "hashes")))
			out.Set("downloadUrl", o.downloadBase+url)
			if isPrimary {
				out.Set("primary", true)
			} else {
				out.Set("primary", superjson.Undefined{})
			}
			out.Set("url", superjson.Undefined{})
			out.Set("visibility", superjson.Undefined{})
			outFiles = append(outFiles, out)
		}
	}

	outImages := []any{}
	if includeImages {
		rawImages, _ := getVal(v, "images").([]any)
		for _, x := range rawImages {
			img, ok := x.(superjson.Object)
			if !ok {
				continue
			}
			lvl, _ := intOf(getVal(img, "nsfwLevel"))
			if (!o.nsfwImagePassthrough || o.detail) && lvl&o.level == 0 {
				continue
			}
			id, _ := intOf(getVal(img, "id"))
			src, _ := getVal(img, "url").(string)
			name := strconv.Itoa(id)
			opts := feed.EdgeOptions{Original: boolTrue(), Name: &name}
			if t, ok := getVal(img, "type").(string); ok {
				opts.Type = t
			}
			edge := feed.EdgeURL(o.imageLocation, src, opts)
			rest := omit(img, "url", "id")
			var out superjson.Object
			if o.detail {
				out = append(superjson.Object{{Key: "url", Val: edge}}, rest...)
			} else {
				out = append(superjson.Object{{Key: "id", Val: int64(id)}, {Key: "url", Val: edge}}, rest...)
			}
			outImages = append(outImages, out)
		}
	}

	var dl any = superjson.Undefined{}
	if includeDownloadURL {
		dl = o.downloadBase + downloadURL(vid, nil, nil, true, 0)
	}
	if o.detail {
		version.Set("files", outFiles)
		version.Set("images", outImages)
		version.Set("downloadUrl", dl)
		version = removeEmpty(version)
		// removeEmpty drops empty arrays, but the docs promise images is [] when every image is left
		// out. Set keeps a non-empty one in place and appends an empty one, as the Node route does.
		version.Set("images", outImages)
		return version, nil
	}
	version.Set("supportsGeneration", getVal(v, "covered"))
	version.Set("files", outFiles)
	version.Set("images", outImages)
	version.Set("downloadUrl", dl)
	return version, nil
}

func boolTrue() *bool { b := true; return &b }

package v1models

import (
	"regexp"
	"strconv"
	"strings"

	"github.com/civitai/civitai/apps/feed-go/internal/fallback"
	"github.com/civitai/civitai/apps/feed-go/internal/feed"
)

// The download filename (resolveModelFileName in src/utils/model-file-naming.ts, through
// getDownloadFilename): each file's name, unique among the files beside it.

type nameModel struct {
	name, typ string
	// unicode: model and version names with non-ASCII text are named as Node names them (jsCanon,
	// jsTrimText) instead of falling back (`v1-models-filename`): FEED_GO_V1_MODELS_SERVE_FILENAME on
	// a public request, always in a shadow sample (shapeOptions.unicodeNames).
	unicode bool
}

type nameVersion struct {
	name         string
	trainedWords []string
}

type nameFile struct {
	id           int
	hasID        bool
	name         string
	overrideName string // "" = none (`||` treats an empty override as none)
	typ          string
	size, fp, qt any // metadata.size / fp / quantType as stored
}

var (
	trainerBlobFileName = regexp.MustCompile(`^[0-9A-HJKMNP-TV-Z]{26}(\.[A-Za-z0-9]{8})?\.safetensors$`)
	precisionSuffix     = regexp.MustCompile(`\.(fp16|fp32|bf16|fp8)$`)
	genericPatterns     = []*regexp.Regexp{
		regexp.MustCompile(`-\d+-of-\d+$`),
		regexp.MustCompile(`^[0-9a-hjkmnp-tv-z]{26}$`),
		regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`),
		regexp.MustCompile(`^[0-9a-f]{16,}$`),
		regexp.MustCompile(`^\d+$`),
	}
	unsafeNameChars = regexp.MustCompile(`[\p{Cc}\p{Cf}]`)
)

var genericBasenames = map[string]bool{
	"model": true, "diffusion_pytorch_model": true, "pytorch_model": true, "pytorch_lora_weights": true,
	"adapter_model": true, "text_encoder": true, "text_encoder_2": true, "unet": true, "transformer": true,
	"vae": true, "ae": true, "clip": true, "checkpoint": true, "weights": true, "output": true, "final": true,
	"last": true, "untitled": true, "file": true, "download": true,
}

func isGenericFileName(name string) bool {
	base := name
	if dot := strings.LastIndex(name, "."); dot > 0 {
		base = name[:dot]
	}
	base = precisionSuffix.ReplaceAllString(strings.ToLower(base), "")
	if base == "" || genericBasenames[base] {
		return true
	}
	for _, p := range genericPatterns {
		if p.MatchString(base) {
			return true
		}
	}
	return false
}

// computeFileName is the naming scheme `<model>_<version>.<ext>` and its per-type variants.
func computeFileName(m nameModel, v nameVersion, f nameFile) (string, error) {
	fileName := f.name
	modelName := filenamize(m.name)
	keeps := ((m.typ == "LORA" || m.typ == "LoCon") && !trainerBlobFileName.MatchString(f.name)) || modelName == ""
	if keeps {
		return fileName, nil
	}
	stripped, err := replaceInsensitive(v.name, m.name, m.unicode)
	if err != nil {
		return "", err
	}
	stripped, err = replaceInsensitive(stripped, modelName, m.unicode)
	if err != nil {
		return "", err
	}
	trimmed := jsTrim(stripped)
	if m.unicode {
		trimmed = jsTrimText(stripped)
	}
	versionName := filenamize(trimmed)
	if versionName == modelName {
		versionName = ""
	}
	ext := f.name
	if i := strings.LastIndex(f.name, "."); i >= 0 {
		ext = f.name[i+1:]
	}
	if !modelFileTypes[f.typ] {
		return f.name, nil
	}
	switch {
	case f.typ == "Training Data":
		fileName = joinNameParts(modelName, versionName, "trainingData") + ".zip"
	case m.typ == "TextualInversion":
		suffix := ""
		if f.typ == "Negative" {
			suffix = "-neg"
		}
		if len(v.trainedWords) > 0 && v.trainedWords[0] != "" {
			fileName = v.trainedWords[0] + suffix + "." + ext
		}
	case f.typ != "VAE":
		suffix := ""
		lower := strings.ToLower(fileName)
		switch {
		case strings.Contains(lower, "-inpainting"):
			if loc := inpaintingWord.FindStringIndex(versionName); loc != nil {
				versionName = versionName[:loc[0]] + versionName[loc[1]:]
			}
			suffix = "-inpainting"
		case strings.Contains(lower, ".instruct-pix2pix"):
			versionName = instructPix2pix.ReplaceAllString(versionName, "")
			suffix = ".instruct-pix2pix"
		case f.typ == "Text Encoder":
			suffix = "_txt"
		}
		fileName = joinNameParts(modelName, versionName) + suffix + "." + ext
	}
	return fileName, nil
}

var (
	instructPix2pix = regexp.MustCompile(`(?i)_?instruct|-?pix2pix`)
	// inpaintingWord is `/_?inpainting/i` (its first match is removed).
	inpaintingWord = regexp.MustCompile(`(?i)_?inpainting`)
)

func joinNameParts(parts ...string) string {
	kept := parts[:0:0]
	for _, p := range parts {
		if p != "" {
			kept = append(kept, p)
		}
	}
	return strings.Join(kept, "_")
}

// replaceInsensitive is `value.replace(new RegExp(escape(search), "gi"), "")`. JS's non-Unicode
// case-insensitive match folds code units its own way (Canonicalize, through the engine's ICU). ASCII
// text is matched here directly, where it and Go's fold agree; other text with unicode by the Node
// engine's own table (replaceInsensitiveUTF16, jscanon.json), and without it falls back
// (`v1-models-filename`).
func replaceInsensitive(value, search string, unicode bool) (string, error) {
	if search == "" {
		return value, nil
	}
	if !feed.IsASCII(value) || !feed.IsASCII(search) {
		if !unicode {
			return "", fallback.New("v1-models-filename")
		}
		return replaceInsensitiveUTF16(value, search), nil
	}
	lv, ls := strings.ToLower(value), strings.ToLower(search)
	var b strings.Builder
	for i := 0; i < len(value); {
		if strings.HasPrefix(lv[i:], ls) {
			i += len(ls)
			continue
		}
		b.WriteByte(value[i])
		i++
	}
	return b.String(), nil
}

// jsTrim is String.prototype.trim for ASCII text (the only text it reaches without nameModel.unicode;
// with it, jsTrimText).
func jsTrim(s string) string { return strings.Trim(s, " \t\n\v\f\r") }

// filenamize is filenamize (src/utils/string-helpers.ts): apostrophes dropped, every other UTF-16 code
// unit outside [a-z0-9] (case-insensitive) an underscore, truncated at an underscore to length plus
// the underscore count, camelCased.
func filenamize(value string) string {
	length := 20
	var b strings.Builder
	for _, r := range value {
		switch {
		case r == '\'':
		case (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') || (r >= '0' && r <= '9'):
			b.WriteRune(r)
		case r > 0xFFFF:
			b.WriteString("__") // a surrogate pair is two code units
		default:
			b.WriteByte('_')
		}
	}
	s := b.String()
	length += strings.Count(s, "_")
	return camelCase(truncateAtUnderscore(s, length))
}

// truncateAtUnderscore is lodash's truncate with `{ length, separator: '_', omission: "" }` over
// ASCII text.
func truncateAtUnderscore(s string, length int) string {
	const sep = "_"
	if length >= len(s) {
		return s
	}
	end := length
	if end < 1 {
		return ""
	}
	result := s[:end]
	if strings.Index(s[end:], sep) != 0 {
		if i := strings.LastIndex(result, sep); i > -1 {
			result = result[:i]
		}
	}
	return result
}

// camelCase is the repo's own camelCase (src/utils/string-helpers.ts, not lodash's): split on runs of
// whitespace, `_` or `-` (only `_` reaches it from filenamize), the first word lowercased, a word
// already all upper case (digits and the empty word included) kept, any other capitalized.
func camelCase(s string) string {
	var b strings.Builder
	words := splitWordRuns(s)
	for i, w := range words {
		switch {
		case i == 0:
			b.WriteString(strings.ToLower(w))
		case strings.ToUpper(w) == w:
			b.WriteString(w)
		default:
			b.WriteString(strings.ToUpper(w[:1]) + strings.ToLower(w[1:]))
		}
	}
	return b.String()
}

// splitWordRuns is `str.split(/[\s_-]+/)` over ASCII text: a separator run at either end leaves an
// empty word there, as JS's split does.
func splitWordRuns(s string) []string {
	isSep := func(c byte) bool {
		return c == '_' || c == '-' || c == ' ' || c == '\t' || c == '\n' || c == '\v' || c == '\f' || c == '\r'
	}
	var out []string
	start := 0
	for i := 0; i < len(s); {
		if !isSep(s[i]) {
			i++
			continue
		}
		out = append(out, s[start:i])
		for i < len(s) && isSep(s[i]) {
			i++
		}
		start = i
	}
	return append(out, s[start:])
}

func isDigit(c byte) bool { return c >= '0' && c <= '9' }

func preferredFileName(m nameModel, v nameVersion, f nameFile) (string, error) {
	if m.typ == "TextualInversion" || f.typ == "Training Data" {
		return computeFileName(m, v, f)
	}
	if isGenericFileName(f.name) || trainerBlobFileName.MatchString(f.name) {
		return computeFileName(m, v, f)
	}
	return f.name, nil
}

func insertBeforeExtension(name, suffix string) string {
	dot := strings.LastIndex(name, ".")
	if dot <= 0 {
		return name + "_" + suffix
	}
	return name[:dot] + "_" + suffix + name[dot:]
}

func variantSuffix(f nameFile) string {
	parts := make([]string, 0, 3)
	for _, p := range []any{f.size, f.fp, f.qt} {
		if s, ok := p.(string); ok && s != "" {
			parts = append(parts, filenamize(s))
		}
	}
	return strings.Join(parts, "_")
}

func nameKey(s string) string { return strings.ToLower(s) }

// nameVersionFiles names every file of a version at once (see the Node function).
func nameVersionFiles(m nameModel, v nameVersion, files []nameFile) ([]string, error) {
	names := make([]string, len(files))
	for i, f := range files {
		if f.overrideName != "" {
			names[i] = f.overrideName
			continue
		}
		n, err := preferredFileName(m, v, f)
		if err != nil {
			return nil, err
		}
		names[i] = n
	}
	counts := map[string]int{}
	for _, n := range names {
		counts[nameKey(n)]++
	}
	taken := map[string]bool{}
	moving := make([]int, 0, len(files))
	for i, f := range files {
		if f.overrideName != "" || counts[nameKey(names[i])] == 1 {
			taken[nameKey(names[i])] = true
		} else {
			moving = append(moving, i)
		}
	}
	scheme := func(f nameFile) (string, error) { return computeFileName(m, v, f) }
	stages := []func(nameFile) (string, bool, error){
		func(f nameFile) (string, bool, error) { s, err := scheme(f); return s, true, err },
		func(f nameFile) (string, bool, error) {
			suffix := variantSuffix(f)
			if suffix == "" {
				return "", false, nil
			}
			s, err := scheme(f)
			return insertBeforeExtension(s, suffix), true, err
		},
		func(f nameFile) (string, bool, error) {
			if !f.hasID {
				return "", false, nil
			}
			s, err := scheme(f)
			return insertBeforeExtension(s, strconv.Itoa(f.id)), true, err
		},
	}
	for _, stage := range stages {
		cands := make([]string, len(moving))
		has := make([]bool, len(moving))
		tried := map[string]int{}
		for j, i := range moving {
			c, ok, err := stage(files[i])
			if err != nil {
				return nil, err
			}
			cands[j], has[j] = c, ok && c != ""
			if has[j] {
				tried[nameKey(c)]++
			}
		}
		next := moving[:0:0]
		for j, i := range moving {
			if !has[j] {
				next = append(next, i)
				continue
			}
			key := nameKey(cands[j])
			if taken[key] || tried[key] != 1 {
				next = append(next, i)
				continue
			}
			names[i] = cands[j]
			taken[key] = true
		}
		moving = next
	}
	for _, i := range moving {
		base := ""
		if files[i].hasID {
			base = strconv.Itoa(files[i].id) + "_"
		}
		s, err := scheme(files[i])
		if err != nil {
			return nil, err
		}
		for attempt := 1; ; attempt++ {
			c := insertBeforeExtension(s, base+strconv.Itoa(attempt))
			if !taken[nameKey(c)] {
				names[i] = c
				taken[nameKey(c)] = true
				break
			}
		}
	}
	return names, nil
}

// resolveFileName is resolveModelFileName for a file found in versionFiles by id (the REST callers
// pass a copy of one of the version's own files).
func resolveFileName(m nameModel, v nameVersion, f nameFile, versionFiles []nameFile) (string, error) {
	if f.overrideName != "" {
		return headerSafeName(f.overrideName), nil
	}
	if len(versionFiles) == 0 {
		n, err := preferredFileName(m, v, f)
		return headerSafeName(n), err
	}
	index := -1
	for i, c := range versionFiles {
		if c.hasID && f.hasID && c.id == f.id {
			index = i
			break
		}
	}
	files := versionFiles
	if index < 0 {
		files = append([]nameFile{f}, versionFiles...)
	}
	names, err := nameVersionFiles(m, v, files)
	if err != nil {
		return "", err
	}
	if index < 0 {
		index = 0
	}
	return headerSafeName(names[index]), nil
}

// headerSafeName strips control and format characters, replaces `"` and `\`, and breaks every `%`
// followed by two hex digits. After it, safeDecodeURIComponent has nothing to decode: the name is
// returned as it is. Invalid UTF-8 (never in a Postgres text value, which is what Node reads) is
// replaced with U+FFFD first: stripping a character from between two stray bytes could otherwise
// join them into a control character ("\xc2\x7f\x89" → U+0089).
func headerSafeName(s string) string {
	s = strings.ToValidUTF8(s, "\uFFFD")
	s = unsafeNameChars.ReplaceAllString(s, "")
	s = strings.NewReplacer(`"`, "_", `\`, "_").Replace(s)
	var b strings.Builder
	for i := 0; i < len(s); i++ {
		if s[i] == '%' && i+2 < len(s) && isHexDigit(s[i+1]) && isHexDigit(s[i+2]) {
			b.WriteByte('_')
			continue
		}
		b.WriteByte(s[i])
	}
	return b.String()
}

func isHexDigit(c byte) bool {
	return isDigit(c) || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F')
}

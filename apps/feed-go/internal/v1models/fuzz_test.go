package v1models

import (
	"strings"
	"testing"

	"github.com/civitai/civitai/apps/feed-go/internal/fallback"
)

// FuzzParseList: any query string either parses into an input inside the schema's bounds or falls
// back; it never panics and never returns a non-fallback error.
func FuzzParseList(f *testing.F) {
	for _, s := range []string{
		"", "limit=5&sort=Newest&cursor=2026-06-02%2009%3A00%3A00.25%7C5300", "types=LORA&types=DoRA&nsfw=true",
		"username=Artist%20One&page=2", "ids=1,2,%203", "baseModels=SDXL%201.0", "query=x", "favorites=false",
		"limit=0", "page=11&limit=100", "a=%zz", "status=Draft&status=Published", "&&=&a",
	} {
		f.Add(s)
	}
	f.Fuzz(func(t *testing.T, raw string) {
		in, err := ParseList(raw)
		if err != nil {
			if fallback.Reason(err) == "" {
				t.Fatalf("%q: a non-fallback error %v", raw, err)
			}
			return
		}
		if in.Limit < 1 || in.Limit > 100 || in.Page < 0 || !sortsPorted[in.Sort] || !periods[in.Period] {
			t.Fatalf("%q: out of bounds %+v", raw, in)
		}
		if in.Page > 0 && in.Cursor == "" && in.Page*in.Limit > 1000 {
			t.Fatalf("%q: the paging guard let %d x %d through", raw, in.Page, in.Limit)
		}
		// Every statement the input can build is built, or its cursor falls back.
		if _, _, err := RawQuery(&RawInput{Take: in.Limit, Cursor: in.Cursor, Sort: in.Sort, Types: in.Types, IDs: in.IDs}); err != nil && fallback.Reason(err) == "" {
			t.Fatalf("%q: statement error %v", raw, err)
		}
	})
}

// FuzzResolveFileName: naming never panics, and a name it returns carries no character a
// Content-Disposition header must not (control or format characters, `"`, `\`).
func FuzzResolveFileName(f *testing.F) {
	for _, s := range [][3]string{
		{"Model 5001", "v1", "model.safetensors"},
		{"BB Bunny", "BB Bunny v2", "01HZX3J8K9M2N4P6Q7R8S9T0VW.safetensors"},
		{"Ünï 😀", "x\u200b", "a\"b\\c%41.zip"},
		{"", "", ""},
	} {
		f.Add(s[0], s[1], s[2], "Checkpoint", "Model")
	}
	f.Fuzz(func(t *testing.T, model, version, name, modelType, fileType string) {
		files := []nameFile{
			{id: 1, hasID: true, name: name, typ: fileType},
			{id: 2, hasID: true, name: name, typ: fileType, size: "pruned"},
		}
		for _, file := range files {
			got, err := resolveFileName(nameModel{model, modelType}, nameVersion{name: version, trainedWords: []string{name}}, file, files)
			if err != nil {
				if fallback.Reason(err) == "" {
					t.Fatalf("a non-fallback error %v", err)
				}
				continue
			}
			if strings.ContainsAny(got, "\"\\") || unsafeNameChars.MatchString(got) {
				t.Fatalf("unsafe name %q", got)
			}
		}
	})
}

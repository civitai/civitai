package v1models

import (
	"encoding/json"
	"os"
	"testing"
)

// The Node answers testdata/golden/gen-v1-filenames.mjs wrote: the REAL replaceInsensitive and
// resolveModelFileName (src/utils/string-helpers.ts, src/utils/model-file-naming.ts) over names with
// non-ASCII text.
type filenameCases struct {
	Replace []struct {
		Value, Search, Result string
	} `json:"replace"`
	Naming []struct {
		Model struct {
			Name, Type string
		} `json:"model"`
		Version struct {
			Name         string   `json:"name"`
			TrainedWords []string `json:"trainedWords"`
		} `json:"version"`
		Files []struct {
			ID           int            `json:"id"`
			Name         string         `json:"name"`
			OverrideName *string        `json:"overrideName"`
			Type         string         `json:"type"`
			Metadata     map[string]any `json:"metadata"`
		} `json:"files"`
		Names []string `json:"names"`
	} `json:"naming"`
}

func loadFilenameCases(t *testing.T) *filenameCases {
	t.Helper()
	raw, err := os.ReadFile("../../testdata/golden/v1-filenames/cases.json")
	if err != nil {
		t.Fatal(err)
	}
	var c filenameCases
	if err := json.Unmarshal(raw, &c); err != nil {
		t.Fatal(err)
	}
	// Positive control on the fixture: a file that read as empty would pass every loop below.
	if len(c.Replace) < 20 || len(c.Naming) < 10 {
		t.Fatalf("%d replace and %d naming cases, want at least 20 and 10", len(c.Replace), len(c.Naming))
	}
	return &c
}

// With nameModel.unicode, replaceInsensitive answers every case as Node's does (Straße and STRASSE,
// the Kelvin sign and k, ſ and s, İ and i, ﬁ and FI do not match; final and medial sigma, fullwidth
// letters, Cyrillic, a surrogate pair do); without it, non-ASCII text still falls back.
func TestReplaceInsensitiveIsNodes(t *testing.T) {
	for _, c := range loadFilenameCases(t).Replace {
		got, err := replaceInsensitive(c.Value, c.Search, true)
		if err != nil || got != c.Result {
			t.Errorf("replaceInsensitive(%q, %q) = %q (%v), Node %q", c.Value, c.Search, got, err, c.Result)
		}
		ascii := true
		for _, s := range []string{c.Value, c.Search} {
			for i := 0; i < len(s); i++ {
				ascii = ascii && s[i] < 0x80
			}
		}
		if _, err := replaceInsensitive(c.Value, c.Search, false); !ascii && c.Search != "" && reason(err) != "v1-models-filename" {
			t.Errorf("replaceInsensitive(%q, %q) without unicode: %v, want the v1-models-filename fallback", c.Value, c.Search, err)
		}
	}
}

// resolveFileName names each file of each case as Node's resolveModelFileName does, the version name
// stripped of the model name (in both spellings) with Node's case folding and trimmed with Node's
// whitespace set.
func TestResolveFileNameNonASCIIIsNodes(t *testing.T) {
	for _, c := range loadFilenameCases(t).Naming {
		files := make([]nameFile, len(c.Files))
		for i, f := range c.Files {
			nf := nameFile{id: f.ID, hasID: true, name: f.Name, typ: f.Type,
				size: f.Metadata["size"], fp: f.Metadata["fp"], qt: f.Metadata["quantType"]}
			if f.OverrideName != nil {
				nf.overrideName = *f.OverrideName
			}
			files[i] = nf
		}
		m := nameModel{name: c.Model.Name, typ: c.Model.Type, unicode: true}
		v := nameVersion{name: c.Version.Name, trainedWords: c.Version.TrainedWords}
		for i, f := range files {
			got, err := resolveFileName(m, v, f, files)
			if err != nil || got != c.Names[i] {
				t.Errorf("%q / %q file %d: %q (%v), Node %q", c.Model.Name, c.Version.Name, f.id, got, err, c.Names[i])
			}
		}
	}
}

// The canonical values the Node engine gives a few code units, pinned literally (ECMA-262
// Canonicalize: toUpperCase of the one unit, kept when it is longer than one unit or maps non-ASCII
// to ASCII).
func TestJSCanon(t *testing.T) {
	canon := jsCanon()
	for _, c := range []struct{ in, want uint16 }{
		{'a', 'A'}, {'Z', 'Z'}, {'0', '0'},
		{0x00e9, 0x00c9}, // é -> É
		{0x00df, 0x00df}, // ß: toUpperCase is "SS", two units
		{0x017f, 0x017f}, // ſ: uppercases to ASCII S, kept
		{0x0131, 0x0131}, // ı: uppercases to ASCII I, kept
		{0x212a, 0x212a}, // Kelvin sign: its own uppercase
		{0x03c2, 0x03a3}, // final sigma -> Σ
		{0x03c3, 0x03a3}, // sigma -> Σ
		{0x00b5, 0x039c}, // micro sign -> Μ
		{0xff4d, 0xff2d}, // fullwidth m -> M
		{0x01c6, 0x01c4}, // ǆ -> Ǆ
		{0x01c5, 0x01c4}, // ǅ (titlecase) -> Ǆ
		{0x1fb3, 0x1fb3}, // ᾳ: toUpperCase is "ΑΙ", two units
		{0xd83d, 0xd83d}, // a lone high surrogate is its own
	} {
		if got := canon[c.in]; got != c.want {
			t.Errorf("canon(U+%04X) = U+%04X, want U+%04X", c.in, got, c.want)
		}
	}
	if got := jsTrimText("\u00a0\u3000 x y\u2028\ufeff"); got != "x y" {
		t.Errorf("jsTrimText = %q, want %q", got, "x y")
	}
	// U+180E (Mongolian vowel separator) left Zs in Unicode 6.3: trim keeps it.
	if got := jsTrimText("\u180ex"); got != "\u180ex" {
		t.Errorf("jsTrimText(U+180E x) = %q, want it kept", got)
	}
}

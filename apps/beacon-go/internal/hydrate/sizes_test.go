package hydrate

import (
	"errors"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
)

// An array32 header claiming 2^32-1 elements must be refused, not allocated.
func TestUnpackRefusesLengthsTheInputCannotHold(t *testing.T) {
	for name, b := range map[string][]byte{
		"array32 of 2^32-1":       {0xdd, 0xff, 0xff, 0xff, 0xff},
		"map32 of 2^32-1":         {0xdf, 0xff, 0xff, 0xff, 0xff},
		"str32 of 2^32-1":         {0xdb, 0xff, 0xff, 0xff, 0xff},
		"bin32 of 2^32-1":         {0xc6, 0xff, 0xff, 0xff, 0xff},
		"ext32 of 2^32-1":         {0xc9, 0xff, 0xff, 0xff, 0xff, 0x01},
		"array16 nested in array": {0x91, 0xdc, 0xff, 0xff},
		"map in map value":        {0x81, 0xa1, 'k', 0xde, 0x00, 0x02, 0x01},
		"array one short":         {0x93, 0x01, 0x02},
		"str one short":           {0xa4, 'a', 'b', 'c'},
		"fixext8 one short":       {0xd7, 0xff, 0, 0, 0, 0, 0, 0, 0},
		"truncated length":        {0xdd, 0x00, 0x01},
		"never-used byte":         {0xc1},
		"empty":                   {},
	} {
		if _, err := Unpack(b); err == nil {
			t.Errorf("%s: Unpack(%x) accepted", name, b)
		}
		if err := checkSizes(b); !errors.Is(err, errTruncated) {
			t.Errorf("%s: checkSizes(%x) = %v, want errTruncated", name, b, err)
		}
	}
}

// The exact boundaries pass: every declared length met by the bytes, with trailing bytes ignored.
func TestCheckSizesAcceptsExactLengths(t *testing.T) {
	for name, b := range map[string][]byte{
		"array of 2":            {0x92, 0x01, 0x02},
		"str of 3":              {0xa3, 'a', 'b', 'c'},
		"map of 1":              {0x81, 0xa1, 'k', 0xc0},
		"fixext8 timestamp":     {0xd7, 0xff, 0, 0, 0, 0, 0, 0, 0, 0},
		"ext8 timestamp96":      append([]byte{0xc7, 12, 0xff}, make([]byte, 12)...),
		"float64":               {0xcb, 0x3f, 0xf8, 0, 0, 0, 0, 0, 0},
		"trailing bytes":        {0x01, 0xff, 0xff},
		"msgpackr undefined":    {0xd4, 0x00, 0x00},
		"nested empty":          {0x91, 0x90},
		"array16 of one nil":    {0xdc, 0x00, 0x01, 0xc0},
		"negative fixint":       {0xe0},
		"uint64":                {0xcf, 1, 2, 3, 4, 5, 6, 7, 8},
		"str8 of 2 then extra":  {0xd9, 0x02, 'h', 'i', 0x00},
		"map16 of 1 int to int": {0xde, 0x00, 0x01, 0x01, 0x02},
	} {
		if err := checkSizes(b); err != nil {
			t.Errorf("%s: checkSizes(%x) = %v", name, b, err)
		}
	}
	// The msgpackr session-user value in the fuzz seed corpus passes and decodes.
	seeds, err := filepath.Glob(filepath.Join("testdata", "fuzz", "FuzzUnpack", "golden-*"))
	if err != nil || len(seeds) == 0 {
		t.Fatalf("no golden seeds: %v", err)
	}
	for _, f := range seeds {
		b := seedBytes(t, f)
		if _, err := Unpack(b); err != nil {
			t.Errorf("golden %s: %v", f, err)
		}
	}
}

// The 16/32-bit length forms at the exact boundary: a declared length the bytes meet is accepted,
// the same bytes declaring one more are refused.
func TestCheckSizesWideLengthBoundaries(t *testing.T) {
	for _, c := range []struct {
		name      string
		fit, over []byte
	}{
		{"str32", []byte{0xdb, 0, 0, 0, 3, 'a', 'b', 'c'}, []byte{0xdb, 0, 0, 0, 4, 'a', 'b', 'c'}},
		{"bin32", []byte{0xc6, 0, 0, 0, 2, 0xff, 0xfe}, []byte{0xc6, 0, 0, 0, 3, 0xff, 0xfe}},
		{"ext16", []byte{0xc8, 0, 3, 0x05, 1, 2, 3}, []byte{0xc8, 0, 4, 0x05, 1, 2, 3}},
		{"ext32", []byte{0xc9, 0, 0, 0, 3, 0x05, 1, 2, 3}, []byte{0xc9, 0, 0, 0, 4, 0x05, 1, 2, 3}},
		{"array32", []byte{0xdd, 0, 0, 0, 2, 0x01, 0x02}, []byte{0xdd, 0, 0, 0, 3, 0x01, 0x02}},
		{"map32", []byte{0xdf, 0, 0, 0, 1, 0x01, 0x02}, []byte{0xdf, 0, 0, 0, 2, 0x01, 0x02}},
	} {
		if err := checkSizes(c.fit); err != nil {
			t.Errorf("%s exact fit %x: %v", c.name, c.fit, err)
		}
		if err := checkSizes(c.over); !errors.Is(err, errTruncated) {
			t.Errorf("%s one over %x: %v, want errTruncated", c.name, c.over, err)
		}
	}
}

// seedBytes reads a `go test fuzz v1` corpus file holding one []byte value.
func seedBytes(t *testing.T, path string) []byte {
	t.Helper()
	raw, err := os.ReadFile(path) //nolint:gosec // G304: a corpus path from a glob under testdata
	if err != nil {
		t.Fatal(err)
	}
	lines := strings.Split(strings.TrimSpace(string(raw)), "\n")
	if len(lines) != 2 || lines[0] != "go test fuzz v1" || !strings.HasPrefix(lines[1], "[]byte(") {
		t.Fatalf("%s: not a []byte corpus entry", path)
	}
	v, err := strconv.Unquote(strings.TrimSuffix(strings.TrimPrefix(lines[1], "[]byte("), ")"))
	if err != nil {
		t.Fatalf("%s: %v", path, err)
	}
	return []byte(v)
}

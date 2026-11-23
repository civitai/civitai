package sign

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

// The golden vectors: testdata/vectors.json, computed outside both implementations (Python's hmac)
// and read byte-identically by the site's test. Every expected value comes from the file, never
// from this package.
type vector struct {
	Name       string            `json:"name"`
	Key        string            `json:"key"`
	Method     string            `json:"method"`
	Path       string            `json:"path"`
	Query      string            `json:"query"`
	Timestamp  string            `json:"timestamp"`
	Region     map[string]string `json:"region"`
	RegionLine string            `json:"regionLine"`
	Body       string            `json:"body"`
	BodySha256 string            `json:"bodySha256"`
	Canonical  string            `json:"canonical"`
	Signature  string            `json:"signature"`
}

func TestTheGoldenVectors(t *testing.T) {
	raw, err := os.ReadFile(filepath.Join("testdata", "vectors.json"))
	if err != nil {
		t.Fatal(err)
	}
	var file struct {
		Vectors []vector `json:"vectors"`
	}
	if err := json.Unmarshal(raw, &file); err != nil {
		t.Fatal(err)
	}
	// Positive control: an empty or truncated file must not pass as agreement; and the file must
	// hold a vector with a region and one without, and one with a body and one without.
	withRegion, withBody := 0, 0
	for _, v := range file.Vectors {
		if len(v.Region) > 0 {
			withRegion++
		}
		if v.Body != "" {
			withBody++
		}
	}
	if len(file.Vectors) < 3 || withRegion == 0 || withRegion == len(file.Vectors) || withBody == 0 || withBody == len(file.Vectors) {
		t.Fatalf("%d vectors (%d with a region, %d with a body): want at least 3, each kind both ways", len(file.Vectors), withRegion, withBody)
	}
	for _, v := range file.Vectors {
		t.Run(v.Name, func(t *testing.T) {
			var values [3]string
			for i, h := range RegionHeaders {
				values[i] = v.Region[h]
			}
			if len(v.Region) > countPresent(values) {
				t.Fatalf("region %v names a header outside %v", v.Region, RegionHeaders)
			}
			if got := RegionLine(values); got != v.RegionLine {
				t.Fatalf("region line %q, want %q", got, v.RegionLine)
			}
			sum := sha256.Sum256([]byte(v.Body))
			if got := hex.EncodeToString(sum[:]); got != v.BodySha256 {
				t.Fatalf("body hash %s, want %s", got, v.BodySha256)
			}
			if got := Canonical(v.Method, v.Path, v.Query, v.Timestamp, []byte(v.Body), RegionLine(values)); got != v.Canonical {
				t.Fatalf("canonical:\n%q\nwant\n%q", got, v.Canonical)
			}
			if got := Sign([]byte(v.Key), v.Method, v.Path, v.Query, v.Timestamp, []byte(v.Body), RegionLine(values)); got != v.Signature {
				t.Fatalf("signature %s, want %s", got, v.Signature)
			}
			// Each input is signed: another region line changes the signature.
			if Sign([]byte(v.Key), v.Method, v.Path, v.Query, v.Timestamp, []byte(v.Body), v.RegionLine+"X") == v.Signature {
				t.Fatal("the region line is not signed")
			}
		})
	}
}

func countPresent(values [3]string) int {
	n := 0
	for _, v := range values {
		if v != "" {
			n++
		}
	}
	return n
}

// The method is uppercased; a lone x-isuk keeps its two leading commas.
func TestTheMethodIsUppercasedAndTheRegionLineKeepsItsPositions(t *testing.T) {
	if RegionLine([3]string{"", "", "1"}) != ",,1" || RegionLine([3]string{"GB", "", ""}) != "GB,," {
		t.Fatalf("%q %q", RegionLine([3]string{"", "", "1"}), RegionLine([3]string{"GB", "", ""}))
	}
	if Canonical("delete", "/p", "q=1", "7", nil, "") != Canonical("DELETE", "/p", "q=1", "7", []byte{}, "") {
		t.Fatal("the method is not uppercased, or an empty body hashes differently from none")
	}
}

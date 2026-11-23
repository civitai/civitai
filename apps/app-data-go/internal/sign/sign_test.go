package sign

import "testing"

// The golden vectors. Every expected value below was computed OUTSIDE Go, with
// `printf '<canonical>' | openssl dgst -sha256 -hmac test-signing-key-0001` and cross-checked with
// Python's hmac module, and is pinned as a literal: never derive it from Sign. The site's
// TypeScript test pins the same inputs and the same hex.
const goldenKey = "test-signing-key-0001" //nolint:gosec // G101: a published test vector key, not a credential

func TestTheGoldenVector(t *testing.T) {
	body := []byte(`{"data":{"n":1},"ifVersion":0}`)
	const (
		wantCanonical = "PUT\n/api/internal/blocks/storage/kv/run-01\nfrom=model-benchmarking\n1795000000\n" +
			"f5edde14e10252c60e896284b60e1ef276ae22fcc79e5c3ada8eaedf0cda2a3e"
		wantSig = "47db374505acbf36f3fce466ff71b2cb1a7ab014831408122a1c52cd4a7a880d"
	)
	if got := Canonical("PUT", "/api/internal/blocks/storage/kv/run-01", "from=model-benchmarking", "1795000000", body); got != wantCanonical {
		t.Fatalf("canonical:\n%q\nwant\n%q", got, wantCanonical)
	}
	if got := Sign([]byte(goldenKey), "PUT", "/api/internal/blocks/storage/kv/run-01", "from=model-benchmarking", "1795000000", body); got != wantSig {
		t.Fatalf("signature %s, want %s", got, wantSig)
	}
}

// An empty body hashes as zero bytes, the method is uppercased, and the query is signed as sent.
func TestAnEmptyBodyAndALowercaseMethod(t *testing.T) {
	const (
		wantCanonical = "DELETE\n/api/internal/blocks/storage/records/01JX\nfrom=model-benchmarking&ifVersion=3\n1795000001\n" +
			"e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
		wantSig = "51056ecf567e973795d820c6d55e00344e7147d4564fb3a933801c452a8336e2"
	)
	if got := Canonical("delete", "/api/internal/blocks/storage/records/01JX", "from=model-benchmarking&ifVersion=3", "1795000001", nil); got != wantCanonical {
		t.Fatalf("canonical:\n%q\nwant\n%q", got, wantCanonical)
	}
	if got := Sign([]byte(goldenKey), "DELETE", "/api/internal/blocks/storage/records/01JX", "from=model-benchmarking&ifVersion=3", "1795000001", []byte{}); got != wantSig {
		t.Fatalf("signature %s, want %s", got, wantSig)
	}
	// Any one input changed changes the signature (a constant answer would pass the vectors above
	// only if it were exactly one of them).
	if Sign([]byte(goldenKey), "DELETE", "/api/internal/blocks/storage/records/01JX", "from=model-benchmarking&ifVersion=4", "1795000001", nil) == wantSig {
		t.Fatal("the query is not signed")
	}
}

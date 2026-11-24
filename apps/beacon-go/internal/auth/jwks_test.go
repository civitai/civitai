package auth

import (
	"bytes"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"testing"
)

// coords returns a key's 32-byte big-endian x and y (from its uncompressed SEC 1 encoding).
func coords(t *testing.T, k *ecdsa.PrivateKey) (x, y []byte) {
	t.Helper()
	b, err := k.PublicKey.Bytes()
	if err != nil || len(b) != 65 || b[0] != 4 {
		t.Fatalf("PublicKey.Bytes = %x, %v", b, err)
	}
	return b[1:33], b[33:]
}

func TestP256PublicKey(t *testing.T) {
	k, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	x, y := coords(t, k)

	pub, err := p256PublicKey(x, y)
	if err != nil || !pub.Equal(&k.PublicKey) {
		t.Fatalf("full-width coordinates: %v, equal %v", err, err == nil && pub.Equal(&k.PublicKey))
	}
	// Leading zero bytes beyond 32 are the same integer.
	if pub, err := p256PublicKey(append([]byte{0, 0}, x...), append([]byte{0}, y...)); err != nil || !pub.Equal(&k.PublicKey) {
		t.Fatalf("zero-prefixed coordinates refused: %v", err)
	}
	// A 33rd significant byte is not a P-256 coordinate.
	if _, err := p256PublicKey(append([]byte{1}, x...), y); err == nil {
		t.Fatal("a 33-byte coordinate was accepted")
	}
	// Off the curve: y + 1.
	bad := bytes.Clone(y)
	bad[len(bad)-1] ^= 1
	if _, err := p256PublicKey(x, bad); err == nil {
		t.Fatal("a point off the curve was accepted")
	}
	if _, err := p256PublicKey(nil, nil); err == nil {
		t.Fatal("the zero point was accepted")
	}
}

// A coordinate whose integer value is shorter than 32 bytes (encoded without its leading zero, as a
// minimal big-endian integer) still names the key: about one key in 256 has such an x (4096 tries
// all missing is about e^-16).
func TestP256PublicKeyShortCoordinate(t *testing.T) {
	for i := 0; i < 4096; i++ {
		k, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
		if err != nil {
			t.Fatal(err)
		}
		x, y := coords(t, k)
		if x[0] != 0 {
			continue
		}
		pub, err := p256PublicKey(x[1:], y)
		if err != nil || !pub.Equal(&k.PublicKey) {
			t.Fatalf("short x refused: %v", err)
		}
		return
	}
	t.Fatal("no key with a short x in 4096 tries")
}

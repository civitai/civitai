package exchange

import (
	"context"
	"testing"
)

// A signed-out viewer's block token (`sub: anon`) is verified by CheckAnonymous with every check
// Check makes, and answers its slug, its app block and its browsing levels. Fails on origin/main:
// there is no CheckAnonymous (the test does not compile); behaviourally, every anonymous token is
// refused there (`anonymous`).
func TestASignedOutTokenVerifiesAndAnswersItsClaims(t *testing.T) {
	testKeys(t)
	s := newJWKS(t, jwk(&siteKey.PublicKey, siteKid))
	v := verifier(s, &clock{t: verifyNow})
	anon := map[string]any{"sub": "anon", "blockId": "model-benchmarking", "maxBrowsingLevel": 31, "viewerBrowsingLevel": 3}
	got, err := v.CheckAnonymous(context.Background(), siteToken(t, anon))
	if err != nil || got.BlockID != "model-benchmarking" || got.AppBlockID != "apb_01notes" ||
		got.MaxBrowsingLevel == nil || *got.MaxBrowsingLevel != 31 || got.ViewerBrowsingLevel == nil || *got.ViewerBrowsingLevel != 3 {
		t.Fatalf("%+v %v", got, err)
	}
	// No viewer level: nil, not 0 (resolveViewerBrowsingLevel reads the two differently).
	got, err = v.CheckAnonymous(context.Background(), siteToken(t, map[string]any{"sub": "anon", "blockId": "mb", "viewerBrowsingLevel": nil}))
	if err != nil || got.ViewerBrowsingLevel != nil || got.MaxBrowsingLevel == nil {
		t.Fatalf("absent viewer level: %+v %v", got, err)
	}
	// Check still refuses it: a signed-out token never reaches the hub.
	if r := localReason(v.Check(context.Background(), siteToken(t, anon))); r != "anonymous" {
		t.Fatalf("Check of an anonymous token: %q", r)
	}
}

// 🔴 Every other check still refuses, and a signed-in token is not signed-out. Each case starts from
// the accepted anonymous token and changes one thing.
func TestASignedOutTokenKeepsEveryOtherCheck(t *testing.T) {
	testKeys(t)
	s := newJWKS(t, jwk(&siteKey.PublicKey, siteKid))
	v := verifier(s, &clock{t: verifyNow})
	base := map[string]any{"sub": "anon", "blockId": "model-benchmarking"}
	with := func(over map[string]any) map[string]any {
		out := map[string]any{}
		for k, val := range base {
			out[k] = val
		}
		for k, val := range over {
			out[k] = val
		}
		return out
	}
	forged := claimsAt(verifyNow)
	for k, val := range base {
		forged[k] = val
	}
	cases := map[string]struct {
		token  string
		reason string
	}{
		"signed in":           {siteToken(t, with(map[string]any{"sub": "user:42"})), "signed in"},
		"forged":              {sign(t, forgerKey, map[string]any{"alg": "RS256", "typ": "JWT", "kid": siteKid}, forged), "signature or claims"},
		"expired":             {siteToken(t, with(map[string]any{"exp": verifyNow.Unix() - 60})), "signature or claims"},
		"dev":                 {siteToken(t, with(map[string]any{"dev": true})), "dev token"},
		"review":              {siteToken(t, with(map[string]any{"reviewRunForReal": true})), "review token"},
		"private run":         {siteToken(t, with(map[string]any{"privateRun": true})), "private run"},
		"too old":             {siteToken(t, with(map[string]any{"iat": verifyNow.Unix() - 2000, "exp": verifyNow.Unix() + 60})), "too old"},
		"no blockId":          {siteToken(t, map[string]any{"sub": "anon"}), "claim shape"},
		"bad max level":       {siteToken(t, with(map[string]any{"maxBrowsingLevel": -1})), "claim shape"},
		"fractional viewer":   {siteToken(t, with(map[string]any{"viewerBrowsingLevel": 1.5})), "claim shape"},
		"string viewer level": {siteToken(t, with(map[string]any{"viewerBrowsingLevel": "3"})), "claim shape"},
		"malformed":           {"a.b", "malformed"},
	}
	for name, tc := range cases {
		if _, err := v.CheckAnonymous(context.Background(), tc.token); localReason(err) != tc.reason {
			t.Errorf("%s: %v, want reason %q", name, err, tc.reason)
		}
	}
}

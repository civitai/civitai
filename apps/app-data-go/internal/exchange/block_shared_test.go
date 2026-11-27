package exchange

import (
	"context"
	"crypto/sha256"
	"errors"
	"testing"
	"time"
)

// fakeShared is a SharedBlocks that answers Begin with begin, and records how each claim ended.
type fakeShared struct {
	begin SharedBegin
	ended []string
	ids   [][sha256.Size]byte
}

func (f *fakeShared) Begin(_ context.Context, id [sha256.Size]byte) SharedBegin {
	f.ids = append(f.ids, id)
	return f.begin
}

func (f *fakeShared) Issued(_ context.Context, claim any, tok Token) {
	f.ended = append(f.ended, "issued:"+claim.(string)+":"+tok.Access)
}

func (f *fakeShared) Refused(_ context.Context, claim any, r *RefusedError) {
	f.ended = append(f.ended, "refused:"+claim.(string)+":"+r.Code)
}

func (f *fakeShared) Release(_ context.Context, claim any) {
	f.ended = append(f.ended, "released:"+claim.(string))
}

func TestASharedStoreIsAskedByTheTokensDigestBeforeTheHub(t *testing.T) {
	for name, tc := range map[string]struct {
		begin    SharedBegin
		hubErr   error
		wantErr  error
		wantTok  string
		hubCalls int
		ended    string
		observed string
	}{
		"another process issued it: the hub is not asked": {
			begin:   SharedBegin{State: SharedIssued, Token: Token{Access: "x.elsewhere", Expires: time.Unix(1_700_000_000, 0).Add(10 * time.Minute)}},
			wantTok: "x.elsewhere", observed: "[reused/none]",
		},
		"another process was refused: remembered, the hub not asked": {
			begin:   SharedBegin{State: SharedRefused, Refusal: &RefusedError{Status: 400, Code: "invalid_grant"}},
			wantErr: ErrRefused, observed: "[remembered/invalid_grant]",
		},
		"another process holds the claim: pending, the hub not asked": {
			begin:   SharedBegin{State: SharedPending},
			wantErr: ErrBlockPending, observed: "[failed/none]",
		},
		"claimed here: the hub's token replaces the claim": {
			begin: SharedBegin{State: SharedClaimed, Claim: "c1"}, wantTok: "x." + blockA, hubCalls: 1,
			ended: "issued:c1:x." + blockA, observed: "[issued/none]",
		},
		"claimed here: the hub's refusal replaces the claim": {
			begin: SharedBegin{State: SharedClaimed, Claim: "c1"}, hubErr: &RefusedError{Status: 401, Code: "invalid_client"},
			wantErr: ErrRefused, hubCalls: 1, ended: "refused:c1:invalid_client", observed: "[refused/invalid_client]",
		},
		"claimed here: a failure releases the claim": {
			begin: SharedBegin{State: SharedClaimed, Claim: "c1"}, hubErr: errors.New("hub unreachable"),
			wantErr: errors.New(""), hubCalls: 1, ended: "released:c1", observed: "[failed/none]",
		},
		"the store unavailable: fail open, the hub asked as without it": {
			begin: SharedBegin{State: SharedUnavailable}, wantTok: "x." + blockA, hubCalls: 1, observed: "[issued/none]",
		},
	} {
		t.Run(name, func(t *testing.T) {
			bc, h, _, o := newBlockCache()
			if tc.hubErr != nil {
				h.answer[blockA] = tc.hubErr
			}
			shared := &fakeShared{begin: tc.begin}
			bc.Shared = shared
			tok, err := bc.Exchange(context.Background(), blockA)
			switch {
			case tc.wantErr == nil && (err != nil || tok.Access != tc.wantTok):
				t.Fatalf("%+v %v", tok, err)
			case tc.wantErr != nil && err == nil:
				t.Fatal("no error")
			case tc.wantErr != nil && tc.wantErr.Error() != "" && !errors.Is(err, tc.wantErr):
				t.Fatalf("err %v, want %v", err, tc.wantErr)
			}
			if h.count(blockA) != tc.hubCalls {
				t.Fatalf("the hub was asked %d times, want %d", h.count(blockA), tc.hubCalls)
			}
			if got := ""; len(shared.ended) > 0 {
				got = shared.ended[0]
				if got != tc.ended {
					t.Fatalf("ended %q, want %q", got, tc.ended)
				}
			} else if tc.ended != "" {
				t.Fatalf("not ended, want %q", tc.ended)
			}
			if o.String() != tc.observed {
				t.Fatalf("observed %s, want %s", o, tc.observed)
			}
			// 🔴 Keyed by the whole token's digest, never a claim read from it.
			if shared.ids[0] != sha256.Sum256([]byte(blockA)) {
				t.Fatal("asked under another id")
			}
		})
	}
}

// Another process's token with too little left to open a stream with is spent, as one of this
// cache's own would be.
func TestASharedTokenNearItsExpiryIsSpent(t *testing.T) {
	bc, _, c, o := newBlockCache()
	bc.Shared = &fakeShared{begin: SharedBegin{State: SharedIssued, Token: Token{Access: "x.old", Expires: c.now().Add(20 * time.Second)}}}
	if _, err := bc.Exchange(context.Background(), blockA); !errors.Is(err, ErrSpent) {
		t.Fatalf("err %v", err)
	}
	if o.String() != "[spent/none]" {
		t.Fatalf("observed %s", o)
	}
}

// A token the local check refuses never reaches the shared store: a flood of made-up tokens writes
// nothing there.
func TestALocallyRefusedTokenNeverReachesTheSharedStore(t *testing.T) {
	bc, h, _, _ := newBlockCache()
	shared := &fakeShared{begin: SharedBegin{State: SharedClaimed, Claim: "c"}}
	bc.Shared = shared
	bc.Verify = func(context.Context, string) error {
		return &RefusedError{Status: 400, Code: LocalRefusalCode}
	}
	if _, err := bc.Exchange(context.Background(), blockA); !errors.Is(err, ErrRefused) {
		t.Fatal(err)
	}
	if len(shared.ids) != 0 || h.count(blockA) != 0 {
		t.Fatalf("store asked %d times, hub %d", len(shared.ids), h.count(blockA))
	}
}

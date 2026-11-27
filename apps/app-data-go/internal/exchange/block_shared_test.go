package exchange

import (
	"context"
	"crypto/sha256"
	"errors"
	"testing"
	"time"
)

// fakeShared is a SharedBlocks holding at most what Save was given (or a preset), recording ids.
type fakeShared struct {
	held  map[[sha256.Size]byte]Token
	loads [][sha256.Size]byte
	saved []Token
}

func (f *fakeShared) Load(_ context.Context, id [sha256.Size]byte) (Token, bool) {
	f.loads = append(f.loads, id)
	tok, ok := f.held[id]
	return tok, ok
}

func (f *fakeShared) Save(_ context.Context, id [sha256.Size]byte, tok Token) {
	if f.held == nil {
		f.held = map[[sha256.Size]byte]Token{}
	}
	f.held[id] = tok
	f.saved = append(f.saved, tok)
}

// Another process's issued token is reused, the hub not asked; keyed by the whole token's digest.
func TestASharedTokenIsReusedWithoutTheHub(t *testing.T) {
	bc, h, c, o := newBlockCache()
	id := sha256.Sum256([]byte(blockA))
	shared := &fakeShared{held: map[[sha256.Size]byte]Token{id: {Access: "x.elsewhere", Expires: c.now().Add(10 * time.Minute)}}}
	bc.Shared = shared
	tok, err := bc.Exchange(context.Background(), blockA)
	if err != nil || tok.Access != "x.elsewhere" || h.count(blockA) != 0 || len(shared.saved) != 0 {
		t.Fatalf("%+v %v (hub %d, saved %d)", tok, err, h.count(blockA), len(shared.saved))
	}
	if o.String() != "[reused/none]" || shared.loads[0] != id {
		t.Fatalf("observed %s", o)
	}
}

// A miss asks the hub, and only an issued token is saved, held to MaxTokenLife.
func TestAMissAsksTheHubAndSavesOnlyAnIssuedToken(t *testing.T) {
	bc, h, c, o := newBlockCache()
	h.life = time.Hour // the hub overstating: held to 15 minutes
	shared := &fakeShared{}
	bc.Shared = shared
	if _, err := bc.Exchange(context.Background(), blockA); err != nil || h.count(blockA) != 1 {
		t.Fatal(err)
	}
	if len(shared.saved) != 1 || !shared.saved[0].Expires.Equal(c.now().Add(MaxTokenLife)) {
		t.Fatalf("saved %+v", shared.saved)
	}
	// A refusal, and a failure, are never saved.
	h.answer["b.b.b"] = &RefusedError{Status: 400, Code: "invalid_grant"}
	h.answer["c.c.c"] = errors.New("hub unreachable")
	_, _ = bc.Exchange(context.Background(), "b.b.b")
	_, _ = bc.Exchange(context.Background(), "c.c.c")
	if len(shared.saved) != 1 {
		t.Fatalf("saved %d", len(shared.saved))
	}
	if o.String() != "[issued/none refused/invalid_grant failed/none]" {
		t.Fatalf("observed %s", o)
	}
}

// Another process's token with too little left to open a stream with is spent, as one of this
// cache's own would be.
func TestASharedTokenNearItsExpiryIsSpent(t *testing.T) {
	bc, _, c, o := newBlockCache()
	id := sha256.Sum256([]byte(blockA))
	bc.Shared = &fakeShared{held: map[[sha256.Size]byte]Token{id: {Access: "x.old", Expires: c.now().Add(20 * time.Second)}}}
	if _, err := bc.Exchange(context.Background(), blockA); !errors.Is(err, ErrSpent) {
		t.Fatalf("err %v", err)
	}
	if o.String() != "[spent/none]" {
		t.Fatalf("observed %s", o)
	}
}

// A token the local check refuses never reaches the shared store.
func TestALocallyRefusedTokenNeverReachesTheSharedStore(t *testing.T) {
	bc, h, _, _ := newBlockCache()
	shared := &fakeShared{}
	bc.Shared = shared
	bc.Verify = func(context.Context, string) error {
		return &RefusedError{Status: 400, Code: LocalRefusalCode}
	}
	if _, err := bc.Exchange(context.Background(), blockA); !errors.Is(err, ErrRefused) {
		t.Fatal(err)
	}
	if len(shared.loads) != 0 || h.count(blockA) != 0 {
		t.Fatalf("store asked %d times, hub %d", len(shared.loads), h.count(blockA))
	}
}

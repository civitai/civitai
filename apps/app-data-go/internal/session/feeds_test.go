package session

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/civitai/civitai/apps/app-data-go/internal/registry"
)

// OTHER FEEDS: the options a level or per-viewer stream manager is built with (package shared).

const levelCursor = "b1.0a1b2c3d4e5f60718293a4b5.l1.0123456789abcdef0123456789abcdef"

func acceptLevel(c string) bool { return strings.Contains(c, ".l1.") }

// A manager whose Accept names another feed serves that feed's Live and refuses the private feed's:
// the cursor test is the option, not the private feed's prefix.
func TestAcceptNamesTheFeedAManagerReads(t *testing.T) {
	h := newHarness(t, Options{Accept: acceptLevel})
	h.o.cursors["lvl"] = levelCursor
	h.o.records["lvl"] = []registry.Entity{entity("urn:apps.civitai.com:todo-app/notes/k-1", "L")}
	got, err := read(t, h.m, "lvl", schemaA)
	if err != nil || urns(got) != "urn:apps.civitai.com:todo-app/notes/k-1" {
		t.Fatalf("level stream: %v %v", urns(got), err)
	}
	// The private feed's own cursor is not this manager's feed.
	if _, err := read(t, h.m, "priv", schemaA); !errors.Is(err, ErrNotPrivate) {
		t.Fatalf("private cursor under a level manager: %v, want ErrNotPrivate", err)
	}
}

// SubscribeMeta names the request meta per subject, and is sent on the subscription; a manager whose
// subscriber cannot send one fails the stream rather than open it without its meta (a level stream
// opened without its level would be routed as some other feed).
func TestSubscribeMetaIsSentAndNeverDropped(t *testing.T) {
	meta := func(subject string) json.RawMessage {
		if subject == "plain" {
			return nil
		}
		return json.RawMessage(`{"level":` + strings.TrimPrefix(subject, "lvl-") + `}`)
	}
	h := newHarness(t, Options{SubscribeMeta: meta})
	if _, err := read(t, h.m, "lvl-4", schemaA); err != nil {
		t.Fatal(err)
	}
	if _, err := read(t, h.m, "plain", schemaA); err != nil {
		t.Fatal(err)
	}
	h.o.mu.Lock()
	got4, gotPlain := h.o.subMetas["lvl-4"], h.o.subMetas["plain"]
	h.o.mu.Unlock()
	if len(got4) != 1 || got4[0] != `{"level":4}` || len(gotPlain) != 0 {
		t.Fatalf("metas sent: lvl-4 %v, plain %v", got4, gotPlain)
	}

	// A subscriber without SubscribeMeta: the stream fails, nothing is opened without the meta.
	o := newOrigin()
	c := &clock{t: time.Unix(1_700_000_000, 0)}
	o.now = c.now
	m := New(plainSubscriber{o}, Options{Exchange: o.Exchange, SubscribeMeta: meta, MaxStreams: 2, MaxPerToken: 2, IdleTTL: time.Hour,
		MaxAge: time.Hour, MaxRecords: 10, MaxBytes: 1 << 20, Cooldown: time.Minute, ExpiryMargin: time.Second, Now: c.now})
	defer m.Close()
	if _, err := read(t, m, "lvl-8", schemaA); !errors.Is(err, ErrFailed) || o.opened.Load() != 0 {
		t.Fatalf("no MetaSubscriber: %v, opened %d", err, o.opened.Load())
	}
}

type plainSubscriber struct{ o *fakeOrigin }

func (p plainSubscriber) Subscribe(ctx context.Context, schema, token string) (Stream, error) {
	return p.o.Subscribe(ctx, schema, token)
}

// View answers the stream's latest meta and head beside its records: the Live's, then each
// Progress's, and a Progress with no meta keeps the last one.
func TestViewAnswersTheLatestMetaAndHead(t *testing.T) {
	h := newHarness(t, overlayOpts())
	h.o.liveMetas["tok-a"] = json.RawMessage(`{"head":{"seq":40},"mask":3}`)
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	snap, err := h.m.View(ctx, "tok-a", schemaA, 0)
	if err != nil || string(snap.Meta) != `{"head":{"seq":40},"mask":3}` || !snap.HasHead || snap.Head != 40 {
		t.Fatalf("at Live: %+v %v", snap, err)
	}
	st := h.o.last(t, "tok-a")
	st.push(t, step{ev: registry.Event{Type: registry.Progress, Meta: json.RawMessage(`{"head":{"seq":57}}`)}})
	st.push(t, step{ev: registry.Event{Type: registry.Progress}})
	barrier(t, st, "v")
	eventually(t, "the progress meta", func() bool {
		snap, err = h.m.View(ctx, "tok-a", schemaA, 0)
		return err == nil && len(snap.Entities) == 1
	})
	if string(snap.Meta) != `{"head":{"seq":57}}` || snap.Head != 57 {
		t.Fatalf("after progress: %+v", snap)
	}
	// A floored read answers the snapshot too (here met by the head).
	snap, err = h.m.View(ctx, "tok-a", schemaA, 57)
	if err != nil || snap.Head != 57 {
		t.Fatalf("floored view: %+v %v", snap, err)
	}
}

// An end naming a reason is an EndedError, answered to the read that meets it and, while the key
// cools down, to every later read (joined with ErrCoolingDown); an end naming none, or a reason
// outside the grammar, is plain ErrEnded.
func TestAnEndsReasonIsAnsweredThroughTheCooldown(t *testing.T) {
	for meta, want := range map[string]string{`{"reason":"levels_off"}`: "levels_off", `{}`: "", `{"reason":"Not A Word"}`: ""} {
		h := newHarness(t, Options{})
		if _, err := read(t, h.m, "tok-a", schemaA); err != nil {
			t.Fatal(err)
		}
		h.o.last(t, "tok-a").push(t, step{ev: registry.Event{Type: registry.End, Meta: json.RawMessage(meta)}})
		eventually(t, "the end", func() bool { return h.closedFor(CloseEnd) == 1 })
		_, err := read(t, h.m, "tok-a", schemaA)
		var ended *EndedError
		switch {
		case !errors.Is(err, ErrCoolingDown):
			t.Fatalf("%s: %v, want cooling down", meta, err)
		case want == "" && errors.As(err, &ended):
			t.Fatalf("%s: a reason %q", meta, ended.Reason)
		case want != "" && (!errors.As(err, &ended) || ended.Reason != want || !errors.Is(err, ErrEnded)):
			t.Fatalf("%s: %v, want reason %s", meta, err, want)
		}
		// Past the cooldown the cause is forgotten with it, and the key opens again.
		h.c.add(31 * time.Second)
		h.m.Sweep()
		if _, err := read(t, h.m, "tok-a", schemaA); err != nil {
			t.Fatalf("%s after the cooldown: %v", meta, err)
		}
	}
	if !strings.Contains((&EndedError{Reason: "levels_on"}).Error(), "levels_on") {
		t.Fatal("the error names its reason")
	}
}

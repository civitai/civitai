package shared

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/civitai/civitai/apps/app-data-go/internal/session"
)

// gatedViews is fakeViews whose reads of one subject wait until gate is closed.
type gatedViews struct {
	*fakeViews
	subject string
	gate    chan struct{}
	waiting chan struct{}
}

func (g *gatedViews) View(ctx context.Context, token, sch string, minSeq int64) (session.Snapshot, error) {
	if token == g.subject {
		g.waiting <- struct{}{}
		<-g.gate
	}
	return g.fakeViews.View(ctx, token, sch, minSeq)
}

// SIGNED-OUT: a schema not Known is probed with its first level stream alone; the rest of the mask's
// streams are read only once that one answered. A failed probe reads nothing else and leaves the
// schema unknown; a signed-in read is never a probe, and any successful read makes the schema Known.
func TestASignedOutReadProbesAnUnknownSchemaWithOneStream(t *testing.T) {
	g := newRig()
	anon := Viewer{Anonymous: &Anonymous{Mask: 1 | 2 | 4, AppBlockID: "apb_bench"}}
	g.levels.fail(lvl("1"), schema, &session.EndedError{Reason: "not_resolved"})
	if _, err := g.read(t, anon, 0); err == nil {
		t.Fatal("a probe that did not resolve answered")
	}
	if g.levels.n(lvl("2")) != 0 || g.levels.n(lvl("4")) != 0 || g.levels.n(lvl("1")) != 1 {
		t.Fatalf("🔴 an unresolved probe read bits 1/2/4 %d/%d/%d times, want 1/0/0",
			g.levels.n(lvl("1")), g.levels.n(lvl("2")), g.levels.n(lvl("4")))
	}
	if g.r.Known(schema) {
		t.Fatal("an unresolved schema is Known")
	}
	g.levels.fail(lvl("1"), schema, nil)
	for _, b := range []string{"1", "2", "4"} {
		g.levels.set(lvl(b), schema, snap(40, `{"block":"apb_bench"}`))
	}
	if _, err := g.read(t, anon, 0); err != nil {
		t.Fatal(err)
	}
	if !g.r.Known(schema) {
		t.Fatal("a resolved schema is not Known")
	}
	// Known: the next signed-out read reads its streams once each, no probe first.
	before := g.levels.n(lvl("1"))
	if _, err := g.read(t, anon, 0); err != nil || g.levels.n(lvl("1")) != before+1 {
		t.Fatalf("a Known schema's read: %v, bit 1 read %d more times, want 1", err, g.levels.n(lvl("1"))-before)
	}
	// It is forgotten after KnownTTL.
	g.c.add(time.Hour)
	if g.r.Known(schema) {
		t.Fatal("still Known after KnownTTL")
	}
}

// 🔴 At most ProbesPerApp signed-out probes run at once per slug: one past it is ErrSignedOutBusy and
// reads nothing, while another slug's probe is not held to it.
func TestSignedOutProbesAreCappedPerApp(t *testing.T) {
	g := newRig()
	g.r.ProbesPerApp = 1
	gated := &gatedViews{fakeViews: g.levels, subject: lvl("1"), gate: make(chan struct{}), waiting: make(chan struct{}, 4)}
	g.r.Levels = gated
	g.levels.set(lvl("1"), schema, snap(40, `{"block":"apb_bench"}`))
	anon := Viewer{Anonymous: &Anonymous{Mask: 1, AppBlockID: "apb_bench"}}
	done := make(chan error, 1)
	go func() { _, err := g.read(t, anon, 0); done <- err }()
	<-gated.waiting
	if _, err := g.read(t, anon, 0); !errors.Is(err, ErrSignedOutBusy) {
		t.Fatalf("a second probe of the slug: %v, want ErrSignedOutBusy", err)
	}
	other := "urn:schema:apps.civitai.com:other-app/records@v1"
	g.levels.set(LevelSubject(other, "1"), other, snap(50, `{"block":"apb_other"}`))
	if _, err := g.r.Read(context.Background(), Viewer{Anonymous: &Anonymous{Mask: 1, AppBlockID: "apb_other"}}, "other-app", "records", 1, 0); err != nil {
		t.Fatalf("another slug's probe: %v", err)
	}
	close(gated.gate)
	if err := <-done; err != nil {
		t.Fatalf("the first probe: %v", err)
	}
	// Its slot was given back.
	g.r.mu.Lock()
	running := len(g.r.probes)
	g.r.mu.Unlock()
	if running != 0 {
		t.Fatalf("%d slugs still hold probes", running)
	}
}

// 🔴 THE SERVICE TOKEN: a level stream refused invalid_token is ErrServiceToken, never the viewer's
// ErrInvalidToken; a per-viewer stream refused so is still the viewer's own.
func TestALevelStreamsInvalidTokenIsTheServicesNotTheViewers(t *testing.T) {
	g := newRig()
	g.viewers.set(hubTok, vschema, snap(30, `{"mask":1}`))
	g.levels.fail(lvl("1"), schema, session.ErrInvalidToken)
	_, err := g.read(t, Viewer{Token: hubTok}, 0)
	if !errors.Is(err, ErrServiceToken) || errors.Is(err, session.ErrInvalidToken) {
		t.Fatalf("level stream refused: %v, want ErrServiceToken only", err)
	}
	g.viewers.fail(hubTok, vschema, session.ErrInvalidToken)
	if _, err := g.read(t, Viewer{Token: hubTok}, 0); !errors.Is(err, session.ErrInvalidToken) {
		t.Fatalf("per-viewer stream refused: %v, want the viewer's ErrInvalidToken", err)
	}
}

// Overlays.MaxBytes bounds the shared overlays' size apart from their count.
func TestOverlaysAreBoundedByBytes(t *testing.T) {
	o := &Overlays{TTL: time.Minute, Max: 100, MaxBytes: 300}
	body := json.RawMessage(`"` + strings.Repeat("x", 200) + `"`)
	o.Ack(hubTok, schema, session.Ack{Key: "k-1", Seq: 1, Body: body})
	o.Ack(hubTok, schema, session.Ack{Key: "k-2", Seq: 2, Body: body})
	if o.Len() != 1 {
		t.Fatalf("%d held, want 1 (the second passes 300 bytes)", o.Len())
	}
	// Replacing the held one counts its own size once.
	o.Ack(hubTok, schema, session.Ack{Key: "k-1", Seq: 3, Body: body})
	o.mu.Lock()
	bytes := o.bytes
	o.mu.Unlock()
	if o.Len() != 1 || bytes != len("k-1")+len(body) {
		t.Fatalf("after a replace %d held, %d bytes", o.Len(), bytes)
	}
}

type ackRecorder struct{ schemas []string }

func (a *ackRecorder) Ack(_, schema string, _ session.Ack) { a.schemas = append(a.schemas, schema) }

// AckBoth: every write reaches the private manager; only a write to a Known shared schema is held as
// a shared overlay, so private writes stay out of the shared overlay map.
func TestAckBothKeepsPrivateWritesOutOfTheSharedOverlays(t *testing.T) {
	g := newRig()
	priv := &ackRecorder{}
	ack := AckBoth(priv, g.r)
	private := "urn:schema:apps.civitai.com:bench-app/notes@v1"
	ack(hubTok, private, session.Ack{Key: "k-p", Seq: 70, Body: json.RawMessage(`{}`)})
	ack(hubTok, schema, session.Ack{Key: "k-s", Seq: 71, Body: json.RawMessage(`{}`)})
	if g.r.Overlays.Len() != 0 {
		t.Fatalf("🔴 %d overlays held for schemas never Known", g.r.Overlays.Len())
	}
	g.viewers.set(hubTok, vschema, snap(30, `{"mask":1}`))
	g.levels.set(lvl("1"), schema, snap(40, `{"block":"apb_bench"}`))
	if _, err := g.read(t, Viewer{Token: hubTok}, 0); err != nil {
		t.Fatal(err)
	}
	ack(hubTok, schema, session.Ack{Key: "k-s", Seq: 72, Body: json.RawMessage(`{}`)})
	ack(hubTok, private, session.Ack{Key: "k-p", Seq: 73, Body: json.RawMessage(`{}`)})
	if g.r.Overlays.Len() != 1 {
		t.Fatalf("%d overlays held, want the Known shared schema's 1", g.r.Overlays.Len())
	}
	if strings.Join(priv.schemas, " ") != strings.Join([]string{private, schema, schema, private}, " ") {
		t.Fatalf("the private manager saw %v", priv.schemas)
	}
}

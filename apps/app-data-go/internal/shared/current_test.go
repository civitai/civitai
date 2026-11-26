package shared

import (
	"encoding/json"
	"testing"

	"github.com/civitai/civitai/apps/app-data-go/internal/session"
)

// The current major of a shared read is the one EVERY level stream read names (level-feed.ts
// levelMeta `currentMajor`); a stream naming none, or two naming different majors, is 0 (unknown),
// and a malformed one never hides the rest of the meta.
func TestTheBoardsCurrentMajorIsTheOneEveryLevelStreamNames(t *testing.T) {
	snap := func(meta string) session.Snapshot { return session.Snapshot{Meta: json.RawMessage(meta)} }
	cases := []struct {
		name  string
		views []session.Snapshot
		want  int
	}{
		{"one names 3", []session.Snapshot{snap(`{"currentMajor":3}`)}, 3},
		{"two name 7", []session.Snapshot{snap(`{"currentMajor":7}`), snap(`{"currentMajor":7,"truncated":true}`)}, 7},
		{"two disagree", []session.Snapshot{snap(`{"currentMajor":7}`), snap(`{"currentMajor":8}`)}, 0},
		{"second names none", []session.Snapshot{snap(`{"currentMajor":7}`), snap(`{"block":"b"}`)}, 0},
		{"first names none", []session.Snapshot{snap(`{}`), snap(`{"currentMajor":7}`)}, 0},
		{"none read", nil, 0},
		{"zero", []session.Snapshot{snap(`{"currentMajor":0}`)}, 0},
		{"fraction", []session.Snapshot{snap(`{"currentMajor":2.5}`)}, 0},
		{"string", []session.Snapshot{snap(`{"currentMajor":"2"}`)}, 0},
		{"past the URN grammar", []session.Snapshot{snap(`{"currentMajor":1000000000}`)}, 0},
	}
	for _, c := range cases {
		if got := agreedCurrent(c.views); got != c.want {
			t.Errorf("%s: %d; want %d", c.name, got, c.want)
		}
	}
	m := readLevelMeta(json.RawMessage(`{"block":"blk-9","truncated":true,"currentMajor":"x"}`))
	if m.Block != "blk-9" || !m.Truncated || m.CurrentMajor != 0 {
		t.Fatalf("a malformed currentMajor beside the block: %+v", m)
	}
}

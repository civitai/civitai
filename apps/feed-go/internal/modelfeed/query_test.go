package modelfeed

import (
	"reflect"
	"regexp"
	"strings"
	"testing"
	"time"

	"github.com/civitai/civitai/apps/feed-go/internal/fallback"
)

var wsRun = regexp.MustCompile(`\s+`)

// norm collapses whitespace so a pinned statement reads as one line: runs become one space, and the
// space after `(` and before `)` goes.
func norm(s string) string {
	s = strings.TrimSpace(wsRun.ReplaceAllString(s, " "))
	return strings.ReplaceAll(strings.ReplaceAll(s, "( ", "("), " )", ")")
}

func build(t *testing.T, q PageQuery) SQL {
	t.Helper()
	stmt, err := q.Build()
	if err != nil {
		t.Fatalf("Build: %v", err)
	}
	return stmt
}

// The whole statement for the plainest feed page, transcribed from getModelsRaw (standard path,
// Highest Rated, no cursor): signed out, the poi switch and two excluded tags (one repeated).
func TestBuildHighestRatedFirstPage(t *testing.T) {
	stmt := build(t, PageQuery{Take: 2, Sort: SortHighestRated, BrowsingLevel: 1, DisablePoi: true, ExcludedTagIDs: []int{5, 5, 6}})
	want := `SELECT mm."modelId" as "id", m."name"::text as "name", m."sfwName"::text as "sfwName", m."coverImageId", m."sfwCoverImageId",
		m."type"::text as "type", mm."minor", m."sfwOnly", mm."poi", m."nsfw", mm."nsfwLevel",
		mm."status"::text as "status", m."createdAt", mm."lastVersionAt", m."publishedAt", m."locked", m."meta",
		mm."mode"::text as "mode", mm."availability"::text as "availability",
		jsonb_build_object('downloadCount', mm."downloadCount", 'thumbsUpCount', mm."thumbsUpCount",
		  'thumbsDownCount', mm."thumbsDownCount", 'commentCount', mm."commentCount",
		  'collectedCount', mm."collectedCount", 'tippedAmountCount', mm."tippedAmountCount") as "rank",
		mm."userId", CONCAT(mm."thumbsUpCount", '|', mm."downloadCount", '|', mm."modelId")::text as "cursorId"
		FROM "ModelMetric" mm JOIN "Model" m ON m."id" = mm."modelId"
		WHERE (mm."mode" IS NULL OR mm."mode" != 'Archived'::"ModelModifier")
		AND (mm."poi" = false OR mm."userId" = $1)
		AND NOT EXISTS (SELECT 1 FROM "TagsOnModels" tom WHERE tom."modelId" = m."id" AND tom."tagId" = ANY($2::int[]))
		AND mm."status" = 'Published'::"ModelStatus"
		AND mm."availability" != 'Private'::"Availability"
		AND (mm."nsfwLevel" & $3) != 0
		ORDER BY mm."thumbsUpCount" DESC, mm."downloadCount" DESC, mm."modelId"
		LIMIT $4`
	if got := norm(stmt.Text); got != norm(want) {
		t.Fatalf("SQL:\n got  %s\n want %s", got, norm(want))
	}
	wantArgs := []any{nil, []int{5, 6}, 1, 3}
	if !reflect.DeepEqual(stmt.Args, wantArgs) {
		t.Fatalf("args %#v, want %#v", stmt.Args, wantArgs)
	}
}

// Newest with a cursor: the split form (equality branch first, then the strict tuple compare), each
// branch limited, and the outer limit; the timestamp token bound as a time.
func TestBuildNewestCursorSplits(t *testing.T) {
	stmt := build(t, PageQuery{Take: 2, Sort: SortNewest, BrowsingLevel: 31, Cursor: "2026-06-15 10:00:00.375|42", ViewerID: 7, IsModerator: true})
	got := norm(stmt.Text)
	for _, frag := range []string{
		`(mm."lastVersionAt" = $2 AND mm."modelId" <= $3)`,
		`((mm."lastVersionAt") < ($1))`,
		`ORDER BY mm."lastVersionAt" DESC NULLS LAST, mm."modelId" DESC`,
		`CONCAT(mm."lastVersionAt", '|', mm."modelId")::text as "cursorId"`,
		`UNION ALL`,
	} {
		if !strings.Contains(got, frag) {
			t.Errorf("missing %s in\n%s", frag, got)
		}
	}
	// Equality first: its branch precedes UNION ALL.
	if strings.Index(got, `mm."modelId" <= $3`) > strings.Index(got, "UNION ALL") {
		t.Error("the equality branch must come first")
	}
	// A moderator is not held to the availability filter.
	if strings.Contains(got, `'Private'`) {
		t.Error("moderator: no availability clause")
	}
	ts := time.Date(2026, 6, 15, 10, 0, 0, 375_000_000, time.UTC)
	wantArgs := []any{ts, ts, int64(42), 31, 3}
	if !reflect.DeepEqual(stmt.Args, wantArgs) {
		t.Fatalf("args %#v, want %#v", stmt.Args, wantArgs)
	}
	if n := strings.Count(got, "LIMIT $5"); n != 3 {
		t.Fatalf("LIMIT $5 appears %d times, want 3 (each branch and the outer)", n)
	}
}

// Oldest's head field is ASC: no split, the legacy OR predicate ANDed in.
func TestBuildOldestCursorLegacy(t *testing.T) {
	stmt := build(t, PageQuery{Take: 5, Sort: SortOldest, BrowsingLevel: 1, Cursor: "2026-01-02 03:04:05|9"})
	got := norm(stmt.Text)
	frag := `((mm."lastVersionAt" > $1) OR (mm."lastVersionAt" = $2 AND mm."modelId" >= $3))`
	if !strings.Contains(got, frag) || strings.Contains(got, "UNION ALL") {
		t.Fatalf("want %s and no UNION ALL in\n%s", frag, got)
	}
}

// Hot's last field is ASC: the equality branch is inclusive upward.
func TestBuildHotCursor(t *testing.T) {
	stmt := build(t, PageQuery{Take: 5, Sort: SortHot, BrowsingLevel: 1, Cursor: "12|5001"})
	got := norm(stmt.Text)
	for _, frag := range []string{`(mm."hotScore" = $2 AND mm."modelId" >= $3)`, `((mm."hotScore") < ($1))`, `ORDER BY mm."hotScore" DESC, mm."modelId"`} {
		if !strings.Contains(got, frag) {
			t.Errorf("missing %s in\n%s", frag, got)
		}
	}
	if !reflect.DeepEqual(stmt.Args[:3], []any{int64(12), int64(12), int64(5001)}) {
		t.Fatalf("args %#v", stmt.Args)
	}
}

// The three base-model paths of getModelsRaw's FROM clause (base-model-feed-metrics on), by the
// filter's size and sort.
func TestBuildBaseModelPaths(t *testing.T) {
	cases := []struct {
		name       string
		q          PageQuery
		has, lacks []string
	}{
		{"one base model: the per-base-model table drives", PageQuery{Sort: SortHighestRated, BaseModels: []string{"A"}},
			[]string{`FROM "ModelBaseModelMetric" mbm JOIN "Model" m ON m."id" = mbm."modelId" JOIN "ModelMetric" mm`, `mbm."baseModel" = $`,
				`mbm."modelId" as "id"`, `ORDER BY mbm."thumbsUpCount" DESC, mbm."downloadCount" DESC, mbm."modelId"`, `mbm."status" = 'Published'`},
			[]string{"LATERAL"}},
		{"several, Newest: ModelMetric drives, the sums by LATERAL", PageQuery{Sort: SortNewest, BaseModels: []string{"A", "B"}},
			[]string{`LEFT JOIN LATERAL`, `LEAST(SUM("downloadCount")::int, mm."downloadCount")`, `EXISTS (SELECT 1 FROM "ModelBaseModelMetric" mbmm`,
				`'downloadCount', mbm."downloadCount"`, `mm."status" = 'Published'`, `mm."modelId" as "id"`},
			[]string{"GROUP BY"}},
		{"several, Highest Rated: the aggregate subquery", PageQuery{Sort: SortHighestRated, BaseModels: []string{"A", "B"}},
			[]string{`GROUP BY "modelId") mbs`, `CROSS JOIN LATERAL`, `mbm."status" = 'Published'`, `mbm."modelId" as "id"`},
			[]string{"LEFT JOIN LATERAL", "mbmm"}},
	}
	for _, c := range cases {
		c.q.Take, c.q.BrowsingLevel = 10, 1
		got := norm(build(t, c.q).Text)
		for _, f := range c.has {
			if !strings.Contains(got, f) {
				t.Errorf("%s: missing %s in\n%s", c.name, f, got)
			}
		}
		for _, f := range c.lacks {
			if strings.Contains(got, f) {
				t.Errorf("%s: unexpected %s in\n%s", c.name, f, got)
			}
		}
	}
}

// Every optional filter, each with its bound value in order.
func TestBuildFilters(t *testing.T) {
	no, yes := false, true
	cutoff := time.Date(2026, 5, 15, 12, 0, 0, 0, time.UTC)
	stmt := build(t, PageQuery{
		Take: 10, Sort: SortMostDiscussed, BrowsingLevel: 3, ViewerID: 7, Archived: true, DisableMinor: true,
		ExcludedTagIDs: []int{4}, TagID: 9, FromPlatform: true, TargetUserID: 8, Types: []string{"Checkpoint", "LORA"},
		PeriodCutoff: cutoff, AllowCommercialUse: []string{"Sell"}, AllowDerivatives: &no, AllowDifferentLicense: &yes,
		AllowNoCredit: &no, CheckpointType: "Merge", EarlyAccess: true, PaidAccess: true, HidePaid: true, OnSale: true,
		ExcludedUserIDs: []int{3}, FileFormats: []string{"SafeTensor", "GGUF"},
	})
	got := norm(stmt.Text)
	for _, f := range []string{
		`(mm."minor" = false OR mm."userId" = $1)`,
		`tom."tagId" = ANY($2::int[])) OR m."userId" = $3)`,
		`tom."modelId" = m."id" AND tom."tagId" = $4)`,
		`mv."trainingStatus" IS NOT NULL`,
		`mm."userId" = $5`,
		`m.type = ANY($6::text[]::"ModelType"[])`,
		`(mm."lastVersionAt" >= $7)`,
		`m."allowCommercialUse" && $8::text[]::"CommercialUse"[]`,
		`m."allowDerivatives" = $9`, `m."allowDifferentLicense" = $10`, `m."allowNoCredit" = $11`,
		`(m."checkpointType" = $12::text::"CheckpointType" OR m."type" = ANY($13::text[]::"ModelType"[]))`,
		`pa."endsAt" > NOW()`, `pa."timeframeDays" IS NULL`, `NOT EXISTS (SELECT 1 FROM "PaidAccess" pa`, `"ModelVersionSaleItem"`,
		`mm."userId" != ALL($14::int[])`,
		`(mf."metadata" @> '{"format": "SafeTensor"}' OR mf."metadata" @> '{"format": "GGUF"}')`,
		`(mm."nsfwLevel" & $15) != 0`,
		`ORDER BY mm."commentCount" DESC, mm."thumbsUpCount" DESC, mm."modelId"`,
		`LIMIT $16`,
	} {
		if !strings.Contains(got, f) {
			t.Errorf("missing %s", f)
		}
	}
	if strings.Contains(got, `'Archived'`) {
		t.Error("archived: no mode clause")
	}
	want := []any{7, []int{4}, 7, 9, 8, []string{"Checkpoint", "LORA"}, cutoff, []string{"Sell"}, false, true, false, "Merge",
		[]string{"LORA"}, []int{3}, 3, 11}
	if !reflect.DeepEqual(stmt.Args, want) {
		t.Fatalf("args\n got  %#v\n want %#v", stmt.Args, want)
	}
}

// checkpointType applies only when the types allow checkpoints; alone it keeps every other type too.
func TestBuildCheckpointType(t *testing.T) {
	got := norm(build(t, PageQuery{Take: 1, BrowsingLevel: 1, CheckpointType: "Trained"}).Text)
	if !strings.Contains(got, `(m."checkpointType" = $1::text::"CheckpointType" OR m."type" != 'Checkpoint')`) {
		t.Fatalf("checkpointType alone:\n%s", got)
	}
	got = norm(build(t, PageQuery{Take: 1, BrowsingLevel: 1, CheckpointType: "Trained", Types: []string{"LORA"}}).Text)
	if strings.Contains(got, "checkpointType") {
		t.Fatalf("types without Checkpoint: no checkpointType clause:\n%s", got)
	}
}

func TestParseCursor(t *testing.T) {
	two := []sortField{{field: "a", desc: true}, {field: "b"}}
	ok := []struct {
		cursor string
		want   []any
	}{
		{"12|34", []any{int64(12), int64(34)}},
		{"12.7|1e5", []any{int64(12), int64(1)}}, // parseInt reads the leading integer
		{" 7|0", []any{int64(7), int64(0)}},
		{"2026-06-15 10:00:00|3", []any{time.Date(2026, 6, 15, 10, 0, 0, 0, time.UTC), int64(3)}},
		{"2026-06-15 10:00:00.123456|3", []any{time.Date(2026, 6, 15, 10, 0, 0, 123_000_000, time.UTC), int64(3)}},
		{"2026-06-15 10:00:00.125|3", []any{time.Date(2026, 6, 15, 10, 0, 0, 125_000_000, time.UTC), int64(3)}},
		{"2026-06-15T10:00:00.040|3", []any{time.Date(2026, 6, 15, 10, 0, 0, 40_000_000, time.UTC), int64(3)}},
		// A 1- or 2-digit fraction is fractional seconds (".25" is 250 ms), as Node reads it since #9075.
		{"2026-06-15 10:00:00.25|3", []any{time.Date(2026, 6, 15, 10, 0, 0, 250_000_000, time.UTC), int64(3)}},
		{"2026-06-15 10:00:00.5|3", []any{time.Date(2026, 6, 15, 10, 0, 0, 500_000_000, time.UTC), int64(3)}},
		{"2026-06-15T10:00:00.07|3", []any{time.Date(2026, 6, 15, 10, 0, 0, 70_000_000, time.UTC), int64(3)}},
	}
	for _, c := range ok {
		got, err := parseCursor(two, c.cursor)
		if err != nil || !reflect.DeepEqual(got, c.want) {
			t.Errorf("parseCursor(%q) = %#v, %v; want %#v", c.cursor, got, err, c.want)
		}
	}
	for _, bad := range []string{"12", "1|2|3", "|5", "abc|5", "-5|1", "2147483648|1", "2026-13-45 00:00:00|1", "1-2|3"} {
		if _, err := parseCursor(two, bad); fallback.Reason(err) != "model-cursor" {
			t.Errorf("parseCursor(%q): %v, want the model-cursor fallback", bad, err)
		}
	}
}

func TestParseSortString(t *testing.T) {
	got := parseSortString(`mm."lastVersionAt" DESC NULLS LAST, mbm."modelId" DESC`)
	want := []sortField{{field: `mm."lastVersionAt"`, desc: true}, {field: `mbm."modelId"`, desc: true}}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("%#v", got)
	}
	if p := cursorProp(want); p != `CONCAT(mm."lastVersionAt", '|', mbm."modelId")` {
		t.Fatalf("prop %s", p)
	}
}

func TestDecreaseDate(t *testing.T) {
	at := func(y int, m time.Month, d int) time.Time { return time.Date(y, m, d, 12, 30, 0, 0, time.UTC) }
	for _, c := range []struct {
		now    time.Time
		period string
		want   time.Time
	}{
		{at(2026, 3, 31), "Month", at(2026, 2, 28)}, // dayjs clamps to the shorter month
		{at(2028, 2, 29), "Year", at(2027, 2, 28)},
		{at(2026, 6, 15), "Month", at(2026, 5, 15)},
		{at(2026, 1, 1), "Day", at(2025, 12, 31)},
		{at(2026, 6, 15), "Week", at(2026, 6, 8)},
	} {
		if got := decreaseDate(c.now, c.period); !got.Equal(c.want) {
			t.Errorf("decreaseDate(%s, %s) = %s, want %s", c.now, c.period, got, c.want)
		}
	}
}

package v1models

import (
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/civitai/civitai/apps/feed-go/internal/fallback"
	"github.com/civitai/civitai/apps/feed-go/internal/feed"
	"github.com/civitai/civitai/apps/feed-go/internal/superjson"
)

// The expected values in this file's naming, primary-file, download-URL and edge-URL tables are the
// REAL Node functions' outputs (resolveModelFileName, filenamize, getPrimaryFile,
// createModelFileDownloadUrl, createSerializedFileDownloadUrl, getEdgeUrl), computed from the repo's
// source over these inputs; none is derived from this package.

func reason(err error) string { return fallback.Reason(err) }

func TestParseList(t *testing.T) {
	in, err := ParseList("")
	if err != nil {
		t.Fatal(err)
	}
	if in.Limit != 100 || in.Sort != SortHighestRated || in.Period != "AllTime" || in.PeriodMode != "published" ||
		in.Page != 0 || in.Cursor != "" || in.IDs != nil || in.Nsfw || in.Username != "" {
		t.Fatalf("defaults: %+v", in)
	}

	in, err = ParseList("limit=5&page=3&sort=Newest&period=Week&periodMode=stats&types=LORA&types=DoRA" +
		"&baseModels=Pony&username=Artist%20One%21%20x&nsfw=True&primaryFileOnly=1&earlyAccess=yes&archived=off" +
		"&ids=1,%202&status=Draft&utm=x&token=abc")
	if err != nil {
		t.Fatal(err)
	}
	want := ListInput{
		Limit: 5, Page: 3, Sort: SortNewest, SortNamed: true, Period: "Week", PeriodMode: "stats", Types: []string{"LORA", "DoRA"},
		// postgresSlugify: the first space an underscore, then every non-word character dropped.
		BaseModels: []string{"Pony"}, Username: "artist_onex", Nsfw: true, PrimaryFileOnly: true, EarlyAccess: true,
		IDs: []int{1, 2},
	}
	in.Query = nil
	if !reflect.DeepEqual(*in, want) {
		t.Fatalf("parsed:\n got  %+v\n want %+v", *in, want)
	}

	in, err = ParseList("ids=4&ids=5")
	if err != nil || !reflect.DeepEqual(in.IDs, []int{4, 5}) {
		t.Fatalf("repeated ids: %v %v", in, err)
	}

	for raw, want := range map[string]string{
		// A repeated key is an array, which the schema refuses.
		"query=&query=":  "v1-models-query",
		"query=&query=x": "v1-models-query",
		// A text query: `query && page` is a 400; a cursor is the search offset, read here only as
		// decimal digits; a lone empty baseModels value is dropped by the schema, not here. Each is the
		// one text query reason.
		"query=a&page=2":                   "v1-models-query",
		"query=a&cursor=1.5":               "v1-models-query",
		"query=a&cursor=-1":                "v1-models-query",
		"query=a&cursor=1e2":               "v1-models-query",
		"query=a&cursor=%205":              "v1-models-query",
		"query=a&cursor=1234567890":        "v1-models-query",
		"query=a&baseModels=":              "v1-models-query",
		"query=a&baseModels=x&baseModels=": "v1-models-query",
		"query=%ED%A0%80":                  "v1-models-query-encoding",
		"tag=caf%C3%A9":                    "v1-models-tag",
		"tag=a&tag=b":                      "v1-models-input-duplicate",
		"tagname=x":                        "v1-models-tagname",
		"tag=x&tagname=x":                  "v1-models-tagname",
		"favorites=false":                  "v1-models-authed-only",
		"hidden=1":                         "v1-models-authed-only",
		"supportsGeneration=true":          "v1-models-supportsGeneration",
		"browsingLevel=31":                 "v1-models-browsingLevel",
		"limit=0":                          "v1-models-limit",
		"limit=101":                        "v1-models-limit",
		"limit=1.5":                        "v1-models-input-number",
		"limit=1&limit=2":                  "v1-models-input-number",
		"page=0":                           "v1-models-input-number",
		"page=11&limit=100":                "v1-models-page-limit",
		"sort=Recently%20Added":            "v1-models-sort",
		"sort=Best":                        "v1-models-sort",
		"sort=Newest&sort=Oldest":          "v1-models-input-duplicate",
		"period=Hour":                      "v1-models-input-enum",
		"periodMode=x":                     "v1-models-input-enum",
		"types=Lora":                       "v1-models-input-enum",
		"status=Live":                      "v1-models-input-enum",
		"nsfw=maybe":                       "v1-models-input-bool",
		"nsfw=1&nsfw=0":                    "v1-models-input-duplicate",
		"ids=1,x":                          "v1-models-ids",
		"cursor=a&cursor=b":                "v1-models-input-duplicate",
		"username=a&username=b":            "v1-models-input-duplicate",
		"a=%zz":                            "v1-models-query-encoding",
	} {
		if _, err := ParseList(raw); reason(err) != want {
			t.Errorf("%s: reason %q (%v), want %q", raw, reason(err), err, want)
		}
	}
	// An empty `query` is falsy: the database path, the key kept for nextPage (where QS.stringify's
	// skipEmptyString drops it). With `page` it is no 400 (`query && page`).
	for _, raw := range []string{"query=", "query", "limit=5&query=&foo=bar", "query=&page=2&limit=5"} {
		in, err := ParseList(raw)
		if err != nil {
			t.Errorf("%s: %v (%s)", raw, err, reason(err))
			continue
		}
		found := false
		for _, p := range in.Query {
			found = found || p.Key == "query"
		}
		if !found {
			t.Errorf("%s: the query key is not kept for nextPage: %+v", raw, in.Query)
		}
	}
	// A truthy `query` (a blank included: no trim) is the text search: its text, the cursor as its
	// offset, and whether `sort` was named (the schema default is never sent to the search).
	for raw, want := range map[string]ListInput{
		"query=golden":                 {Text: "golden"},
		"query=%20":                    {Text: " "},
		"query=+":                      {Text: " "},
		"limit=5&query=a":              {Text: "a"},
		"query=a&cursor=007":           {Text: "a", TextOffset: 7},
		"query=a&cursor=":              {Text: "a"},
		"query=a&sort=Highest%20Rated": {Text: "a", SortNamed: true},
		"query=a&page=11&limit=100":    {}, // the 429 is decided first
	} {
		in, err := ParseList(raw)
		if want.Text == "" {
			if reason(err) != "v1-models-page-limit" {
				t.Errorf("%s: %v, want v1-models-page-limit", raw, err)
			}
			continue
		}
		if err != nil {
			t.Errorf("%s: %v (%s)", raw, err, reason(err))
			continue
		}
		if in.Text != want.Text || in.TextOffset != want.TextOffset || in.SortNamed != want.SortNamed {
			t.Errorf("%s: text %q offset %d sortNamed %v, want %+v", raw, in.Text, in.TextOffset, in.SortNamed, want)
		}
	}
	// `tag` is read; an empty one is no filter (`tagname ?? tag` is falsy).
	for raw, want := range map[string]string{"tag=character": "character", "tag=Some%20Tag": "Some Tag", "tag=": ""} {
		in, err := ParseList(raw)
		if err != nil {
			t.Errorf("%s: %v (%s)", raw, err, reason(err))
		} else if in.Tag != want {
			t.Errorf("%s: tag %q, want %q", raw, in.Tag, want)
		}
	}
	// A cursor lifts the paging guard: `page && !cursor`.
	if _, err := ParseList("page=11&limit=100&cursor=1"); err != nil {
		t.Errorf("page with a cursor: %v", err)
	}
}

func TestParseID(t *testing.T) {
	for in, want := range map[string]int{"1": 1, "0042": 42, "2147483647": 2147483647} {
		if got, err := ParseID(in); err != nil || got != want {
			t.Errorf("%q: %d %v, want %d", in, got, err, want)
		}
	}
	for _, in := range []string{"", "0", "-1", "1e3", "2147483648", "12a", " 1", "123456789012345678901"} {
		if _, err := ParseID(in); reason(err) != "v1-models-id" {
			t.Errorf("%q: %v, want v1-models-id", in, err)
		}
	}
}

func TestPostgresSlugify(t *testing.T) {
	for in, want := range map[string]string{
		"Artist One":       "artist_one",
		"a b c":            "a_bc",
		"Üser.Name!":       "sername",
		"":                 "",
		"already_slug_123": "already_slug_123",
	} {
		if got := postgresSlugify(in); got != want {
			t.Errorf("%q: %q, want %q", in, got, want)
		}
	}
}

func TestCursorValues(t *testing.T) {
	fields := parseSortString(`mm."lastVersionAt" DESC NULLS LAST, mm."modelId" DESC`)
	v, err := cursorValues(fields, "2026-06-02 09:00:00.250|5300")
	if err != nil {
		t.Fatal(err)
	}
	// A 3-digit fraction is a millisecond count on every Node build.
	if got := v[`mm."lastVersionAt"`]; got != time.Date(2026, 6, 2, 9, 0, 0, 250*int(time.Millisecond), time.UTC) {
		t.Errorf("date: %v", got)
	}
	if v[`mm."modelId"`] != 5300 {
		t.Errorf("id: %v", v[`mm."modelId"`])
	}
	v, err = cursorValues(fields, "2026-06-02 09:00:00.9681|12abc")
	if err != nil || v[`mm."lastVersionAt"`] != time.Date(2026, 6, 2, 9, 0, 0, 968*int(time.Millisecond), time.UTC) || v[`mm."modelId"`] != 12 {
		t.Errorf("4-digit fraction / parseInt prefix: %v %v", v, err)
	}
	// parseCursor pads a timestamp's fraction to three digits (Postgres drops trailing zeros): ".25"
	// is 250 ms and ".5" 500 ms, not 25 and 5. A token without a fraction is read as before, and one
	// outside the padded shape (a 1-digit month) keeps dayjs's own millisecond count.
	ms := func(n int) time.Duration { return time.Duration(n) * time.Millisecond }
	for _, c := range []struct {
		tok  string
		want time.Time
	}{
		{"2026-06-02 09:00:00.25|5300", time.Date(2026, 6, 2, 9, 0, 0, int(ms(250)), time.UTC)},
		{"2026-06-02 09:00:00.5|5300", time.Date(2026, 6, 2, 9, 0, 0, int(ms(500)), time.UTC)},
		{"2026-06-02T09:00:00.05|1", time.Date(2026, 6, 2, 9, 0, 0, int(ms(50)), time.UTC)},
		{"2026-06-02 09:00:00.1239|1", time.Date(2026, 6, 2, 9, 0, 0, int(ms(123)), time.UTC)},
		{"2026-06-02 09:00:00|7", time.Date(2026, 6, 2, 9, 0, 0, 0, time.UTC)},
		{"2026-6-02 09:00:00.25|7", time.Date(2026, 6, 2, 9, 0, 0, int(ms(25)), time.UTC)},
	} {
		v, err := cursorValues(fields, c.tok)
		if err != nil || v[`mm."lastVersionAt"`] != c.want {
			t.Errorf("%q: %v %v, want %v", c.tok, v[`mm."lastVersionAt"`], err, c.want)
		}
	}
	for _, c := range []string{"|5", "5", "1|2|3", "-5|1", "2026-06-02T09:00:00.000Z", "2026-06-02Z|1", "x-y|1", "0050-01-01|1", "1|2147483648"} {
		if _, err := cursorValues(fields, c); reason(err) != "v1-models-cursor" {
			t.Errorf("%q: %v, want v1-models-cursor", c, err)
		}
	}
}

func TestPeriodStart(t *testing.T) {
	at := func(y int, m time.Month, d int) time.Time { return time.Date(y, m, d, 12, 30, 0, 0, time.UTC) }
	for _, c := range []struct {
		now    time.Time
		period string
		want   time.Time
	}{
		{at(2026, 3, 31), "Month", at(2026, 2, 28)},
		{at(2028, 3, 31), "Month", at(2028, 2, 29)},
		{at(2026, 1, 15), "Month", at(2025, 12, 15)},
		{at(2028, 2, 29), "Year", at(2027, 2, 28)},
		{at(2026, 3, 3), "Week", at(2026, 2, 24)},
		{at(2026, 3, 1), "Day", at(2026, 2, 28)},
		{at(2026, 3, 1), "AllTime", at(2026, 3, 1)},
	} {
		if got := periodStart(c.now, c.period); !got.Equal(c.want) {
			t.Errorf("%s from %v: %v, want %v", c.period, c.now, got, c.want)
		}
	}
}

func TestRawQueryDetail(t *testing.T) {
	text, args, err := RawQuery(&RawInput{
		IDs: []int{5001}, Sort: SortHighestRated, Archived: true, IncludeWithheld: true, Period: "AllTime",
		PeriodMode: "published", BrowsingLevel: 31, DisablePoi: true,
	})
	if err != nil {
		t.Fatal(err)
	}
	want := `SELECT mm."modelId" as "id", m."name", m."sfwName", m."coverImageId", m."sfwCoverImageId", ` +
		`m."description", m."sfwDescription", m."allowNoCredit", m."allowCommercialUse", m."allowDerivatives", ` +
		`m."allowDifferentLicense", m."type", mm."minor", m."sfwOnly", mm."poi", m."nsfw", mm."nsfwLevel", ` +
		`mm."status", m."createdAt", mm."lastVersionAt", m."publishedAt", m."locked", m."meta", mm."mode", ` +
		`mm."availability", jsonb_build_object( 'downloadCount', mm."downloadCount", 'thumbsUpCount', ` +
		`mm."thumbsUpCount", 'thumbsDownCount', mm."thumbsDownCount", 'commentCount', mm."commentCount", ` +
		`'collectedCount', mm."collectedCount", 'tippedAmountCount', mm."tippedAmountCount" ) as "rank", ` +
		`mm."userId", CONCAT(mm."thumbsUpCount", '|', mm."downloadCount", '|', mm."modelId") as "cursorId" ` +
		`FROM "ModelMetric" mm JOIN "Model" m ON m."id" = mm."modelId" WHERE (mm."poi" = false OR mm."userId" = $1) ` +
		`AND mm."status" = $2::"ModelStatus" AND mm."modelId" IN ($3) AND mm."availability" != 'Private'::"Availability" ` +
		`AND (mm."nsfwLevel" & $4) != 0 ORDER BY mm."thumbsUpCount" DESC, mm."downloadCount" DESC, mm."modelId" LIMIT $5`
	if got := NormalizeSQL(text); got != want {
		t.Fatalf("statement:\n got  %s\n want %s", got, want)
	}
	if !reflect.DeepEqual(args, []any{nil, "Published", 5001, 31, 101}) {
		t.Fatalf("args: %#v", args)
	}
}

func TestRawQueryCursorForms(t *testing.T) {
	now := time.Date(2026, 6, 15, 12, 0, 0, 0, time.UTC)
	// A DESC-headed sort splits into the equality branch, then the strict tuple branch.
	text, args, err := RawQuery(&RawInput{
		Take: 1, Cursor: "2026-06-02 09:00:00.250|5300", Sort: SortNewest, Types: []string{"LORA", "LoCon"},
		BrowsingLevel: 31, DisablePoi: true, DisableMinor: true, Now: now,
	})
	if err != nil {
		t.Fatal(err)
	}
	n := NormalizeSQL(text)
	for _, frag := range []string{
		`(mm."mode" IS NULL OR mm."mode" != $1::"ModelModifier") AND ( mm."mode" IS DISTINCT FROM $2::"ModelModifier" OR ($3::boolean AND mm."userId" = $4) OR $5::boolean ) AND (mm."poi" = false OR mm."userId" = $6) AND mm."minor" = false AND m.type = ANY(ARRAY[$7,$8]::"ModelType"[])`,
		`AND (mm."lastVersionAt" = $11 AND mm."modelId" <= $12) ORDER BY mm."lastVersionAt" DESC NULLS LAST, mm."modelId" DESC LIMIT $13 ) UNION ALL ( SELECT`,
		`AND ((mm."lastVersionAt") < ($24)) ORDER BY mm."lastVersionAt" DESC NULLS LAST, mm."modelId" DESC LIMIT $25 ) LIMIT $26`,
		`CONCAT(mm."lastVersionAt", '|', mm."modelId") as "cursorId"`,
	} {
		if !strings.Contains(n, frag) {
			t.Errorf("split statement lacks %q:\n%s", frag, n)
		}
	}
	if len(args) != 26 || args[12] != 2 || args[25] != 2 || args[10] != time.Date(2026, 6, 2, 9, 0, 0, 250*int(time.Millisecond), time.UTC) {
		t.Errorf("split args: %d %#v", len(args), args)
	}

	// An ASC head keeps the OR-chain, inside the one WHERE, before the level.
	text, args, err = RawQuery(&RawInput{
		Take: 100, Cursor: "2026-06-05 00:00:00|5250", Sort: SortOldest, Archived: true, Period: "Month",
		BrowsingLevel: 1, DisablePoi: true, Now: now, ExcludedTagIDs: []int{13, 13, 14},
	})
	if err != nil {
		t.Fatal(err)
	}
	n = NormalizeSQL(text)
	for _, frag := range []string{
		`AND tom."tagId" IN ($6,$7) )`,
		`(mm."lastVersionAt" >= $8)`,
		`AND ((mm."lastVersionAt" > $10) OR (mm."lastVersionAt" = $11 AND mm."modelId" >= $12)) AND (mm."nsfwLevel" & $13) != 0 ORDER BY mm."lastVersionAt" ASC, mm."modelId" LIMIT $14`,
	} {
		if !strings.Contains(n, frag) {
			t.Errorf("legacy statement lacks %q:\n%s", frag, n)
		}
	}
	if strings.Contains(n, "UNION ALL") {
		t.Error("an ASC-headed cursor must not split")
	}
	if args[7] != time.Date(2026, 5, 15, 12, 0, 0, 0, time.UTC) || args[13] != 101 {
		t.Errorf("legacy args: %#v", args)
	}
}

func TestRawQueryBaseModelPaths(t *testing.T) {
	for _, c := range []struct {
		name  string
		in    RawInput
		frags []string
	}{
		{"no metrics flag: an EXISTS on the versions", RawInput{BaseModels: []string{"Pony"}, Sort: SortHighestRated}, []string{
			`EXISTS ( SELECT 1 FROM "ModelVersion" mv WHERE mv."modelId" = m."id" AND mv."baseModel" IN ($6) )`,
			`FROM "ModelMetric" mm JOIN "Model" m`,
		}},
		{"one base model: the per-base-model row", RawInput{BaseModels: []string{"Pony"}, BaseModelMetrics: true, Sort: SortMostDownloaded}, []string{
			`mbm."modelId" as "id"`, `mbm."baseModel" = $6`, `FROM "ModelBaseModelMetric" mbm JOIN "Model" m ON m."id" = mbm."modelId"`,
			`ORDER BY mbm."downloadCount" DESC, mbm."thumbsUpCount" DESC, mbm."modelId"`,
		}},
		{"several, Newest: driven from ModelMetric", RawInput{BaseModels: []string{"Pony", "SDXL 1.0"}, BaseModelMetrics: true, Sort: SortNewest}, []string{
			`mm."modelId" as "id"`, `'downloadCount', mbm."downloadCount"`, `mbmm."baseModel" IN ($8,$9)`, // after the LATERAL's own two in the FROM
			`LEFT JOIN LATERAL ( SELECT LEAST(SUM("downloadCount")::int, mm."downloadCount") as "downloadCount"`,
		}},
		{"several, a stat sort: the aggregate", RawInput{BaseModels: []string{"Pony", "SDXL 1.0"}, BaseModelMetrics: true, Sort: SortImageCount}, []string{
			`mbm."modelId" as "id"`, `GROUP BY "modelId" ) mbs`, `ORDER BY mbm."imageCount" DESC`,
		}},
	} {
		text, _, err := RawQuery(&c.in)
		if err != nil {
			t.Fatalf("%s: %v", c.name, err)
		}
		n := NormalizeSQL(text)
		for _, f := range c.frags {
			if !strings.Contains(n, f) {
				t.Errorf("%s: lacks %q:\n%s", c.name, f, n)
			}
		}
	}
	// Every sort has its own order, and an unknown cursor shape is refused before any SQL.
	for sort, head := range map[string]string{
		SortHot: `mm."hotScore" DESC`, SortMostLiked: `mm."thumbsUpCount" DESC`, SortMostDiscussed: `mm."commentCount" DESC`,
		SortMostCollected: `mm."collectedCount" DESC`,
	} {
		text, _, _ := RawQuery(&RawInput{Sort: sort})
		if !strings.Contains(text, "ORDER BY\n      "+head) {
			t.Errorf("%s: no %q", sort, head)
		}
	}
	if _, _, err := RawQuery(&RawInput{Sort: SortNewest, Cursor: "nope"}); reason(err) != "v1-models-cursor" {
		t.Errorf("bad cursor: %v", err)
	}
	text, _, _ := RawQuery(&RawInput{Sort: SortHighestRated, EarlyAccess: true, TargetUserID: 7})
	if n := NormalizeSQL(text); !strings.Contains(n, `mm."userId" = $6`) || !strings.Contains(n, `pa."endsAt" > NOW()`) {
		t.Errorf("username / earlyAccess clauses: %s", n)
	}
}

// A taken-down model is withheld from the list for a signed-out viewer (modelNotWithheldSql); only the
// by-id route keeps it.
func TestRawQueryTakenDown(t *testing.T) {
	clause := `( mm."mode" IS DISTINCT FROM $2::"ModelModifier" OR ($3::boolean AND mm."userId" = $4) OR $5::boolean )`
	text, args, err := RawQuery(&RawInput{Sort: SortHighestRated})
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(NormalizeSQL(text), clause) {
		t.Errorf("list lacks the taken-down clause:\n%s", NormalizeSQL(text))
	}
	if !reflect.DeepEqual(args[1:5], []any{"TakenDown", false, nil, false}) {
		t.Errorf("taken-down args: %#v", args[1:5])
	}
	text, _, err = RawQuery(&RawInput{Sort: SortHighestRated, IncludeWithheld: true})
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(text, "IS DISTINCT FROM") {
		t.Errorf("by-id input keeps taken-down models, got:\n%s", NormalizeSQL(text))
	}
}

func TestFilenamize(t *testing.T) {
	for in, want := range map[string]string{
		"Model 5001":       "model5001",
		"Golden's Model":   "goldensModel",
		"BB Bunny v2":      "bbBunnyV2",
		"Ünicode Name 😀 x": "NicodeNameX",
		"a-very-long-model-name-that-goes-on-and-on": "aVeryLongModelNameThat",
		"SDXL 1.0 Lightning 4-step":                  "sdxl10Lightning4Step",
		"!!!":                                        "",
		"model_v2_2_final_really_long_name_here":     "modelV22FinalReally",
		"v6001":                                      "v6001",
		"":                                           "",
	} {
		if got := filenamize(in); got != want {
			t.Errorf("%q: %q, want %q", in, got, want)
		}
	}
}

func TestResolveFileName(t *testing.T) {
	f := func(id int, name, typ string, size, fp any, override string) nameFile {
		return nameFile{id: id, hasID: true, name: name, typ: typ, size: size, fp: fp, overrideName: override}
	}
	for _, c := range []struct {
		model   nameModel
		version nameVersion
		files   []nameFile
		want    []string
	}{
		{nameModel{"Model 5001", "Checkpoint"}, nameVersion{name: "v6001"}, []nameFile{
			f(1, "model.safetensors", "Model", "full", "fp32", ""), f(2, "golden_pruned.safetensors", "Model", nil, nil, ""),
			f(3, "config.yaml", "Config", nil, nil, ""), f(4, "model.safetensors", "Model", "pruned", "fp16", ""),
		}, []string{"model5001_v6001_full_fp32.safetensors", "golden_pruned.safetensors", "config.yaml", "model5001_v6001_pruned_fp16.safetensors"}},
		{nameModel{"BB Bunny", "Checkpoint"}, nameVersion{name: "BB Bunny v2"}, []nameFile{
			f(1, "model.safetensors", "Model", nil, nil, ""), f(2, "01HZX3J8K9M2N4P6Q7R8S9T0VW.safetensors", "Model", nil, nil, ""),
		}, []string{"bbBunny_v2_1.safetensors", "bbBunny_v2_2.safetensors"}},
		{nameModel{"Lora Thing", "LORA"}, nameVersion{name: "v1"}, []nameFile{
			f(1, "model.safetensors", "Model", nil, nil, ""), f(2, "mylora.safetensors", "Model", nil, nil, ""),
		}, []string{"model.safetensors", "mylora.safetensors"}},
		{nameModel{"Lora Thing", "LORA"}, nameVersion{name: "v1"}, []nameFile{
			f(1, "01HZX3J8K9M2N4P6Q7R8S9T0VW.safetensors", "Model", nil, nil, ""),
		}, []string{"loraThing_v1.safetensors"}},
		{nameModel{"Embed", "TextualInversion"}, nameVersion{name: "v1", trainedWords: []string{"golden token"}}, []nameFile{
			f(1, "embed.pt", "Model", nil, nil, ""), f(2, "neg.pt", "Negative", nil, nil, ""),
		}, []string{"golden token.pt", "golden token-neg.pt"}},
		{nameModel{"Embed", "TextualInversion"}, nameVersion{name: "v1"}, []nameFile{f(1, "embed.pt", "Model", nil, nil, "")}, []string{"embed.pt"}},
		{nameModel{"Data Model", "Checkpoint"}, nameVersion{name: "v3"}, []nameFile{f(1, "stuff.zip", "Training Data", nil, nil, "")}, []string{"dataModel_v3_trainingData.zip"}},
		{nameModel{"Inpaint Model", "Checkpoint"}, nameVersion{name: "v1 Inpainting"}, []nameFile{f(1, "model-inpainting.safetensors", "Model", nil, nil, "")}, []string{"model-inpainting.safetensors"}},
		{nameModel{"Pix Model", "Checkpoint"}, nameVersion{name: "instruct pix2pix v1"}, []nameFile{f(1, "model.instruct-pix2pix.ckpt", "Model", nil, nil, "")}, []string{"model.instruct-pix2pix.ckpt"}},
		{nameModel{"TE Model", "Checkpoint"}, nameVersion{name: "v1"}, []nameFile{f(1, "text_encoder.safetensors", "Text Encoder", nil, nil, "")}, []string{"teModel_v1_txt.safetensors"}},
		{nameModel{"VAE Model", "Checkpoint"}, nameVersion{name: "v1"}, []nameFile{f(1, "vae.safetensors", "VAE", nil, nil, "")}, []string{"vae.safetensors"}},
		{nameModel{"Dup", "Checkpoint"}, nameVersion{name: "v1"}, []nameFile{
			f(1, "model.safetensors", "Model", nil, nil, ""), f(2, "model.safetensors", "Model", nil, nil, ""), f(3, "model.safetensors", "Model", nil, nil, ""),
		}, []string{"dup_v1_1.safetensors", "dup_v1_2.safetensors", "dup_v1_3.safetensors"}},
		{nameModel{"Dup", "Checkpoint"}, nameVersion{name: "v1"}, []nameFile{
			f(1, "model.safetensors", "Model", nil, nil, `Custom "Name"%41.safetensors`), f(2, "weird\u200bname.safetensors", "Model", nil, nil, ""),
		}, []string{"Custom _Name__41.safetensors", "weirdname.safetensors"}},
		{nameModel{"Other", "Checkpoint"}, nameVersion{name: "v1"}, []nameFile{f(1, "thing.bin", "Mystery Type", nil, nil, "")}, []string{"thing.bin"}},
		{nameModel{"Same", "Checkpoint"}, nameVersion{name: "Same"}, []nameFile{f(1, "model.safetensors", "Model", nil, nil, "")}, []string{"same.safetensors"}},
	} {
		for i, file := range c.files {
			got, err := resolveFileName(c.model, c.version, file, c.files)
			if err != nil || got != c.want[i] {
				t.Errorf("%s/%s file %d: %q %v, want %q", c.model.name, c.version.name, file.id, got, err, c.want[i])
			}
		}
	}
	// A name the scheme must strip a non-ASCII model name from is not read here.
	if _, err := resolveFileName(nameModel{"Ünï", "Checkpoint"}, nameVersion{name: "Ünï v1"},
		f(1, "model.safetensors", "Model", nil, nil, ""), nil); reason(err) != "v1-models-filename" {
		t.Errorf("non-ASCII strip: %v", err)
	}
}

func meta(kv ...any) superjson.Object {
	o := superjson.Object{}
	for i := 0; i+1 < len(kv); i += 2 {
		o = append(o, superjson.Field{Key: kv[i].(string), Val: kv[i+1]})
	}
	return o
}

func TestPrimaryFile(t *testing.T) {
	u := superjson.Undefined{}
	fv := func(typ string, m superjson.Object) fileView { return fileView{typ: typ, metadata: m} }
	for i, c := range []struct {
		files []fileView
		want  int
	}{
		{[]fileView{
			fv("Model", meta("format", "SafeTensor", "size", "full", "fp", "fp32", "quantType", u, "isRequired", u)),
			fv("Model", meta("format", "SafeTensor", "size", "pruned", "fp", "fp16", "quantType", u, "isRequired", u)),
			fv("Config", meta("format", "Other", "size", u, "fp", u, "quantType", u, "isRequired", u)),
		}, 1},
		{[]fileView{fv("Model", meta("format", "SafeTensor", "size", "pruned", "fp", "bf16")), fv("Model", meta("format", "SafeTensor", "size", "pruned", "fp", "fp8"))}, 1},
		{[]fileView{fv("Pruned Model", meta("format", "SafeTensor", "size", "pruned", "fp", "fp8")), fv("Model", meta("format", "SafeTensor", "size", "pruned", "fp", "bf16"))}, 0},
		{[]fileView{fv("Config", meta()), fv("Archive", meta("format", "Other"))}, 0},
		{[]fileView{fv("Model", meta("format", "GGUF", "quantType", "Q4_K_M")), fv("Model", meta("format", "GGUF", "quantType", "Q8_0"))}, 0},
	} {
		if got := primaryFile(c.files); got != c.want {
			t.Errorf("case %d: %d, want %d", i, got, c.want)
		}
	}
	if primaryFile(nil) != -1 {
		t.Error("no files: want -1")
	}
}

func TestDownloadURL(t *testing.T) {
	for _, c := range []struct{ got, want string }{
		{downloadURL(1, nil, nil, true, 0), "/api/download/models/1"},
		{downloadURL(2, "Model", meta("format", "SafeTensor", "size", "pruned", "fp", "fp16"), false, 0), "/api/download/models/2?type=Model&format=SafeTensor&size=pruned&fp=fp16"},
		{downloadURL(3, "Training Data", meta("format", "Other"), false, 0), "/api/download/models/3?type=Training%20Data"},
		{downloadURL(4, "Config", meta("format", "Other", "size", "", "fp", nil), false, 0), "/api/download/models/4?type=Config&format=Other"},
		{downloadURL(5, "VAE", meta("format", "SafeTensor", "quantType", "Q 4/8"), false, 0), "/api/download/models/5?type=VAE&format=SafeTensor&quantType=Q%204%2F8"},
		{downloadURL(6, nil, nil, false, 9), "/api/download/models/6?fileId=9"},
		{downloadURL(6, "VAE", meta("format", "SafeTensor", "size", "full"), false, 0), "/api/download/models/6?type=VAE&format=SafeTensor&size=full"},
	} {
		if c.got != c.want {
			t.Errorf("%s, want %s", c.got, c.want)
		}
	}
}

func TestEdgeURLWidthAndName(t *testing.T) {
	const loc = "https://image.example.test/golden"
	const u = "00000000-0000-4000-8000-000000008901"
	name := func(s string) *string { return &s }
	for _, c := range []struct{ got, want string }{
		{feed.EdgeURL(loc, u, feed.EdgeOptions{Width: 96, Name: name("artist_one"), Type: "image"}), loc + "/" + u + "/width=96/artist_one.jpeg"},
		{feed.EdgeURL(loc, u, feed.EdgeOptions{Width: 96}), loc + "/" + u + "/width=96/" + u + ".jpeg"},
		{feed.EdgeURL(loc, u+".png", feed.EdgeOptions{Width: 100, Name: name("a.b%c"), Type: "video"}), loc + "/" + u + ".png/width=320/a.mp4"},
		{feed.EdgeURL(loc, u, feed.EdgeOptions{Original: boolTrue(), Name: name("8001"), Type: "video"}), loc + "/" + u + "/original=true/8001.mp4"},
		{feed.EdgeURL(loc, u, feed.EdgeOptions{Width: 5000, Name: name("x")}), loc + "/" + u + "/width=1800/x.jpeg"},
		{feed.EdgeURL(loc, "https://elsewhere.example.test/a.png", feed.EdgeOptions{Width: 96}), "https://elsewhere.example.test/a.png"},
	} {
		if c.got != c.want {
			t.Errorf("%s\n want %s", c.got, c.want)
		}
	}
}

func TestParsePGTextArray(t *testing.T) {
	for in, want := range map[string][]string{
		"{}": {}, "{Image}": {"Image"}, "{Image,RentCivit}": {"Image", "RentCivit"}, `{"a b","c\"d"}`: {"a b", `c"d`},
	} {
		got, err := parsePGTextArray(in)
		if err != nil || !reflect.DeepEqual(got, want) {
			t.Errorf("%s: %#v %v", in, got, err)
		}
	}
	for _, in := range []string{"", "Image", "{NULL}", "{{a}}", `{"open}`, `{"a"x}`} {
		if _, err := parsePGTextArray(in); err == nil {
			t.Errorf("%s: want an error", in)
		}
	}
	if got, _ := textArray([]any{"A", "B"}); !reflect.DeepEqual(got, []string{"A", "B"}) {
		t.Errorf("decoded array: %v", got)
	}
	if got, _ := textArray(nil); got != nil {
		t.Errorf("null: %v", got)
	}
	if _, err := textArray(3); err == nil {
		t.Error("a number is not an array")
	}
}

func TestRemoveEmptyAndHashes(t *testing.T) {
	got := removeEmpty(meta("a", nil, "b", superjson.Undefined{}, "c", []any{}, "d", "", "e", []any{1}, "f", false))
	if !reflect.DeepEqual(got, meta("d", "", "e", []any{1}, "f", false)) {
		t.Errorf("removeEmpty: %#v", got)
	}
	h := hashesObject([]any{meta("type", "SHA256", "hash", "A"), meta("type", "AutoV2", "hash", "B"), meta("type", "SHA256", "hash", "C")})
	if !reflect.DeepEqual(h, meta("SHA256", "C", "AutoV2", "B")) {
		t.Errorf("hashes: %#v", h)
	}
}

func TestMetricPrivacy(t *testing.T) {
	m := map[string]any{"metricVisibility": map[string]any{"downloads": "show", "buzz": "hide"}, "hideGenerations": true, "hideDownloads": true}
	if got := metricVisibility(m); !reflect.DeepEqual(got, map[string]string{"buzz": "hide", "downloads": "show", "generations": "hide"}) {
		t.Errorf("visibility: %v", got)
	}
	if got := metaHidden(m); got != (hidden{buzz: true, generations: true}) {
		t.Errorf("hidden: %+v", got)
	}
	def := hidden{downloads: true}
	if got := nearestExplicit([]map[string]string{{}, {"downloads": "show"}}, def); got.downloads {
		t.Error("a model-level show wins over the default")
	}
	if got := nearestExplicit(nil, def); !got.downloads {
		t.Error("no explicit level: the default")
	}
}

package v1models

import (
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/civitai/civitai/apps/feed-go/internal/fallback"
)

// Model sorts (ModelSort in src/server/common/enums.ts).
const (
	SortHot            = "Hot"
	SortHighestRated   = "Highest Rated"
	SortMostDownloaded = "Most Downloaded"
	SortMostLiked      = "Most Liked"
	SortMostDiscussed  = "Most Discussed"
	SortMostCollected  = "Most Collected"
	SortImageCount     = "Most Images"
	SortNewest         = "Newest"
	SortOldest         = "Oldest"
	SortRecentlyAdded  = "Recently Added"
)

// RawInput is the part of getModelsRaw's input (src/server/services/model.service.ts) the ported REST
// shapes reach, after enforceBlockedBrowsingTagsForModels has applied the browsing-settings addons.
// The viewer is always signed out here: every per-viewer clause binds a null user id.
type RawInput struct {
	Take           int // 0 = undefined (the query then reads 100 + 1)
	Cursor         string
	Archived       bool
	DisablePoi     bool
	DisableMinor   bool
	ExcludedTagIDs []int
	// TagID is the `tag` filter's tag as the replica named it (nil: no filter, or a name no tag has).
	TagID        *int
	TargetUserID int // the `username` filter's resolved user, 0 = none
	Types        []string
	BaseModels   []string
	// BaseModelMetrics is the `base-model-feed-metrics` flag (read only with BaseModels).
	BaseModelMetrics bool
	Sort             string
	Period           string
	PeriodMode       string
	IDs              []int
	EarlyAccess      bool
	BrowsingLevel    int
	Now              time.Time
}

// usesBaseModelMetrics is getModelsRaw's useBaseModelMetrics.
func (in *RawInput) usesBaseModelMetrics() bool {
	return len(in.BaseModels) > 0 && in.BaseModelMetrics
}

// metricDrivenMultiBm is useModelMetricDrivenMultiBmPath.
func (in *RawInput) metricDrivenMultiBm() bool {
	return in.usesBaseModelMetrics() && len(in.BaseModels) > 1 &&
		(in.Sort == SortNewest || in.Sort == SortOldest || in.Sort == SortHot)
}

// orderBy is getModelsRaw's ORDER BY for a sort, over the alias that holds the per-base-model stats.
func orderBy(sort, pAlias string) string {
	switch sort {
	case SortHot:
		return pAlias + `."hotScore" DESC, ` + pAlias + `."modelId"`
	case SortHighestRated, SortMostLiked:
		return pAlias + `."thumbsUpCount" DESC, ` + pAlias + `."downloadCount" DESC, ` + pAlias + `."modelId"`
	case SortMostDownloaded:
		return pAlias + `."downloadCount" DESC, ` + pAlias + `."thumbsUpCount" DESC, ` + pAlias + `."modelId"`
	case SortMostDiscussed:
		return `mm."commentCount" DESC, ` + pAlias + `."thumbsUpCount" DESC, ` + pAlias + `."modelId"`
	case SortMostCollected:
		return `mm."collectedCount" DESC, ` + pAlias + `."thumbsUpCount" DESC, ` + pAlias + `."modelId"`
	case SortImageCount:
		return pAlias + `."imageCount" DESC, ` + pAlias + `."thumbsUpCount" DESC, ` + pAlias + `."modelId"`
	case SortOldest:
		return `mm."lastVersionAt" ASC, ` + pAlias + `."modelId"`
	}
	// Newest, and any sort without its own branch.
	return `mm."lastVersionAt" DESC NULLS LAST, ` + pAlias + `."modelId" DESC`
}

// periodStart is decreaseDate(now, 1, period): dayjs's subtract, which clamps the day of the month
// for months and years (Mar 31 - 1 month = Feb 28/29), in UTC (the Node pods' zone).
func periodStart(now time.Time, period string) time.Time {
	now = now.UTC()
	switch period {
	case "Day":
		return now.AddDate(0, 0, -1)
	case "Week":
		return now.AddDate(0, 0, -7)
	case "Month":
		return clampedMonthShift(now, 0, -1)
	case "Year":
		return clampedMonthShift(now, -1, 0)
	}
	return now
}

func clampedMonthShift(t time.Time, years, months int) time.Time {
	first := time.Date(t.Year()+years, t.Month()+time.Month(months), 1, t.Hour(), t.Minute(), t.Second(), t.Nanosecond(), time.UTC)
	last := first.AddDate(0, 1, -1).Day()
	day := min(t.Day(), last)
	return time.Date(first.Year(), first.Month(), day, t.Hour(), t.Minute(), t.Second(), t.Nanosecond(), time.UTC)
}

type sortField struct {
	field string
	desc  bool
}

// parseSortString is parseSortString (src/server/utils/pagination-helpers.ts): each comma part's
// first word is the field, its second the order (ASC when absent); anything after is ignored.
func parseSortString(s string) []sortField {
	split := strings.Split(s, ",")
	out := make([]sortField, 0, len(split))
	for _, part := range split {
		words := strings.Fields(part)
		f := sortField{}
		if len(words) > 0 {
			f.field = words[0]
		}
		if len(words) > 1 {
			f.desc = strings.ToUpper(words[1]) == "DESC"
		}
		out = append(out, f)
	}
	return out
}

func cursorOperator(desc, last bool) string {
	switch {
	case desc && last:
		return "<="
	case desc:
		return "<"
	case last:
		return ">="
	}
	return ">"
}

var (
	numericCursorToken = regexp.MustCompile(`^-?\d+$`)
	// dayjsParse is dayjs's REGEX_PARSE, the format dayjs.utc(string) reads without a format.
	dayjsParse = regexp.MustCompile(`^(\d{4})[-/]?(\d{1,2})?[-/]?(\d{0,2})[Tt\s]*(\d{1,2})?:?(\d{1,2})?:?(\d{1,2})?[.:]?(\d+)?$`)
	// isoStrictCursor is keysetCursorSchema's transform: a string dayjs reads strictly as
	// `YYYY-MM-DDTHH:mm:ss.SSS[Z]` becomes a Date, which no multi-field model sort accepts (a 400).
	isoStrictCursor = regexp.MustCompile(`^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$`)
	leadingInt      = regexp.MustCompile(`^\s*([+-]?\d+)`)
)

const int4Max = 2147483647

// cursorValues is parseCursor for a string cursor over fields: one value per `|`-separated token,
// a date (dayjs.utc) for a token with a `-` that is not an integer, else parseInt. Every input Node
// answers with a 400 falls back, as does a token whose reading JS's Date parser would decide.
func cursorValues(fields []sortField, cursor string) (map[string]any, error) {
	if isoStrictCursor.MatchString(cursor) {
		return nil, fallback.New("v1-models-cursor")
	}
	values := strings.Split(cursor, "|")
	if len(values) != len(fields) {
		return nil, fallback.New("v1-models-cursor")
	}
	out := make(map[string]any, len(fields))
	for i, f := range fields {
		v := values[i]
		if strings.Contains(v, "-") && !numericCursorToken.MatchString(v) {
			t, ok := dayjsUTC(normalizeCursorTimestamp(v))
			if !ok {
				return nil, fallback.New("v1-models-cursor")
			}
			out[f.field] = t
			continue
		}
		m := leadingInt.FindStringSubmatch(v)
		if m == nil {
			return nil, fallback.New("v1-models-cursor")
		}
		n, err := strconv.ParseInt(m[1], 10, 64)
		if err != nil || n < 0 || n > int4Max {
			return nil, fallback.New("v1-models-cursor")
		}
		out[f.field] = int(n)
	}
	return out, nil
}

// cursorTimestampFraction is CURSOR_TIMESTAMP_FRACTION (src/server/utils/pagination-helpers.ts).
var cursorTimestampFraction = regexp.MustCompile(`^(\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2})\.(\d+)`)

// normalizeCursorTimestamp is parseCursor's normalizeCursorTimestamp: a `YYYY-MM-DD HH:mm:ss.f…`
// token's fraction padded to three digits and cut to three (Postgres drops trailing zeros, so 250 ms
// renders as ".25"). Any other token is returned unchanged.
func normalizeCursorTimestamp(v string) string {
	m := cursorTimestampFraction.FindStringSubmatchIndex(v)
	if m == nil {
		return v
	}
	frac := v[m[4]:m[5]] + "00"
	return v[m[2]:m[3]] + "." + frac[:3] + v[m[1]:]
}

// dayjsUTC is dayjs.utc(value) for a string dayjs parses itself (REGEX_PARSE, no `Z` suffix): the
// fields are read as UTC, the fraction by its first three digits as a millisecond count (cursorValues
// pads a timestamp's fraction first, as Node does), out-of-range fields roll over as Date.UTC rolls them. A string dayjs
// hands to the Date constructor instead is not read here (ok false), nor is a year below 100 (Date.UTC
// maps it to the 1900s).
func dayjsUTC(v string) (time.Time, bool) {
	if strings.HasSuffix(strings.ToLower(v), "z") {
		return time.Time{}, false
	}
	m := dayjsParse.FindStringSubmatch(v)
	if m == nil {
		return time.Time{}, false
	}
	num := func(s string, def int) int {
		if s == "" {
			return def
		}
		n, _ := strconv.Atoi(s)
		return n
	}
	year := num(m[1], 0)
	if year < 100 {
		return time.Time{}, false
	}
	month := num(m[2], 1) - 1 // `d[2] - 1 || 0`
	ms := m[7]
	if len(ms) > 3 {
		ms = ms[:3]
	}
	t := time.Date(year, time.Month(month+1), num(m[3], 1), num(m[4], 0), num(m[5], 0), num(m[6], 0),
		num(ms, 0)*int(time.Millisecond), time.UTC)
	return t, true
}

// cursorClauses is getCursorClauses: the split (strict tuple + equality) predicate for a multi-field
// sort whose head fields are all DESC, else the OR-chain in strict alone.
type cursorClauses struct {
	strict, equality *sqlFrag
	prop             string
	splittable       bool
}

func getCursorClauses(sort, cursor string) (*cursorClauses, error) {
	fields := parseSortString(sort)
	props := make([]string, len(fields))
	for i, f := range fields {
		props[i] = f.field
	}
	out := &cursorClauses{prop: fields[0].field}
	if len(fields) > 1 {
		out.prop = "CONCAT(" + strings.Join(props, ", '|', ") + ")"
	}
	if cursor == "" {
		return out, nil
	}
	values, err := cursorValues(fields, cursor)
	if err != nil {
		return nil, err
	}
	legacy := func() *sqlFrag {
		conds := make([]*sqlFrag, 0, len(fields))
		last := len(fields) - 1
		for i := range fields {
			parts := make([]*sqlFrag, 0, i+1)
			for j := 0; j <= i; j++ {
				op := "="
				if j == i {
					op = cursorOperator(fields[j].desc, i == last)
				}
				parts = append(parts, sqlRaw(fields[j].field+" "+op+" ").arg(values[fields[j].field]))
			}
			conds = append(conds, sqlRaw("(").sub(sqlJoin(parts, " AND ")).raw(")"))
		}
		return sqlRaw("(").sub(sqlJoin(conds, " OR ")).raw(")")
	}
	if len(fields) == 1 {
		out.strict = legacy()
		return out, nil
	}
	head := fields[:len(fields)-1]
	for _, f := range head {
		if !f.desc {
			out.strict = legacy()
			return out, nil
		}
	}
	names := make([]*sqlFrag, len(head))
	vals := make([]*sqlFrag, len(head))
	eq := make([]*sqlFrag, 0, len(fields))
	for i, f := range head {
		names[i] = sqlRaw(f.field)
		vals[i] = (&sqlFrag{}).arg(values[f.field])
		eq = append(eq, sqlRaw(f.field+" = ").arg(values[f.field]))
	}
	lastField := fields[len(fields)-1]
	eq = append(eq, sqlRaw(lastField.field+" "+cursorOperator(lastField.desc, true)+" ").arg(values[lastField.field]))
	out.strict = sqlRaw("((").sub(sqlJoin(names, ", ")).raw(") < (").sub(sqlJoin(vals, ", ")).raw("))")
	out.equality = sqlRaw("(").sub(sqlJoin(eq, " AND ")).raw(")")
	out.splittable = true
	return out, nil
}

// RawQuery is getModelsRaw's model statement for in (with includeDetails: the REST callers ask for
// `details`), built clause by clause as Node builds it, so the text and the arguments are Node's.
func RawQuery(in *RawInput) (string, []any, error) {
	useBM := in.usesBaseModelMetrics()
	multiBm := in.metricDrivenMultiBm()
	pAlias := "mm"
	if useBM && !multiBm {
		pAlias = "mbm"
	}
	rankAlias := pAlias
	if multiBm {
		rankAlias = "mbm"
	}

	var and []*sqlFrag
	if !in.Archived {
		and = append(and, sqlRaw("("+pAlias+`."mode" IS NULL OR `+pAlias+`."mode" != `).arg("Archived").raw(`::"ModelModifier")`))
	}
	if in.DisablePoi {
		and = append(and, sqlRaw("("+pAlias+`."poi" = false OR mm."userId" = `).arg(nil).raw(")"))
	}
	if in.DisableMinor {
		and = append(and, sqlRaw(pAlias+`."minor" = false`))
	}
	if len(in.ExcludedTagIDs) > 0 {
		and = append(and, sqlRaw(`NOT EXISTS (
      SELECT 1 FROM "TagsOnModels" tom
      WHERE tom."modelId" = m."id"
        AND tom."tagId" IN (`).sub(sqlJoinArgs(uniqueInts(in.ExcludedTagIDs), ",")).raw(`)
    )`))
	}
	if in.TagID != nil {
		and = append(and, sqlRaw(`EXISTS (
            SELECT 1 FROM "TagsOnModels" tom
            WHERE tom."modelId" = m."id" AND tom."tagId" = `).arg(*in.TagID).raw(`
          )`))
	}
	if in.TargetUserID != 0 {
		and = append(and, sqlRaw(`mm."userId" = `).arg(in.TargetUserID))
	}
	if len(in.Types) > 0 {
		and = append(and, sqlRaw(`m.type = ANY(ARRAY[`).sub(sqlJoinArgs(in.Types, ",")).raw(`]::"ModelType"[])`))
	}
	switch {
	case len(in.BaseModels) > 0 && !useBM:
		and = append(and, sqlRaw(`EXISTS (
          SELECT 1 FROM "ModelVersion" mv
          WHERE mv."modelId" = m."id"
            AND mv."baseModel" IN (`).sub(sqlJoinArgs(in.BaseModels, ",")).raw(`)
        )`))
	case useBM && len(in.BaseModels) == 1:
		and = append(and, sqlRaw(`mbm."baseModel" = `).arg(in.BaseModels[0]))
	case multiBm:
		and = append(and, sqlRaw(`EXISTS (
          SELECT 1 FROM "ModelBaseModelMetric" mbmm
          WHERE mbmm."modelId" = mm."modelId"
            AND mbmm."baseModel" IN (`).sub(sqlJoinArgs(in.BaseModels, ",")).raw(`)
        )`))
	}
	if in.Period != "" && in.Period != "AllTime" && in.PeriodMode != "stats" {
		and = append(and, sqlRaw(`(mm."lastVersionAt" >= `).arg(periodStart(in.Now, in.Period)).raw(")"))
	}
	and = append(and, sqlRaw(pAlias+`."status" = `).arg("Published").raw(`::"ModelStatus"`))
	if len(in.IDs) > 0 {
		and = append(and, sqlRaw(`mm."modelId" IN (`).sub(sqlJoinArgs(in.IDs, ",")).raw(")"))
	}
	if in.EarlyAccess {
		and = append(and, sqlRaw(`EXISTS (
        SELECT 1 FROM "PaidAccess" pa
        JOIN "ModelVersion" pamv ON pamv.id = pa."entityId"
        WHERE pa."entityType" = 'ModelVersion' AND pamv."modelId" = m.id
          AND pamv.status = 'Published'::"ModelStatus" AND pa."endsAt" > NOW()
      )`))
	}
	and = append(and, sqlRaw(pAlias+`."availability" != 'Private'::"Availability"`))

	order := orderBy(in.Sort, pAlias)
	cc, err := getCursorClauses(order, in.Cursor)
	if err != nil {
		return "", nil, err
	}
	if !cc.splittable && cc.strict != nil {
		and = append(and, cc.strict)
	}
	and = append(and, sqlRaw("("+pAlias+`."nsfwLevel" & `).arg(in.BrowsingLevel).raw(") != 0"))

	var from *sqlFrag
	switch {
	case !useBM:
		from = sqlRaw(`FROM "ModelMetric" mm
      JOIN "Model" m ON m."id" = mm."modelId"`)
	case len(in.BaseModels) == 1:
		from = sqlRaw(`FROM "ModelBaseModelMetric" mbm
      JOIN "Model" m ON m."id" = mbm."modelId"
      JOIN "ModelMetric" mm ON mm."modelId" = mbm."modelId"`)
	case multiBm:
		from = sqlRaw(`FROM "ModelMetric" mm
      JOIN "Model" m ON m."id" = mm."modelId"
      LEFT JOIN LATERAL (
        SELECT
          LEAST(SUM("downloadCount")::int, mm."downloadCount") as "downloadCount",
          LEAST(SUM("thumbsUpCount")::int, mm."thumbsUpCount") as "thumbsUpCount"
        FROM "ModelBaseModelMetric"
        WHERE "modelId" = mm."modelId"
          AND "baseModel" IN (`).sub(sqlJoinArgs(in.BaseModels, ",")).raw(`)
      ) mbm ON true`)
	default:
		from = sqlRaw(`FROM (
        SELECT "modelId",
          SUM("downloadCount")::int as "downloadCount",
          SUM("thumbsUpCount")::int as "thumbsUpCount",
          SUM("imageCount")::int as "imageCount",
          MIN("status") as "status",
          MIN("nsfwLevel") as "nsfwLevel",
          MIN("availability") as "availability",
          MIN("mode") as "mode",
          MAX("minor"::int)::bool as "minor",
          MAX("poi"::int)::bool as "poi"
        FROM "ModelBaseModelMetric"
        WHERE "baseModel" IN (`).sub(sqlJoinArgs(in.BaseModels, ",")).raw(`)
        GROUP BY "modelId"
      ) mbs
      JOIN "Model" m ON m."id" = mbs."modelId"
      JOIN "ModelMetric" mm ON mm."modelId" = mbs."modelId"
      CROSS JOIN LATERAL (
        SELECT mbs."modelId",
          LEAST(mbs."downloadCount", mm."downloadCount") as "downloadCount",
          LEAST(mbs."thumbsUpCount", mm."thumbsUpCount") as "thumbsUpCount",
          mbs."imageCount", mbs."status", mbs."nsfwLevel", mbs."availability",
          mbs."mode", mbs."minor", mbs."poi"
      ) mbm`)
	}

	cursorProp := "null"
	if cc.prop != "" {
		cursorProp = cc.prop
	}
	selectList := sqlRaw(`
      ` + pAlias + `."modelId" as "id",
      m."name",
      m."sfwName",
      m."coverImageId",
      m."sfwCoverImageId",

        m."description",
        m."sfwDescription",
        m."allowNoCredit",
        m."allowCommercialUse",
        m."allowDerivatives",
        m."allowDifferentLicense",
       m."type",
      ` + pAlias + `."minor",
      m."sfwOnly",
      ` + pAlias + `."poi",
      m."nsfw",
      ` + pAlias + `."nsfwLevel",
      ` + pAlias + `."status",
      m."createdAt",
      mm."lastVersionAt",
      m."publishedAt",
      m."locked",
      m."meta",
      ` + pAlias + `."mode",
      ` + pAlias + `."availability",
      jsonb_build_object(
        'downloadCount', ` + rankAlias + `."downloadCount",
        'thumbsUpCount', ` + rankAlias + `."thumbsUpCount",
        'thumbsDownCount', mm."thumbsDownCount",
        'commentCount', mm."commentCount",
        'collectedCount', mm."collectedCount",
        'tippedAmountCount', mm."tippedAmountCount"
      ) as "rank",
      mm."userId",
      ` + cursorProp + ` as "cursorId"`)
	fromAndJoin := (&sqlFrag{}).sub(from).raw("\n      \n      ")
	limit := in.Take
	if limit == 0 {
		limit = 100
	}
	limit++
	base := sqlJoin(and, " AND ")

	var q *sqlFrag
	if cc.splittable && cc.strict != nil && cc.equality != nil {
		q = sqlRaw("\n    \n    (\n      SELECT\n        ").sub(selectList).raw("\n      ").sub(fromAndJoin).
			raw("\n      WHERE\n        ").sub(base).raw(" AND ").sub(cc.equality).
			raw("\n      ORDER BY\n        " + order + "\n      LIMIT ").arg(limit).
			raw("\n    )\n    UNION ALL\n    (\n      SELECT\n        ").sub(selectList).raw("\n      ").sub(fromAndJoin).
			raw("\n      WHERE\n        ").sub(base).raw(" AND ").sub(cc.strict).
			raw("\n      ORDER BY\n        " + order + "\n      LIMIT ").arg(limit).
			raw("\n    )\n    LIMIT ").arg(limit).raw("\n  ")
	} else {
		q = sqlRaw("\n    \n    SELECT\n      ").sub(selectList).raw("\n    ").sub(fromAndJoin).
			raw("\n    WHERE\n      ").sub(base).
			raw("\n    ORDER BY\n      " + order + "\n    LIMIT ").arg(limit).raw("\n  ")
	}
	text, args := q.build()
	return text, args, nil
}

func uniqueInts(ids []int) []int {
	seen := make(map[int]bool, len(ids))
	out := make([]int, 0, len(ids))
	for _, id := range ids {
		if !seen[id] {
			seen[id] = true
			out = append(out, id)
		}
	}
	return out
}

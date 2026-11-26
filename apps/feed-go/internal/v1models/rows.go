package v1models

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/civitai/civitai/apps/feed-go/internal/hydrate"
)

// Querier is the replica (a *pgxpool.Pool satisfies it).
type Querier interface {
	Query(ctx context.Context, sql string, args ...any) (pgx.Rows, error)
}

// ModelRow is one row of getModelsRaw's statement: the columns the REST answers read.
type ModelRow struct {
	ID                    int
	Name                  string
	SfwName               *string
	CoverImageID          *int
	SfwCoverImageID       *int
	Description           *string
	SfwDescription        *string
	AllowNoCredit         bool
	AllowCommercialUse    []string
	AllowDerivatives      bool
	AllowDifferentLicense bool
	Type                  string
	Minor                 bool
	SfwOnly               bool
	Poi                   bool
	Nsfw                  bool
	NsfwLevel             int
	Status                string
	Mode                  *string
	Availability          string
	Meta                  map[string]any
	UserID                int
	CursorID              *string
}

// queryRows runs sql and collects every row as a column-name map (pgx's Values: an unregistered
// enum or enum array arrives as its text form, jsonb decoded).
func queryRows(ctx context.Context, db Querier, sql string, args ...any) ([]map[string]any, error) {
	rows, err := db.Query(ctx, sql, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	fields := rows.FieldDescriptions()
	var out []map[string]any
	for rows.Next() {
		vals, err := rows.Values()
		if err != nil {
			return nil, err
		}
		m := make(map[string]any, len(vals))
		for i, f := range fields {
			if i < len(vals) {
				m[f.Name] = vals[i]
			}
		}
		out = append(out, m)
	}
	return out, rows.Err()
}

func modelRowFrom(m map[string]any) (ModelRow, error) {
	r := ModelRow{}
	var ok bool
	if r.ID, ok = intOf(m["id"]); !ok {
		return r, errors.New("v1models: model row without an id")
	}
	r.Name, _ = m["name"].(string)
	r.SfwName = strPtr(m["sfwName"])
	r.CoverImageID = intPtr(m["coverImageId"])
	r.SfwCoverImageID = intPtr(m["sfwCoverImageId"])
	r.Description = strPtr(m["description"])
	r.SfwDescription = strPtr(m["sfwDescription"])
	r.AllowNoCredit, _ = m["allowNoCredit"].(bool)
	acu, err := textArray(m["allowCommercialUse"])
	if err != nil {
		return r, err
	}
	r.AllowCommercialUse = acu
	r.AllowDerivatives, _ = m["allowDerivatives"].(bool)
	r.AllowDifferentLicense, _ = m["allowDifferentLicense"].(bool)
	r.Type = enumText(m["type"])
	r.Minor, _ = m["minor"].(bool)
	r.SfwOnly, _ = m["sfwOnly"].(bool)
	r.Poi, _ = m["poi"].(bool)
	r.Nsfw, _ = m["nsfw"].(bool)
	r.NsfwLevel, _ = intOf(m["nsfwLevel"])
	r.Status = enumText(m["status"])
	if s := enumText(m["mode"]); s != "" {
		r.Mode = &s
	}
	r.Availability = enumText(m["availability"])
	r.Meta = jsonObject(m["meta"])
	r.UserID, _ = intOf(m["userId"])
	r.CursorID = strPtr(m["cursorId"])
	return r, nil
}

// intOf reads an integer column or cached number (hydrate.Int; a string is not a number here).
func intOf(v any) (int, bool) {
	if _, isString := v.(string); isString {
		return 0, false
	}
	return hydrate.Int(v)
}

func intPtr(v any) *int {
	if n, ok := intOf(v); ok && v != nil {
		return &n
	}
	return nil
}

func strPtr(v any) *string {
	switch t := v.(type) {
	case string:
		return &t
	case []byte:
		s := string(t)
		return &s
	}
	return nil
}

// enumText reads an enum column: pgx hands an unregistered enum over as its text.
func enumText(v any) string {
	switch t := v.(type) {
	case string:
		return t
	case []byte:
		return string(t)
	case fmt.Stringer:
		return t.String()
	}
	return ""
}

// jsonObject reads a jsonb object column (decoded by pgx, or its text).
func jsonObject(v any) map[string]any {
	switch t := v.(type) {
	case map[string]any:
		return t
	case string:
		var m map[string]any
		if json.Unmarshal([]byte(t), &m) == nil {
			return m
		}
	case []byte:
		var m map[string]any
		if json.Unmarshal(t, &m) == nil {
			return m
		}
	}
	return nil
}

// textArray reads an enum[] column: pgx hands an unregistered array type over as Postgres's text
// form (`{Image,RentCivit}`); a decoded array is taken as it is.
func textArray(v any) ([]string, error) {
	switch t := v.(type) {
	case nil:
		return nil, nil
	case []string:
		return t, nil
	case []any:
		out := make([]string, 0, len(t))
		for _, e := range t {
			s, _ := e.(string)
			out = append(out, s)
		}
		return out, nil
	case []byte:
		return parsePGTextArray(string(t))
	case string:
		return parsePGTextArray(t)
	}
	return nil, fmt.Errorf("v1models: unreadable array column %T", v)
}

// parsePGTextArray reads a one-dimensional Postgres array literal of enum labels. Enum labels are
// plain words, so only the quoted form needs care; a NULL element or a nested array is refused.
func parsePGTextArray(s string) ([]string, error) {
	if len(s) < 2 || s[0] != '{' || s[len(s)-1] != '}' {
		return nil, errors.New("v1models: not an array literal")
	}
	body := s[1 : len(s)-1]
	out := []string{}
	if body == "" {
		return out, nil
	}
	for i := 0; i < len(body); {
		if body[i] == '"' {
			var b strings.Builder
			i++
			for i < len(body) && body[i] != '"' {
				if body[i] == '\\' && i+1 < len(body) {
					i++
				}
				b.WriteByte(body[i])
				i++
			}
			if i >= len(body) {
				return nil, errors.New("v1models: unterminated array element")
			}
			i++ // closing quote
			out = append(out, b.String())
		} else {
			j := strings.IndexByte(body[i:], ',')
			if j < 0 {
				j = len(body) - i
			}
			el := body[i : i+j]
			if el == "NULL" || strings.ContainsAny(el, "{}") {
				return nil, errors.New("v1models: unsupported array element")
			}
			out = append(out, el)
			i += j
		}
		if i < len(body) {
			if body[i] != ',' {
				return nil, errors.New("v1models: malformed array literal")
			}
			i++
		}
	}
	return out, nil
}

// timeOf reads a timestamp column or a cached Date.
func timeOf(v any) (time.Time, bool) {
	t, ok := v.(time.Time)
	return t.UTC(), ok
}

func itoa(n int) string { return strconv.Itoa(n) }

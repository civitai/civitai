package testkit

import (
	"context"
	"errors"
	"fmt"
	"reflect"
	"strings"
	"sync"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgtype"
)

// Rows is a pgx.Rows over literal values. Scan assigns each column to its destination by reflection,
// converting between Go numeric kinds and from string to []byte (a jsonb column as its text); a nil
// value scans into a pointer destination as nil and fails for a non-pointer one, as pgx does.
// Values returns the stored values as they are (what rowsToMaps reads).
type Rows struct {
	Cols []string
	Data [][]any

	i      int
	err    error
	closed bool
}

// NewRows returns rows with the given columns.
func NewRows(cols []string, data ...[]any) *Rows { return &Rows{Cols: cols, Data: data, i: -1} }

func (r *Rows) Close()                        { r.closed = true }
func (r *Rows) Err() error                    { return r.err }
func (r *Rows) CommandTag() pgconn.CommandTag { return pgconn.NewCommandTag("SELECT") }
func (r *Rows) Conn() *pgx.Conn               { return nil }
func (r *Rows) TypeMap() *pgtype.Map          { return nil }
func (r *Rows) RawValues() [][]byte           { return nil }

func (r *Rows) FieldDescriptions() []pgconn.FieldDescription {
	out := make([]pgconn.FieldDescription, len(r.Cols))
	for i, c := range r.Cols {
		out[i] = pgconn.FieldDescription{Name: c}
	}
	return out
}

func (r *Rows) Next() bool {
	if r.closed || r.err != nil {
		return false
	}
	r.i++
	if r.i >= len(r.Data) {
		r.closed = true
		return false
	}
	return true
}

func (r *Rows) Values() ([]any, error) {
	if r.i < 0 || r.i >= len(r.Data) {
		return nil, errors.New("testkit.Rows: Values outside a row")
	}
	return append([]any(nil), r.Data[r.i]...), nil
}

func (r *Rows) Scan(dest ...any) error {
	if r.i < 0 || r.i >= len(r.Data) {
		return errors.New("testkit.Rows: Scan outside a row")
	}
	row := r.Data[r.i]
	if len(dest) != len(row) {
		r.err = fmt.Errorf("testkit.Rows: %d destinations for %d columns", len(dest), len(row))
		return r.err
	}
	for i, d := range dest {
		if err := assign(d, row[i]); err != nil {
			r.err = fmt.Errorf("testkit.Rows: column %d (%s): %w", i, r.colName(i), err)
			return r.err
		}
	}
	return nil
}

func (r *Rows) colName(i int) string {
	if i < len(r.Cols) {
		return r.Cols[i]
	}
	return "?"
}

func assign(dest, val any) error {
	dv := reflect.ValueOf(dest)
	if dv.Kind() != reflect.Pointer || dv.IsNil() {
		return fmt.Errorf("destination %T is not a non-nil pointer", dest)
	}
	target := dv.Elem()
	if val == nil {
		switch target.Kind() {
		case reflect.Pointer, reflect.Slice, reflect.Interface, reflect.Map:
			target.Set(reflect.Zero(target.Type()))
			return nil
		}
		return fmt.Errorf("cannot scan NULL into %s", target.Type())
	}
	if target.Kind() == reflect.Interface {
		target.Set(reflect.ValueOf(val))
		return nil
	}
	if target.Kind() == reflect.Pointer {
		elem := reflect.New(target.Type().Elem())
		if err := assign(elem.Interface(), val); err != nil {
			return err
		}
		target.Set(elem)
		return nil
	}
	v := reflect.ValueOf(val)
	if target.Type() == reflect.TypeOf([]byte(nil)) {
		switch t := val.(type) {
		case string:
			target.SetBytes([]byte(t))
			return nil
		case []byte:
			target.SetBytes(append([]byte(nil), t...))
			return nil
		}
	}
	if v.Type().AssignableTo(target.Type()) {
		target.Set(v)
		return nil
	}
	if isNumber(v.Kind()) && isNumber(target.Kind()) {
		target.Set(v.Convert(target.Type()))
		return nil
	}
	return fmt.Errorf("cannot scan %T into %s", val, target.Type())
}

func isNumber(k reflect.Kind) bool {
	switch k {
	case reflect.Int, reflect.Int8, reflect.Int16, reflect.Int32, reflect.Int64,
		reflect.Uint, reflect.Uint8, reflect.Uint16, reflect.Uint32, reflect.Uint64,
		reflect.Float32, reflect.Float64:
		return true
	}
	return false
}

// Route answers one query: Match picks it by SQL text, Rows builds the answer from the bound
// arguments (or fails the query). SQLRows, when set, is used instead of Rows and also receives the
// SQL text, for a fake that evaluates the query's clauses (the golden tests' image query).
type Route struct {
	// Match is a substring the SQL must contain (all of them, when several are given with "&&").
	Match   string
	Rows    func(args []any) (*Rows, error)
	SQLRows func(sql string, args []any) (*Rows, error)
}

// DB is a Querier that answers each query from the first Route whose Match the SQL contains. A query
// no route matches fails with an error naming its first line, so a test never passes on a query the
// fixture did not anticipate.
type DB struct {
	Routes []Route

	mu    sync.Mutex
	Calls []string
}

// Query implements feed.Querier and hydrate.Querier.
func (d *DB) Query(ctx context.Context, sql string, args ...any) (pgx.Rows, error) {
	d.mu.Lock()
	d.Calls = append(d.Calls, sql)
	d.mu.Unlock()
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	for _, r := range d.Routes {
		if matches(sql, r.Match) {
			var rows *Rows
			var err error
			if r.SQLRows != nil {
				rows, err = r.SQLRows(sql, args)
			} else {
				rows, err = r.Rows(args)
			}
			if err != nil {
				return nil, err
			}
			return rows, nil
		}
	}
	return nil, fmt.Errorf("testkit.DB: no route for query %q", firstLine(sql))
}

func matches(sql, pattern string) bool {
	for _, p := range strings.Split(pattern, "&&") {
		if !strings.Contains(sql, strings.TrimSpace(p)) {
			return false
		}
	}
	return true
}

func firstLine(sql string) string {
	for _, l := range strings.Split(sql, "\n") {
		if l = strings.TrimSpace(l); l != "" {
			return l
		}
	}
	return ""
}

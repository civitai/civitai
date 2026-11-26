package server

import (
	"go/ast"
	"go/parser"
	"go/token"
	"net/http"
	"os"
	"path/filepath"
	"reflect"
	"runtime"
	"slices"
	"sort"
	"strings"
	"testing"
)

// funcName is the fully qualified name of a function value.
func funcName(f any) string {
	return runtime.FuncForPC(reflect.ValueOf(f).Pointer()).Name()
}

const (
	shadowPkg = "github.com/civitai/civitai/apps/feed-go/internal/shadow."
	serverPkg = "github.com/civitai/civitai/apps/feed-go/internal/server."
)

// compareSelectionWant is every endpoint compare() handles, with the literal comparator and classifier
// it used before CompareSelection existed (read off the pre-change compare(), the route selectors and
// trpcClassify), and the header names a REST-marked sample compares.
var compareSelectionWant = map[string]struct {
	compare, classify string
	rest              bool
	restHeaders       []string
}{
	EndpointAsPosts:     {shadowPkg + "Compare", shadowPkg + "Classify", false, nil},
	EndpointInfinite:    {shadowPkg + "Compare", shadowPkg + "ClassifyFlat", false, nil},
	EndpointModelGetAll: {shadowPkg + "Compare", shadowPkg + "ClassifyFlat", false, nil},
	EndpointAssociated:  {shadowPkg + "Compare", shadowPkg + "ClassifyArray", false, nil},
	EndpointV1Images: {shadowPkg + "CompareV1Images", shadowPkg + "ClassifyJSON", true, []string{
		"cache-control", "vary", "cache-tag", "set-cookie", "x-update-required", "etag", "access-control-allow-origin",
		"access-control-allow-headers", "access-control-allow-methods", "access-control-expose-headers", "x-frame-options", "x-expires"}},
	EndpointV1Models: {shadowPkg + "CompareJSON", shadowPkg + "ClassifyJSON", true, []string{
		"cache-control", "vary", "cache-tag", "set-cookie", "x-update-required", "etag", "access-control-allow-origin",
		"access-control-allow-headers", "access-control-allow-methods", "access-control-expose-headers", "x-frame-options", "x-expires"}},
	EndpointV1ModelsID: {shadowPkg + "CompareJSON", serverPkg + "ClassifyV1ModelID", true, []string{
		"cache-control", "vary", "cache-tag", "set-cookie", "x-update-required", "etag", "access-control-allow-origin",
		"access-control-allow-headers", "access-control-allow-methods", "access-control-expose-headers", "x-frame-options", "x-expires"}},
	EndpointSearch: {shadowPkg + "CompareJSON", serverPkg + "ClassifySearch", true, []string{
		"cache-control", "vary", "cache-tag", "set-cookie", "x-update-required", "access-control-allow-origin",
		"access-control-allow-headers", "access-control-allow-methods", "access-control-expose-headers", "x-frame-options"}},
}

var trpcHeaders = []string{"cache-control", "vary", "cache-tag", "set-cookie", "x-update-required"}

func TestCompareSelectionPinsEveryEndpoint(t *testing.T) {
	for endpoint, want := range compareSelectionWant {
		sel := CompareSelection(endpoint)
		if sel.Endpoint != endpoint {
			t.Errorf("%s: Endpoint %q", endpoint, sel.Endpoint)
		}
		if got := funcName(sel.Compare); got != want.compare {
			t.Errorf("%s: compare %s, want %s", endpoint, got, want.compare)
		}
		if got := funcName(sel.Classify); got != want.classify {
			t.Errorf("%s: classify %s, want %s", endpoint, got, want.classify)
		}
		if sel.REST != want.rest {
			t.Errorf("%s: REST %v, want %v", endpoint, sel.REST, want.rest)
		}
		// An unmarked sample (a tRPC sample, or a REST one from a sampler predating the REST list)
		// compares the tRPC list everywhere.
		if got := sel.HeaderNames(""); !slices.Equal(got, trpcHeaders) {
			t.Errorf("%s: unmarked header names %v", endpoint, got)
		}
		wantREST := want.restHeaders
		if !want.rest {
			wantREST = trpcHeaders // a tRPC endpoint ignores the REST mark
		}
		if got := sel.HeaderNames(ResponseHeaderSetREST); !slices.Equal(got, wantREST) {
			t.Errorf("%s: REST-marked header names %v, want %v", endpoint, got, wantREST)
		}
		wantSet := ""
		if want.rest {
			wantSet = ResponseHeaderSetREST
		}
		if got := sel.HeaderSet(); got != wantSet {
			t.Errorf("%s: HeaderSet %q, want %q", endpoint, got, wantSet)
		}
	}
}

// TestCompareSelectionLedger: the endpoints compare() handles are exactly the ones whose internal
// shadow handler calls shadowHandler (read from the package source), and the table above names each
// of them. A new shadow endpoint fails here until its selection is pinned; a removed one too.
func TestCompareSelectionLedger(t *testing.T) {
	idents := map[string]string{
		"EndpointAsPosts": EndpointAsPosts, "EndpointInfinite": EndpointInfinite, "EndpointModelGetAll": EndpointModelGetAll,
		"EndpointAssociated": EndpointAssociated, "EndpointV1Images": EndpointV1Images, "EndpointV1Models": EndpointV1Models,
		"EndpointV1ModelsID": EndpointV1ModelsID, "EndpointSearch": EndpointSearch,
	}
	files, err := filepath.Glob("*.go")
	if err != nil {
		t.Fatal(err)
	}
	fset := token.NewFileSet()
	var found []string
	for _, f := range files {
		if strings.HasSuffix(f, "_test.go") {
			continue
		}
		src, err := os.ReadFile(f) //nolint:gosec // G304: this package's own source files
		if err != nil {
			t.Fatal(err)
		}
		file, err := parser.ParseFile(fset, f, src, 0)
		if err != nil {
			t.Fatal(err)
		}
		ast.Inspect(file, func(n ast.Node) bool {
			call, ok := n.(*ast.CallExpr)
			if !ok {
				return true
			}
			sel, ok := call.Fun.(*ast.SelectorExpr)
			if !ok || sel.Sel.Name != "shadowHandler" || len(call.Args) != 3 {
				return true
			}
			id, ok := call.Args[2].(*ast.Ident)
			if !ok {
				t.Errorf("%s: shadowHandler called with a non-constant endpoint", fset.Position(call.Pos()))
				return true
			}
			found = append(found, id.Name)
			return true
		})
	}
	sort.Strings(found)
	wantIdents := []string{"EndpointAsPosts", "EndpointAssociated", "EndpointInfinite", "EndpointModelGetAll",
		"EndpointSearch", "EndpointV1Images", "EndpointV1Models", "EndpointV1ModelsID"}
	if !slices.Equal(found, wantIdents) {
		t.Fatalf("shadowHandler endpoints %v, want %v", found, wantIdents)
	}
	if len(found) != len(compareSelectionWant) {
		t.Fatalf("%d shadow endpoints, %d pinned selections", len(found), len(compareSelectionWant))
	}
	for _, name := range found {
		if _, ok := compareSelectionWant[idents[name]]; !ok {
			t.Errorf("%s (%q) has no pinned selection", name, idents[name])
		}
	}
	// The exported known-endpoint list is the same set: what the harness accepts is what is pinned.
	known := CompareSelectionEndpoints()
	sort.Strings(known)
	pinned := make([]string, 0, len(compareSelectionWant))
	for e := range compareSelectionWant {
		pinned = append(pinned, e)
	}
	sort.Strings(pinned)
	if !slices.Equal(known, pinned) {
		t.Fatalf("CompareSelectionEndpoints %v, pinned %v", known, pinned)
	}
	for _, e := range pinned {
		if !HasCompareSelection(e) {
			t.Errorf("HasCompareSelection(%q) false", e)
		}
	}
	if HasCompareSelection("not-an-endpoint") {
		t.Error("HasCompareSelection accepts an unknown endpoint")
	}
}

// An endpoint with no rule of its own is compared as the gallery: the pre-change default.
func TestCompareSelectionDefault(t *testing.T) {
	sel := CompareSelection("not-an-endpoint")
	if funcName(sel.Compare) != shadowPkg+"Compare" || funcName(sel.Classify) != shadowPkg+"Classify" || sel.REST {
		t.Fatalf("default selection %s %s %v", funcName(sel.Compare), funcName(sel.Classify), sel.REST)
	}
}

func TestPickResponseHeadersOverNames(t *testing.T) {
	h := http.Header{}
	h.Add("Cache-Control", "public, max-age=60")
	h.Add("Vary", "Cookie")
	h.Add("Vary", "Accept")
	h.Add("Set-Cookie", "k=v1")
	h.Add("X-Other", "dropped")
	h.Add("ETag", `"e1"`)
	h.Set("Cache-Tag", strings.Repeat("t", 1030))
	got := PickResponseHeaders(h, []string{"cache-control", "vary", "set-cookie", "cache-tag", "x-update-required"})
	want := map[string]string{"cache-control": "public, max-age=60", "vary": "Cookie, Accept", "set-cookie": "present",
		"cache-tag": strings.Repeat("t", 1024)}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %v, want %v", got, want)
	}
	// The serve-parity picker is the tRPC list's.
	if !reflect.DeepEqual(pickResponseHeaders(h), want) {
		t.Fatalf("pickResponseHeaders %v", pickResponseHeaders(h))
	}
}

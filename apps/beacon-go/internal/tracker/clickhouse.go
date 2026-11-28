package tracker

import (
	"net/http"
	"net/url"
	"strings"

	"github.com/civitai/civitai/apps/beacon-go/internal/beacon"
)

// ClickHouseSettings are the settings the Node app's shared client sends with every request
// (packages/civitai-clickhouse/src/client.ts createClickhouseClient's clickhouse_settings): an
// asynchronous insert that does not wait for the flush, so the server batches the many small inserts.
var ClickHouseSettings = [][2]string{
	{"async_insert", "1"},
	{"wait_for_async_insert", "0"},
	{"output_format_json_quote_64bit_integers", "0"},
}

// ClickHouseInsertURL is the HTTP interface request the Node client's `insert({table, values,
// format: 'JSONEachRow'})` makes: `INSERT INTO <table> FORMAT JSONEachRow` as the query, the shared
// settings as parameters. The table name comes from this service's own constants, never a request.
func ClickHouseInsertURL(host, table string) string {
	q := url.Values{}
	q.Set("query", "INSERT INTO "+table+" FORMAT JSONEachRow")
	for _, s := range ClickHouseSettings {
		q.Set(s[0], s[1])
	}
	return strings.TrimRight(host, "/") + "/?" + q.Encode()
}

// NewClickHouse is a Client that inserts each Write into its table directly (CLICKHOUSE_HOST, with
// CLICKHOUSE_USERNAME / CLICKHOUSE_PASSWORD as basic auth, as the Node client sends them). A Write's
// Body is the insert's JSONEachRow body (one row per line). One attempt: the Node client's insert is
// not retried, and a failure is logged and dropped there too. Start it like any Client.
func NewClickHouse(host, username, password string, hc *http.Client) *Client {
	return &Client{
		BaseURL:  host,
		HTTP:     hc,
		Attempts: 1,
		URL:      func(w beacon.Write) string { return ClickHouseInsertURL(host, w.Table) },
		Prepare: func(r *http.Request) {
			r.Header.Set("Content-Type", "text/plain")
			r.SetBasicAuth(username, password)
		},
	}
}

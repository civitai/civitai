package feed

// WithParam is withParam for the other REST ports: key set to value in Object.keys order (in place
// when present, else appended), as a JS property assignment on req.query.
func WithParam(params []QueryParam, key, value string) []QueryParam {
	return withParam(params, key, value)
}

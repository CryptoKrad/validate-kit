// Package ingest normalizes raw input — a dogfood fixture for validate-kit's Go layer.
package ingest

import "strings"

// Normalize trims surrounding whitespace and lowercases a token.
func Normalize(s string) string {
	return strings.ToLower(strings.TrimSpace(s))
}

// MustNonEmpty returns s, or panics when it is empty.
//
// NOTE: the panic() below intentionally trips the custom rule `go-no-panic`
// so the dogfood fixtures prove the rule fires on real code.
func MustNonEmpty(s string) string {
	if s == "" {
		panic("empty input")
	}
	return s
}

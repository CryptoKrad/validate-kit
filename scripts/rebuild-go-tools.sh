#!/bin/sh
# Rebuild Go-installed tools that were built with an older Go release than the
# one on PATH. A tool that loads Go packages (govulncheck, nilaway, deadcode,
# gopls) stops on code that asks for a newer Go than it was built with, and a
# Go upgrade leaves every `go install`ed binary on the old one. `check doctor`
# names the stale tools a project uses; this rebuilds them where they are, at
# the module version they already have.
#
#   scripts/rebuild-go-tools.sh                 list the stale binaries in GOBIN
#   scripts/rebuild-go-tools.sh <name> [...]    rebuild those, same version, this Go
set -eu
bin=$(go env GOBIN)
[ -n "$bin" ] || bin=$(go env GOPATH)/bin
here=$(go env GOVERSION | sed -E 's/^go([0-9]+\.[0-9]+).*/\1/')
older() { # is release $1 (1.26) older than release $2 (1.27)?
	[ "$(printf '%s\n%s\n' "$1" "$2" | sort -t. -k1,1n -k2,2n | head -1)" = "$1" ] && [ "$1" != "$2" ]
}
status=0
for file in "$bin"/*; do
	name=$(basename "$file")
	info=$(go version -m "$file" 2>/dev/null) || continue
	built=$(printf '%s\n' "$info" | sed -n -E '1s/.*: go([0-9]+\.[0-9]+).*/\1/p')
	path=$(printf '%s\n' "$info" | awk '$1 == "path" { print $2 }')
	version=$(printf '%s\n' "$info" | awk '$1 == "mod" { print $3 }')
	# The Go distribution's own commands (cmd/go, cmd/gofmt) come with a Go, not from `go install`.
	case "$path" in "" | cmd/*) continue ;; esac
	if [ -z "$built" ] || ! older "$built" "$here"; then continue; fi
	if [ $# -eq 0 ]; then
		printf '%s\tbuilt with go%s, Go here is go%s\t%s@%s\n' "$name" "$built" "$here" "$path" "$version"
		continue
	fi
	case " $* " in *" $name "*) ;; *) continue ;; esac
	case "$version" in
	"" | "(devel)") printf '%s: no module version recorded, not rebuilt\n' "$name" >&2 && status=1 && continue ;;
	esac
	# GOTOOLCHAIN=local: build with the Go on PATH, not one a go.mod asks for.
	if GOTOOLCHAIN=local GOBIN="$bin" go install "$path@$version" 2>/dev/null; then
		printf '%s\trebuilt with %s\t%s@%s\n' "$name" "$(go env GOVERSION)" "$path" "$version"
	else
		printf '%s: go install %s@%s failed\n' "$name" "$path" "$version" >&2
		status=1
	fi
done
exit $status

#!/bin/sh
# Run the done gate on a clean copy of the committed code: a detached git
# worktree of HEAD, installed from the lockfile, with nothing from this
# checkout leaking in. It catches what a gate run in the working tree cannot:
# a file that was never committed, a bin that only resolves because of an
# earlier install, a tool found through this checkout's node_modules/.bin.
#
#   scripts/verify-clean.sh [<ref>]             the done gate, default ref HEAD
#   scripts/verify-clean.sh --ci [<ref>]        the preflight: also every command
#                                               CI's push jobs run that this
#                                               machine can run, and the jobs
#                                               it leaves to CI, named
#   scripts/verify-clean.sh --pushed            the pre-push hook: the preflight
#                                               on each commit git is pushing
#                                               (its refs on stdin), once per
#                                               commit
#   scripts/verify-clean.sh --stamps [<range>]  how each commit was verified:
#                                               `preflight`, `gate` or `none`
#                                               (default range: what is not
#                                               on origin/main); exit 1 when
#                                               a commit has no stamp. The
#                                               third column is the session's
#                                               stamp, the commit's `Verified:`
#                                               trailer (`-` when it has none)
#
# A pass prints one line. A failing step prints its command, exit code, last
# lines and log path; the rest stay in their logs. Exit 0 only if every step
# exits 0. The worktree is removed on exit, and the logs too on a pass.
# workflow:check (scripts/validate-workflows.mjs) fails when a push job runs a
# command this preflight neither runs nor leaves to CI by name.
set -u
# A hook runs with git's GIT_DIR (a linked worktree's, say) in its
# environment: the steps' own git commands, the tests' `git init` among them,
# would act on this repository instead of their temp folders.
# shellcheck disable=SC2046 # one name per word
unset $(git rev-parse --local-env-vars)
# A hook's PATH can put another `go` first than the one the shell's GOROOT
# belongs to (a global hook that prepends Homebrew, a GOROOT exported by
# mise): go then fails to compile its own standard library. Without GOROOT,
# go finds its root from its own path.
unset GOROOT
top="$(git rev-parse --show-toplevel)" || exit 2
# Commits the preflight passed, per API base, so a retried push runs it once.
passed_dir="$(git -C "$top" rev-parse --path-format=absolute --git-common-dir)/preflight" || exit 2
# Commits the done gate passed, in a folder of their own: a preflight record
# is named for its API base.
gate_dir="$passed_dir/gate"
# The base check-openapi compares the API with: the remote's tip a push names
# (github.event.before in CI), else origin/main, as check-openapi itself does.
api_base() {
	if [ -n "${1:-}" ] && git -C "$top" cat-file -e "$1^{commit}" 2>/dev/null; then
		printf '%s' "$1"
	else
		git -C "$top" rev-parse --verify --quiet origin/main
	fi
}

# Every commit carries a stamp of how it was verified, `none` included, so
# the ones nothing verified can be listed (Anthropic, "How the Claude Code
# team thinks about verification", 2026-11-16). The stamp is the record a
# pass leaves below; it stays on this machine.
if [ "${1:-}" = "--stamps" ]; then
	range="${2:-}"
	if [ -z "$range" ]; then
		base="$(api_base)"
		range="${base:+$base..HEAD}"
	fi
	# shellcheck disable=SC2086 # the fallback range is two words
	commits="$(git -C "$top" rev-list ${range:--20 HEAD})" || exit 2
	status=0
	for commit in $commits; do
		stamp=none
		[ -f "$gate_dir/$commit" ] && stamp=gate
		for record in "$passed_dir/$commit".*; do
			[ -f "$record" ] && stamp=preflight
		done
		[ "$stamp" = none ] && status=1
		# The session's own stamp, a trailer the commit gate adds (scripts/commit-gate.mjs).
		session="$(git -C "$top" log -1 --format='%(trailers:key=Verified,valueonly,separator=%x2C )' "$commit")"
		printf '%s %-9s %-16s %s\n' "$(git -C "$top" rev-parse --short "$commit")" "$stamp" "${session:--}" "$(git -C "$top" log -1 --format=%s "$commit")"
	done
	exit "$status"
fi

if [ "${1:-}" = "--pushed" ]; then
	status=0
	seen=" "
	while read -r _local_ref local_sha _remote_ref remote_sha; do
		# A deleted ref (all zeros) has nothing to judge; a tag is judged by its
		# commit.
		commit="$(git -C "$top" rev-parse --verify --quiet "$local_sha^{commit}")" || continue
		case "$seen" in *" $commit "*) continue ;; esac
		seen="$seen$commit "
		base="$(api_base "$remote_sha")"
		if [ -f "$passed_dir/$commit.${base:-none}" ]; then
			printf 'preflight already passed on %s\n' "$commit"
			continue
		fi
		OPENAPI_BASE_REF="$base" "$0" --ci "$commit" </dev/null
		rc=$?
		# Interrupted: stop, rather than start on the next commit.
		[ "$rc" -gt 128 ] && exit "$rc"
		[ "$rc" -eq 0 ] || status=1
	done
	exit "$status"
fi

ci=0
if [ "${1:-}" = "--ci" ]; then
	ci=1
	shift
fi
ref="${1:-HEAD}"
full="$(git -C "$top" rev-parse --verify "$ref^{commit}")" || exit 2
sha="$(git -C "$top" rev-parse --short=12 "$full")" || exit 2

# The smoke below requires TLC and Lean (SMOKE_REQUIRE_FORMAL; it installs
# its own Quint), and a missing one fails it minutes in, without saying how to
# get it. Say so before anything is built, with the line that installs it.
# CI puts TLC in ~/.local/bin and that folder on PATH (validate.yml, "Install
# TLC"). Here the folder goes last, so no step finds another binary than
# before; whatever else this machine keeps there is found too, as in CI.
PATH="$PATH${HOME:+:$HOME/.local/bin}"
export PATH
missing=""
need() {
	command -v "$1" >/dev/null 2>&1 && return
	missing="$missing
  $1: $2"
}
need tlc "the pinned jar and a launcher in ~/.local/bin, as the step 'Install TLC' of .github/workflows/validate.yml does (shasum -a 256 -c on macOS)"
need lean "brew install elan-init"
# TLC is a jar. macOS has a /usr/bin/java with no JDK behind it, so ask java.
java -version >/dev/null 2>&1 || missing="$missing
  java: a JDK on PATH (brew install openjdk@21, then the link line brew prints)"
if [ -n "$missing" ]; then
	printf '%s cannot start: the smoke requires these tools, and they are not on PATH:%s\n' "$([ "$ci" -eq 1 ] && echo preflight || echo verify-clean)" "$missing" >&2
	exit 2
fi

scratch="$(mktemp -d)" || exit 2
work="$scratch/verify-clean-$sha"
logs="$scratch/logs"

# shellcheck disable=SC2317,SC2329 # run by the EXIT trap below (0.9 says SC2317)
cleanup() {
	git -C "$top" worktree remove --force "$work" >/dev/null 2>&1
	[ "$fail" -eq 0 ] && rm -rf "$logs"
	rmdir "$scratch" >/dev/null 2>&1
}
fail=0
trap cleanup EXIT
# A handler that returns lets the script carry on; exit so EXIT cleans up once.
trap 'fail=1; exit 130' INT
trap 'fail=1; exit 143' TERM

mkdir "$logs" || exit 2
git -C "$top" worktree add --quiet --detach "$work" "$full" || exit 2
cd "$work" || exit 2

# This checkout's node_modules/.bin must not satisfy the copy's commands.
clean_path=""
old_ifs="$IFS"
IFS=:
for entry in $PATH; do
	case "$entry" in
	"$top" | "$top"/*) ;;
	*) clean_path="${clean_path:+$clean_path:}$entry" ;;
	esac
done
IFS="$old_ifs"
PATH="$clean_path"
export PATH
# mise refuses config files in a directory it has not been told to trust.
export MISE_TRUSTED_CONFIG_PATHS="$work"

step=0
failed=0
began=$(date +%s)
# Seconds per step, kept in the record a pass leaves: where the minutes of a
# preflight go (`pnpm run ci:metrics` prints the slowest).
timings=""
run() {
	step=$((step + 1))
	log="$logs/$step.log"
	started=$(date +%s)
	sh -c "$1" >"$log" 2>&1
	rc=$?
	timings="$timings$(($(date +%s) - started))s $1
"
	if [ "$rc" -ne 0 ]; then
		fail=1
		failed=$((failed + 1))
		printf '##### FAIL (exit %s): %s\n' "$rc" "$1"
		# pnpm's own closing lines repeat the exit code and push the cause out.
		grep -v -e ELIFECYCLE -e ERR_PNPM_ -e '^Exit status ' "$log" | tail -n 40
		printf '##### full output: %s\n' "$log"
	fi
}
left_to_ci=""
left() {
	left_to_ci="${left_to_ci:+$left_to_ci; }$1 ($2)"
}

run "pnpm install --frozen-lockfile"
run "pnpm run build"
run "pnpm --filter validate-kit run typecheck"
run "pnpm --filter validate-kit run test"
run "pnpm run check"
run "node scripts/consumer-upgrade.mjs --self-test"
run "node scripts/outdated.mjs --self-test"
# A formal case that would be skipped here is a failure, as in CI.
run "SMOKE_REQUIRE_FORMAL=1 pnpm run smoke:external-package"
if [ "$ci" -eq 1 ]; then
	OPENAPI_BASE_REF="$(api_base "${OPENAPI_BASE_REF:-}")"
	export OPENAPI_BASE_REF
	# validate.yml#validate (and poly.yml's build)
	run "cd packages/validate-kit && ./node_modules/.bin/tsup"
	run "pnpm exec check doctor --profile ci"
	run "cd packages/validate-kit && ./node_modules/.bin/ast-grep test"
	# CI runs these two parts of the kit's tests by name: run them as it does.
	run "pnpm --fail-if-no-match --filter validate-kit run test:core"
	run "pnpm run workflow:check"
	run "OPENAPI_BASE_REF=${OPENAPI_BASE_REF:-} pnpm run openapi:check"
	# security.yml
	run "semgrep --config packages/validate-kit/semgrep/custom.yml --error --disable-version-check ."
	run "pnpm audit --audit-level=high"
	# test-ts.yml
	run "pnpm --fail-if-no-match --filter api run test"
	run "pnpm --fail-if-no-match --filter web run test"
	run "pnpm run pact:check"
	docker info >/dev/null 2>&1 && docker=1 || docker=0
	if [ "$docker" -eq 1 ]; then
		run "pnpm --fail-if-no-match --filter api run test:integration:docker"
	fi
	# poly.yml
	run "pnpm --fail-if-no-match --filter validate-kit run test:polyglot"

	left "validate.yml#windows" "Windows runner"
	left "e2e.yml#playwright" "baselines rendered in CI's Linux container"
	left "test-ts.yml#unit-component-api" "the other Node legs of 22, 24 and 26; here $(node --version)"
	if [ "$docker" -eq 0 ]; then
		left "test-ts.yml#integration" "Docker not running"
	fi
fi

[ "$ci" -eq 1 ] && [ "$fail" -eq 0 ] && mkdir -p "$passed_dir" && printf '%s' "$timings" >"$passed_dir/$full.${OPENAPI_BASE_REF:-none}"
[ "$ci" -eq 0 ] && [ "$fail" -eq 0 ] && mkdir -p "$gate_dir" && printf '%s' "$timings" >"$gate_dir/$full"
name="$([ "$ci" -eq 1 ] && echo preflight || echo verify-clean)"
if [ "$fail" -eq 0 ]; then
	printf '%s PASS on %s: %s steps, %ss%s\n' "$name" "$sha" "$step" "$(($(date +%s) - began))" "${left_to_ci:+; left to CI: $left_to_ci}"
else
	printf '%s FAIL on %s: %s of %s steps failed\n' "$name" "$sha" "$failed" "$step"
fi
exit "$fail"

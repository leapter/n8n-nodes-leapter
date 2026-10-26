#!/usr/bin/env bash
# This repository is public: fails when a tracked file contains a workstation path, an internal
# repository, an internal link or ticket id, an internal account or address, or a key or token.
# Prints file and line only, never the match itself.
set -uo pipefail
cd "$(dirname "$0")/.."

# name|extended regular expression
CHECKS=(
	'workstation path|/Users/[A-Za-z]|/home/[a-z]+/(leapter|dev|src|projects)|~/leapter|C:\\\\Users\\\\'
	'internal repository|genielabs|leapter-core|leapter-mcp'
	'internal link or ticket id|linear\.app|(^|[^A-Za-z0-9])P?-?ENG-[0-9]+'
	'internal account|[A-Za-z0-9._%+-]+@leapter\.com'
	'non-public address|dev\.runtime\.leapter\.com|staging\.[a-z.]*leapter'
	'key or token|lk_(mgmt|dev|rec|prod|stage)_[A-Za-z0-9_-]{20,}|eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}'
)
# Public on purpose: the package's contact address
ALLOWED='developers@leapter\.com'

failed=0
for check in "${CHECKS[@]}"; do
	name=${check%%|*}
	pattern=${check#*|}
	hits=$(git grep -nIE "$pattern" -- . ':!pnpm-lock.yaml' ':!scripts/check-public.sh' | grep -vE "$ALLOWED" | cut -d: -f1,2)
	if [[ -n $hits ]]; then
		echo "check-public: $name in"
		sed 's/^/  /' <<<"$hits"
		failed=1
	fi
done
((failed == 0)) && echo 'check-public: no internal information found'
exit "$failed"

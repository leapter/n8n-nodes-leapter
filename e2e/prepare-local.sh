#!/usr/bin/env bash
# Prepares the local Runtime Cluster for e2e/run.sh and prints its six inputs as export lines:
#   eval "$(bash e2e/prepare-local.sh)" && pnpm e2e
#
# Needs ADMIN_KEY (a key of an administrator of the local cluster), APPLICATION (a project deployed
# to dev with a public blueprint) and INPUT_JSON (that blueprint's input); BLUEPRINT_ID is optional
# (default: the project's first public blueprint). Grants service account n8n and the admin key's
# principal `operator` on dev (a key creator must hold what the key holds) and creates an n8n
# service key. Messages go to stderr, so only the exports are evaluated.
set -euo pipefail

CP=http://localhost:3002/runtime-management

fail() {
	echo "prepare-local: $*" >&2
	exit 1
}

command -v jq >/dev/null || fail "jq is required."
[ -n "${ADMIN_KEY:-}" ] || fail "ADMIN_KEY is not set: a key of an administrator of the local cluster."
[ -n "${APPLICATION:-}" ] || fail "APPLICATION is not set: a project deployed to dev with a public blueprint."
[ -n "${INPUT_JSON:-}" ] || fail "INPUT_JSON is not set: the blueprint's input, e.g. '{\"name\": \"n8n\"}'."

# admin METHOD PATH [BODY] -> prints the answer body; fails on a non-2xx answer
admin() {
	local answer status
	answer=$(curl -sS -w '\n%{http_code}' -X "$1" "$CP$2" \
		-H "Authorization: Bearer $ADMIN_KEY" -H 'Content-Type: application/json' \
		${3:+-d "$3"}) || fail "The local cluster is not running: nothing answers at $CP."
	status=${answer##*$'\n'}
	answer=${answer%$'\n'*}
	[[ $status == 2* ]] || fail "$1 $2 answered $status: $answer"
	printf '%s' "$answer"
}

ADMIN_PRINCIPAL=$(admin GET /environments | jq -r '.caller.principal')
echo "prepare-local: admin principal $ADMIN_PRINCIPAL" >&2

grant() {
	admin POST /grants "$(jq -nc --argjson principal "$1" \
		'{event: "granted", principal: $principal, role: "operator", environment: "dev",
		  reason: "n8n node e2e (prepare-local.sh)"}')" >/dev/null
}
grant '{"kind": "service", "name": "n8n"}'
grant "$(jq -nc --arg p "$ADMIN_PRINCIPAL" '$p')"
echo "prepare-local: granted operator on dev to service n8n and $ADMIN_PRINCIPAL" >&2

# Checked before a key is created, so a wrong project leaves nothing behind
APP=$(admin GET /environments/dev/status | jq -c --arg app "$APPLICATION" \
	'[.environments[0].applications[] | select(.slug == $app and ((.callable // []) | length > 0))][0] // empty')
[ -n "$APP" ] || fail "$APPLICATION is not deployed to dev with a public blueprint."
BLUEPRINT_ID=${BLUEPRINT_ID:-$(jq -r '.callable[0].id' <<<"$APP")}

KEY_ANSWER=$(admin POST /service-accounts/service:env:dev:n8n/keys '{"reason": "n8n node e2e"}')
SERVICE_KEY=$(jq -r '.key' <<<"$KEY_ANSWER")
SERVICE_KEY_ID=$(jq -r '.credential.id' <<<"$KEY_ANSWER")
echo "prepare-local: created service key $SERVICE_KEY_ID" >&2

cat <<EOF
export CLUSTER_URL=http://localhost:3002
export SERVICE_KEY=$SERVICE_KEY
export ENVIRONMENT=dev
export APPLICATION=$APPLICATION
export BLUEPRINT_ID=$BLUEPRINT_ID
export INPUT_JSON='$INPUT_JSON'
# Service key id (revoke it when done): $SERVICE_KEY_ID
EOF

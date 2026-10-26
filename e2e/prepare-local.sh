#!/usr/bin/env bash
# Prepares the local Runtime Cluster for e2e/run.sh and prints its six inputs as export lines:
#   eval "$(bash e2e/prepare-local.sh)" && pnpm e2e
#
# Needs ADMIN_KEY, a key of an administrator of the local cluster. Grants service account n8n and the
# admin key's principal `operator` on dev (a key creator must hold what the key holds), creates an
# n8n service key and picks APPLICATION, else
# the first application of dev with a public blueprint. Without INPUT_JSON it picks the fixture
# application whose blueprint the default input fits. Messages go to stderr, so only the exports
# are evaluated.
set -euo pipefail

CP=http://localhost:3002/runtime-management

fail() {
	echo "prepare-local: $*" >&2
	exit 1
}

command -v jq >/dev/null || fail "jq is required."
[ -n "${ADMIN_KEY:-}" ] || fail "ADMIN_KEY is not set: a key of an administrator of the local cluster."

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

KEY_ANSWER=$(admin POST /service-accounts/service:env:dev:n8n/keys '{"reason": "n8n node e2e"}')
SERVICE_KEY=$(jq -r '.key' <<<"$KEY_ANSWER")
SERVICE_KEY_ID=$(jq -r '.credential.id' <<<"$KEY_ANSWER")
echo "prepare-local: created service key $SERVICE_KEY_ID" >&2

# The default input below fits only the fixture blueprint "Hello World"
[ -n "${INPUT_JSON:-}" ] || APPLICATION=${APPLICATION:-n8n-discovery-spike-fixtures}

APP=$(admin GET /environments/dev/status | jq -c --arg app "${APPLICATION:-}" \
	'[.environments[0].applications[] | select((.callable // []) | length > 0)
	  | select($app == "" or .slug == $app)][0] // empty')
[ -n "$APP" ] || fail "No application in dev${APPLICATION:+ named $APPLICATION} has a public blueprint. Deploy a project with one from the Lab."

# The fixture blueprint "Hello World" takes {"userInput": string}; set INPUT_JSON for another one
INPUT_JSON=${INPUT_JSON:-'{"userInput": "n8n e2e"}'}

cat <<EOF
export CLUSTER_URL=http://localhost:3002
export SERVICE_KEY=$SERVICE_KEY
export ENVIRONMENT=dev
export APPLICATION=$(jq -r '.slug' <<<"$APP")
export BLUEPRINT_ID=$(jq -r '.callable[0].id' <<<"$APP")
export INPUT_JSON='$INPUT_JSON'
# Service key id (revoke it when done): $SERVICE_KEY_ID
EOF

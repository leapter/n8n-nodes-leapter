#!/usr/bin/env bash
# End-to-end test of the Leapter n8n node: n8n 2.44.5 in Docker against a real Runtime Cluster.
# See e2e/README.md.
set -euo pipefail

usage() {
	cat <<'EOF'
Usage: pnpm e2e            (or: bash e2e/run.sh)

Runs n8n 2.44.5 in Docker with this repository's build and checks against a Runtime Cluster:
  C1 credential test, C2 first run (one key created), C3 second run (same key),
  C4 run after an n8n restart (same key), C5 run after the key was revoked (new key).

Inputs (environment variables, all required):
  CLUSTER_URL    The cluster's address, e.g. http://localhost:3002 or https://dev.runtime.leapter.com
  SERVICE_KEY    An operator service key of the environment (lk_mgmt_...)
  ENVIRONMENT    Environment slug, e.g. dev
  APPLICATION    Application (project) slug with a public blueprint
  BLUEPRINT_ID   The blueprint's id (callable[].id in the environment's status)
  INPUT_JSON     The run's input, e.g. {"userInput": "n8n e2e"}

Optional: E2E_N8N_PORT (default 5691), E2E_KEEP=1 keeps n8n running and the key unrevoked.

For the local cluster: eval "$(bash e2e/prepare-local.sh)" && pnpm e2e
EOF
}

if [[ ${1:-} == --help || ${1:-} == -h ]]; then
	usage
	exit 0
fi

for input in CLUSTER_URL SERVICE_KEY ENVIRONMENT APPLICATION BLUEPRINT_ID INPUT_JSON; do
	if [[ -z ${!input:-} ]]; then
		echo "run.sh: $input is not set." >&2
		usage >&2
		exit 2
	fi
done

HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
ROOT=$(dirname "$HERE")
CLUSTER_URL=${CLUSTER_URL%/}
export N8N_PORT=${E2E_N8N_PORT:-5691}
N8N=http://localhost:$N8N_PORT
CREDENTIAL_ID=leapterE2eCred01
WORKFLOW_ID=leapterE2eFlow01
KEY_PATH=$ENVIRONMENT/$APPLICATION
OWNER_LOGIN='{"emailOrLdapLoginId": "e2e@leapter.test", "password": "e2e-Owner-Pass-1"}'
WORK=$(mktemp -d)
KEY_ID=

compose() {
	docker compose -f "$HERE/docker-compose.yml" "$@"
}

pass() {
	echo "PASS $*"
}

fail() {
	echo "FAIL $*"
	exit 1
}

# A local cluster answers on http://localhost; the relay in the container forwards those ports
# (the cluster's and its run address's) to host.docker.internal.
RELAY_PORTS=
local_port() {
	if [[ $1 =~ ^http://(localhost|127\.0\.0\.1)(:([0-9]+))?(/|$) ]]; then
		echo "${BASH_REMATCH[3]:-80}"
	fi
}
if [[ -n $(local_port "$CLUSTER_URL") ]]; then
	run_base=$(curl -sf "$CLUSTER_URL/runtime-management/ui/config.json" | jq -r '.runBaseUrl // empty') ||
		fail "setup: nothing answers at $CLUSTER_URL"
	RELAY_PORTS="$(local_port "$CLUSTER_URL") $(local_port "${run_base:-$CLUSTER_URL}")"
fi
export RELAY_PORTS

revoke() {
	curl -sf -X POST "$CLUSTER_URL/runtime-management/environments/$ENVIRONMENT/applications/$APPLICATION/keys/$1/revoke" \
		-H "Authorization: Bearer $SERVICE_KEY" -H 'Content-Type: application/json' \
		-d "{\"reason\": \"$2\"}" >/dev/null
}

cleanup() {
	local status=$?
	trap - EXIT
	if [[ -n ${E2E_KEEP:-} ]]; then
		echo "E2E_KEEP: n8n stays at $N8N; key ${KEY_ID:-none} stays active"
	else
		KEY_ID=$(stored_key_id 2>/dev/null || true)
		if [[ -n $KEY_ID ]]; then
			if revoke "$KEY_ID" 'n8n node e2e: cleanup'; then
				echo "cleanup: revoked key $KEY_ID"
			else
				echo "cleanup: could not revoke key $KEY_ID; revoke it in the Admin UI"
			fi
		fi
		compose down -v >/dev/null 2>&1 || true
		echo 'cleanup: n8n removed'
	fi
	rm -rf "$WORK"
	exit "$status"
}
trap cleanup EXIT

wait_for_n8n() {
	for _ in $(seq 1 120); do
		curl -sf "$N8N/healthz/readiness" >/dev/null && return 0
		sleep 1
	done
	fail "setup: n8n did not become ready at $N8N"
}

login() {
	curl -sf -c "$WORK/cookies" -X POST "$N8N/rest/login" -H 'Content-Type: application/json' \
		-d "$OWNER_LOGIN" >/dev/null || fail 'setup: owner login failed'
}

# The evaluation key map the credential stores, as JSON ({} when empty)
stored_keys() {
	curl -sf -b "$WORK/cookies" "$N8N/rest/credentials/$CREDENTIAL_ID?includeData=true" |
		jq -c '.data.data.evalKeys // "" | if . == "" then {} else fromjson end'
}

stored_key_id() {
	stored_keys | jq -r --arg path "$KEY_PATH" '.[$path].id // empty'
}

# Runs the workflow with the n8n CLI; prints the Leapter node's output item, fails on an error
run_workflow() {
	local output
	# Its own task broker port: the server already holds the default one
	if ! output=$(compose exec -T -e N8N_RUNNERS_BROKER_PORT=5681 n8n \
		n8n execute --id="$WORKFLOW_ID" --rawOutput 2>"$WORK/execute.log"); then
		echo "$output" | tail -20
		tail -5 "$WORK/execute.log"
		return 1
	fi
	# The CLI prints log lines before the JSON
	sed -n '/^{/,$p' <<<"$output" | jq -c '.data.resultData.runData.Leapter[0].data.main[0][0].json'
}

# --- Setup ---------------------------------------------------------------------------------

echo "Cluster $CLUSTER_URL, project $KEY_PATH, blueprint $BLUEPRINT_ID${RELAY_PORTS:+, relayed ports $RELAY_PORTS}"
pnpm --dir "$ROOT" build >/dev/null || fail 'setup: pnpm build failed'
compose down -v >/dev/null 2>&1 || true
compose up -d >/dev/null 2>&1 || fail 'setup: docker compose up failed'
wait_for_n8n

jq -n --arg id "$CREDENTIAL_ID" --arg url "$CLUSTER_URL" --arg key "$SERVICE_KEY" \
	'[{id: $id, name: "Leapter e2e", type: "leapterApi", data: {serviceKey: $key, showAdvanced: true, clusterUrl: $url}}]' \
	>"$WORK/credential.json"
jq --arg env "$ENVIRONMENT" --arg app "$APPLICATION" --arg id "$BLUEPRINT_ID" --arg input "$INPUT_JSON" \
	'.nodes[1].parameters += {project: "\($env)::\($app)", operation: $id, parametersJson: $input}' \
	"$HERE/workflow.json" >"$WORK/workflow.json"
compose exec -T n8n sh -c 'cat > /tmp/credential.json && n8n import:credentials --input=/tmp/credential.json' \
	<"$WORK/credential.json" >/dev/null 2>&1 || fail 'setup: n8n import:credentials failed'
compose exec -T n8n sh -c 'cat > /tmp/workflow.json && n8n import:workflow --input=/tmp/workflow.json' \
	<"$WORK/workflow.json" >/dev/null 2>&1 || fail 'setup: n8n import:workflow failed'
login

# --- C1 credential test --------------------------------------------------------------------

answer=$(curl -s -b "$WORK/cookies" -X POST "$N8N/rest/credentials/test" -H 'Content-Type: application/json' \
	-d "$(jq -c '{credentials: .[0]}' "$WORK/credential.json")")
if [[ $(jq -r '.data.status' <<<"$answer") == OK ]]; then
	pass "C1 credential test: $(jq -c '.data' <<<"$answer")"
else
	fail "C1 credential test: $answer"
fi

# --- C2 first run --------------------------------------------------------------------------

started=$SECONDS
output=$(run_workflow) || fail "C2 first run: the workflow failed: $output"
keys=$(stored_keys)
KEY_ID=$(stored_key_id)
if jq -e '.outputData' <<<"$output" >/dev/null &&
	[[ $(jq -r --arg path "$KEY_PATH" 'keys == [$path]' <<<"$keys") == true ]]; then
	pass "C2 first run ($((SECONDS - started)) s): $output; stored keys: $(jq -c 'keys' <<<"$keys"), id $KEY_ID"
else
	fail "C2 first run: output $output; stored keys $(jq -c 'map_values(.id)' <<<"$keys")"
fi

# --- C3 second run -------------------------------------------------------------------------

started=$SECONDS
output=$(run_workflow) || fail "C3 second run: the workflow failed: $output"
id=$(stored_key_id)
if jq -e '.outputData' <<<"$output" >/dev/null && [[ $id == "$KEY_ID" ]]; then
	pass "C3 second run ($((SECONDS - started)) s): $output; key id unchanged ($id)"
else
	fail "C3 second run: output $output; key id $id, was $KEY_ID"
fi

# --- C4 restart ----------------------------------------------------------------------------

compose restart >/dev/null 2>&1 || fail 'C4 restart: docker compose restart failed'
wait_for_n8n
login
started=$SECONDS
output=$(run_workflow) || fail "C4 restart: the workflow failed: $output"
id=$(stored_key_id)
if jq -e '.outputData' <<<"$output" >/dev/null && [[ $id == "$KEY_ID" ]]; then
	pass "C4 restart ($((SECONDS - started)) s): $output; key id unchanged ($id)"
else
	fail "C4 restart: output $output; key id $id, was $KEY_ID"
fi

# --- C5 revoked key ------------------------------------------------------------------------

revoke "$KEY_ID" 'n8n node e2e: C5' || fail "C5 revoked key: revoking $KEY_ID failed"
# 65 s for the engines to drop the key. The node replaces a key only once it is older than its
# 90 s grace period, so wait longer if the key is younger than that.
minted_at=$(stored_keys | jq -r --arg path "$KEY_PATH" '.[$path].mintedAt')
age=$(($(date +%s) - minted_at / 1000))
pause=$((age + 65 < 95 ? 95 - age : 65))
echo "C5: revoked $KEY_ID (age ${age} s), waiting ${pause} s"
sleep "$pause"
started=$SECONDS
output=$(run_workflow) || fail "C5 revoked key: the workflow failed: $output"
elapsed=$((SECONDS - started))
id=$(stored_key_id)
if jq -e '.outputData' <<<"$output" >/dev/null && ((elapsed <= 120)) && [[ -n $id && $id != "$KEY_ID" ]]; then
	pass "C5 revoked key (${elapsed} s): $output; key id changed ($KEY_ID -> $id)"
	KEY_ID=$id
else
	fail "C5 revoked key (${elapsed} s): output $output; key id $id, was $KEY_ID"
fi

echo 'All checks passed.'

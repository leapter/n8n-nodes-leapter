#!/usr/bin/env bash
# The Leapter node in n8n queue mode: the editor's field list runs on the main process, runs on a
# separate worker. Each process keeps its own evaluation key state, so this checks that they share
# keys through the stored credential. See e2e/README.md.
set -euo pipefail

usage() {
	cat <<'EOF'
Usage: bash e2e/queue.sh

Runs n8n in queue mode (main, worker, Postgres, Redis) with this repository's build:
  Q1 first run on the worker creates one key, Q2 the editor's field list (main) reuses it,
  Q3 a key created by the editor is reused by a run, Q4 a revoked key is replaced by a run and the
  editor takes the replacement, Q5 first use on main and worker at the same moment,
  Q6 a project that never had a key (only with FRESH_APPLICATION and FRESH_BLUEPRINT_ID).

Inputs: as e2e/run.sh (CLUSTER_URL, SERVICE_KEY, ENVIRONMENT, APPLICATION, BLUEPRINT_ID,
INPUT_JSON), and ADMIN_KEY: a key that may list an application's keys (the service key may not);
for a local cluster it is read from genielabs (GENIELABS_DIR, default ~/leapter/genielabs).
Optional: FRESH_APPLICATION and FRESH_BLUEPRINT_ID (a deployed project without any
key yet, blueprint without inputs), N8N_VERSION (default 2.44.5; tested with 2.39.6 and 2.44.5,
n8n 2.0.3 cannot activate imported workflows from the CLI), E2E_N8N_PORT (default 5693).

For the local cluster: eval "$(bash e2e/prepare-local.sh)" && bash e2e/queue.sh
EOF
}

if [[ ${1:-} == --help || ${1:-} == -h ]]; then
	usage
	exit 0
fi

for input in CLUSTER_URL SERVICE_KEY ENVIRONMENT APPLICATION BLUEPRINT_ID INPUT_JSON; do
	if [[ -z ${!input:-} ]]; then
		echo "queue.sh: $input is not set." >&2
		usage >&2
		exit 2
	fi
done

HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
ROOT=$(dirname "$HERE")
CLUSTER_URL=${CLUSTER_URL%/}
export N8N_PORT=${E2E_N8N_PORT:-5693}
N8N=http://localhost:$N8N_PORT
CP=$CLUSTER_URL/runtime-management
KEY_PATH=$ENVIRONMENT/$APPLICATION
OWNER_LOGIN='{"emailOrLdapLoginId": "e2e@leapter.test", "password": "e2e-Owner-Pass-1"}'
CREDENTIALS=(leapterQueueCred1 leapterQueueCred2 leapterQueueCred3)
WORK=$(mktemp -d)
STARTED_AT=$(date -u +%Y-%m-%dT%H:%M:%S)

compose() {
	docker compose -f "$HERE/docker-compose.queue.yml" "$@"
}

pass() {
	echo "PASS $*"
}

fail() {
	echo "FAIL $*"
	exit 1
}

RELAY_PORTS=
local_port() {
	if [[ $1 =~ ^http://(localhost|127\.0\.0\.1)(:([0-9]+))?(/|$) ]]; then
		echo "${BASH_REMATCH[3]:-80}"
	fi
}
if [[ -n $(local_port "$CLUSTER_URL") ]]; then
	run_base=$(curl -sf "$CP/ui/config.json" | jq -r '.runBaseUrl // empty') ||
		fail "setup: nothing answers at $CLUSTER_URL"
	RELAY_PORTS="$(local_port "$CLUSTER_URL") $(local_port "${run_base:-$CLUSTER_URL}")"
fi
export RELAY_PORTS

if [[ -z ${ADMIN_KEY:-} && -n $(local_port "$CLUSTER_URL") ]]; then
	ADMIN_KEY=$(sed -n 's/^RUNTIME_MANAGEMENT_BOOTSTRAP_ADMIN_KEY=//p' \
		"${GENIELABS_DIR:-$HOME/leapter/genielabs}/apps/runtime-management/.env" 2>/dev/null | tr -d "\"'")
fi
[[ -n ${ADMIN_KEY:-} ]] || fail 'setup: ADMIN_KEY is not set'
curl -sf "$CP/environments/$ENVIRONMENT/applications/$APPLICATION/keys" -H "Authorization: Bearer $ADMIN_KEY" >/dev/null ||
	fail "setup: ADMIN_KEY may not list the keys of $APPLICATION"

# Active keys of an application created since this run started
active_keys() {
	curl -sf "$CP/environments/$ENVIRONMENT/applications/$1/keys" -H "Authorization: Bearer $ADMIN_KEY" |
		jq -c --arg since "$STARTED_AT" '[.keys[] | select(.revokedAt == null and .mintedAt >= $since) | .id]'
}

revoke() {
	curl -sf -X POST "$CP/environments/$ENVIRONMENT/applications/$1/keys/$2/revoke" \
		-H "Authorization: Bearer ${ADMIN_KEY:-$SERVICE_KEY}" -H 'Content-Type: application/json' \
		-d "{\"reason\": \"$3\"}" >/dev/null
}

cleanup() {
	local status=$?
	trap - EXIT
	# Every key this run created, including any a race left unstored
	[[ -n ${ADMIN_KEY:-} ]] || { compose down -v >/dev/null 2>&1 || true; rm -rf "$WORK"; exit "$status"; }
	for app in "$APPLICATION" ${FRESH_APPLICATION:-}; do
		for id in $(active_keys "$app" 2>/dev/null | jq -r '.[]'); do
			if revoke "$app" "$id" 'n8n node queue e2e: cleanup'; then
				echo "cleanup: revoked $app key $id"
			else
				echo "cleanup: could not revoke $app key $id; revoke it in the Admin UI"
			fi
		done
	done
	if [[ -n ${SECOND_KEY_ID:-} ]]; then
		curl -sf -X POST "$CP/service-accounts/service:env:$ENVIRONMENT:n8n/keys/$SECOND_KEY_ID/revoke" \
			-H "Authorization: Bearer $ADMIN_KEY" -H 'Content-Type: application/json' \
			-d '{"reason": "n8n node queue e2e: cleanup"}' >/dev/null && echo "cleanup: revoked service key $SECOND_KEY_ID" ||
			echo "cleanup: could not revoke service key $SECOND_KEY_ID; revoke it in the Admin UI"
	fi
	compose down -v >/dev/null 2>&1 || true
	echo 'cleanup: n8n removed'
	rm -rf "$WORK"
	exit "$status"
}
trap cleanup EXIT

wait_for_n8n() {
	for _ in $(seq 1 180); do
		curl -sf "$N8N/healthz/readiness" >/dev/null && curl -sf "$N8N/rest/settings" >/dev/null && return 0
		sleep 1
	done
	fail "setup: n8n did not become ready at $N8N"
}

# The evaluation key map a credential stores, as JSON ({} when empty)
stored_keys() {
	compose exec -T n8n n8n export:credentials --id="$1" --decrypted 2>/dev/null |
		sed -n '/^\[/,$p' | jq -c '.[0].data.evalKeys // "" | if . == "" then {} else fromjson end'
}

stored_key_id() {
	stored_keys "$1" | jq -r --arg path "${2:-$KEY_PATH}" '.[$path].id // empty'
}

# The editor's field list request (main process); prints the answer
load_fields() {
	curl -s -b "$WORK/cookies" -X POST "$N8N/rest/dynamic-node-parameters/resource-mapper-fields" \
		-H 'Content-Type: application/json' \
		-d "$(jq -nc --arg project "$ENVIRONMENT::$APPLICATION" --arg blueprint "$BLUEPRINT_ID" --arg credential "$1" \
			'{nodeTypeAndVersion: {name: "CUSTOM.leapter", version: 1}, path: "parameters",
				methodName: "getOperationFields",
				currentNodeParameters: {project: {__rl: true, mode: "list", value: $project}, operation: $blueprint,
					inputMode: "visual", parameters: {mappingMode: "defineBelow", value: null}},
				credentials: {leapterApi: {id: $credential, name: $credential}}}')"
}

# A run through the workflow's webhook: the main process queues it, the worker executes it.
# Prints the Leapter node's output.
run_webhook() {
	curl -s --max-time 150 "$N8N/webhook/$1"
}

# Workflow <id> <webhook path> <credential> <application> <blueprint> <input>
workflow() {
	jq -n --arg id "$1" --arg path "$2" --arg credential "$3" --arg project "$ENVIRONMENT::$4" \
		--arg blueprint "$5" --arg input "$6" --arg version "$(uuidgen | tr 'A-Z' 'a-z')" --arg hook "$(uuidgen | tr 'A-Z' 'a-z')" \
		'{id: $id, name: $id, active: false, versionId: $version, settings: {executionOrder: "v1"},
			nodes: [
				{id: "q-webhook", name: "Webhook", type: "n8n-nodes-base.webhook", typeVersion: 2,
					position: [0, 0], webhookId: $hook,
					parameters: {httpMethod: "GET", path: $path, responseMode: "lastNode", options: {}}},
				{id: "q-leapter", name: "Leapter", type: "CUSTOM.leapter", typeVersion: 1, position: [300, 0],
					parameters: {project: {__rl: true, mode: "list", value: $project}, operation: $blueprint,
						inputMode: "json", parametersJson: $input},
					credentials: {leapterApi: {id: $credential, name: $credential}}}],
			connections: {Webhook: {main: [[{node: "Leapter", type: "main", index: 0}]]}}}'
}

# Runs the worker finished so far
worker_runs() {
	compose logs worker 2>/dev/null | grep -c 'Worker finished execution' || true
}

# --- Setup ---------------------------------------------------------------------------------

echo "n8n ${N8N_VERSION:-2.44.5} in queue mode, cluster $CLUSTER_URL, project $KEY_PATH${FRESH_APPLICATION:+, fresh project $FRESH_APPLICATION}"
pnpm --dir "$ROOT" build >/dev/null || fail 'setup: pnpm build failed'
compose down -v >/dev/null 2>&1 || true
compose up -d >/dev/null 2>&1 || fail 'setup: docker compose up failed'
wait_for_n8n

# Credentials with the same cluster and service key share their key state (keyState()), so Q5's
# credential gets a service key of its own: a first use that has nothing to share
answer=$(curl -sf -X POST "$CP/service-accounts/service:env:$ENVIRONMENT:n8n/keys" -H "Authorization: Bearer $ADMIN_KEY" \
	-H 'Content-Type: application/json' -d '{"reason": "n8n node queue e2e: Q5"}') || fail 'setup: creating a second service key failed'
SECOND_KEY=$(jq -r '.key' <<<"$answer")
SECOND_KEY_ID=$(jq -r '.credential.id' <<<"$answer")
jq -n --arg url "$CLUSTER_URL" --arg key "$SERVICE_KEY" --arg second "$SECOND_KEY" '[$ARGS.positional[] |
	{id: ., name: ., type: "leapterApi",
		data: {serviceKey: (if . == "leapterQueueCred3" then $second else $key end), showAdvanced: true, clusterUrl: $url}}]' \
	--args "${CREDENTIALS[@]}" >"$WORK/credentials.json"
{
	workflow leapterQueueFlow1 leapter-q1 leapterQueueCred1 "$APPLICATION" "$BLUEPRINT_ID" "$INPUT_JSON"
	workflow leapterQueueFlow2 leapter-q2 leapterQueueCred2 "$APPLICATION" "$BLUEPRINT_ID" "$INPUT_JSON"
	workflow leapterQueueFlow3 leapter-q3 leapterQueueCred3 "$APPLICATION" "$BLUEPRINT_ID" "$INPUT_JSON"
	if [[ -n ${FRESH_APPLICATION:-} ]]; then
		workflow leapterQueueFlow4 leapter-q4 leapterQueueCred1 "$FRESH_APPLICATION" "$FRESH_BLUEPRINT_ID" '{}'
	fi
} | jq -s '.' >"$WORK/workflows.json"
compose exec -T n8n sh -c 'cat > /tmp/credentials.json && n8n import:credentials --input=/tmp/credentials.json' \
	<"$WORK/credentials.json" >/dev/null 2>&1 || fail 'setup: n8n import:credentials failed'
compose exec -T n8n sh -c 'cat > /tmp/workflows.json && n8n import:workflow --input=/tmp/workflows.json' \
	<"$WORK/workflows.json" >/dev/null 2>&1 || fail 'setup: n8n import:workflow failed'
for id in $(jq -r '.[].id' "$WORK/workflows.json"); do
	compose exec -T n8n n8n publish:workflow --id="$id" >/dev/null 2>&1 ||
		compose exec -T n8n n8n update:workflow --id="$id" --active=true >/dev/null 2>&1 ||
		fail "setup: could not activate $id"
done
# Active workflows register their webhooks on start
compose restart n8n >/dev/null 2>&1
wait_for_n8n
if ! curl -sf -c "$WORK/cookies" -X POST "$N8N/rest/login" -H 'Content-Type: application/json' \
	-d "$OWNER_LOGIN" >/dev/null; then
	# Before n8n 2.x took the owner from the environment (N8N_INSTANCE_OWNER_*), set it up once
	curl -sf -X POST "$N8N/rest/owner/setup" -H 'Content-Type: application/json' \
		-d '{"email": "e2e@leapter.test", "firstName": "E2E", "lastName": "Owner", "password": "e2e-Owner-Pass-1"}' \
		>/dev/null || fail 'setup: owner login failed'
	curl -sf -c "$WORK/cookies" -X POST "$N8N/rest/login" -H 'Content-Type: application/json' \
		-d "$OWNER_LOGIN" >/dev/null || fail 'setup: owner login failed'
fi

# --- Q1 first run on the worker --------------------------------------------------------------

before=$(worker_runs)
started=$SECONDS
output=$(run_webhook leapter-q1)
key1=$(stored_key_id leapterQueueCred1)
if jq -e '.outputData' <<<"$output" >/dev/null && [[ -n $key1 ]] && (($(worker_runs) > before)) &&
	[[ $(active_keys "$APPLICATION") == "[\"$key1\"]" ]]; then
	pass "Q1 first run on the worker ($((SECONDS - started)) s): $output; one key, $key1"
else
	fail "Q1 first run on the worker: output $output; stored $key1; active $(active_keys "$APPLICATION"); worker runs $before -> $(worker_runs)"
fi

# --- Q2 the editor reuses the worker's key ---------------------------------------------------

started=$SECONDS
fields=$(load_fields leapterQueueCred1)
if jq -e '.data.fields | length > 0' <<<"$fields" >/dev/null && [[ $(stored_key_id leapterQueueCred1) == "$key1" ]] &&
	[[ $(active_keys "$APPLICATION") == "[\"$key1\"]" ]]; then
	pass "Q2 editor after the worker ($((SECONDS - started)) s): $(jq -c '.data.fields | map(.id)' <<<"$fields"); same key, no new one"
else
	fail "Q2 editor after the worker: $fields; stored $(stored_key_id leapterQueueCred1); active $(active_keys "$APPLICATION")"
fi

# --- Q3 a run reuses the editor's key --------------------------------------------------------

started=$SECONDS
fields=$(load_fields leapterQueueCred2)
key2=$(stored_key_id leapterQueueCred2)
output=$(run_webhook leapter-q2)
if jq -e '.data.fields | length > 0' <<<"$fields" >/dev/null && jq -e '.outputData' <<<"$output" >/dev/null &&
	[[ -n $key2 && $(stored_key_id leapterQueueCred2) == "$key2" ]] &&
	[[ $(active_keys "$APPLICATION" | jq 'length') == 2 ]]; then
	pass "Q3 run after the editor ($((SECONDS - started)) s): $output; the editor's key $key2 reused"
else
	fail "Q3 run after the editor: fields $fields; output $output; stored $key2 -> $(stored_key_id leapterQueueCred2); active $(active_keys "$APPLICATION")"
fi

# --- Q4 a revoked key: the worker replaces it, the editor takes the replacement --------------

revoke "$APPLICATION" "$key1" 'n8n node queue e2e: Q4' || fail "Q4: revoking $key1 failed"
echo "Q4: revoked $key1, waiting 95 s"
sleep 95
started=$SECONDS
output=$(run_webhook leapter-q1)
replaced=$(stored_key_id leapterQueueCred1)
fields=$(load_fields leapterQueueCred1)
if jq -e '.outputData' <<<"$output" >/dev/null && [[ -n $replaced && $replaced != "$key1" ]] &&
	jq -e '.data.fields | length > 0' <<<"$fields" >/dev/null &&
	[[ $(stored_key_id leapterQueueCred1) == "$replaced" ]] &&
	[[ $(active_keys "$APPLICATION" | jq --arg r "$replaced" --arg k "$key2" 'sort == ([$r, $k] | sort)') == true ]]; then
	pass "Q4 revoked key ($((SECONDS - started)) s): run $output; key $key1 -> $replaced; the editor kept it"
else
	fail "Q4 revoked key: output $output; stored $replaced -> $(stored_key_id leapterQueueCred1); fields $fields; active $(active_keys "$APPLICATION")"
fi

# --- Q5 first use on main and worker at the same moment ---------------------------------------

before=$(active_keys "$APPLICATION")
started=$SECONDS
load_fields leapterQueueCred3 >"$WORK/q5-fields.json" &
fields_pid=$!
output=$(run_webhook leapter-q3)
wait "$fields_pid"
stored3=$(stored_key_id leapterQueueCred3)
created=$(jq -c --argjson before "$before" '. - $before' <<<"$(active_keys "$APPLICATION")")
if jq -e '.outputData' <<<"$output" >/dev/null && jq -e '.data.fields | length > 0' "$WORK/q5-fields.json" >/dev/null && [[ -n $stored3 ]]; then
	if [[ $(jq 'length' <<<"$created") == 1 ]]; then
		pass "Q5 same moment ($((SECONDS - started)) s): both succeeded, one key ($stored3)"
	elif [[ $(jq 'length' <<<"$created") -gt 1 ]]; then
		pass "Q5 same moment ($((SECONDS - started)) s): both succeeded; $(jq 'length' <<<"$created") keys created ($created), the credential stores $stored3 (the others stay active until revoked)"
	else
		fail "Q5 same moment: no new key, the credential stores $stored3"
	fi
else
	fail "Q5 same moment: output $output; fields $(cat "$WORK/q5-fields.json"); stored $stored3; created $created"
fi

# --- Q6 a project that never had a key, first used on the worker ------------------------------

if [[ -n ${FRESH_APPLICATION:-} ]]; then
	started=$SECONDS
	output=$(run_webhook leapter-q4)
	fresh=$(stored_key_id leapterQueueCred1 "$ENVIRONMENT/$FRESH_APPLICATION")
	if jq -e '.outputData' <<<"$output" >/dev/null && [[ -n $fresh ]]; then
		pass "Q6 never-keyed project on the worker ($((SECONDS - started)) s): $output; key $fresh"
	else
		fail "Q6 never-keyed project on the worker: output $output; stored $(stored_keys leapterQueueCred1)"
	fi
fi

echo 'All checks passed.'

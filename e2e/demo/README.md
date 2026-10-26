# Demo video

`node e2e/demo/record.mjs` records `e2e/demo/recordings/n8n-node-demo.webm` (gitignored): a captioned
take, 1280×720 and 60–120 s, of the Leapter node in n8n 2.44.5 triaging an insurance claim
against the local Runtime Cluster. Record it again for a release whenever the node's screens change.

`node e2e/demo/record.mjs --help` lists its inputs. Required: `ADMIN_KEY` (a key of an administrator
of the local cluster), `LAB_ACCOUNT` and `LAB_PROJECT_ID` (the Lab workspace and the project to
deploy, with a public blueprint taking the claim below), `LAB_EMAIL` and `LAB_PASSWORD` (who signs
in to the Lab and the Admin UI).

## Needs

The local Lab on `http://localhost:3000`, the local Runtime Cluster, Docker, `jq`, and Playwright's
Chromium and ffmpeg (`npx playwright install chromium ffmpeg`).

## What the script does

**Setup** (not recorded):

1. Signs in to the Lab as `LAB_EMAIL`, opens `LAB_PROJECT_ID` (an "Insurance Claim Triage"
   project, deployed as `insurance-claim-triage`), creates a release (or continues with the release
   of the current version) and deploys it to `dev` on the cluster "local". Stops when the release
   has no public blueprint.
2. Waits until the cluster lists the blueprint as callable, gets an `n8n` service key with
   `e2e/prepare-local.sh` and starts a fresh n8n with `e2e/docker-compose.yml` and this branch's
   build.

**The take**, one caption per step, each shown at least 3 s:

| # | Caption | On screen |
|---|---------|-----------|
| 1 | Install the Leapter node in n8n | The nodes panel finds the installed Leapter node |
| 2 | Add your Runtime Cluster and the n8n service key | New credential "Leapter API": the key pasted; Advanced Settings opened, showing the default Leapter Server `https://runtime.leapter.com`, which the local take replaces with the local cluster; Save, then the test ("Retry" in n8n's result banner) answers "Connection tested successfully" |
| 3 | Pick project and blueprint | Manual Trigger → Leapter; project `insurance-claim-triage` (no environment choice: the key reaches one) and "Insurance Claim Triage"; the yellow note "On first use, Leapter activates access to this project…" and n8n's "Fetching parameters" while the node waits for the project's new key (created when the project was chosen), then the input fields, with no click; the note disappears. Only if the key is not active after the node's 6 retries does the list show "No input fields to show. Retry" with the activation notice (the script then clicks Retry) |
| 4 | Enter a claim | The claim below is entered |
| 5 | Run it | Execute workflow |
| 6 | The decision comes back with its trace id | The output (JSON): `outputData.decision` and `_metadata.runId` |
| 7 | Every run is recorded in the Runtime Cluster | Admin UI (signed in as `LAB_EMAIL`) → Runs, searched by the n8n execution ID, opened: the run with the same id |

The claim is the first case of the project's test suite "Triage Verification Suite", "Basic
policy within limit" (expects `approve`):

| Field | Value |
|-------|-------|
| `claimAmount` | 850 |
| `policyType` | basic |
| `incidentDate` | 2026-05-01 |
| `filingDate` | 2026-05-10 |

**After the take:** trims the video to start at step 1 with Playwright's ffmpeg
(`-ss <sec> -i in.webm -c:v libvpx -b:v 3M -crf 10 out.webm`), writes the caption marks to
`recordings/marks.json`, then checks the video: it plays it in headless Chromium and saves one frame per
caption as `recordings/caption-<n>.png` when `currentTime` passes each mark (1.2 s before the next caption, so
the frame shows what the step achieved), plus `recordings/fields-loading.png` while n8n loads the fields in
step 3 (and `recordings/demo-activation-notice.png` if the fallback notice appeared), and fails unless the length is
60–120 s and the seven captions come in order, each for at least 2.5 s. `--verify` repeats only
this check.

`marks.json` also records `fieldsWait`: the seconds between choosing the blueprint and the fields appearing.

**Cleanup:** revokes the evaluation key the credential created and the service key, and removes
n8n (`--keep` skips this).

## Other fixtures

`--deploy-only` releases and deploys another Lab project the same way, for example a project with
a blueprint without inputs, which shows the node's "This blueprint takes no inputs" notice:

```bash
LAB_PROJECT_ID=<project id> APPLICATION=<its application slug> node e2e/demo/record.mjs --deploy-only
```

// Records the captioned demo video of the Leapter n8n node. See e2e/demo/README.md.
//
//   node e2e/demo/record.mjs            setup, record, trim, check frames, clean up
//   node e2e/demo/record.mjs --verify   only check the frames of an existing video
//   node e2e/demo/record.mjs --help
import { chromium } from 'playwright';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '../..');
const env = (name, fallback) => process.env[name] || fallback;

const LAB_URL = env('LAB_URL', 'http://localhost:3000');
// The Lab workspace and project to release and deploy, and who signs in: no defaults
const LAB_ACCOUNT = env('LAB_ACCOUNT');
const LAB_PROJECT_ID = env('LAB_PROJECT_ID');
const LAB_EMAIL = env('LAB_EMAIL');
const CLUSTER_NAME = env('CLUSTER_NAME', 'local');
const CLUSTER_URL = env('CLUSTER_URL', 'http://localhost:3002');
const ENVIRONMENT = env('ENVIRONMENT', 'dev');
const APPLICATION = env('APPLICATION', 'insurance-claim-triage');
const N8N_PORT = env('E2E_N8N_PORT', '5691');
const OUT = env('DEMO_OUT', join(HERE, 'recordings'));

const N8N = `http://localhost:${N8N_PORT}`;
const DEFAULT_CLUSTER_URL = 'https://runtime.leapter.com';
const ADMIN_UI = `${CLUSTER_URL}/runtime-management/ui/`;
const N8N_OWNER = { emailOrLdapLoginId: 'e2e@leapter.test', password: 'e2e-Owner-Pass-1' };
const VIEWPORT = { width: 1280, height: 720 };
const VIDEO = join(OUT, 'n8n-node-demo.webm');
const MARKS = join(OUT, 'marks.json');

// The first case of the project's test suite "Triage Verification Suite" ("Basic policy within
// limit", expects approve). Kept here because the suite is read in the Lab, not over an API.
const DEMO_INPUT = {
	claimAmount: '850',
	policyType: 'basic',
	incidentDate: '2026-05-01',
	filingDate: '2026-05-10',
};

const CAPTIONS = [
	'Install the Leapter node in n8n',
	'Add your Runtime Cluster and the n8n service key',
	'Pick project and blueprint',
	'Enter a claim',
	'Run it',
	'The decision comes back with its trace id',
	'Every run is recorded in the Runtime Cluster',
];
const MIN_CAPTION_MS = 3000;
const MIN_LENGTH_S = 62;
const MAX_LENGTH_S = 120;

function usage() {
	console.log(`Usage: node e2e/demo/record.mjs [--verify] [--keep]

Records e2e/demo/recordings/n8n-node-demo.webm: the Leapter node in n8n 2.44.5 triaging an insurance
claim against the local Runtime Cluster, with seven English captions, 1280x720, 60-120 s.

Needs the local Lab, the local Runtime Cluster, Docker and jq.

Inputs (environment variables):
  ADMIN_KEY        required: a key of an administrator of the local cluster
  LAB_ACCOUNT      required: the Lab workspace (slug) of the project
  LAB_PROJECT_ID   required: the Lab project to release and deploy, with a public blueprint
  LAB_EMAIL        required: who signs in to the Lab and the Admin UI
  LAB_PASSWORD     required: their password
  LAB_URL          default http://localhost:3000
  CLUSTER_NAME     the cluster's name in the Lab's deploy dialog, default local
  CLUSTER_URL      default http://localhost:3002
  ENVIRONMENT      default dev
  APPLICATION      the project's application slug, default insurance-claim-triage
  E2E_N8N_PORT     default 5691
  DEMO_OUT         output directory, default e2e/demo/recordings

Flags:
  --verify   only check an existing video: length, and one still per caption
  --deploy-only  only release LAB_PROJECT_ID and deploy it as APPLICATION (e.g. another fixture)
  --keep     keep n8n running and the keys unrevoked`);
}

const log = (message) => console.log(`[demo] ${message}`);
const T = (id) => `[data-test="${id}"], [data-testid="${id}"]`;
const N = (id) => `[data-test-id="${id}"]`;
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

// A required input; fails with what is missing
function required(name) {
	const value = process.env[name];
	if (!value) throw new Error(`${name} is not set; see node e2e/demo/record.mjs --help.`);
	return value;
}

const labPassword = () => required('LAB_PASSWORD');

async function controlPlane(path, key, init = {}) {
	const answer = await fetch(`${CLUSTER_URL}/runtime-management${path}`, {
		...init,
		headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
	});
	if (!answer.ok) throw new Error(`${init.method ?? 'GET'} ${path} answered ${answer.status}`);
	return answer.json();
}

// --- Setup: release and deploy in the Lab ---------------------------------------------------

async function releaseAndDeploy(browser) {
	const context = await browser.newContext({ viewport: VIEWPORT });
	const page = await context.newPage();
	await page.goto(`${LAB_URL}/auth/sign-in`);
	await page.locator(T('email-input')).fill(LAB_EMAIL);
	await page.locator(T('password-input')).fill(labPassword());
	await page.locator(T('password-input')).press('Enter');
	await page.waitForURL(/\/(home|projects)/, { timeout: 30_000 });

	await page.goto(`${LAB_URL}/home/${LAB_ACCOUNT}/projects/${LAB_PROJECT_ID}`);
	await page.locator(T('release-toolbar-action')).click();
	const dialog = page.locator(T('create-release-dialog'));
	await dialog.waitFor();
	log(`Lab: ${(await dialog.locator(T('create-release-source')).innerText()).trim()}`);
	// "Create release" for new content, "Continue" when this version is already released
	await dialog.locator(T('create-release-submit')).click();

	const callable = (await dialog.locator(T('create-release-outcome-callable')).innerText({ timeout: 60_000 })).trim();
	if (!callable.startsWith('Callable on the cluster:')) {
		throw new Error(`The release has no public blueprint: "${callable}" Make the blueprint public in the Lab.`);
	}
	log(`Lab: ${callable}`);

	await dialog.locator(T('cluster-connect-select')).selectOption({ label: CLUSTER_NAME });
	const environments = dialog.locator(T('deploy-environment-select'));
	if (!(await environments.isVisible())) {
		// "Sign in and deploy" opens the cluster's sign-in in a popup; the Lab session completes it
		const [popup] = await Promise.all([
			context.waitForEvent('page', { timeout: 15_000 }).catch(() => null),
			dialog.locator(T('deploy-submit')).click(),
		]);
		if (popup && !popup.isClosed() && (await popup.locator(T('email-input')).count())) {
			await popup.locator(T('email-input')).fill(LAB_EMAIL);
			await popup.locator(T('password-input')).fill(labPassword());
			await popup.locator(T('password-input')).press('Enter');
		}
		await environments.waitFor({ timeout: 60_000 });
	}
	const option = await environments.evaluate(
		(select, slug) => [...select.options].find((entry) => entry.text.startsWith(`${slug} `))?.value,
		ENVIRONMENT,
	);
	if (!option) throw new Error(`The cluster ${CLUSTER_NAME} offers no environment ${ENVIRONMENT}.`);
	await environments.selectOption(option);
	await dialog.locator(T('deploy-submit')).click();
	const result = dialog.locator(`${T('deploy-outcome')}, ${T('deploy-problem')}`).first();
	await result.waitFor({ timeout: 180_000 });
	const outcome = (await result.innerText()).trim().replace(/\s+/g, ' ');
	if (await dialog.locator(T('deploy-problem')).count()) throw new Error(`Deploy failed: ${outcome}`);
	log(`Lab: ${outcome}`);

	const state = await context.storageState();
	await context.close();
	return state;
}

async function waitUntilCallable(adminKey) {
	for (let attempt = 0; attempt < 60; attempt++) {
		const status = await controlPlane(`/environments/${ENVIRONMENT}/status`, adminKey);
		const app = status.environments[0].applications.find((entry) => entry.slug === APPLICATION);
		if (app?.callable?.length) return app.callable;
		await sleep(5_000);
	}
	throw new Error(`${ENVIRONMENT}/${APPLICATION} has no callable blueprint after 5 minutes.`);
}

// --- Setup: service key and n8n -------------------------------------------------------------

function prepareServiceKey() {
	const exports = execFileSync('bash', [join(ROOT, 'e2e/prepare-local.sh')], {
		env: { ...process.env, APPLICATION },
		encoding: 'utf8',
		stdio: ['ignore', 'pipe', 'inherit'],
	});
	const value = (name) => exports.match(new RegExp(`^export ${name}=(.*)$`, 'm'))?.[1];
	const id = exports.match(/Service key id \(revoke it when done\): (\S+)/)?.[1];
	return { key: value('SERVICE_KEY'), id };
}

async function relayPorts() {
	const local = (url) => url.match(/^http:\/\/(?:localhost|127\.0\.0\.1)(?::(\d+))?(?:\/|$)/)?.[1] ?? null;
	if (local(CLUSTER_URL) === null) return '';
	const config = await (await fetch(`${CLUSTER_URL}/runtime-management/ui/config.json`)).json();
	return [local(CLUSTER_URL), local(config.runBaseUrl ?? CLUSTER_URL)].filter(Boolean).join(' ');
}

function compose(args, extraEnv = {}) {
	execFileSync('docker', ['compose', '-f', join(ROOT, 'e2e/docker-compose.yml'), ...args], {
		env: { ...process.env, N8N_PORT, ...extraEnv },
		stdio: ['ignore', 'ignore', 'pipe'],
	});
}

async function startN8n() {
	execFileSync('pnpm', ['--dir', ROOT, 'build'], { stdio: 'ignore' });
	compose(['down', '-v']);
	compose(['up', '-d'], { RELAY_PORTS: await relayPorts() });
	for (let attempt = 0; attempt < 120; attempt++) {
		if ((await fetch(`${N8N}/healthz/readiness`).catch(() => null))?.ok) return;
		await sleep(1_000);
	}
	throw new Error(`n8n did not become ready at ${N8N}`);
}

// --- The recorded take ----------------------------------------------------------------------

async function setCaption(page, text) {
	await page
		.evaluate((caption) => {
			let box = document.getElementById('leapter-demo-caption');
			if (!box) {
				box = document.createElement('div');
				box.id = 'leapter-demo-caption';
				Object.assign(box.style, {
					position: 'fixed', left: '50%', bottom: '28px', transform: 'translateX(-50%)',
					zIndex: '2147483647', pointerEvents: 'none', padding: '12px 28px', borderRadius: '10px',
					background: 'rgba(17, 17, 17, 0.86)', color: '#fff',
					font: '600 26px/1.3 -apple-system, "Segoe UI", Helvetica, Arial, sans-serif',
					boxShadow: '0 6px 24px rgba(0, 0, 0, 0.35)', whiteSpace: 'nowrap',
				});
				document.body.appendChild(box);
			}
			box.textContent = caption;
		}, text)
		.catch(() => {});
}

async function record(browser, labState, serviceKey) {
	rmSync(join(OUT, 'raw'), { recursive: true, force: true });
	const context = await browser.newContext({
		viewport: VIEWPORT,
		storageState: labState,
		recordVideo: { dir: join(OUT, 'raw'), size: VIEWPORT },
	});
	const page = await context.newPage();
	const videoStart = Date.now();
	const marks = [];
	const extras = [];
	let fieldsWait = null;
	let caption = '';
	page.on('load', () => void setCaption(page, caption));

	const step = async (index, action) => {
		caption = CAPTIONS[index];
		marks.push({ caption, at: (Date.now() - videoStart) / 1000 });
		await setCaption(page, caption);
		log(`step ${index + 1}: ${caption}`);
		const started = Date.now();
		await action().catch(async (error) => {
			await page.screenshot({ path: join(OUT, 'failure.png') }).catch(() => {});
			throw error;
		});
		await sleep(Math.max(0, started + MIN_CAPTION_MS - Date.now()));
	};

	// Before step 1 (trimmed away): sign in to n8n and open a new workflow
	await page.goto(`${N8N}/signin`);
	await page.locator(N('emailOrLdapLoginId')).locator('input').fill(N8N_OWNER.emailOrLdapLoginId);
	await page.locator(N('password')).locator('input').fill(N8N_OWNER.password);
	await page.locator(N('form-submit-button')).click();
	await page.waitForURL(/\/home\//);
	await page.goto(`${N8N}/workflow/new`);
	await page.locator(N('canvas-add-button')).waitFor();
	await sleep(1_000);

	await step(0, async () => {
		await page.locator(N('canvas-add-button')).click();
		await page.keyboard.type('Leapter', { delay: 120 });
		const item = page.locator(N('node-creator-item-name')).filter({ hasText: /^Leapter$/ });
		await item.waitFor();
		await item.hover();
		await sleep(2_500);
		await page.keyboard.press('Escape');
	});

	await step(1, async () => {
		await page.locator(N('universal-add')).click();
		await page.getByRole('menuitem', { name: 'New credential' }).click();
		await page.keyboard.type('Leapter', { delay: 90 });
		await page.getByRole('option', { name: 'Leapter API' }).click();
		await page.locator(N('new-credential-type-button')).click();
		// Pasted, as a user would
		await page.locator(N('parameter-input-serviceKey')).locator('input').fill(serviceKey);
		await sleep(800);
		// Advanced Settings shows the default server; a local cluster has to replace it
		await page.locator(N('parameter-input-showAdvanced')).locator('.el-switch, [role="switch"]').first().click();
		const clusterUrl = page.locator(N('parameter-input-clusterUrl')).locator('input');
		await clusterUrl.waitFor();
		await sleep(1_800);
		if (CLUSTER_URL !== DEFAULT_CLUSTER_URL) {
			await clusterUrl.fill('');
			await clusterUrl.pressSequentially(CLUSTER_URL, { delay: 70 });
		}
		await page.keyboard.press('Tab');
		await sleep(700);
		await page.locator(N('credential-save-button')).click();
		const success = page.getByText('Connection tested successfully');
		await success.waitFor({ timeout: 30_000 });
		await sleep(1_200);
		// n8n tests on save; "Retry" in the result banner is its test-credential button
		await page.getByRole('button', { name: 'Retry' }).click();
		await success.waitFor({ timeout: 30_000 });
		await sleep(2_000);
		const close = page.locator(`${N('dialog-close-button')}:visible`).last();
		if (await close.count()) await close.click();
		else await page.keyboard.press('Escape');
		await page.locator(N('editCredential-modal')).waitFor({ state: 'hidden' });
	});

	const ndv = page.locator(N('ndv'));
	const mapper = page.locator(N('resource-mapper-container'));
	await step(2, async () => {
		// Creating the credential from the overview's "+" leaves the workflow editor
		if (!(await page.locator(N('canvas-add-button')).isVisible())) {
			await page.goto(`${N8N}/workflow/new`);
			await page.locator(N('canvas-add-button')).waitFor();
			await sleep(800);
		}
		await page.locator(N('canvas-add-button')).click();
		await page.keyboard.type('manual', { delay: 90 });
		await sleep(500);
		await page.keyboard.press('Enter');
		await page.locator(N('canvas-handle-plus')).first().click();
		await page.keyboard.type('Leapter', { delay: 90 });
		await sleep(500);
		await page.keyboard.press('Enter');
		await ndv.waitFor();
		await sleep(1_000);
		const pick = async (parameter, name) => {
			// Project is a resource locator (its list opens on a click), Blueprint a dropdown
			const locator = page.locator(N(`resource-locator-${parameter}`));
			const rl = (await locator.count()) > 0;
			await (rl ? locator.locator(N('rlc-input')) : page.locator(N(`parameter-input-${parameter}`))).click();
			const option = page
				.locator(rl ? `${N('rlc-item')}:visible` : '.el-select-dropdown__item:visible')
				.filter({ hasText: name })
				.first();
			await option.waitFor({ timeout: 30_000 });
			await sleep(700);
			await option.click();
			await sleep(800);
		};
		// One environment: the project is listed by its slug; several: "environment · slug"
		await pick('project', APPLICATION);
		await pick('operation', /./);
		// The node waits for a new project key itself (up to 6 retries, 10 s apart): n8n shows
		// its loading state, then the fields. Its notice with Retry is only the fallback.
		const picked = Date.now();
		const firstField = mapper.locator(N(`parameter-input-body.${Object.keys(DEMO_INPUT)[0]}`));
		const notice = page.locator(N('empty-fields-notice'));
		const activationBox = ndv.getByText('On first use, Leapter activates access to this project');
		if (await mapper.getByText(/Fetching/).first().isVisible().catch(() => false)) {
			extras.push({ name: 'fields-loading', at: (Date.now() - videoStart) / 1000 + 0.5 });
			log(`loading: activation note ${(await activationBox.isVisible()) ? 'shown' : 'NOT shown'}`);
		}
		await Promise.race([
			firstField.waitFor({ timeout: 90_000 }),
			notice.waitFor({ timeout: 90_000 }),
		]);
		if (!(await firstField.isVisible()) && (await notice.isVisible())) {
			extras.push({ name: 'demo-activation-notice', at: (Date.now() - videoStart) / 1000 });
			log(`notice (fallback): ${(await notice.innerText()).trim()}`);
			while (!(await firstField.isVisible())) {
				if (Date.now() - picked > 180_000) throw new Error('The blueprint fields did not load.');
				await sleep(4_000);
				await mapper.getByText('Retry', { exact: true }).first().click();
				await sleep(1_500);
			}
		}
		fieldsWait = Math.round((Date.now() - picked) / 1000);
		log(`the editor waited ${fieldsWait} s for the fields`);
		await sleep(500);
		log(`loaded: activation note ${(await activationBox.isVisible()) ? 'STILL shown' : 'hidden'}`);
		await sleep(1_500);
	});

	await step(3, async () => {
		for (const [name, value] of Object.entries(DEMO_INPUT)) {
			const field = mapper.locator(N(`parameter-input-body.${name}`));
			const input = field.locator('input').first();
			if ((await input.getAttribute('placeholder')) === 'Select') {
				await field.click();
				await sleep(500);
				await page.locator('.el-select-dropdown__item:visible').filter({ hasText: new RegExp(`^${value}$`) }).click();
			} else {
				await input.click();
				await input.pressSequentially(value, { delay: 90 });
			}
			await sleep(400);
		}
		await page.keyboard.press('Tab');
		await sleep(1_000);
	});

	await step(4, async () => {
		await page.locator(N('ndv-close-button')).click();
		await sleep(800);
		await page.locator(N('execute-workflow-button')).click();
		await page.getByText(/Workflow executed successfully/i).waitFor({ timeout: 150_000 });
		await sleep(1_000);
	});

	let runId = '';
	await step(5, async () => {
		await page.locator(N('canvas-node')).filter({ hasText: 'Leapter' }).dblclick();
		const output = page.locator(N('output-panel'));
		await output.getByText('runId').first().waitFor({ timeout: 30_000 });
		await output.locator(N('radio-button-json')).click();
		await sleep(800);
		runId = (await output.innerText()).match(/runId"?\s*:\s*"?([0-9a-f-]{36})/)?.[1] ?? '';
		if (!runId) throw new Error('The output shows no _metadata.runId.');
		await output.getByText(runId).first().hover().catch(() => {});
		await sleep(4_500);
	});

	await step(6, async () => {
		// The n8n execution ID is the run's correlation ID; the editor's own fetch sends browser-id
		const executionId = await page.evaluate(async () => {
			const answer = await fetch('/rest/executions?limit=1', {
				headers: { 'browser-id': localStorage.getItem('n8n-browserId') ?? '' },
			});
			const body = await answer.json().catch(() => ({}));
			const list = body.data?.results ?? body.data ?? [];
			return list[0]?.id ? String(list[0].id) : '';
		});
		await page.goto(ADMIN_UI);
		const signIn = page.getByRole('button', { name: /Sign in with Leapter/i });
		await Promise.race([signIn.waitFor(), page.waitForURL(/\/status\//)]);
		if (await signIn.isVisible()) await signIn.click();
		await page.waitForURL(/\/status\//);
		await sleep(1_000);
		await page.getByRole('link', { name: 'Runs' }).click();
		const search = page.getByPlaceholder('Search correlation IDs…');
		await search.waitFor();
		if (executionId) await search.pressSequentially(executionId, { delay: 150 });
		else log('n8n execution ID not readable; opening the run from the list');
		const link = page.locator(`a[href*="${runId}"]`);
		for (let attempt = 0; !(await link.count()); attempt++) {
			if (attempt > 20) throw new Error(`Run ${runId} did not appear in Runs.`);
			await sleep(2_000);
			await page.getByRole('button', { name: 'Refresh runs' }).click();
		}
		await sleep(1_500);
		await link.first().click();
		await page.getByText(runId).first().waitFor();
		await sleep(2_000);
		// Long enough for the minimum length, short of the maximum
		const length = (Date.now() - videoStart) / 1000 - marks[0].at;
		await sleep(Math.max(3_000, (MIN_LENGTH_S - length) * 1000));
	});

	const video = page.video();
	await context.close();
	const raw = await video.path();
	return { raw, marks, extras, runId, fieldsWait };
}

// --- Trim and check -------------------------------------------------------------------------

function playwrightFfmpeg() {
	const cache =
		process.env.PLAYWRIGHT_BROWSERS_PATH ||
		(process.platform === 'darwin'
			? join(homedir(), 'Library/Caches/ms-playwright')
			: join(homedir(), '.cache/ms-playwright'));
	const dir = readdirSync(cache).filter((name) => name.startsWith('ffmpeg-')).sort().pop();
	const binary = { darwin: 'ffmpeg-mac', linux: 'ffmpeg-linux', win32: 'ffmpeg-win64.exe' }[process.platform];
	if (!dir || !existsSync(join(cache, dir, binary))) {
		throw new Error('Playwright ffmpeg not found; run npx playwright install ffmpeg.');
	}
	return join(cache, dir, binary);
}

function trim(raw, marks, extras) {
	const start = Math.max(0, marks[0].at - 0.3);
	execFileSync(
		playwrightFfmpeg(),
		['-y', '-ss', start.toFixed(2), '-i', raw, '-c:v', 'libvpx', '-b:v', '3M', '-crf', '10', VIDEO],
		{ stdio: 'ignore' },
	);
	const shift = (entry) => ({ ...entry, at: Number((entry.at - start).toFixed(2)) });
	return { captions: marks.map(shift), extras: extras.map(shift) };
}

// Plays the video in headless Chromium and screenshots one frame per caption as currentTime
// passes its mark: 1.2 s before the next caption, so the frame shows what the step achieved
async function verify(browser) {
	const { captions: marks, extras = [] } = JSON.parse(readFileSync(MARKS, 'utf8'));
	const page = await browser.newPage({ viewport: VIEWPORT });
	const html = join(OUT, 'verify.html');
	writeFileSync(html, `<body style="margin:0;background:#000"><video id="v" muted src="${pathToFileURL(VIDEO)}" width="1280" height="720"></video></body>`);
	await page.goto(pathToFileURL(html).href);
	const duration = await page.evaluate(
		() => new Promise((done) => {
			const video = document.getElementById('v');
			if (video.readyState >= 1) done(video.duration);
			video.addEventListener('loadedmetadata', () => done(video.duration));
		}),
	);
	await page.evaluate(() => {
		const video = document.getElementById('v');
		video.playbackRate = 2;
		return video.play();
	});
	const stills = [];
	for (const [index, mark] of marks.entries()) {
		const at = (marks[index + 1]?.at ?? duration) - 1.2;
		await page.waitForFunction((time) => document.getElementById('v').currentTime >= time, at, {
			timeout: 120_000,
			polling: 50,
		});
		await page.evaluate(() => document.getElementById('v').pause());
		const still = join(OUT, `caption-${index + 1}.png`);
		await page.locator('#v').screenshot({ path: still });
		const shown = await page.evaluate(() => document.getElementById('v').currentTime);
		stills.push({ caption: mark.caption, mark: mark.at, frame: Number(shown.toFixed(2)), still });
		await page.evaluate(() => document.getElementById('v').play());
	}
	// Stills of moments within a caption, e.g. the activation notice
	for (const extra of extras) {
		await page.evaluate((time) => {
			const video = document.getElementById('v');
			video.pause();
			video.currentTime = time;
			return new Promise((done) => video.addEventListener('seeked', done, { once: true }));
		}, extra.at + 1.0);
		const still = join(OUT, `${extra.name}.png`);
		await page.locator('#v').screenshot({ path: still });
		stills.push({ caption: extra.name, mark: extra.at, frame: extra.at + 1.0, still, extra: true });
	}
	await page.close();
	rmSync(html);

	const ordered = marks.every((mark, index) => index === 0 || mark.at > marks[index - 1].at);
	const gaps = marks.map((mark, index) => (marks[index + 1]?.at ?? duration) - mark.at);
	console.log(`\nVideo: ${VIDEO}\nLength: ${duration.toFixed(1)} s`);
	for (const [index, entry] of stills.entries()) {
		console.log(
			entry.extra
				? `  +  ${entry.mark.toFixed(1)} s ${entry.caption} -> ${entry.still}`
				: `  ${index + 1}. ${entry.mark.toFixed(1)} s (${gaps[index].toFixed(1)} s) "${entry.caption}" -> ${entry.still}`,
		);
	}
	const problems = [];
	if (!(duration >= 60 && duration <= MAX_LENGTH_S)) problems.push(`length ${duration.toFixed(1)} s is outside 60-120 s`);
	if (!ordered || marks.length !== CAPTIONS.length) problems.push('captions are missing or out of order');
	if (gaps.some((gap) => gap < 2.5)) problems.push('a caption shows for less than 2.5 s');
	if (problems.length) throw new Error(`Video check failed: ${problems.join('; ')}`);
	console.log('Video check passed.');
}

// --- Main -----------------------------------------------------------------------------------

async function main() {
	const args = process.argv.slice(2);
	if (args.includes('--help') || args.includes('-h')) {
		usage();
		return;
	}
	mkdirSync(OUT, { recursive: true });
	const browser = await chromium.launch();
	try {
		if (args.includes('--verify')) {
			await verify(browser);
			return;
		}
		const adminKey = required('ADMIN_KEY');
		for (const name of ['LAB_ACCOUNT', 'LAB_PROJECT_ID', 'LAB_EMAIL', 'LAB_PASSWORD']) required(name);
		if (args.includes('--deploy-only')) {
			await releaseAndDeploy(browser);
			const callable = await waitUntilCallable(adminKey);
			log(`cluster: ${ENVIRONMENT}/${APPLICATION} calls ${callable.map((entry) => `${entry.name} (${entry.id})`).join(', ')}`);
			return;
		}
		let service;
		try {
			log('Lab: release and deploy');
			const labState = await releaseAndDeploy(browser);
			const callable = await waitUntilCallable(adminKey);
			log(`cluster: ${ENVIRONMENT}/${APPLICATION} calls ${callable.map((entry) => entry.name).join(', ')}`);
			service = prepareServiceKey();
			log('n8n: starting');
			await startN8n();
			const { raw, marks, extras, runId, fieldsWait } = await record(browser, labState, service.key);
			writeFileSync(MARKS, JSON.stringify({ ...trim(raw, marks, extras), fieldsWait }, null, 2));
			log(`fields appeared ${fieldsWait} s after the blueprint was picked, without a Retry click`);
			log(`recorded run ${runId}`);
			await verify(browser);
		} finally {
			if (!args.includes('--keep')) await cleanUp(adminKey, service);
		}
	} finally {
		await browser.close();
	}
}

// Revokes the evaluation keys the n8n credential created and the service key, removes n8n
async function cleanUp(adminKey, service) {
	try {
		// The REST API redacts evalKeys like every password field; the CLI exports them decrypted
		const exported = execFileSync(
			'docker',
			['compose', '-f', join(ROOT, 'e2e/docker-compose.yml'), 'exec', '-T', 'n8n', 'n8n', 'export:credentials', '--all', '--decrypted'],
			{ env: { ...process.env, N8N_PORT }, stdio: ['ignore', 'pipe', 'ignore'] },
		).toString();
		const credentials = JSON.parse(exported.slice(exported.indexOf('[')));
		for (const { type, data } of credentials) {
			if (type !== 'leapterApi') continue;
			const keys = data?.evalKeys ? JSON.parse(data.evalKeys) : {};
			for (const [project, entry] of Object.entries(keys)) {
				const [environment, application] = project.split('/');
				await controlPlane(
					`/environments/${environment}/applications/${application}/keys/${entry.id}/revoke`,
					service.key,
					{ method: 'POST', body: JSON.stringify({ reason: 'n8n node demo: cleanup' }) },
				);
				log(`cleanup: revoked evaluation key ${entry.id}`);
			}
		}
	} catch (error) {
		log(`cleanup: could not revoke the evaluation keys (${error.message}); revoke them in the Admin UI`);
	}
	if (service?.id) {
		await controlPlane(`/service-accounts/service:env:${ENVIRONMENT}:n8n/keys/${service.id}/revoke`, adminKey, {
			method: 'POST',
			body: JSON.stringify({ reason: 'n8n node demo: cleanup' }),
		}).then(
			() => log(`cleanup: revoked service key ${service.id}`),
			(error) => log(`cleanup: could not revoke service key ${service.id} (${error.message})`),
		);
	}
	compose(['down', '-v']);
	log('cleanup: n8n removed');
}

main().catch((error) => {
	console.error(`[demo] FAILED: ${error.message}`);
	process.exitCode = 1;
});

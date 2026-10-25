/**
 * The packaging contract, checked in one place.
 *
 * ci.yml and release.yml both run this instead of each carrying its own copy of the
 * assertions, so the two can never drift and a developer can run exactly what CI runs:
 *
 *   node tools/check-contract.mjs
 *
 * Six things are guarded, each one a mistake that has actually happened or that
 * cannot be undone once published:
 *
 *   1. `dsh.bundle.patch` points at a file that exists and parses.
 *   2. A declared browser half exports a bundle `dsh-client-modules` can read.
 *   3. That half really claims the sidebar entry (`sidebar.panellist`) AND the page it
 *      opens (`main`). A row with no page is a click that does nothing; a page with no
 *      row is unreachable. The ids must match, and grep is enough to refuse a build
 *      that lost either half before it reaches a profile.
 *   4. `dsh.client.inject` names the client bundle rows the entry is composed after
 *      (the layout owns `main`, the sidebar owns `sidebar.panellist`).
 *   5. The entry exports what the loader consumes -- and `Config` answers to the three
 *      consumers that read it (Cordis, the settings service's compiler and its
 *      descriptor walker). The assertions are the contract BOTH schema forms satisfy:
 *      `safeParse` is deliberately absent, because the dependency-free fallback
 *      provides it while the real schemastery does not.
 *   6. The README's "current version" line matches `package.json`. These are two
 *      hand-edited files that must agree, the npm page shows one while the registry
 *      serves the other, and nothing else would notice them drifting.
 *
 * This file is a development tool for dsh-image-router, not part of the plugin, and it
 * is not published (`files` in package.json lists what ships).
 */
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const problems = []

/**
 * Runs one check and records its failure instead of throwing, so a single run reports
 * everything that is wrong rather than stopping at the first problem. Awaited, because
 * one of the checks imports the entry.
 */
async function check(what, run) {
	try {
		const detail = await run()
		console.log(`  ok    ${what}${detail === undefined ? '' : ` — ${detail}`}`)
	} catch (error) {
		const message = error?.message ?? String(error)
		problems.push(`${what}: ${message}`)
		console.log(`  FAIL  ${what} — ${message}`)
	}
}

const read = (relative) => readFileSync(join(ROOT, relative), 'utf8')
const manifest = JSON.parse(read('package.json'))

console.log(`checking ${manifest.name}@${manifest.version}`)

await check('package.json declares dsh.bundle.patch', () => {
	const patch = manifest.dsh?.bundle?.patch
	if (typeof patch !== 'string') throw new Error('dsh.bundle.patch must be a string')
	read(patch)
	return patch
})

await check('the declared browser half exists', () => {
	if (manifest.dsh?.client === undefined) return 'none declared'
	const client = manifest.exports?.['./client']
	if (typeof client !== 'string') throw new Error('dsh.client requires a string exports["./client"]')
	read(client)
	return client
})

/**
 * The sidebar entry is two registrations in one bundle. String assertions, not a
 * render: this tool runs in CI without a DOM, and the failure it must catch is a
 * bundle that lost one half during a refactor — which reads exactly like "the row
 * does nothing" at runtime.
 */
await check('the browser half claims the sidebar entry and its page', () => {
	const client = read(manifest.exports['./client'])
	if (!client.includes("'sidebar.panellist'")) throw new Error("client.js never mentions the 'sidebar.panellist' slot")
	if (!/name:\s*'sidebar\.panellist'/.test(client)) throw new Error('client.js never registers into sidebar.panellist')
	if (!/name:\s*'main'/.test(client)) throw new Error("client.js never registers the 'main' page")
	// One id for both slots: the sidebar row selects, the layout dispatches by it.
	const ids = client.match(/PANEL_ID\s*=\s*'([^']+)'/)?.[1]
	if (typeof ids !== 'string') throw new Error('client.js has no PANEL_ID constant to share between the two slots')
	const uses = client.match(/PANEL_ID\b/g)?.length ?? 0
	if (uses < 3) throw new Error(`PANEL_ID is used ${uses} time(s): it must key both slots and be declared once`)
	return `${ids} (row + page)`
})

await check('the client manifest names the rows the entry is composed after', () => {
	const rows = manifest.dsh?.client?.inject
	if (!Array.isArray(rows)) throw new Error('dsh.client.inject must be an array of client bundle package names')
	for (const row of ['@deepseek-ai/dsh-client-ui-layout', '@deepseek-ai/dsh-client-ui-sidebar']) {
		if (!rows.includes(row)) throw new Error(`dsh.client.inject must name ${row}, which owns one of the entry's slots`)
	}
	return rows.join(', ')
})

await check('the entry exports what the loader reads', async () => {
	const mod = await import(pathToFileURL(join(ROOT, 'lib/index.js')).href)
	if (typeof mod.name !== 'string' || mod.name.length === 0) throw new Error('name must be a non-empty string')
	if (mod.default !== undefined) throw new Error('a DSH plugin entry must not have a default export')
	if (typeof mod.apply !== 'function') throw new Error('apply must be a function')
	if (mod.Config === undefined) throw new Error('Config must be exported')
	if (typeof mod.Config !== 'function') throw new Error('Config must be callable: the settings service layers defaults by calling it')
	if (typeof mod.Config.toJSON !== 'function') throw new Error('Config.toJSON must be callable: the settings page renders the field graph it returns')
	if (typeof mod.Config['~standard']?.validate !== 'function') throw new Error('Config must answer ~standard.validate: the Cordis loader validates the deployment config with it')
	const graph = mod.Config.toJSON()
	if (graph === null || typeof graph !== 'object') throw new Error('Config.toJSON must return a field graph, not nothing')
	if (typeof mod.Config({ mode: 'digest' }) !== 'object') throw new Error('Config must be callable to layer defaults')
	return `name=${mod.name} schemaForm=${mod.schemaForm}`
})

await check('the README names the current version', () => {
	const match = read('README.md').match(/当前版本\s*`([^`]+)`/)
	if (match === null) throw new Error('README has no "当前版本 `x.y.z`" line to check')
	if (match[1] !== manifest.version) {
		throw new Error(`README says ${match[1]}, package.json says ${manifest.version} — bump both (tools/release.mjs does it)`)
	}
	return match[1]
})

if (problems.length > 0) {
	console.error(`\n${problems.length} problem(s):`)
	for (const problem of problems) console.error(`  - ${problem}`)
	process.exit(1)
}
console.log('\ncontract ok')

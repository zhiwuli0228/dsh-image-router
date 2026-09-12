/**
 * Cut a release without hand-editing two files.
 *
 *   node tools/release.mjs 0.4.5            # bump, verify, commit, tag (no push)
 *   node tools/release.mjs 0.4.5 --push     # ...then push, which is what publishes
 *   node tools/release.mjs 0.4.5 --dry-run  # report what would happen, change nothing
 *
 * The version lives in two hand-edited places -- `package.json` and the README's
 * "current version" line -- and nothing else notices when they disagree. This script
 * writes both, then refuses to continue unless the contract check and the suite pass,
 * so a tag cannot be created around a state that CI would reject anyway.
 *
 * Pushing the tag is what publishes: .github/workflows/release.yml verifies the tag
 * against package.json, publishes to npm over trusted publishing, and opens the GitHub
 * release. That is why --push is opt-in here and the default stops after the local tag:
 * the irreversible step stays a decision rather than an argument's side effect.
 *
 * This file is a development tool for dsh-image-router, not part of the plugin, and it
 * is not published (`files` in package.json lists what ships).
 */
import { spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const target = args.find((a) => !a.startsWith('--'))
const dryRun = args.includes('--dry-run')
const push = args.includes('--push')

/**
 * Windows resolves `npm` through a .cmd shim, which needs the platform-suffixed name
 * when spawning without a shell. A shell would be worse than this constant: it joins
 * argv with spaces and quotes nothing, so `git commit -m "release: 0.4.5"` would arrive
 * as two arguments and the tag message would be lost.
 */
const NPM = process.platform === 'win32' ? 'npm.cmd' : 'npm'

/** Runs a command in the repo, streaming output; returns its exit status. */
function run(command, commandArgs) {
	const result = spawnSync(command, commandArgs, { cwd: ROOT, stdio: 'inherit' })
	return result.status ?? 1
}

/** Runs a command and returns its trimmed stdout, or undefined when it fails. */
function capture(command, commandArgs) {
	const result = spawnSync(command, commandArgs, { cwd: ROOT, encoding: 'utf8' })
	return result.status === 0 ? String(result.stdout).trim() : undefined
}

function die(message) {
	console.error(`\nrelease aborted: ${message}`)
	process.exit(1)
}

if (target === undefined || !/^\d+\.\d+\.\d+$/.test(target)) {
	die('usage: node tools/release.mjs <x.y.z> [--push] [--dry-run]')
}

const manifestPath = join(ROOT, 'package.json')
const readmePath = join(ROOT, 'README.md')
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
const readme = readFileSync(readmePath, 'utf8')
const current = manifest.version

const compare = (a, b) => {
	const left = a.split('.').map(Number)
	const right = b.split('.').map(Number)
	for (let i = 0; i < 3; i += 1) {
		if (left[i] !== right[i]) return left[i] - right[i]
	}
	return 0
}

if (compare(target, current) <= 0) die(`target ${target} is not greater than the current version ${current}`)

/**
 * Preconditions, collected rather than thrown one at a time. A dry run has to be able
 * to preview a branch that is not ready yet -- that is what makes it useful before the
 * version bump is committed -- so these become blockers a real run refuses on, and a
 * report a dry run prints.
 */
const blockers = []
if (compare(target, current) <= 0) {
	blockers.push(`target ${target} is not greater than the current version ${current}`)
}

const dirty = capture('git', ['status', '--porcelain'])
if (dirty === undefined) {
	blockers.push('git status failed — is this a git checkout?')
} else if (dirty.length > 0) {
	blockers.push(`the working tree has uncommitted changes, so a tag would name a tree that does not exist:\n${dirty.split('\n').map((line) => `      ${line}`).join('\n')}`)
}

if (capture('git', ['rev-parse', '--verify', '--quiet', `refs/tags/v${target}`]) !== undefined) {
	blockers.push(`tag v${target} already exists locally`)
}

const published = capture(NPM, ['view', manifest.name, 'versions', '--json'])
if (published !== undefined && published.includes(`"${target}"`)) {
	blockers.push(`${manifest.name}@${target} is already published — a published version cannot be overwritten`)
}

console.log(`\n${manifest.name}: ${current} -> ${target}`)
console.log(`  contract check : runs before the tag`)
console.log(`  suite          : runs before the tag`)
console.log(`  push           : ${push ? 'yes — this will publish' : 'no (pass --push to publish)'}`)
console.log(`  mode           : ${dryRun ? 'dry run — nothing will be written' : 'writing'}`)

if (blockers.length > 0) {
	console.log(`\n${dryRun ? 'this run would be blocked by' : 'blocked by'}:`)
	for (const blocker of blockers) console.log(`  - ${blocker}`)
}

if (dryRun) {
	if (blockers.length === 0) {
		console.log('\ndry run: would bump both files, run the checks, then commit and tag.')
	} else {
		console.log('\ndry run: nothing was written. Clear the blockers above first.')
	}
	process.exit(0)
}

if (blockers.length > 0) die('see the blockers above')

// --- write both version references --------------------------------------------
manifest.version = target
writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n')

const withVersion = readme.replace(/(当前版本\s*`)[^`]+(`)/, `$1${target}$2`)
if (withVersion === readme) {
	// Put package.json back: a half-applied bump is worse than none.
	manifest.version = current
	writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n')
	die('the README has no "当前版本 `x.y.z`" line to update — refusing to bump half of it')
}
writeFileSync(readmePath, withVersion)
console.log(`\nwrote package.json and README.md`)

// --- verify before the tag exists ---------------------------------------------
if (run('node', ['tools/check-contract.mjs']) !== 0) {
	die('the contract check failed — the version bump is left in place for you to fix')
}
if (run('node', ['test/routing.test.js']) !== 0) {
	die('the suite failed — the version bump is left in place for you to fix')
}

// --- commit and tag ------------------------------------------------------------
if (run('git', ['add', 'package.json', 'README.md']) !== 0) die('git add failed')
if (run('git', ['commit', '-m', `release: ${target}`]) !== 0) die('git commit failed')
if (run('git', ['tag', '-a', `v${target}`, '-m', `${manifest.name} ${target}`]) !== 0) die('git tag failed')

console.log(`\ncommitted and tagged v${target}`)
if (push) {
	if (run('git', ['push', 'origin', 'main', `v${target}`]) !== 0) {
		die('push failed — the commit and tag are local, nothing was published')
	}
	console.log('pushed — release.yml is now publishing; watch it with:')
	console.log(`  gh run watch $(gh run list --workflow release.yml --limit 1 --json databaseId --jq '.[0].databaseId')`)
} else {
	console.log('nothing has been pushed yet. to publish:')
	console.log(`  git push origin main v${target}`)
}

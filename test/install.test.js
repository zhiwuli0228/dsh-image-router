// The manual installer names its target: `desktop` or `web`. These tests cover the
// parts that can go wrong silently — the target parse, which CLI is chosen for
// which target, the specifier defaults, and the preflight that refuses to touch a
// profile the desktop app is holding. The install itself is one CLI call; a test
// for it would only assert that `spawnSync` happened.
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { buildCommand, compareVersions, desktopCliCandidates, installSpec, main, parseArgs, resolveCli, resolveHome, resolveProfileDir, spawnPlan, TARGETS } from '../tools/install.mjs'

test('the target is required and must be desktop or web', () => {
	assert.deepEqual(TARGETS, ['desktop', 'web'], 'two builds, two profiles')
	for (const target of TARGETS) assert.equal(parseArgs([target]).target, target)
	assert.throws(() => parseArgs([]), /missing target .*desktop or web/u)
	assert.throws(() => parseArgs(['server']), /unknown target "server"/u)
	assert.throws(() => parseArgs(['desktop', 'web']), /expected one target/u)
	assert.throws(() => parseArgs(['desktop', '--spec']), /--spec needs a value/u)
	assert.throws(() => parseArgs(['desktop', '--nope']), /unknown flag --nope/u)
	assert.equal(parseArgs(['--help']).help, true)
})

test('every flag parses beside the target', () => {
	const plan = parseArgs(['desktop', '--source', '--dry-run', '--force', '--home', 'C:\\h', '--cli', 'C:\\dsh.cmd', '--spec', 'dsh-image-router@0.6.1'])
	assert.equal(plan.target, 'desktop')
	assert.equal(plan.source, true)
	assert.equal(plan.dryRun, true)
	assert.equal(plan.force, true)
	assert.equal(plan.home, 'C:\\h')
	assert.equal(plan.cli, 'C:\\dsh.cmd')
	assert.equal(plan.spec, 'dsh-image-router@0.6.1')
})

test('the profile is <DSH_HOME>/profiles/<target>', () => {
	assert.equal(resolveHome({ DSH_HOME: 'D:\\dsh' }, undefined), 'D:\\dsh')
	assert.equal(resolveHome({ DSH_HOME: 'D:\\dsh' }, 'E:\\other'), 'E:\\other', '--home wins')
	const derived = resolveHome({ USERPROFILE: 'C:\\Users\\x' }, undefined)
	assert.equal(resolveProfileDir(derived, 'desktop'), join('C:\\Users\\x', '.dsh', 'profiles', 'desktop'))
	assert.equal(resolveProfileDir(derived, 'web'), join('C:\\Users\\x', '.dsh', 'profiles', 'web'))
})

test('the desktop CLI is the one inside the app, never the PATH one', () => {
	const candidates = desktopCliCandidates('win32', { LOCALAPPDATA: 'C:\\Users\\x\\AppData\\Local', ProgramFiles: 'C:\\Program Files' })
	assert.equal(candidates[0], join('C:\\Users\\x\\AppData\\Local', 'Programs', 'DeepSeek Harness', 'resources', 'runtime', 'cli', 'bin', 'dsh.cmd'))
	assert.ok(candidates.every((candidate) => candidate.includes('runtime') && candidate.includes('cli')))
	const mac = desktopCliCandidates('darwin', { HOME: '/Users/x' })
	assert.ok(mac[0].startsWith('/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/'), 'macOS bundles it under the app')
})

test('an explicit --cli is used verbatim, and a missing one is refused', () => {
	const dir = mkdtempSync(join(tmpdir(), 'image-router-cli-'))
	try {
		const cli = join(dir, 'dsh.cmd')
		writeFileSync(cli, '')
		const resolved = resolveCli({ target: 'desktop', cli }, {}, 'win32')
		assert.equal(resolved.command, cli)
		assert.equal(resolved.source, 'explicit')
		assert.throws(() => resolveCli({ target: 'desktop', cli: join(dir, 'nope') }, {}, 'win32'), /points at nothing/u)
	} finally {
		rmSync(dir, { recursive: true, force: true })
	}
})

test('a desktop install with no desktop app explains where it looked', () => {
	const missing = join(tmpdir(), 'no-app-here')
	const env = { LOCALAPPDATA: missing, ProgramFiles: missing }
	assert.throws(() => resolveCli({ target: 'desktop' }, env, 'win32'), /no DeepSeek Harness desktop install found[\s\S]*dsh\.cmd/u)
})

test('the specifier defaults to npm, and --source points at this checkout', () => {
	assert.equal(installSpec({ target: 'desktop', source: false }), 'dsh-image-router')
	assert.match(installSpec({ target: 'web', source: true }), /^file:.*dsh-image-router$/u)
	assert.equal(installSpec({ target: 'web', source: false, spec: 'dsh-image-router@0.6.1' }), 'dsh-image-router@0.6.1')
})

test('the command names the target profile and the add verb', () => {
	const plan = parseArgs(['desktop'])
	assert.deepEqual(buildCommand(plan, 'C:\\dsh.cmd'), { command: 'C:\\dsh.cmd', args: ['plugin', '--profile', 'desktop', 'add', 'dsh-image-router'] })
	assert.deepEqual(buildCommand(plan, 'C:\\dsh.cmd', 'file:E:/repo').args.slice(-1), ['file:E:/repo'])
})

test('versions compare numerically, prerelease suffix ignored', () => {
	assert.ok(compareVersions('0.6.1', '0.6.0') > 0)
	assert.equal(compareVersions('0.6.1', '0.6.1'), 0)
	assert.ok(compareVersions('0.6.0', '0.6.1') < 0)
	assert.equal(compareVersions('0.2.1-rc.3', '0.2.1'), 0)
	assert.ok(compareVersions('0.10.0', '0.9.9') > 0)
})

test('a .cmd CLI goes through cmd.exe, a plain binary does not', () => {
	// Node refuses to exec a .cmd shim directly (EINVAL, argv-injection fix), so the
	// Windows CLIs are both started through cmd.exe — and the desktop one lives under
	// "DeepSeek Harness", so the quoting has to survive a space in the path.
	const windows = spawnPlan('C:\\Program Files\\DeepSeek Harness\\resources\\runtime\\cli\\bin\\dsh.cmd', ['plugin', '--profile', 'desktop', 'add', 'dsh-image-router'], 'win32')
	assert.equal(windows.shell, true)
	assert.deepEqual(windows.args, [])
	assert.equal(windows.command, '"C:\\Program Files\\DeepSeek Harness\\resources\\runtime\\cli\\bin\\dsh.cmd" "plugin" "--profile" "desktop" "add" "dsh-image-router"')
	assert.deepEqual(spawnPlan('/usr/local/bin/dsh', ['plugin'], 'linux'), { command: '/usr/local/bin/dsh', args: ['plugin'] })
	assert.deepEqual(spawnPlan('C:\\npm\\dsh.exe', ['plugin'], 'win32'), { command: 'C:\\npm\\dsh.exe', args: ['plugin'] }, 'an .exe is still started directly')
})

test('a Windows .cmd install really runs, spaces in the path included', { skip: process.platform !== 'win32' }, () => {
	const dir = mkdtempSync(join(tmpdir(), 'image-router-cmd-'))
	try {
		const spaced = join(dir, 'Program Files', 'App')
		mkdirSync(spaced, { recursive: true })
		const out = join(dir, 'out.txt')
		const cli = join(spaced, 'dsh.cmd')
		writeFileSync(cli, `@echo off\r\n> "${out}" echo %*\r\n`)
		const code = main(['web', '--home', join(dir, 'home'), '--cli', cli], { env: process.env, platform: 'win32', log: () => {} })
		assert.equal(code, 0, 'the shim ran and exited 0')
		// The tokens arrive quoted (the shim path itself contains a space), so compare
		// the argument list rather than the raw echo line.
		const seen = readFileSync(out, 'utf8').trim().replaceAll('"', '').split(/\s+/u)
		assert.deepEqual(seen, ['plugin', '--profile', 'web', 'add', 'dsh-image-router'], 'every argument survived cmd.exe')
	} finally {
		rmSync(dir, { recursive: true, force: true })
	}
})

test('--home reaches the CLI as DSH_HOME, so the profile dir really moves', { skip: process.platform !== 'win32' }, () => {
	const dir = mkdtempSync(join(tmpdir(), 'image-router-home-'))
	try {
		const cli = join(dir, 'dsh.cmd')
		const out = join(dir, 'home.txt')
		writeFileSync(cli, `@echo off\r\n> "${out}" echo %DSH_HOME%\r\n`)
		const home = join(dir, 'probe home')
		const code = main(['web', '--home', home, '--cli', cli], { env: process.env, platform: 'win32', log: () => {} })
		assert.equal(code, 0)
		// The CLI resolves the profile from DSH_HOME itself; without this the install
		// would land in the default home while the script reports the requested one.
		assert.equal(readFileSync(out, 'utf8').trim(), home)
	} finally {
		rmSync(dir, { recursive: true, force: true })
	}
})

test('the desktop version is read from either runtime manifest layout', () => {
	const dir = mkdtempSync(join(tmpdir(), 'image-router-runtime-'))
	try {
		const bin = join(dir, 'resources', 'runtime', 'cli', 'bin')
		mkdirSync(bin, { recursive: true })
		const cli = join(bin, 'dsh.cmd')
		writeFileSync(cli, '')
		const resolved = resolveCli({ target: 'desktop', cli }, {}, 'win32')
		assert.equal(resolved.version, undefined, 'no manifest yet')
		// rc.3 ships the manifest one level deeper than older builds; both must work or
		// the compatibility warning silently disappears.
		mkdirSync(join(dir, 'resources', 'runtime', 'primary-runtime'), { recursive: true })
		writeFileSync(join(dir, 'resources', 'runtime', 'primary-runtime', 'runtime.json'), JSON.stringify({ desktopVersion: '0.2.1-rc.5' }))
		assert.equal(resolveCli({ target: 'desktop', cli }, {}, 'win32').version, '0.2.1-rc.5')
		writeFileSync(join(dir, 'resources', 'runtime', 'runtime.json'), JSON.stringify({ desktopVersion: '0.2.1-rc.3' }))
		assert.equal(resolveCli({ target: 'desktop', cli }, {}, 'win32').version, '0.2.1-rc.3', 'the shallowest manifest wins')
	} finally {
		rmSync(dir, { recursive: true, force: true })
	}
})

test('a desktop dry run refuses before the profile is initialized, and prints the command after', () => {
	const dir = mkdtempSync(join(tmpdir(), 'image-router-install-'))
	try {
		const home = join(dir, 'home')
		const cli = join(dir, 'dsh.cmd')
		writeFileSync(cli, '')
		const profile = resolveProfileDir(home, 'desktop')
		const lines = []
		const missing = main(['desktop', '--home', home, '--cli', cli, '--dry-run'], { env: {}, platform: 'linux', log: (line) => lines.push(line) })
		assert.equal(missing, 1, 'no package.json means the app has never initialized the profile')
		assert.ok(lines.some((line) => line.includes('先完整打开一次桌面 App')), 'and it says so')

		mkdirSync(profile, { recursive: true })
		writeFileSync(join(profile, 'package.json'), JSON.stringify({ name: 'dsh-profile-desktop', private: true, dependencies: { 'dsh-image-router': 'file:E:/repo' } }))
		const ok = main(['desktop', '--home', home, '--cli', cli, '--dry-run'], { env: {}, platform: 'linux', log: (line) => lines.push(line) })
		assert.equal(ok, 0)
		const command = lines.at(-1)
		assert.ok(command.startsWith('dry-run: '), `last line is the command: ${command}`)
		assert.ok(command.includes('plugin --profile desktop add dsh-image-router'))
		assert.ok(lines.some((line) => line.startsWith('current  file:E:/repo')), 'the installed spec is reported')
	} finally {
		rmSync(dir, { recursive: true, force: true })
	}
})

test('a web dry run needs no initialized profile and never asks about the app', () => {
	const dir = mkdtempSync(join(tmpdir(), 'image-router-install-web-'))
	try {
		const home = join(dir, 'home')
		const cli = join(dir, 'dsh.cmd')
		writeFileSync(cli, '')
		const lines = []
		const code = main(['web', '--home', home, '--cli', cli, '--dry-run'], { env: {}, platform: 'linux', log: (line) => lines.push(line) })
		assert.equal(code, 0, 'a web target does not require an initialized profile')
		assert.ok(lines.some((line) => line.startsWith('profile  ') && line.includes(join('profiles', 'web'))))
		assert.ok(lines.at(-1).includes('plugin --profile web add dsh-image-router'))
		assert.equal(lines.some((line) => line.includes('DeepSeek Harness 正在运行')), false)
	} finally {
		rmSync(dir, { recursive: true, force: true })
	}
})

#!/usr/bin/env node
/**
 * Manual installer that names its TARGET: `desktop` or `web`.
 *
 * Why this exists: the two builds keep separate profiles and use separate CLIs.
 * A web profile is served by the `dsh` on PATH (`dsh plugin --profile web …`,
 * then `dsh web`), while the desktop app ships its own harness — its CLI lives
 * inside the installed app and its profile is initialized by the app itself, so
 * `dsh plugin --profile desktop …` must come from THAT binary, and only after
 * the app has been fully quit. Running the wrong one installs into a profile the
 * app never loads, or edits a profile while the app holds it.
 *
 * Usage:
 *
 *   node tools/install.mjs desktop            # 装进桌面版（自动找 App 自带的 CLI）
 *   node tools/install.mjs web                # 装进 web 版（用 PATH 上的 dsh）
 *   node tools/install.mjs desktop --source   # 装本地克隆（file:<repo>）
 *   node tools/install.mjs desktop --dry-run  # 只做预检、打印将执行的命令
 *
 * Flags:
 *   --source          install `file:<this repo>` instead of the published package
 *   --spec <spec>     install an explicit specifier (overrides both defaults)
 *   --home <dir>      DSH_HOME to use (default: $DSH_HOME, then ~/.dsh)
 *   --cli <path>      the harness CLI to run (default: target-specific discovery)
 *   --dry-run         preflight only: print the command, install nothing
 *   --force           skip the "quit the desktop app first" refusal
 *   --help            print this text
 *
 * Exit codes: 0 success, 1 usage/preflight failure, 2 the install command failed.
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
export const TARGETS = ['desktop', 'web']
const USAGE = `usage: node tools/install.mjs <${TARGETS.join('|')}> [--source] [--spec <specifier>] [--home <dir>] [--cli <path>] [--dry-run] [--force]

  desktop  装进桌面版 profile（用 App 内置的 dsh CLI；先把 App 完全退出）
  web      装进 web profile（用 PATH 上的 dsh；装完重启 dsh web）

  --source       装本地克隆：file:<repo>
  --spec <s>     显式指定包（默认 dsh-image-router）
  --home <dir>   DSH_HOME（默认 $DSH_HOME，再退回 ~/.dsh）
  --cli <path>   指定 harness CLI
  --dry-run      只预检并打印命令
  --force        桌面 App 在运行时也继续（默认拒绝）`

/** A usage error: printed without a stack trace. */
export class UsageError extends Error {}

/** Read one flag's value, or throw a usage error naming it. */
function valueOf(argv, index, flag) {
	const next = argv[index + 1]
	if (next === undefined || next.startsWith('--')) throw new UsageError(`${flag} needs a value`)
	return next
}

/**
 * Parse the command line into one explicit plan.
 * @param {string[]} argv - arguments after the script name.
 * @returns {{target: string, source: boolean, spec: string|undefined, home: string|undefined, cli: string|undefined, dryRun: boolean, force: boolean, help: boolean}}
 */
export function parseArgs(argv) {
	const plan = { target: '', source: false, spec: undefined, home: undefined, cli: undefined, dryRun: false, force: false, help: false }
	const rest = []
	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index]
		if (arg === '--help' || arg === '-h') plan.help = true
		else if (arg === '--source') plan.source = true
		else if (arg === '--dry-run') plan.dryRun = true
		else if (arg === '--force') plan.force = true
		else if (arg === '--spec') plan.spec = valueOf(argv, index++, arg)
		else if (arg === '--home') plan.home = valueOf(argv, index++, arg)
		else if (arg === '--cli') plan.cli = valueOf(argv, index++, arg)
		else if (arg.startsWith('--')) throw new UsageError(`unknown flag ${arg}`)
		else rest.push(arg)
	}
	if (plan.help) return { ...plan, target: rest[0] ?? '' }
	if (rest.length === 0) throw new UsageError(`missing target — say ${TARGETS.join(' or ')} (node tools/install.mjs <${TARGETS.join('|')}> …, or --help)`)
	if (rest.length > 1) throw new UsageError(`expected one target, got ${rest.join(' ')}`)
	if (!TARGETS.includes(rest[0])) throw new UsageError(`unknown target "${rest[0]}" — ${TARGETS.join(' or ')}`)
	return { ...plan, target: rest[0] }
}

/**
 * The profile root: `$DSH_HOME`, else `~/.dsh`.
 * @param {NodeJS.ProcessEnv} env - environment to read.
 * @param {string} [home] - explicit `--home`.
 * @returns {string} the DSH home directory.
 */
export function resolveHome(env, home) {
	if (home !== undefined) return resolve(home)
	if (typeof env.DSH_HOME === 'string' && env.DSH_HOME.length > 0) return resolve(env.DSH_HOME)
	return join(env.USERPROFILE ?? env.HOME ?? homedir(), '.dsh')
}

/**
 * The profile a target installs into.
 * @param {string} home - DSH home.
 * @param {string} target - `desktop` or `web`.
 * @returns {string} profile directory.
 */
export function resolveProfileDir(home, target) {
	return join(home, 'profiles', target)
}

/**
 * Where the desktop build keeps its harness CLI.
 *
 * The desktop app does not reuse the npm `dsh`: it embeds one under
 * `<app>/resources/runtime/cli/bin`, and that is the one whose runtime version
 * matches the app's profile (0.2.1-rc.3 here). A PATH `dsh` can be older — mixing
 * them is how a plugin ends up installed into a profile the app never loads.
 * @param {string} platform - `process.platform`.
 * @param {NodeJS.ProcessEnv} env - environment (LOCALAPPDATA / ProgramFiles).
 * @returns {string[]} candidates in probe order.
 */
export function desktopCliCandidates(platform, env) {
	const relative = ['resources', 'runtime', 'cli', 'bin']
	if (platform === 'win32') {
		const local = env.LOCALAPPDATA ?? join(env.USERPROFILE ?? '', 'AppData', 'Local')
		return [
			join(local, 'Programs', 'DeepSeek Harness', ...relative, 'dsh.cmd'),
			join(env.ProgramFiles ?? 'C:\\Program Files', 'DeepSeek Harness', ...relative, 'dsh.cmd'),
			join(local, 'DeepSeek Harness', ...relative, 'dsh.cmd')
		]
	}
	if (platform === 'darwin') {
		return [
			'/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh',
			join(env.HOME ?? '', 'Applications', 'DeepSeek Harness.app', 'Contents', 'Resources', 'runtime', 'cli', 'bin', 'dsh')
		]
	}
	return [
		'/opt/DeepSeek Harness/resources/runtime/cli/bin/dsh',
		'/usr/lib/deepseek-harness/resources/runtime/cli/bin/dsh',
		join(env.HOME ?? '', '.local', 'share', 'DeepSeek Harness', 'resources', 'runtime', 'cli', 'bin', 'dsh')
	]
}

/**
 * Resolve the CLI to run for a target.
 * @param {object} plan - parsed arguments.
 * @param {NodeJS.ProcessEnv} env - environment.
 * @param {string} platform - `process.platform`.
 * @returns {{command: string, source: string, version: string|undefined}} the CLI plus where it came from.
 */
export function resolveCli(plan, env, platform) {
	const explicit = plan.cli ?? env.DSH_IMAGE_ROUTER_CLI
	if (explicit !== undefined) {
		if (!existsSync(explicit)) throw new UsageError(`--cli points at nothing: ${explicit}`)
		// An explicit desktop CLI still gets its version probed: the compatibility
		// warning is about the runtime, not about how the path was chosen.
		return { command: explicit, source: 'explicit', version: plan.target === 'desktop' ? readDesktopVersion(explicit) : undefined }
	}
	if (plan.target === 'web') {
		const probe = spawnSync(platform === 'win32' ? 'where' : 'which', ['dsh'], { encoding: 'utf8' })
		const found = probe.status === 0 ? probe.stdout.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean) : []
		// npm on Windows also drops an extension-less shim beside `dsh.cmd`; the
		// latter is the one a shell-less spawn can actually execute.
		const runnable = platform === 'win32' ? (found.find((entry) => /\.(?:cmd|exe)$/iu.test(entry)) ?? found[0]) : found[0]
		if (runnable === undefined) throw new UsageError('no `dsh` on PATH — install the CLI (npm i -g @deepseek-ai/dsh) or pass --cli <path>')
		return { command: runnable, source: 'PATH', version: undefined }
	}
	for (const candidate of desktopCliCandidates(platform, env)) {
		if (existsSync(candidate)) return { command: candidate, source: 'desktop app', version: readDesktopVersion(candidate) }
	}
	throw new UsageError(`no DeepSeek Harness desktop install found — pass --cli <path to the app's dsh>.
Probed:
${desktopCliCandidates(platform, env).map((candidate) => `  ${candidate}`).join('\n')}`)
}

/** The desktop version the CLI belongs to, from the runtime manifest beside it. */
function readDesktopVersion(cliPath) {
	// The manifest moved between desktop builds: `resources/runtime/runtime.json` on
	// some, `resources/runtime/primary-runtime/runtime.json` on others (0.2.1-rc.3
	// ships the second). Check both, nearest first.
	const base = resolve(dirname(cliPath), '..', '..')
	for (const candidate of [join(base, 'runtime.json'), join(base, 'primary-runtime', 'runtime.json')]) {
		try {
			const manifest = JSON.parse(readFileSync(candidate, 'utf8'))
			if (typeof manifest.desktopVersion === 'string') return manifest.desktopVersion
		} catch {
			// Keep looking; a missing manifest just means "version unknown".
		}
	}
	return undefined
}

/**
 * Whether the desktop app is running.
 *
 * The desktop CLI edits the profile through a file lock and requires the app to
 * be quit first ("Open … once … then fully quit it before running dsh plugin").
 * Detection is best-effort: an unavailable probe reports "unknown" and lets the
 * install proceed with a warning.
 * @param {string} platform - `process.platform`.
 * @returns {boolean|undefined} true/false, or undefined when undetectable.
 */
export function desktopAppRunning(platform) {
	try {
		if (platform === 'win32') {
			const out = execFileSync('tasklist', ['/FI', 'IMAGENAME eq DeepSeek Harness.exe', '/NH'], { encoding: 'utf8' })
			return /DeepSeek Harness\.exe/iu.test(out)
		}
		const out = execFileSync('pgrep', ['-f', 'DeepSeek Harness'], { encoding: 'utf8' })
		return out.trim().length > 0
	} catch {
		return undefined
	}
}

/**
 * The specifier to install when none was given.
 * @param {object} plan - parsed arguments.
 * @returns {string} npm specifier or `file:` path.
 */
export function installSpec(plan) {
	if (plan.spec !== undefined) return plan.spec
	return plan.source ? `file:${ROOT.replaceAll('\\', '/')}` : 'dsh-image-router'
}

/**
 * Build the CLI invocation.
 * @param {object} plan - parsed arguments.
 * @param {string} cli - CLI to run.
 * @param {string} [spec] - specifier to install; defaults to the plan's own.
 * @returns {{command: string, args: string[]}} argv for `spawnSync`.
 */
export function buildCommand(plan, cli, spec = installSpec(plan)) {
	const args = ['plugin', '--profile', plan.target, 'add', spec]
	return { command: cli, args }
}

/**
 * Turn a CLI invocation into something `spawnSync` can actually start.
 *
 * On Windows a `.cmd`/`.bat` shim is not a program: since the 2024 argv-injection
 * fix Node refuses to exec one directly (`EINVAL`), so it has to go through
 * cmd.exe. The command string is quoted here instead of setting `shell: true`,
 * because `shell: true` joins argv with bare spaces and the desktop CLI lives
 * under `…\Programs\DeepSeek Harness\…` — a path with a space in it.
 * @param {string} command - the CLI path.
 * @param {string[]} args - arguments after it.
 * @param {string} platform - `process.platform`.
 * @returns {{command: string, args: string[], shell?: boolean}} argv for `spawnSync`.
 */
export function spawnPlan(command, args, platform) {
	if (platform !== 'win32' || !/\.(?:cmd|bat)$/iu.test(command)) return { command, args }
	const quoted = [command, ...args].map((part) => `"${part.replaceAll('"', '""')}"`).join(' ')
	return { command: quoted, args: [], shell: true }
}

/** Read the profile's declared plugin version, when it is installed already. */
function installedVersion(profileDir) {
	try {
		const manifest = JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8'))
		const declared = manifest.dependencies?.['dsh-image-router']
		return typeof declared === 'string' ? declared : undefined
	} catch {
		return undefined
	}
}

/** The version this checkout declares. */
function repoVersion() {
	try {
		return JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version
	} catch {
		return undefined
	}
}

/**
 * Compare two dotted versions numerically (prerelease suffix ignored).
 * @returns {number} negative when `left < right`.
 */
export function compareVersions(left, right) {
	const parse = (value) => String(value).split('-')[0].split('.').map((part) => Number.parseInt(part, 10) || 0)
	const a = parse(left)
	const b = parse(right)
	for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
		const diff = (a[index] ?? 0) - (b[index] ?? 0)
		if (diff !== 0) return diff
	}
	return 0
}

/** Print the target-specific restart step. */
function printNextSteps(target) {
	if (target === 'desktop') {
		console.log('')
		console.log('next: 完全退出 DeepSeek Harness（关窗口不算：托盘/任务栏都要退出），再重新打开。')
		console.log('      侧栏应出现「图片路由」行；插件页 dsh-image-router 那一行会有「配置」。')
		return
	}
	console.log('')
	console.log('next: 重启 dsh web（Ctrl+C 后重新执行），然后在浏览器硬刷新（Ctrl/Cmd+Shift+R）。')
	console.log('      打开左侧栏「图片路由」行，或在设置里找 image-router 卡片。')
}

/**
 * Run the plan. Exported so a test can drive it with a fake env/platform.
 * @param {string[]} argv - command line after the script name.
 * @param {{env?: NodeJS.ProcessEnv, platform?: string, log?: (line: string) => void}} [options]
 * @returns {number} exit code.
 */
export function main(argv, options = {}) {
	const env = options.env ?? process.env
	const platform = options.platform ?? process.platform
	const log = options.log ?? console.log

	const plan = parseArgs(argv)
	if (plan.help) {
		log(USAGE)
		return 0
	}

	const home = resolveHome(env, plan.home)
	const run = options.run ?? ((command, args) => {
		const spawn = spawnPlan(command, args, platform)
		// `--home` has to reach the CLI too: it resolves the profile from DSH_HOME on
		// its own, so a child that inherits the ambient environment would install into
		// the default home while this script reports the requested one.
		return spawnSync(spawn.command, spawn.args, { stdio: 'inherit', shell: spawn.shell ?? false, env: { ...env, DSH_HOME: home } })
	})
	const profileDir = resolveProfileDir(home, plan.target)
	const cli = resolveCli(plan, env, platform)
	const spec = installSpec(plan)
	const { command, args } = buildCommand(plan, cli.command, spec)

	log(`target   ${plan.target}`)
	log(`profile  ${profileDir}`)
	log(`cli      ${cli.command}${cli.version === undefined ? '' : ` (desktop ${cli.version})`}`)
	log(`spec     ${spec}`)
	const current = installedVersion(profileDir)
	if (current !== undefined) log(`current  ${current}  (add 会就地升级)`)

	if (plan.target === 'desktop') {
		if (!existsSync(join(profileDir, 'package.json'))) {
			log('')
			log(`not ready: ${profileDir} has no package.json.`)
			log('先完整打开一次桌面 App，让它初始化 profile，再完全退出，然后重跑本命令。')
			return 1
		}
		const running = desktopAppRunning(platform)
		if (running === true && !plan.force) {
			if (plan.dryRun) {
				// A dry run installs nothing, so looking at the command is safe even
				// while the app holds the profile.
				log('note     DeepSeek Harness 正在运行 —— 真正安装前必须完全退出（--dry-run 不受影响）。')
			} else {
				log('')
				log('refused: DeepSeek Harness 正在运行，桌面 profile 被 App 占用。')
				log('完全退出 App（含托盘）后重跑；确认无误可加 --force。')
				return 1
			}
		}
		if (running === undefined) log('note     无法确认桌面 App 是否在运行 —— 请自行确保已完全退出。')
		// The desktop runtime and this plugin must agree on the settings model:
		// 0.2.x keys the section by the Loader entry id and owns the page form.
		const pluginVersion = repoVersion()
		if (cli.version !== undefined && compareVersions(cli.version, '0.2.1-rc.3') >= 0 && pluginVersion !== undefined && compareVersions(pluginVersion, '0.6.2') < 0) {
			log('')
			log(`warning  desktop ${cli.version} on 0.2.x needs dsh-image-router ≥ 0.6.2 (entry-id section + blank-instruction fix);`)
			log(`         this checkout is ${pluginVersion}.`)
		}
	}

	const shown = [command, ...args].map((part) => (part.includes(' ') ? JSON.stringify(part) : part)).join(' ')
	if (plan.dryRun) {
		log('')
		log(`dry-run: ${shown}`)
		return 0
	}

	log('')
	log(`run      ${shown}`)
	const result = run(command, args)
	if (result.error !== undefined) {
		log(`failed: ${result.error.message}`)
		return 2
	}
	if (result.status !== 0) {
		log(`failed: exit ${result.status ?? result.signal ?? 'unknown'}`)
		return 2
	}
	printNextSteps(plan.target)
	return 0
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
	try {
		process.exitCode = main(process.argv.slice(2))
	} catch (error) {
		if (error instanceof UsageError) {
			console.error(`error: ${error.message}`)
			process.exitCode = 1
		} else {
			throw error
		}
	}
}

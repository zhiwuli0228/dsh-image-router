/**
 * dsh-image-router — image work without touching the session's model.
 *
 * DSH has no built-in "an image arrived, ask a vision model" policy. What it has
 * (see `dsh-llm`, `dsh-api-session-controller`, `dsh-tool-fs`) is:
 *
 *   - a text-only route silently projects images to text placeholders
 *     (`dsh-llm`, `projectImagesForTextModel`);
 *   - the Web prompt path refuses an image prompt outright unless the session's
 *     current route declares `image` input (`MODEL_DOES_NOT_SUPPORT_IMAGES`);
 *   - `read_image` refuses on a route that does not declare `image` input.
 *
 * The default mode here is **digest**, the same shape as the Codex-side
 * `image-router` proxy: the session keeps the model the user chose, and the
 * images in one prompt are sent *out of band* to a vision route whose answer
 * replaces them as text before admission. Nothing about the session's model
 * selection is written, so the GUI keeps showing the user's own model.
 *
 * `mode: switch` keeps the older policy as an explicit opt-in: lend the session's
 * next-request route to the vision model for image turns and restore it after.
 *
 * Deliberately dependency-free plain ESM (Node builtins only): a profile may
 * mount this file by absolute path, where no package dependency would resolve.
 *
 * @module dsh-image-router
 */

import { randomUUID } from 'node:crypto'
import { appendFileSync } from 'node:fs'
import { basename } from 'node:path'

import { installSettings, SETTINGS_NAMESPACE } from './settings.js'
import { ENDPOINT_KEY_REF, ENDPOINT_PROVIDER, readEndpoint, routeForEndpoint, syncEndpoint } from './endpoint.js'

/** Plugin name shown by the loader and the plugin inventory. */
export const name = 'image-router'

/** Routing modes: `digest` never changes the session model; `switch` lends it. */
const MODES = new Set(['digest', 'switch'])

/**
 * Name fragments that mark a model as vision-capable when the route does not
 * declare its modalities. Only used as a fallback: an explicit declaration is
 * always authoritative, and a model the route describes as text-only stays out
 * even if its id says otherwise.
 */
const IMAGE_MODEL_HINTS = /(vision|visual|multimodal|omni|image|(?:^|[^a-z])vl(?:[^a-z]|$)|4o|gpt-4\.1|claude-3|claude-4|gemini|qwen-vl|glm-4v|internvl|llava|pixtral)/iu

/** File extensions treated as image work when they appear in prompt text (switch mode). */
const DEFAULT_EXTENSIONS = [
	'png',
	'jpg',
	'jpeg',
	'webp',
	'gif',
	'bmp',
	'avif',
	'tif',
	'tiff',
	'heic',
	'heif',
	'ico',
	'svg'
]

/** Default side-call instruction: extract text, then describe. */
const DEFAULT_INSTRUCTION = [
	'分析用户附上的图片，只输出以下两部分，不要寒暄：',
	'1. 文字内容：逐字提取图中所有可见文字；没有则写「无」。',
	'2. 画面描述：客观说明画面主体、布局、颜色与关键细节；若图中有报错信息、日志、表格或数据，原样保留关键内容。'
].join('\n')

/** Default cap on the digest answer, in tokens. */
const DEFAULT_MAX_TOKENS = 900

/** Default deadline for one digest call, in milliseconds. */
const DEFAULT_TIMEOUT_MS = 120000

/**
 * Documented per-field defaults. Both schema forms below resolve to these, so the
 * value `normalizeConfig` sees does not depend on which one the host produced.
 */
const CONFIG_DEFAULTS = {
	enabled: true,
	mode: 'digest',
	sticky: false,
	maxTokens: DEFAULT_MAX_TOKENS,
	timeoutMs: DEFAULT_TIMEOUT_MS,
	label: true,
	tool: true,
	dryRun: false,
	holdTurns: 0
}

/**
 * The plugin's configuration schema.
 *
 * Two consumers read this value and they want different things from it:
 *
 *  - **Cordis (the loader)** consumes a plugin schema through the Standard Schema
 *    interface only (`cordis/lib/index.js`: `runtime.Config['~standard'].validate(config)`).
 *  - **The settings service** treats a schema as a *callable* schemastery schema:
 *    `settings.register(ns, schema, { base })` stores it and later calls it to
 *    resolve defaults. A plain object with only `~standard` throws
 *    `TypeError: schema is not a function` there, which costs the deployment its
 *    editable section (and was observed doing exactly that).
 *
 * Schemastery is used whenever this module can resolve it, and that is the only
 * fully faithful form. It cannot always: the import is resolved from this file's
 * own location, and a profile installed through pnpm keeps every dependency
 * under `.pnpm`, so a plugin that does not depend on schemastery finds nothing —
 * the same property that lets this plugin be mounted by absolute path at all.
 *
 * The fallback therefore has to be **both** standard-shaped and callable. Being
 * callable is what the settings service needs; being standard-shaped is what the
 * loader needs. It is deliberately permissive: every field is optional, so the
 * loader never rejects a deployment's config and `apply` keeps owning the
 * semantics (normalizeConfig disables the plugin with a readable warning rather
 * than failing the boot).
 */
/**
 * Which schema form this deployment resolved: `'schemastery'` or `'fallback'`.
 *
 * Audited because the two forms are indistinguishable from the outside, and only
 * the fallback has to be defended against every consumer the settings service
 * reaches for (`describe()` calls `schema.toJSON()`, `resolve()` calls the schema
 * itself). A live `describe()` failure was hard to attribute precisely because
 * "which schema am I running here" was invisible.
 */
const { schema: Config, form: schemaForm } = await loadConfigSchema()

export { Config, schemaForm }

/**
 * Resolve `@deepseek-ai/schemastery`, trying more than this module's own location.
 *
 * A bare `import` from here resolves against this file's real path, which for an
 * installed plugin is a profile's `node_modules` — nowhere near the harness's own
 * packages, so the import fails and the plugin falls back. The fallback is enough
 * for activation and for the settings service, but **not** for the settings UI:
 * that page renders forms from `schema.toJSON()` and walks the descriptor, so a
 * schema without real field metadata degrades the configuration page itself.
 *
 * The harness is reachable, so it is used as a second anchor: the running CLI
 * (`process.argv[1]`, e.g. `.../@deepseek-ai/dsh/lib/bin.js`) and the global npm
 * root it was installed under. Each anchor is tried and the first real schemastery
 * wins; anything else falls back to the local equivalent.
 *
 * @returns the schemastery module, or `undefined` when no anchor resolves it.
 */
async function resolveSchemastery() {
	const { createRequire } = await import('node:module')
	const { pathToFileURL } = await import('node:url')
	const { join, dirname, resolve: resolvePath } = await import('node:path')

	/** Anchors as `[baseUrl, specifier]`; the first that resolves a usable module wins. */
	const anchors = []
	const fromThisFile = (specifier) => import(specifier).then((mod) => mod.default).catch(() => undefined)

	// 1. This module's own location — the normal case for a checkout with deps.
	try {
		const resolved = await fromThisFile('@deepseek-ai/schemastery')
		if (resolved !== undefined && typeof resolved.object === 'function') return resolved
	} catch {
		/* fall through to the harness anchors */
	}

	// 2. The running harness: the CLI script and the npm root above it.
	const cli = typeof process.argv[1] === 'string' && process.argv[1].length > 0 ? resolvePath(process.argv[1]) : undefined
	if (cli !== undefined) {
		// .../@deepseek-ai/dsh/lib/bin.js -> .../@deepseek-ai/dsh -> the package root
		const dshRoot = dirname(dirname(cli))
		anchors.push(pathToFileURL(join(dshRoot, 'package.json')).href)
		// The global root the package was installed into.
		const globalRoot = dirname(dirname(dshRoot))
		anchors.push(pathToFileURL(join(globalRoot, 'package.json')).href)
	}

	for (const anchor of anchors) {
		try {
			const requireFrom = createRequire(anchor)
			const resolved = requireFrom('@deepseek-ai/schemastery')
			const module = resolved?.default ?? resolved
			if (module !== undefined && typeof module.object === 'function') return module
		} catch {
			/* try the next anchor */
		}
	}
	return undefined
}

/** Load the schemastery schema when available, else the dependency-free equivalent. */
async function loadConfigSchema() {
	const z = await resolveSchemastery()
	const form = z === undefined || typeof z.object !== 'function' ? 'fallback' : 'schemastery'
	if (form === 'fallback') {
		/**
		 * The callable fallback.
		 *
		 * Three consumers read this value and each wants a different shape, which
		 * is why the fallback carries all three:
		 *
		 *  - **Cordis** uses `~standard.validate` (Standard Schema).
		 *  - **The settings service** *calls* it to layer defaults (`resolve()` does
		 *    `schema(mergeLayers(base, section))`), so it must be a function.
		 *  - **`settings.describe()`** calls `schema.toJSON()` to hand a
		 *    configuration surface the field metadata. Omitting that method is not
		 *    cosmetic: the throw happened inside `describe()`, so the whole
		 *    provider/settings directory failed to load and no plugin card could
		 *    render at all.
		 *
		 * `redactSecrets` walks the schema but is tolerant by construction (it reads
		 * `node.meta`/`node.type` and returns the value unchanged for anything else),
		 * so the fallback needs no schemastery metadata to survive it. No validation
		 * is declared because the semantic checks live in {@link normalizeConfig};
		 * a schema that rejected a half-filled deployment would fail the boot instead
		 * of disabling one plugin.
		 */
		const schema = (value) => ({ ...CONFIG_DEFAULTS, ...(value === null || value === undefined ? {} : value) })
		/** The permissive descriptor a surface renders: no declared fields, no secrets. */
		schema.toJSON = () => ({
			type: 'object',
			meta: { default: { ...CONFIG_DEFAULTS } },
			dict: {}
		})
		/** Zod-shaped parse, for any consumer that reaches for it. */
		schema.safeParse = (value) => ({ success: true, data: schema(value) })
		schema['~standard'] = {
			version: 1,
			vendor: 'dsh-image-router',
			validate: (value) => ({ value: schema(value) })
		}
		return { schema, form }
	}
	return {
		form,
		schema: z.object({
		enabled: z.boolean().default(CONFIG_DEFAULTS.enabled),
		mode: z.string().default(CONFIG_DEFAULTS.mode),
		sticky: z.boolean().default(CONFIG_DEFAULTS.sticky),
		vision: z.object({
			provider: z.string(),
			model: z.string(),
			reasoningEffort: z.string(),
			// The custom-endpoint tier: an OpenAI-compatible endpoint the user
			// supplies directly instead of naming an already-configured route.
			endpoint: z.object({
				baseURL: z.string(),
				model: z.string(),
				api: z.string(),
				name: z.string(),
				apiKeyEnv: z.string(),
				apiKey: z.string(),
				images: z.boolean()
			})
		}),
		text: z.object({
			provider: z.string(),
			model: z.string(),
			reasoningEffort: z.string()
		}),
		instruction: z.string(),
		maxTokens: z.number().default(CONFIG_DEFAULTS.maxTokens),
		timeoutMs: z.number().default(CONFIG_DEFAULTS.timeoutMs),
		label: z.boolean().default(CONFIG_DEFAULTS.label),
		tool: z.boolean().default(CONFIG_DEFAULTS.tool),
		dryRun: z.boolean().default(CONFIG_DEFAULTS.dryRun),
		holdTurns: z.number().default(CONFIG_DEFAULTS.holdTurns),
		imageExtensions: z.array(z.string()),
		hint: z.string(),
		traceFile: z.string()
		})
	}
}

/** Read and validate one configured route, or return `undefined`. */
function readRoute(value, label, problems) {
	if (value === undefined || value === null) return undefined
	if (typeof value !== 'object' || Array.isArray(value)) {
		problems.push(`${label} must be an object with provider and model`)
		return undefined
	}
	const provider = value.provider
	const model = value.model
	const reasoningEffort = value.reasoningEffort
	// A schema may materialize an unset optional object as `{}`; that is "absent",
	// not "configured with missing fields".
	if (provider === undefined && model === undefined && reasoningEffort === undefined) return undefined
	if (typeof provider !== 'string' || provider.length === 0) problems.push(`${label}.provider must be a non-empty string`)
	if (typeof model !== 'string' || model.length === 0) problems.push(`${label}.model must be a non-empty string`)
	if (reasoningEffort !== undefined && (typeof reasoningEffort !== 'string' || reasoningEffort.length === 0)) problems.push(`${label}.reasoningEffort must be a non-empty string when present`)
	if (problems.length > 0) return undefined
	return {
		provider,
		model,
		...(reasoningEffort === undefined ? {} : { reasoningEffort })
	}
}

/**
 * Normalize raw patch configuration without ever throwing, so a mistyped config
 * can only disable this plugin and never fail the profile tree.
 *
 * @param raw - Configuration object handed to `apply`.
 * @returns resolved config, or the problem list when it is unusable.
 */
export function normalizeConfig(raw) {
	const problems = []
	const config = raw === undefined || raw === null ? {} : raw
	if (typeof config !== 'object' || Array.isArray(config)) return { problems: ['config must be an object'] }

	const enabled = config.enabled === undefined ? true : config.enabled
	if (typeof enabled !== 'boolean') problems.push('enabled must be a boolean')

	// `auto` and `sticky` are the pre-digest mode names; keep them working.
	let mode = config.mode === undefined ? 'digest' : config.mode
	let sticky = config.sticky === undefined ? false : config.sticky
	if (mode === 'auto') mode = 'switch'
	else if (mode === 'sticky') {
		mode = 'switch'
		sticky = true
	}
	if (typeof mode !== 'string' || !MODES.has(mode)) problems.push('mode must be "digest" or "switch"')
	if (typeof sticky !== 'boolean') problems.push('sticky must be a boolean')

	// The endpoint tier is resolved first because it can *be* the vision route:
	// a user who supplies an endpoint, a model and a key has configured the
	// vision route, and should not also have to name an upstream provider id.
	const visionInput = config.vision === undefined || config.vision === null || typeof config.vision !== 'object' || Array.isArray(config.vision) ? {} : config.vision
	const endpoint = readEndpoint(visionInput.endpoint, 'vision.endpoint', problems)
	const endpointRoute = endpoint === undefined ? undefined : routeForEndpoint(endpoint)
	const vision = readRoute(config.vision, 'vision', problems) ?? endpointRoute
	if (vision === undefined) {
		problems.push('vision (the image-capable route) is required — either set vision: { provider: <provider>, model: <model> } for a route this deployment already has, or set vision.endpoint: { baseURL: <url>, model: <model>, apiKey: <key> } to derive one')
	}
	const text = readRoute(config.text, 'text', problems)

	const holdTurns = config.holdTurns === undefined ? 0 : config.holdTurns
	if (!Number.isInteger(holdTurns) || holdTurns < 0) problems.push('holdTurns must be a non-negative integer')

	const dryRun = config.dryRun === undefined ? false : config.dryRun
	if (typeof dryRun !== 'boolean') problems.push('dryRun must be a boolean')

	let instruction = DEFAULT_INSTRUCTION
	if (config.instruction !== undefined) {
		if (typeof config.instruction !== 'string' || config.instruction.trim().length === 0) problems.push('instruction must be a non-empty string')
		else instruction = config.instruction
	}

	const maxTokens = config.maxTokens === undefined ? DEFAULT_MAX_TOKENS : config.maxTokens
	if (!Number.isInteger(maxTokens) || maxTokens <= 0) problems.push('maxTokens must be a positive integer')

	const timeoutMs = config.timeoutMs === undefined ? DEFAULT_TIMEOUT_MS : config.timeoutMs
	if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) problems.push('timeoutMs must be a positive integer')

	const label = config.label === undefined ? true : config.label
	if (typeof label !== 'boolean') problems.push('label must be a boolean')

	const tool = config.tool === undefined ? true : config.tool
	if (typeof tool !== 'boolean') problems.push('tool must be a boolean')

	let imageExtensions = DEFAULT_EXTENSIONS
	if (config.imageExtensions !== undefined) {
		if (!Array.isArray(config.imageExtensions) || config.imageExtensions.some((entry) => typeof entry !== 'string' || entry.length === 0)) problems.push('imageExtensions must be an array of non-empty strings')
		// A schema may materialize an unset optional array as `[]`; that is "absent".
		else if (config.imageExtensions.length > 0) imageExtensions = config.imageExtensions.map((entry) => entry.replace(/^\./u, '').toLowerCase())
	}

	let hint
	if (config.hint !== undefined) {
		if (typeof config.hint !== 'string') problems.push('hint must be a regular expression source string')
		else {
			try {
				hint = new RegExp(config.hint, 'iu')
			} catch (error) {
				problems.push(`hint is not a valid regular expression: ${String(error)}`)
			}
		}
	}

	let traceFile
	if (config.traceFile !== undefined) {
		if (typeof config.traceFile !== 'string' || config.traceFile.length === 0) problems.push('traceFile must be a non-empty path string')
		else traceFile = config.traceFile
	}

	if (problems.length > 0) return { problems }
	return { enabled, mode, sticky, vision, endpoint, text, dryRun, holdTurns, imageExtensions, hint, instruction, maxTokens, timeoutMs, label, tool, traceFile }
}

/** Build the audit-line writer, or a no-op when no trace file is configured. */
function createTrace(traceFile) {
	if (typeof traceFile !== 'string' || traceFile.length === 0) return () => {}
	return (line) => {
		try {
			appendFileSync(traceFile, `${new Date().toISOString()} ${line}\n`)
		} catch {
			/* An unwritable trace file must never affect routing. */
		}
	}
}

/** Whether one path or file name carries image work. */
export function nameLooksLikeImage(value, extensions) {
	const pattern = new RegExp(`\\.(?:${extensions.map((extension) => extension.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')).join('|')})(?![\\w])`, 'iu')
	return pattern.test(value)
}

/** Whether a content block is a file reference that names an image. */
function fileBlockLooksLikeImage(part, extensions) {
	const mediaType = part.mediaType ?? part.media_type ?? part.mimeType
	if (typeof mediaType === 'string' && mediaType.toLowerCase().startsWith('image/')) return true
	for (const candidate of [part.name, part.fileName, part.filename, part.path, part.displayPath]) if (typeof candidate === 'string' && nameLooksLikeImage(candidate, extensions)) return true
	return false
}

/**
 * Whether this prompt asks for image work. Switch mode trusts two signals: an
 * image content block (a pasted or attached image), and an image reference the
 * model would have to resolve — an image file block, or image file name/path
 * text (`see shot.png`, `@design/mock.PNG`, `data:image/png;base64,...`).
 *
 * @param content - Prompt content blocks.
 * @param extensions - Accepted image extensions, without the dot.
 * @param hint - Optional extra regular expression.
 * @returns whether the turn needs a vision-capable route.
 */
export function promptWantsVision(content, extensions, hint) {
	if (!Array.isArray(content)) return false
	for (const part of content) {
		if (part === null || typeof part !== 'object') continue
		if (part.type === 'image') return true
		if (part.type === 'file' && fileBlockLooksLikeImage(part, extensions)) return true
		const text = typeof part.text === 'string' ? part.text : undefined
		if (text === undefined) continue
		if (/data:image\//iu.test(text)) return true
		if (nameLooksLikeImage(text, extensions)) return true
		if (hint !== undefined && hint.test(text)) return true
	}
	return false
}

/** Whether two selections already name the same provider/model pair. */
export function sameModel(left, right) {
	if (left === undefined || left === null || right === undefined || right === null) return false
	return left.provider === right.provider && left.model === right.model
}

/**
 * Decide what this prompt does to the session's model selection (switch mode).
 *
 * @param input - Prompt content, current selection, the route this plugin lent
 *   (when one is outstanding), and resolved configuration.
 * @returns `lend` to install the vision route and remember `input.current`,
 *   `release` to restore `route`, `forget` to drop a lent route the user has
 *   since changed by hand, or `undefined` to leave the selection alone.
 */
export function decideRoute(input) {
	if (promptWantsVision(input.content, input.extensions, input.hint)) {
		if (sameModel(input.current, input.vision)) return undefined
		return { action: 'lend', route: input.vision, reason: 'image' }
	}
	if (input.sticky === true) return undefined
	if (input.lent !== undefined) {
		if (!sameModel(input.current, input.vision)) return { action: 'forget', reason: 'changed-by-hand' }
		return { action: 'release', route: input.lent, reason: 'restore' }
	}
	if (input.text !== undefined && sameModel(input.current, input.vision)) return { action: 'release', route: input.text, reason: 'text' }
	return undefined
}

/** Image content blocks in one prompt, in order. */
function imageParts(content) {
	return Array.isArray(content) ? content.filter((part) => part !== null && typeof part === 'object' && part.type === 'image') : []
}

/**
 * Ask the vision route about the images of one prompt, out of band.
 *
 * The call is a hand-built one-shot: a plugin-sourced user message carrying the
 * instruction and the admitted image references, streamed through `ctx.llm` so
 * the endpoint, credentials, retry policy, and attachment resolution are the
 * deployment's own. Nothing is appended to the session log; the answer only
 * becomes text inside the prompt it was made for.
 *
 * @param env - `{ ctx, config, trace }`.
 * @param refs - admitted image references, in prompt order.
 * @param sessionId - session the call is attributed to, when known.
 * @param signal - caller cancellation.
 * @returns the analysis text, or `undefined` when the call could not be trusted.
 */
async function analyzeImages(env, refs, sessionId, signal) {
	const llm = typeof env.ctx.get === 'function' ? env.ctx.get('llm') : undefined
	if (llm === undefined || typeof llm.stream !== 'function') {
		// Audited rather than silent: this is the one failure path with no provider
		// attempt behind it, so without a line here the audit file looks like the
		// model simply answered nothing and the caller has nothing to go on.
		env.trace(`digest-no-llm images=${refs.length} — the llm service is not resolvable in this deployment (its entry must be mounted for image analysis)`)
		return undefined
	}
	const timeout = AbortSignal.timeout(env.config.timeoutMs)
	const combined = signal === undefined ? timeout : AbortSignal.any([signal, timeout])
	const content = [{ type: 'text', text: env.config.instruction }]
	for (const ref of refs) content.push({ type: 'image', attachment: ref })
	const messages = [{
		id: randomUUID(),
		role: 'user',
		source: { kind: 'plugin', plugin: 'image-router' },
		content
	}]
	const options = {
		provider: env.config.vision.provider,
		model: env.config.vision.model,
		...(env.config.vision.reasoningEffort === undefined ? {} : { reasoningEffort: env.config.vision.reasoningEffort }),
		messages,
		maxTokens: env.config.maxTokens,
		...(typeof sessionId === 'string' && sessionId.length > 0 ? { sessionId } : {}),
		signal: combined
	}
	let text = ''
	let failure
	try {		for await (const chunk of llm.stream(options)) {
			if (chunk === null || typeof chunk !== 'object') continue
			if (chunk.type === 'text-delta' && typeof chunk.text === 'string') text += chunk.text
			else if (chunk.type === 'finish' && (chunk.reason === 'error' || chunk.reason === 'aborted')) failure = chunk.reason
		}
	} catch (error) {
		failure = error?.message ?? String(error)
	}
	const trimmed = text.trim()
	if (failure !== undefined) {
		env.trace(`digest-failed reason=${failure} images=${refs.length}`)
		return undefined
	}
	if (trimmed.length === 0) {
		env.trace(`digest-empty images=${refs.length}`)
		return undefined
	}
	return trimmed
}

/**
 * Replace the images of one prompt with a text analysis of them.
 *
 * @param env - `{ ctx, config, trace }`.
 * @param request - the inbound prompt request.
 * @param signal - caller cancellation.
 * @returns a rewritten request, or `undefined` to leave the request untouched.
 */
async function rewritePrompt(env, request, signal) {
	if (request === null || typeof request !== 'object') return undefined
	const images = imageParts(request.content)
	if (images.length === 0) return undefined
	const sessionId = request.sessionId
	const attachments = typeof env.ctx.get === 'function' ? env.ctx.get('attachments') : undefined
	if (attachments === undefined || typeof attachments.admitPromptContent !== 'function') {
		env.trace('digest-skipped no attachment service')
		return undefined
	}
	let refs
	try {
		const admitted = await attachments.admitPromptContent(images)
		refs = admitted.map((part) => part?.attachment).filter((ref) => ref !== undefined)
	} catch (error) {
		env.trace(`digest-admit-failed ${error?.message ?? String(error)}`)
		return undefined
	}
	if (refs.length !== images.length) {
		env.trace(`digest-skipped admitted=${refs.length} images=${images.length}`)
		return undefined
	}
	const analysis = await analyzeImages(env, refs, sessionId, signal)
	if (analysis === undefined) {
		// Keep the images: the prompt's own path then decides, and any refusal names
		// the real reason instead of hiding it behind this plugin.
		return undefined
	}
	const names = images.map((part) => (typeof part.name === 'string' && part.name.length > 0 ? part.name : undefined)).filter((name) => name !== undefined)
	// Deliberately no file names in the visible text: a name like `shot.png` reads
	// as a path, and a model that tries to open it costs a round trip and gets a
	// confusing refusal on a route without image input.
	const header = env.config.label ? `[图片分析 · ${env.config.vision.provider}/${env.config.vision.model}${images.length > 1 ? ` · ${images.length} 张` : ''}]` : '[图片分析]'
	const replacement = { type: 'text', text: `${header}\n${analysis}` }
	let placed = false
	const content = []
	for (const part of request.content) {
		if (part !== null && typeof part === 'object' && part.type === 'image') {
			if (!placed) {
				content.push(replacement)
				placed = true
			}
			continue
		}
		content.push(part)
	}
	env.trace(`digest session=${typeof sessionId === 'string' ? sessionId : '?'} images=${images.length} chars=${analysis.length}${names.length === 0 ? '' : ` names=${names.join(',')}`}`)
	return { ...request, content }
}

/**
 * Whether one model's metadata says it accepts images.
 *
 * An explicit declaration wins in both directions: a route that declares its
 * modalities answers the question, and one that describes a text-only model
 * keeps it out even when its id looks like a vision model. Only silence falls
 * back to the id, because a catalog route may simply not disclose the field.
 *
 * @param model - model metadata from `llm.listModels()`.
 * @returns whether this model should be offered as a vision route.
 */
export function modelAcceptsImages(model) {
	const modalities = model?.inputModalities
	if (Array.isArray(modalities) && modalities.length > 0) return modalities.includes('image')
	return IMAGE_MODEL_HINTS.test(String(model?.id ?? ''))
}

/**
 * The capability oracle behind the plugin card's model picker.
 *
 * The card runs in the browser, where the only model-shaped call available is
 * `remote.llm.discoverModels(settingsNs, request)`. Registering a discovery
 * handler for this plugin's own namespace is what makes that call answer with
 * the thing the card actually needs — the image-capable models of a route —
 * instead of every model the route serves. It also keeps the filtering where
 * the capability data lives: only the Host can read `inputModalities`.
 *
 * Read-only and failure-tolerant: an unknown or unreachable route answers with
 * an empty list, and the probe refuses to hang on one bad route.
 *
 * @param provider - route to inspect.
 * @param llmCtx - a context carrying the `llm` service.
 * @param trace - audit writer.
 * @param signal - caller cancellation.
 * @returns the image-capable models of that route.
 */
export async function discoverVisionModels(provider, llmCtx, trace = () => {}, signal) {
	const id = typeof provider === 'string' && provider.trim().length > 0 ? provider.trim() : undefined
	if (id === undefined) return []
	// A route that is not registered (or a deployment without the llm service)
	// has nothing to advertise; that is an answer, not a failure.
	const llm = llmCtx !== undefined && typeof llmCtx.get === 'function' ? llmCtx.get('llm') : undefined
	if (llm === undefined || typeof llm.listModels !== 'function') {
		trace(`discover-no-llm provider=${id}`)
		return []
	}
	let models
	try {
		models = await llm.listModels(id)
	} catch (error) {
		trace(`discover-failed provider=${id} ${String(error)}`)
		return []
	}
	const visible = []
	for (const model of models ?? []) {
		if (model === null || typeof model !== 'object' || typeof model.id !== 'string' || model.id.length === 0) continue
		if (!modelAcceptsImages(model)) continue
		visible.push({
			id: model.id,
			...(typeof model.name === 'string' && model.name.length > 0 ? { name: model.name } : {})
		})
		if (visible.length >= 50) break
		if (signal?.aborted === true) break
	}
	trace(`discover provider=${id} models=${models?.length ?? 0} imageCapable=${visible.length}`)
	return visible
}

/** Model-facing tool name for the on-demand analysis of one image file. */
const TOOL_NAME = 'describe_image'
/** Model-facing tool description: when to reach for it instead of `read_image`. */
const TOOL_DESCRIPTION = [
	'Analyse an image file with the deployment\'s vision model and return the analysis as text: the text visible in the image, then a description of what it shows.',
	'Use it for an image the current model cannot accept directly, or when only the image\'s content in words is needed — it works on any model because the image never enters this conversation.',
	'Accepts PNG/JPEG/WebP/GIF, including extension-less files whose bytes are one of those formats.',
	'Independent files may be described concurrently.'
].join(' ')

/** Sniff the supported image formats from their magic bytes. */
export function imageMediaTypeFromBytes(bytes) {
	if (!(bytes instanceof Uint8Array) || bytes.length < 12) return undefined
	if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'image/png'
	if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg'
	if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38) return 'image/gif'
	if (bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) return 'image/webp'
	return undefined
}

/**
 * Register `describe_image`: read one image through the deployment filesystem,
 * persist it, and answer with the vision route's text analysis.
 *
 * The image is analysed out of band, so this works on a session whose model
 * declares no image input at all — which is exactly the gap `read_image` leaves
 * (`read_image` gates on the calling route's modalities).
 *
 * @param ctx - Cordis plugin context carrying `tools`, `fs`, and `attachments`.
 * @param config - resolved configuration.
 * @param trace - audit writer.
 */
function registerDescribeTool(env) {
	/**
	 * Injected rather than read: a plugin's `apply` runs while the tree is still
	 * settling, so `ctx.get('tools')` is legitimately empty at this point — the
	 * same reason the session controller is injected below.
	 */
	env.ctx.inject(['tools'], (runtimeCtx) => {
		try {
			const tools = typeof runtimeCtx.get === 'function' ? runtimeCtx.get('tools') : runtimeCtx.tools
			if (tools === undefined || typeof tools.register !== 'function') {
				env.trace('tool-skipped no tools service')
				return
			}
			registerDescribeDefinition(runtimeCtx, tools, env)
		} catch (error) {
			runtimeCtx.logger?.warn?.(`image-router: ${TOOL_NAME} was not registered: ${String(error)}`)
			env.trace(`tool-failed ${String(error)}`)
		}
	})
}

/** Build and register the tool definition on a context whose tools service is live. */
function registerDescribeDefinition(ctx, tools, env) {
	const definition = {
		name: TOOL_NAME,
		description: TOOL_DESCRIPTION,
		parameters: {
			type: 'object',
			additionalProperties: false,
			properties: {
				file_path: {
					type: 'string',
					description: 'Path to the image file, resolved by the filesystem backend.'
				},
				question: {
					type: 'string',
					description: 'What to ask about this image; omit for the default transcript-and-describe analysis.'
				}
			},
			required: ['file_path']
		},
		output: {
			schema: { type: 'string' },
			render: (_args, value) => [{ type: 'text', text: value }]
		},
		async execute(args, exec) {
			const requested = typeof args?.file_path === 'string' ? args.file_path.trim() : ''
			if (requested.length === 0) throw new Error('file_path must be a non-empty string')
			const fs = typeof ctx.get === 'function' ? ctx.get('fs') : ctx.fs
			const attachments = typeof ctx.get === 'function' ? ctx.get('attachments') : ctx.attachments
			if (fs === undefined || typeof fs.resolve !== 'function') throw new Error(`${TOOL_NAME}: no filesystem service is mounted`)
			if (attachments === undefined || typeof attachments.saveImage !== 'function') throw new Error(`${TOOL_NAME}: no attachment service is mounted`)

			const cwd = exec?.agent?.session?.header?.cwd
			const target = await fs.resolve(requested, {
				...(typeof cwd === 'string' && cwd.length > 0 ? { cwd } : {}),
				signal: exec?.signal
			})
			const info = await fs.stat(target, exec?.signal)
			if (info === undefined) throw new Error(`cannot describe "${target.displayPath}": not found`)
			if (info.type !== 'file') throw new Error(`cannot describe "${target.displayPath}": not a regular file`)

			const limits = attachments.imageLimits ?? {}
			const byteCap = Math.min(limits.maxImageBytes ?? 20971520, limits.maxMessageImageBytes ?? 209715200)
			const data = await fs.readBytes(target, exec?.signal, byteCap)
			const mediaType = imageMediaTypeFromBytes(data)
			if (mediaType === undefined) throw new Error(`cannot describe "${target.displayPath}": the file content is not a supported PNG/JPEG/WebP/GIF image`)
			if (Array.isArray(limits.mediaTypes) && !limits.mediaTypes.includes(mediaType)) throw new Error(`cannot describe "${target.displayPath}": ${mediaType} images are not accepted by this deployment`)

			const name = basename(target.displayPath) || 'image'
			const reference = await attachments.saveImage({ data, mediaType, name })
			const question = typeof args?.question === 'string' ? args.question.trim() : ''
			const config = env.config
			const instruction = question.length === 0 ? config.instruction : `${config.instruction}\n\n针对这次请求的额外要求：${question}`
			const sessionId = exec?.agent?.session?.header?.id
			const analysis = await analyzeImages({ ctx, config: { ...config, instruction }, trace: env.trace }, [reference], typeof sessionId === 'string' ? sessionId : undefined, exec?.signal)
			if (analysis === undefined) throw new Error(`${TOOL_NAME}: the vision model produced no analysis (see the plugin audit file for the reason)`)
			env.trace(`tool session=${typeof sessionId === 'string' ? sessionId : '?'} path=${target.displayPath} mediaType=${mediaType} bytes=${data.length} chars=${analysis.length}${question.length === 0 ? '' : ' question=yes'}`)
			return analysis
		}
	}
	ctx.effect(() => tools.register(definition), 'image-router: describe_image tool')
	env.trace(`tool-registered name=${TOOL_NAME} vision=${env.config.vision.provider}/${env.config.vision.model}`)
}

/** Warn and audit one unusable selection API; `undefined` stops the mount. */
function unavailableSelection(controller, ctx, trace) {
	const detail = `controller.selectionFor=${typeof controller.selectionFor} controller.agents=${typeof controller.agents} inner.selectionFor=${typeof controller.agents?.selectionFor}`
	ctx.logger?.warn?.('image-router: disabled — no session model-selection API on sessionController or sessionController.agents')
	trace(`mount-skipped no selection API ${detail}`)
	return undefined
}

/** Wrap `prompt` so image prompts are digested by the vision route (no model switching). */
function digestWrapper(env, original) {
	return async function digestingPrompt(...args) {
		const request = args[0]
		try {
			const images = imageParts(request?.content)
			if (images.length > 0) {
				if (env.config.dryRun) env.trace(`digest-dryRun session=${request?.sessionId ?? '?'} images=${images.length}`)
				else {
					const rewritten = await rewritePrompt(env, request, args[1])
					if (rewritten !== undefined) return original.apply(this, [rewritten, ...args.slice(1)])
				}
			}
		} catch (error) {
			env.ctx.logger?.warn?.(`image-router: digest skipped: ${String(error)}`)
			const frame = typeof error?.stack === 'string' ? error.stack.split('\n')[1]?.trim() : undefined
			env.trace(`session=${request?.sessionId ?? '?'} error=${error?.message ?? String(error)}${frame === undefined ? '' : ` at=${frame}`}`)
		}
		return original.apply(this, args)
	}
}

/**
 * Wrap `prompt` so image turns are lent the vision route and restored afterwards.
 *
 * @returns the wrapper, or `undefined` when the selection API is unavailable.
 */
function switchWrapper(env, controller, original) {
	const ctx = env.ctx
	const trace = env.trace
	const selection = selectionApi(controller)
	if (selection === undefined) return unavailableSelection(controller, ctx, trace)

	/**
	 * Route lent to each session, so the previous selection can be restored, and
	 * the image-free turns still held on it. Keyed by session id rather than by the
	 * agent object, so a controller that hands back a fresh agent wrapper per call
	 * still resumes the same state; entries live only while a route is lent.
	 */
	const lent = new Map()
	const held = new Map()
	/** Resolved route cache: each route is validated against the adapter registry once. */
	const resolvedRoutes = new Map()
	/** Targets that already failed validation, so each failure logs once. */
	const failedRoutes = new Set()

	const resolveRoute = async (route) => {
		const key = `${route.provider}\u0000${route.model}\u0000${route.reasoningEffort ?? ''}`
		const cached = resolvedRoutes.get(key)
		if (cached !== undefined) return cached
		const llm = typeof ctx.get === 'function' ? ctx.get('llm') : undefined
		let selected = route
		if (llm !== undefined && typeof llm.resolveCallConfig === 'function') {
			const callConfig = await llm.resolveCallConfig({
				provider: route.provider,
				model: route.model,
				...(route.reasoningEffort === undefined ? {} : { reasoningEffort: route.reasoningEffort })
			})
			selected = {
				provider: callConfig.provider,
				model: callConfig.model,
				...(callConfig.reasoningEffort === undefined ? {} : { reasoningEffort: callConfig.reasoningEffort })
			}
		}
		resolvedRoutes.set(key, selected)
		return selected
	}

	/** Install one route for the session's next request, or give up with one warning. */
	const install = async (agent, sessionId, route, reason, current) => {
		const config = env.config
		const key = `${route.provider}\u0000${route.model}\u0000${route.reasoningEffort ?? ''}`
		if (failedRoutes.has(key)) return false
		let selected
		try {
			selected = await resolveRoute(route)
		} catch (error) {
			failedRoutes.add(key)
			ctx.logger?.warn?.(`image-router: cannot route ${reason} turn to ${route.provider}/${route.model}: ${String(error)}`)
			trace(`session=${sessionId} ${reason}-failed target=${route.provider}/${route.model} error=${String(error)}`)
			return false
		}
		if (sameModel(current, selected)) return false
		if (config.dryRun) {
			ctx.logger?.info?.(`image-router: [dryRun] ${reason} turn would use ${selected.provider}/${selected.model}`)
			trace(`session=${sessionId} ${reason}-dryRun from=${current.provider}/${current.model} to=${selected.provider}/${selected.model}`)
			return false
		}
		selection.selectForNextRequest(agent, selected)
		ctx.logger?.info?.(`image-router: ${reason} turn → ${selected.provider}/${selected.model}`)
		trace(`session=${sessionId} ${reason} from=${current.provider}/${current.model} to=${selected.provider}/${selected.model}`)
		return true
	}

	const routeForPrompt = async (request) => {
		if (request === null || typeof request !== 'object') return
		const sessionId = request.sessionId
		if (typeof sessionId !== 'string' || sessionId.length === 0) return
		// One snapshot per prompt: the configuration in force when the turn arrives.
		const config = env.config
		const resolvedAgent = await resolveAgent(selection, sessionId)
		if (resolvedAgent.error !== undefined) {
			// The prompt being routed is what creates this session's first agent, so a
			// cold session has none yet: leave this one turn unrouted.
			trace(`session=${sessionId} resolve-skipped ${String(resolvedAgent.error)}`)
			return
		}
		const agent = resolvedAgent.agent
		const current = selection.selectionFor(agent).current
		const wantsVision = promptWantsVision(request.content, config.imageExtensions, config.hint)
		if (!wantsVision) {
			// A turn that needs no vision first burns one held turn.
			const remaining = held.get(sessionId)
			if (remaining !== undefined && remaining > 0) {
				held.set(sessionId, remaining - 1)
				trace(`session=${sessionId} hold remaining=${remaining - 1}`)
				return
			}
		}
		const decision = decideRoute({
			content: request.content,
			current,
			lent: lent.get(sessionId),
			vision: config.vision,
			text: config.text,
			sticky: config.sticky,
			extensions: config.imageExtensions,
			hint: config.hint
		})
		if (decision === undefined) return
		if (decision.action === 'forget') {
			lent.delete(sessionId)
			held.delete(sessionId)
			ctx.logger?.info?.('image-router: the model was changed by hand — releasing the lent route')
			trace(`session=${sessionId} forget current=${current.provider}/${current.model}`)
			return
		}
		if (decision.action === 'release') {
			lent.delete(sessionId)
			held.delete(sessionId)
			await install(agent, sessionId, decision.route, decision.reason, current)
			return
		}
		const installed = await install(agent, sessionId, decision.route, decision.reason, current)
		if (!installed) return
		lent.set(sessionId, { ...current })
		if (config.holdTurns > 0) held.set(sessionId, config.holdTurns)
	}

	/**
	 * The wrapper forwards every argument positionally and preserves `this`, so
	 * the gateway's own invocation keeps working unchanged. Routing failures are
	 * swallowed on purpose: the prompt must still be admitted.
	 */
	return async function routingPrompt(...args) {
		try {
			await routeForPrompt(args[0])
		} catch (error) {
			ctx.logger?.warn?.(`image-router: routing skipped: ${String(error)}`)
			const frame = typeof error?.stack === 'string' ? error.stack.split('\n')[1]?.trim() : undefined
			trace(`session=${args[0]?.sessionId ?? '?'} error=${error?.message ?? String(error)}${frame === undefined ? '' : ` at=${frame}`}`)
		}
		return original.apply(this, args)
	}
}

/**
 * Resolve the session model-selection API (switch mode only).
 *
 * `ctx.sessionController` is the Typert Remote facade. Two traps live here: its
 * `resolveAgent` is the Remote-facing variant, which does not hand back the live
 * agent the selection primitives need, and the primitives themselves live on its
 * internal `agents` member — a different object from the root-level `agents`
 * service, which is the Agent registry and carries none of them. The internal
 * member is therefore preferred whenever it carries the whole trio; a facade
 * that re-exports the primitives stays supported.
 *
 * @param controller - the injected session controller service.
 * @returns `{ source, selectionFor, selectForNextRequest }`, or `undefined`.
 */
function selectionApi(controller) {
	const inner = controller.agents
	if (inner !== null && typeof inner === 'object' && typeof inner.selectionFor === 'function' && typeof inner.selectForNextRequest === 'function' && typeof inner.resolveAgent === 'function') {
		return {
			source: inner,
			selectionFor: inner.selectionFor.bind(inner),
			selectForNextRequest: inner.selectForNextRequest.bind(inner)
		}
	}
	if (typeof controller.selectionFor === 'function' && typeof controller.selectForNextRequest === 'function' && typeof controller.resolveAgent === 'function') {
		return {
			source: controller,
			selectionFor: controller.selectionFor.bind(controller),
			selectForNextRequest: controller.selectForNextRequest.bind(controller)
		}
	}
	return undefined
}

/**
 * Resolve the live agent for one session.
 *
 * `resolveAgent` answers `{ agent }` or `{ error }` — never a bare agent, and the
 * Remote-facing variant may answer neither. A session without a live agent yet
 * (the first prompt after a restart) answers `{ error }`, because the very prompt
 * being routed is what creates it; that turn is left unrouted instead of failing.
 *
 * @param api - the resolved selection API.
 * @param sessionId - session whose agent is needed.
 * @returns `{ agent }` or `{ error }`.
 */
async function resolveAgent(api, sessionId) {
	const found = await api.source.resolveAgent(sessionId)
	if (found === undefined || found === null) return { error: 'resolveAgent returned nothing' }
	if (found.error !== undefined) return { error: found.error }
	const agent = found.agent ?? found
	if (agent === null || typeof agent !== 'object' || agent.session === undefined) return { error: 'resolveAgent returned no live agent' }
	return { agent }
}

/**
 * Mount the router.
 *
 * Never throws: a service the plugin does not recognize or a configuration it
 * cannot use disables routing with a warning instead of failing the profile.
 *
 * @param ctx - Cordis plugin context; the session controller is injected optionally.
 * @param rawConfig - Patch configuration.
 */
/**
 * Compose the loader configuration with the settings-section override layer.
 *
 * A schema may materialize an unset optional object as `{}` and an unset optional
 * array as `[]`; those are "unset", not "set to empty", so they never enter the
 * layer. Returns `undefined` when there is nothing to override.
 *
 * @param raw - the configuration the loader composed for this entry.
 * @param overrides - the live settings section, when one is mounted.
 * @returns the merged configuration, or `undefined` for "no overrides".
 */
function mergeOverrides(raw, overrides) {
	if (overrides === undefined || overrides === null) return undefined
	const layer = {}
	for (const [key, value] of Object.entries(overrides)) {
		if (value === undefined || value === null) continue
		if (typeof value === 'string' && value.length === 0) continue
		if (Array.isArray(value) && value.length === 0) continue
		if (typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 0) continue
		layer[key] = value
	}
	if (Object.keys(layer).length === 0) return undefined
	return { ...raw, ...layer }
}

/**
 * The plugin's live view of its own configuration.
 *
 * `config` is a getter rather than a snapshot, so every decision reads the
 * configuration in force at that moment: a change saved on the plugin
 * configuration page reaches the next prompt, the next side call and the next
 * tool call without a restart. An override that does not validate is ignored in
 * favour of the last good configuration — a mistyped GUI edit must not be able to
 * break a router that was working.
 *
 * @param ctx - the plugin context (rebound to the injected scope before mount).
 * @param raw - the loader-composed configuration.
 * @param resolved - that configuration, already normalized.
 * @param trace - audit writer.
 * @returns the environment the wrappers and the tool share.
 */
function createEnv(ctx, raw, resolved, trace) {
	let overrides
	let lastGood = resolved
	let active = ctx
	return {
		trace,
		/** Replace the settings override layer; `undefined` restores the composed config. */
		setOverrides(values) {
			overrides = values
		},
		/** Rebind the context the wrappers use, once the session scope is injected. */
		bindCtx(next) {
			active = next
		},
		get ctx() {
			return active
		},
		get config() {
			const merged = mergeOverrides(raw, overrides)
			if (merged === undefined) return lastGood
			const next = normalizeConfig(merged)
			if (next.problems !== undefined) {
				trace(`settings-invalid ${next.problems.join('; ')}`)
				return lastGood
			}
			lastGood = next
			return next
		}
	}
}

/**
 * The editable subset of a resolved configuration, used as the settings section's
 * composition base so the card shows the values actually in force.
 *
 * @param resolved - a normalized configuration.
 * @returns the schema-shaped subset.
 */
function configBase(resolved) {
	return {
		enabled: resolved.enabled,
		mode: resolved.mode,
		sticky: resolved.sticky,
		vision: resolved.endpoint === undefined ? resolved.vision : { ...resolved.vision, endpoint: resolved.endpoint },
		...(resolved.text === undefined ? {} : { text: resolved.text }),
		instruction: resolved.instruction,
		maxTokens: resolved.maxTokens,
		timeoutMs: resolved.timeoutMs,
		label: resolved.label,
		tool: resolved.tool,
		dryRun: resolved.dryRun,
		holdTurns: resolved.holdTurns,
		imageExtensions: resolved.imageExtensions,
		...(resolved.hint === undefined ? {} : { hint: resolved.hint }),
		...(resolved.traceFile === undefined ? {} : { traceFile: resolved.traceFile })
	}
}

export function apply(ctx, rawConfig) {
	const resolved = normalizeConfig(rawConfig)
	const trace = createTrace(resolved.traceFile)
	if (resolved.problems !== undefined) {
		ctx.logger?.warn?.(`image-router: disabled — ${resolved.problems.join('; ')}`)
		trace(`apply-disabled problems=${resolved.problems.join('; ')}`)
		return
	}
	if (!resolved.enabled) {
		ctx.logger?.info?.('image-router: disabled by configuration')
		trace('apply-disabled by-config')
		return
	}
	trace(`apply-entered mode=${resolved.mode} vision=${resolved.vision.provider}/${resolved.vision.model} schema=${schemaForm}`)
	const env = createEnv(ctx, rawConfig === null || rawConfig === undefined ? {} : rawConfig, resolved, trace)

	/**
	 * Upstream services the endpoint tier writes through, filled by the optional
	 * injection below. Held here rather than in `env` because they are a
	 * deployment fact, not part of the routing configuration.
	 */
	const services = { trace }

	/** Last endpoint configuration pushed upstream, so an unchanged section is a no-op. */
	let lastEndpointSignature
	/** Serializes syncs: the settings watch and the service injection can both fire. */
	let syncChain = Promise.resolve()

	/**
	 * Ask the llm service whether it now serves the route this card wrote.
	 *
	 * Read-only and best-effort: the model may legitimately be unresolvable for a
	 * moment after the settings write (the adapter re-registers on its own
	 * schedule), and a routing failure here must never look like a plugin
	 * failure. The audit line is the whole point — it turns "is my endpoint
	 * actually live?" into something the user can read.
	 */
	const probeDerivedRoute = async () => {
		try {
			const llm = typeof env.ctx.get === 'function' ? env.ctx.get('llm') : undefined
			if (llm === undefined || typeof llm.resolveModelInfo !== 'function') return
			const info = await llm.resolveModelInfo(ENDPOINT_PROVIDER, env.config.vision.model)
			const modalities = Array.isArray(info?.inputModalities) ? info.inputModalities.join('+') : 'unknown'
			trace(`endpoint-route-live provider=${ENDPOINT_PROVIDER} model=${env.config.vision.model} modalities=${modalities}`)
		} catch (error) {
			trace(`endpoint-route-not-live-yet ${String(error)}`)
		}
	}

	/**
	 * Push the endpoint tier to the upstream services when it differs from what
	 * was pushed last.
	 *
	 * Two properties matter here:
	 *
	 *  - **The key stays write-only, and the shared config is never mutated.**
	 *    The key is stripped from a *copy* before the sync; editing the resolved
	 *    configuration in place would strip it for every other reader of the same
	 *    object (the settings watch and the service injection both read it).
	 *  - **The key is not part of the signature.** It only decides whether a
	 *    credential write happens, so adding or clearing it must not make the
	 *    derived route look changed.
	 *
	 * @param reason - short label for the audit line.
	 * @returns the outcome string, for the audit line.
	 */
	const syncEndpointTier = (reason) => {
		syncChain = syncChain.then(async () => {
			try {
				const configured = env.config.endpoint
				if (configured === undefined) {
					if (lastEndpointSignature === '') return 'endpoint-unchanged'
					const outcome = await syncEndpoint(services, undefined)
					lastEndpointSignature = ''
					trace(`endpoint-result reason=${reason} ${outcome}`)
					return outcome
				}
				const { apiKey, ...secretless } = configured
				const signature = JSON.stringify(secretless)
				if (signature === lastEndpointSignature) return 'endpoint-unchanged'
				const outcome = await syncEndpoint(services, { ...secretless, ...(apiKey === undefined ? {} : { apiKey }) })
				// Remember the signature only when the upstream write really happened.
				// A sync that ran before the settings service was available must stay
				// eligible, or the endpoint would be configured in the card and never
				// reach pi-ai for the lifetime of the process.
				lastEndpointSignature = outcome.startsWith('endpoint-route-ok') ? signature : undefined
				trace(`endpoint-result reason=${reason} ${outcome} keyProvided=${apiKey === undefined ? 'no' : 'yes'}`)
				// One resolving probe, so the audit answers the question a user actually
				// has next: did the upstream adapter accept the route this card wrote?
				// It writes nothing and is skipped when the route is not live yet.
				if (outcome.startsWith('endpoint-route-ok')) await probeDerivedRoute()
				return outcome
			} catch (error) {
				trace(`endpoint-sync-failed reason=${reason} ${String(error)}`)
				return `endpoint-sync-failed ${String(error)}`
			}
		})
		return syncChain
	}

	/**
	 * The on-demand tool is registered on its own, before (and independently of)
	 * the session controller: it needs only `tools` + `fs` + `attachments`, so it
	 * also works in a profile whose entry points never prompt through the Web
	 * session controller (headless, sdk, acp).
	 */
	if (resolved.tool) registerDescribeTool(env)

	/** The editable namespace; a saved change reaches the next decision, not the next boot. */
	installSettings(env, Config, configBase(resolved), () => {
		void syncEndpointTier('settings-changed')
	})

	/**
	 * Optional injection: the endpoint tier writes through the settings and
	 * credentials services, so it must wait for all three. Injecting `llm` alone
	 * is a real trap — this factory runs at entry-activation time, before the
	 * settings namespace is registered, so `get('settings')` answers `undefined`
	 * and the endpoint tier silently does nothing in a deployment that has it.
	 *
	 * Nothing is registered with `llm` here: the custom endpoint is written as a
	 * pi-ai route profile, and pi-ai owns the wire protocol, discovery, image
	 * projection and retry for it. A deployment that mounts no settings or no
	 * credentials simply never runs this factory, and the explicit
	 * `vision.provider/model` route keeps working.
	 */
	ctx.inject(['llm', 'settings', 'credentials'], async (tierCtx) => {
		try {
			services.settings = tierCtx.get('settings')
			services.credentials = tierCtx.get('credentials')
			/**
			 * Reads the route profile this card owns, so a save preserves whatever
			 * the Models page added to it (headers, compat, timeouts).
			 *
			 * `settings.get(ns)` is the service's resolved-value read; a read failure
			 * is not fatal, and the write then behaves as it did before the merge.
			 */
			services.readProfile = () => {
				const settings = services.settings
				if (settings === undefined || typeof settings.get !== 'function') return undefined
				try {
					const value = settings.get('llm-pi-ai')
					const profile = value !== null && typeof value === 'object' && !Array.isArray(value) ? value.providers?.[ENDPOINT_PROVIDER] : undefined
					return profile !== null && typeof profile === 'object' && !Array.isArray(profile) ? profile : undefined
				} catch (error) {
					trace(`endpoint-read-profile-failed ${String(error)}`)
					return undefined
				}
			}
			tierCtx.effect(() => () => {
				delete services.settings
				delete services.credentials
				delete services.readProfile
			}, 'image-router: endpoint services')
			trace(`endpoint-services settings=${services.settings === undefined ? 'no' : 'yes'} credentials=${services.credentials === undefined ? 'no' : 'yes'}`)
			await syncEndpointTier('apply')
		} catch (error) {
			trace(`endpoint-services-failed ${String(error)}`)
		}
	})

	/**
	 * The capability oracle the card's model picker calls.
	 *
	 * `remote.llm.discoverModels(settingsNs, request)` is the only model-shaped
	 * call a browser plugin has, and it answers per namespace. Registering this
	 * plugin's own namespace is therefore what lets the card ask "which of this
	 * route's models actually take images?" — a question only the Host can
	 * answer, since `inputModalities` never crosses to the browser.
	 *
	 * Optional injection: a deployment without the llm service simply never
	 * registers, the card's discovery call fails, and it falls back to the
	 * route's whole model list with a caveat.
	 */
	ctx.inject(['llm'], (llmCtx) => {
		try {
			const llm = llmCtx.get('llm')
			if (llm === undefined || typeof llm.registerModelDiscovery !== 'function') {
				trace('vision-oracle-skipped no llm service')
				return
			}
			llmCtx.effect(() => llm.registerModelDiscovery(SETTINGS_NAMESPACE, (request, signal) => {
				const provider = request !== null && typeof request === 'object' ? request.provider : undefined
				return discoverVisionModels(provider, llmCtx, trace, signal)
			}), 'image-router: vision model oracle')
			trace(`vision-oracle-registered ns=${SETTINGS_NAMESPACE}`)
		} catch (error) {
			trace(`vision-oracle-failed ${String(error)}`)
		}
	})

	/**
	 * Optional injection, not a required dependency. `sessionController` ships
	 * with the Web app bundle, so a profile that has no session controller
	 * (headless, sdk, acp) must still activate this entry: a required dependency
	 * would leave the entry pending, and DSH aborts the boot with
	 * "1 entry did not activate". `ctx.inject` lets the entry activate now and
	 * the routing wiring appear whenever the service does.
	 */
	ctx.inject(['sessionController'], (sessionCtx) => {
		trace('inject-fired')
		try {
			env.bindCtx(sessionCtx)
			mount(env)
		} catch (error) {
			sessionCtx.logger?.warn?.(`image-router: disabled — ${String(error)}`)
			trace(`mount-threw ${String(error)}`)
		}
	})
}

/** Wire the router onto a context whose session controller is available. */
function mount(env) {
	const ctx = env.ctx
	const trace = env.trace
	const resolved = env.config
	const controller = ctx.sessionController
	if (controller === null || typeof controller !== 'object' || typeof controller.prompt !== 'function') {
		ctx.logger?.warn?.('image-router: disabled — sessionController.prompt is unavailable in this deployment')
		trace('mount-skipped sessionController.prompt unavailable')
		return
	}
	const original = controller.prompt
	const routed = resolved.mode === 'digest' ? digestWrapper(env, original) : switchWrapper(env, controller, original)
	if (routed === undefined) return

	controller.prompt = routed
	ctx.effect(() => () => {
		if (controller.prompt === routed) controller.prompt = original
	}, 'image-router: session prompt router')

	if (resolved.mode === 'digest') {
		ctx.logger?.info?.(`image-router: mounted in digest mode — images are analysed by ${resolved.vision.provider}/${resolved.vision.model} and replaced with text; the session model is never changed`)
		trace(`mounted mode=digest vision=${resolved.vision.provider}/${resolved.vision.model} maxTokens=${resolved.maxTokens} timeoutMs=${resolved.timeoutMs} label=${resolved.label} dryRun=${resolved.dryRun}`)
		return
	}
	ctx.logger?.info?.(`image-router: mounted in switch mode — image turns → ${resolved.vision.provider}/${resolved.vision.model}${resolved.sticky ? ' (sticky: the lent route is never released)' : `, released after ${resolved.holdTurns} image-free turn(s)`}${resolved.dryRun ? ' [dryRun]' : ''}`)
	trace(`mounted mode=switch vision=${resolved.vision.provider}/${resolved.vision.model} text=${resolved.text === undefined ? '-' : `${resolved.text.provider}/${resolved.text.model}`} sticky=${resolved.sticky} holdTurns=${resolved.holdTurns} dryRun=${resolved.dryRun}`)
}

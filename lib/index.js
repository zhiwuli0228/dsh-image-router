/**
 * dsh-vision-router — image work without touching the session's model.
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
 * @module dsh-vision-router
 */

import { randomUUID } from 'node:crypto'
import { appendFileSync } from 'node:fs'
import { basename } from 'node:path'

/** Plugin name shown by the loader and the plugin inventory. */
export const name = 'vision-router'

/** Routing modes: `digest` never changes the session model; `switch` lends it. */
const MODES = new Set(['digest', 'switch'])

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
 * Cordis consumes a plugin schema through the Standard Schema interface only
 * (`cordis/lib/index.js`: `runtime.Config['~standard'].validate(config)`), so the
 * form below is what the loader actually needs. Schemastery is used when the
 * deployment provides it — a normal install, where the package resolves inside a
 * profile whose `node_modules` already carries it — and an equivalent Standard
 * Schema supplies the same defaults otherwise. That fallback is what keeps a
 * plugin mounted **by absolute path** loadable: Node resolves bare specifiers
 * from a module's real path, and a checkout outside any `node_modules` tree has
 * no schemastery to import.
 *
 * Shape only, and deliberately permissive: every field is optional, so the loader
 * never rejects a deployment's config and `apply` keeps owning the semantics
 * (normalizeConfig disables the plugin with a readable warning rather than
 * failing the boot). Configuration is validated semantically in
 * {@link normalizeConfig}.
 */
export const Config = await loadConfigSchema()

/** Load the schemastery schema when available, else the dependency-free equivalent. */
async function loadConfigSchema() {
	let z
	try {
		z = (await import('@deepseek-ai/schemastery')).default
	} catch {
		z = undefined
	}
	if (z === undefined || typeof z.object !== 'function') {
		return {
			'~standard': {
				version: 1,
				vendor: 'dsh-vision-router',
				validate: (value) => ({ value: { ...CONFIG_DEFAULTS, ...(value === null || value === undefined ? {} : value) } })
			}
		}
	}
	return z.object({
		enabled: z.boolean().default(CONFIG_DEFAULTS.enabled),
		mode: z.string().default(CONFIG_DEFAULTS.mode),
		sticky: z.boolean().default(CONFIG_DEFAULTS.sticky),
		vision: z.object({
			provider: z.string(),
			model: z.string(),
			reasoningEffort: z.string()
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

	const vision = readRoute(config.vision, 'vision', problems)
	const text = readRoute(config.text, 'text', problems)
	if (vision === undefined) problems.push('vision (the image-capable route) is required — set it where this plugin is mounted, e.g. vision: { provider: <provider>, model: <model> }')

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
	return { enabled, mode, sticky, vision, text, dryRun, holdTurns, imageExtensions, hint, instruction, maxTokens, timeoutMs, label, tool, traceFile }
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
	if (llm === undefined || typeof llm.stream !== 'function') return undefined
	const timeout = AbortSignal.timeout(env.config.timeoutMs)
	const combined = signal === undefined ? timeout : AbortSignal.any([signal, timeout])
	const content = [{ type: 'text', text: env.config.instruction }]
	for (const ref of refs) content.push({ type: 'image', attachment: ref })
	const messages = [{
		id: randomUUID(),
		role: 'user',
		source: { kind: 'plugin', plugin: 'vision-router' },
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
	try {
		for await (const chunk of llm.stream(options)) {
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
function registerDescribeTool(ctx, config, trace) {
	/**
	 * Injected rather than read: a plugin's `apply` runs while the tree is still
	 * settling, so `ctx.get('tools')` is legitimately empty at this point — the
	 * same reason the session controller is injected below.
	 */
	ctx.inject(['tools'], (runtimeCtx) => {
		try {
			const tools = typeof runtimeCtx.get === 'function' ? runtimeCtx.get('tools') : runtimeCtx.tools
			if (tools === undefined || typeof tools.register !== 'function') {
				trace('tool-skipped no tools service')
				return
			}
			registerDescribeDefinition(runtimeCtx, tools, config, trace)
		} catch (error) {
			runtimeCtx.logger?.warn?.(`vision-router: ${TOOL_NAME} was not registered: ${String(error)}`)
			trace(`tool-failed ${String(error)}`)
		}
	})
}

/** Build and register the tool definition on a context whose tools service is live. */
function registerDescribeDefinition(ctx, tools, config, trace) {
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
			const instruction = question.length === 0 ? config.instruction : `${config.instruction}\n\n针对这次请求的额外要求：${question}`
			const sessionId = exec?.agent?.session?.header?.id
			const analysis = await analyzeImages({ ctx, config: { ...config, instruction }, trace }, [reference], typeof sessionId === 'string' ? sessionId : undefined, exec?.signal)
			if (analysis === undefined) throw new Error(`${TOOL_NAME}: the vision model produced no analysis (see the plugin audit file for the reason)`)
			trace(`tool session=${typeof sessionId === 'string' ? sessionId : '?'} path=${target.displayPath} mediaType=${mediaType} bytes=${data.length} chars=${analysis.length}${question.length === 0 ? '' : ' question=yes'}`)
			return analysis
		}
	}
	ctx.effect(() => tools.register(definition), 'vision-router: describe_image tool')
	trace(`tool-registered name=${TOOL_NAME} vision=${config.vision.provider}/${config.vision.model}`)
}

/** Warn and audit one unusable selection API; `undefined` stops the mount. */
function unavailableSelection(controller, ctx, trace) {
	const detail = `controller.selectionFor=${typeof controller.selectionFor} controller.agents=${typeof controller.agents} inner.selectionFor=${typeof controller.agents?.selectionFor}`
	ctx.logger?.warn?.('vision-router: disabled — no session model-selection API on sessionController or sessionController.agents')
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
			env.ctx.logger?.warn?.(`vision-router: digest skipped: ${String(error)}`)
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
function switchWrapper(ctx, controller, original, config, trace) {
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
		const key = `${route.provider}\u0000${route.model}\u0000${route.reasoningEffort ?? ''}`
		if (failedRoutes.has(key)) return false
		let selected
		try {
			selected = await resolveRoute(route)
		} catch (error) {
			failedRoutes.add(key)
			ctx.logger?.warn?.(`vision-router: cannot route ${reason} turn to ${route.provider}/${route.model}: ${String(error)}`)
			trace(`session=${sessionId} ${reason}-failed target=${route.provider}/${route.model} error=${String(error)}`)
			return false
		}
		if (sameModel(current, selected)) return false
		if (config.dryRun) {
			ctx.logger?.info?.(`vision-router: [dryRun] ${reason} turn would use ${selected.provider}/${selected.model}`)
			trace(`session=${sessionId} ${reason}-dryRun from=${current.provider}/${current.model} to=${selected.provider}/${selected.model}`)
			return false
		}
		selection.selectForNextRequest(agent, selected)
		ctx.logger?.info?.(`vision-router: ${reason} turn → ${selected.provider}/${selected.model}`)
		trace(`session=${sessionId} ${reason} from=${current.provider}/${current.model} to=${selected.provider}/${selected.model}`)
		return true
	}

	const routeForPrompt = async (request) => {
		if (request === null || typeof request !== 'object') return
		const sessionId = request.sessionId
		if (typeof sessionId !== 'string' || sessionId.length === 0) return
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
			ctx.logger?.info?.('vision-router: the model was changed by hand — releasing the lent route')
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
			ctx.logger?.warn?.(`vision-router: routing skipped: ${String(error)}`)
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
export function apply(ctx, rawConfig) {
	const resolved = normalizeConfig(rawConfig)
	const trace = createTrace(resolved.traceFile)
	if (resolved.problems !== undefined) {
		ctx.logger?.warn?.(`vision-router: disabled — ${resolved.problems.join('; ')}`)
		trace(`apply-disabled problems=${resolved.problems.join('; ')}`)
		return
	}
	if (!resolved.enabled) {
		ctx.logger?.info?.('vision-router: disabled by configuration')
		trace('apply-disabled by-config')
		return
	}
	trace(`apply-entered mode=${resolved.mode} vision=${resolved.vision.provider}/${resolved.vision.model}`)

	/**
	 * The on-demand tool is registered on its own, before (and independently of)
	 * the session controller: it needs only `tools` + `fs` + `attachments`, so it
	 * also works in a profile whose entry points never prompt through the Web
	 * session controller (headless, sdk, acp).
	 */
	if (resolved.tool) registerDescribeTool(ctx, resolved, trace)

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
			mount(sessionCtx, resolved, trace)
		} catch (error) {
			sessionCtx.logger?.warn?.(`vision-router: disabled — ${String(error)}`)
			trace(`mount-threw ${String(error)}`)
		}
	})
}

/** Wire the router onto a context whose session controller is available. */
function mount(ctx, resolved, trace) {
	const controller = ctx.sessionController
	if (controller === null || typeof controller !== 'object' || typeof controller.prompt !== 'function') {
		ctx.logger?.warn?.('vision-router: disabled — sessionController.prompt is unavailable in this deployment')
		trace('mount-skipped sessionController.prompt unavailable')
		return
	}
	const original = controller.prompt
	const env = { ctx, config: resolved, trace }
	const routed = resolved.mode === 'digest' ? digestWrapper(env, original) : switchWrapper(ctx, controller, original, resolved, trace)
	if (routed === undefined) return

	controller.prompt = routed
	ctx.effect(() => () => {
		if (controller.prompt === routed) controller.prompt = original
	}, 'vision-router: session prompt router')

	if (resolved.mode === 'digest') {
		ctx.logger?.info?.(`vision-router: mounted in digest mode — images are analysed by ${resolved.vision.provider}/${resolved.vision.model} and replaced with text; the session model is never changed`)
		trace(`mounted mode=digest vision=${resolved.vision.provider}/${resolved.vision.model} maxTokens=${resolved.maxTokens} timeoutMs=${resolved.timeoutMs} label=${resolved.label} dryRun=${resolved.dryRun}`)
		return
	}
	ctx.logger?.info?.(`vision-router: mounted in switch mode — image turns → ${resolved.vision.provider}/${resolved.vision.model}${resolved.sticky ? ' (sticky: the lent route is never released)' : `, released after ${resolved.holdTurns} image-free turn(s)`}${resolved.dryRun ? ' [dryRun]' : ''}`)
	trace(`mounted mode=switch vision=${resolved.vision.provider}/${resolved.vision.model} text=${resolved.text === undefined ? '-' : `${resolved.text.provider}/${resolved.text.model}`} sticky=${resolved.sticky} holdTurns=${resolved.holdTurns} dryRun=${resolved.dryRun}`)
}

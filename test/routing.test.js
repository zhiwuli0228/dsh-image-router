/**
 * Unit tests for the pure routing logic and for the `apply` wiring against fakes
 * shaped like the real services.
 *
 * Run in-process (`node test/routing.test.js`) or through the runner
 * (`node --test test/`); the runner spawns a child per file, which some sandboxes
 * refuse, so the in-process form is the one to reach for first.
 */
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { apply, Config, configBase, createEnv, decideRoute, discoverVisionModels, LIVE_FIELDS, liveValue, modelAcceptsImages, nameLooksLikeImage, normalizeConfig, plainConfig, promptWantsVision, sameModel, schemaForm } from '../lib/index.js'
import { ENDPOINT_APIS, ENDPOINT_KEY_REF, ENDPOINT_PROVIDER, endpointSettingsOp, readEndpoint, routeForEndpoint, syncEndpoint } from '../lib/endpoint.js'

const EXTENSIONS = ['png', 'jpg', 'jpeg', 'webp', 'gif']
const VISION = { provider: 'qwen-token-plan-cn', model: 'qwen3.8-flash' }
const TEXT = { provider: 'deepseek-official', model: 'deepseek-flash' }
const WIRE_IMAGE = { type: 'image', mediaType: 'image/png', data: 'AAAA', name: 'shot.png' }
const EMPTY_IMAGE = [{ type: 'image', attachment: {} }]
const IMAGE = [{ type: 'text', text: '读一下' }, WIRE_IMAGE]
const PLAIN = [{ type: 'text', text: 'plain question' }]

/** Let the endpoint tier's fire-and-forget promises settle before asserting. */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

/**
 * A client-context double that enforces cordis' declaration gate.
 *
 * The real plugin context refuses undeclared service reads with
 * `cannot get property "X" without inject` — a failure that takes the whole
 * loader entry down, or (for a service only the card's render touches) makes the
 * dispatched card crash so the tab draws nothing. This proxy reproduces the gate
 * for *every* string property, not just ones absent from the target: a service
 * the double happens to carry is still unreadable unless the plugin declared it,
 * which is the only way the card's `ctx.remote` regression can fail here.
 *
 * @param base - the context behaviour under test (`remote`, `inject`).
 * @param declared - the service names the plugin exported in `inject`.
 * @returns the gated context.
 */
function declaredContext(base, declared) {
	// `inject` is a context verb, not a service: the real gate exempts the verbs
	// (CTX_VERBS) and gates service reads only. Dotted declarations such as
	// `remote.settings` name a namespace *inside* the `remote` table, so they gate
	// that table's contents rather than a top-level context property — the read the
	// plugin actually performs is `ctx.remote.settings`.
	const verbs = new Set(['inject'])
	const services = new Set(declared.filter((key) => !key.includes('.')))
	const namespaces = new Set(declared.filter((key) => key.startsWith('remote.')).map((key) => key.slice('remote.'.length)))
	return new Proxy(base, {
		get(target, property, receiver) {
			if (typeof property === 'string' && !verbs.has(property) && !services.has(property)) {
				throw new TypeError(`cannot get property "${property}" without inject`)
			}
			const value = Reflect.get(target, property, receiver)
			// Gate the Remote table per namespace, which is how the real context
			// behaves: `remote` alone does not make `remote.settings` readable.
			if (property === 'remote' && value !== null && typeof value === 'object') {
				return new Proxy(value, {
					get(remoteTarget, remoteProperty, remoteReceiver) {
						if (typeof remoteProperty === 'string' && !namespaces.has(remoteProperty)) {
							throw new TypeError(`cannot get property "remote.${remoteProperty}" without inject`)
						}
						return Reflect.get(remoteTarget, remoteProperty, remoteReceiver)
					}
				})
			}
			return value
		}
	})
}

/** Minimal ctx double recording logger calls and collecting effects. */
function fakeContext(controller, llm, { controllerAvailable = true, attachments, fs, tools, settings, credentials } = {}) {
	const logs = { info: [], warn: [] }
	const disposers = []
	const injected = []
	const ctx = {
		logs,
		disposers,
		injected,
		tools,
		settings,
		credentials,
		sessionController: controllerAvailable ? controller : undefined,
		get: (key) => {
			if (key === 'llm') return llm
			if (key === 'attachments') return attachments
			if (key === 'fs') return fs
			if (key === 'tools') return tools
			if (key === 'settings') return settings
			if (key === 'credentials') return credentials
			return undefined
		},
		logger: {
			info: (message) => logs.info.push(message),
			warn: (message) => logs.warn.push(message)
		},
		effect: (callback) => {
			disposers.push(callback())
		},
		/** Mirrors the optional-injection form: run the callback when its services are there. */
		inject: (names, callback) => {
			injected.push(names.join(','))
			const available = names.every((name) => {
				if (name === 'sessionController') return controllerAvailable
				if (name === 'tools') return tools !== undefined
				if (name === 'settings') return settings !== undefined
				return true
			})
			if (available) callback(ctx)
		}
	}
	return ctx
}

/**
 * Minimal session controller double shaped like the real service: the Typert
 * Remote facade carries `prompt`, while `resolveAgent` and the selection
 * primitives live on its internal `agents` member. `resolveAgent` answers
 * `{ agent }` or `{ error }`, and `selectionFor` returns a live selection, since
 * the pending selection is what the next request runs on.
 *
 * @param options.current - route the session starts on.
 * @param options.flat - also expose the primitives on the facade itself.
 * @param options.resolveError - answer `{ error }` instead of `{ agent }`.
 * @param options.resolveThrows - make resolution throw outright.
 * @param options.noSelectionApi - expose neither selection layout.
 */
function fakeController({ current = TEXT, flat = false, resolveError, resolveThrows = false, noSelectionApi = false } = {}) {
	const state = { current: { ...current } }
	const calls = []
	const requests = []
	const agent = { id: 'agent', session: { header: { id: 'session-1' } } }
	const live = () => ({
		get current() {
			return state.current
		},
		set current(next) {
			state.current = next
		}
	})
	const api = {
		resolveAgent: async () => {
			if (resolveThrows) throw new Error('session registry exploded')
			return resolveError === undefined ? { agent } : { error: resolveError }
		},
		selectionFor: () => live(),
		selectForNextRequest: (_agent, selection) => {
			calls.push(selection)
			state.current = selection
		}
	}
	const controller = {
		calls,
		requests,
		prompt: async function prompt(request) {
			requests.push(request)
			return { accepted: true, model: state.current.model }
		},
		setCurrent: (selection) => {
			state.current = { ...selection }
		},
		current: () => ({ ...state.current })
	}
	if (!noSelectionApi) controller.agents = api
	if (flat) {
		controller.resolveAgent = api.resolveAgent
		controller.selectionFor = api.selectionFor
		controller.selectForNextRequest = api.selectForNextRequest
	}
	return controller
}

/** Attachment-store double: admits wire image parts, saves bytes, hands back references. */
function fakeAttachments({ fail = false } = {}) {
	return {
		admitted: [],
		saved: [],
		imageLimits: {
			maxImageBytes: 20971520,
			maxMessageImageBytes: 209715200,
			maxImageDimension: 8192,
			maxImagePixels: 64000000,
			mediaTypes: ['image/png', 'image/jpeg', 'image/webp', 'image/gif']
		},
		async saveImage(input) {
			this.saved.push(input)
			return { attachmentId: `saved-${this.saved.length}`, mediaType: input.mediaType }
		},
		async admitPromptContent(parts) {
			if (fail) throw new Error('IMAGE_TOO_LARGE')
			return parts.map((part) => {
				const attachment = { attachmentId: `a${this.admitted.length}`, mediaType: part.mediaType ?? 'image/png' }
				this.admitted.push(attachment)
				return { type: 'image', attachment }
			})
		}
	}
}

/**
 * LLM double: an async stream of chunks, recording every option object, plus the
 * registry surface the plugin reads for its capability oracle.
 */
function fakeLlm({ chunks = [{ type: 'text-delta', text: '文字内容: VISION ROUTER\n画面描述: 深蓝色背景' }, { type: 'finish', reason: 'stop' }], chunksPerCall, models = {} } = {}) {
	const calls = []
	const discoveries = []
	return {
		calls,
		/** `provider -> model list` this fake advertises. */
		models,
		/** Every `(settingsNs, handler)` pair the plugin registered. */
		discoveries,
		registerModelDiscovery(settingsNs, handler) {
			discoveries.push({ settingsNs, handler })
		},
		async listModels(provider) {
			if (!Object.hasOwn(this.models, provider)) throw new Error(`unknown provider ${provider}`)
			return this.models[provider]
		},
		async *stream(options) {
			calls.push(options)
			// `chunksPerCall` scripts a different answer per attempt, which is how a
			// retry (a second `stream` call) is told apart from the first attempt.
			const scripted = Array.isArray(chunksPerCall) ? chunksPerCall[calls.length - 1] : undefined
			for (const chunk of scripted ?? chunks) yield chunk
		}
	}
}

/** A tiny buffer whose first bytes are a real PNG signature. */
const PNG_BYTES = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52])

/** Filesystem double: resolve, stat, and read are recorded and scriptable. */
function fakeFs(options = {}) {
	// `info: undefined` must mean "absent", so the default applies only when the key is missing.
	const info = Object.hasOwn(options, 'info') ? options.info : { type: 'file', size: PNG_BYTES.length, version: 'v1' }
	const bytes = options.bytes ?? PNG_BYTES
	return {
		resolved: [],
		stats: 0,
		async resolve(path, resolveOptions) {
			this.resolved.push({ path, options: resolveOptions })
			return { targetKey: `k:${path}`, displayPath: `E:\\ws\\${path}` }
		},
		async stat() {
			this.stats += 1
			return info
		},
		async readBytes() {
			return bytes
		}
	}
}

/** Tool registry double. */
function fakeTools() {
	return {
		registered: [],
		register(definition) {
			this.registered.push(definition)
			return () => {}
		}
	}
}

/** The single text block a digest replaces images with, when there is one. */
const replacementText = (request) => request.content.filter((part) => part.type === 'text').map((part) => part.text).join('\n')

test('normalizeConfig applies defaults and rejects unusable input', () => {
	const config = normalizeConfig({ vision: VISION })
	assert.equal(config.enabled, true)
	assert.equal(config.mode, 'digest', 'digest is the default: the session model is never changed')
	assert.equal(config.sticky, false)
	assert.equal(config.dryRun, false)
	assert.equal(config.holdTurns, 0)
	assert.equal(config.label, true)
	assert.ok(config.instruction.includes('文字内容'))
	assert.ok(config.maxTokens > 0)
	assert.ok(config.timeoutMs > 0)
	assert.deepEqual(config.vision, VISION)

	// The pre-digest mode names keep working as switch-mode spellings.
	assert.equal(normalizeConfig({ vision: VISION, mode: 'auto' }).mode, 'switch')
	const legacySticky = normalizeConfig({ vision: VISION, mode: 'sticky' })
	assert.equal(legacySticky.mode, 'switch')
	assert.equal(legacySticky.sticky, true)

	assert.ok(normalizeConfig({ text: TEXT }).problems.some((problem) => problem.includes('vision')))
	assert.ok(normalizeConfig({ vision: VISION, mode: 'sometimes' }).problems.some((problem) => problem.includes('mode')))
	assert.ok(normalizeConfig({ vision: VISION, hint: '(' }).problems.some((problem) => problem.includes('hint')))
	assert.ok(normalizeConfig({ vision: VISION, holdTurns: -1 }).problems.some((problem) => problem.includes('holdTurns')))
	assert.ok(normalizeConfig({ vision: VISION, maxTokens: 0 }).problems.some((problem) => problem.includes('maxTokens')))
	assert.ok(normalizeConfig({ vision: VISION, instruction: '  ' }).problems.some((problem) => problem.includes('instruction')))
	assert.deepEqual(normalizeConfig({ vision: VISION, imageExtensions: ['.PNG', 'JPG'] }).imageExtensions, ['png', 'jpg'])
})

test('normalizeConfig treats schema-materialized empty values as absent', () => {
	// Schemastery fills an unset optional object with `{}` and an unset optional
	// array with `[]`; neither may read as "configured but broken".
	const filled = normalizeConfig({ vision: VISION, text: {}, imageExtensions: [], hint: undefined, instruction: undefined, traceFile: undefined })
	assert.equal(filled.problems, undefined, 'a materialized-empty config must not disable the plugin')
	assert.equal(filled.text, undefined)
	assert.ok(filled.imageExtensions.includes('png'), 'the default extension list is restored')
	assert.equal(filled.mode, 'digest')

	// An empty vision object is still "no vision route configured".
	assert.ok(normalizeConfig({ vision: {} }).problems.some((problem) => problem.includes('vision')))
})

test('a live (volatile) configuration value is unwrapped before it is read', () => {
	// 0.2.x's schemastery resolves a `meta.volatile` field to a cosmokit cell rather
	// than to the value, and that is exactly what the loader hands to `apply` (via
	// `Config['~standard'].validate`). Reading the cell as a value failed every type
	// check and disabled the plugin with a validation problem — observed by booting
	// the real 0.2.0 runtime offline, where the trace stayed empty because the
	// config is rejected before `traceFile` is even read.
	const cell = (value) => ({ get: () => value, [Symbol('cosmokit.volatile.write')]: () => {} })
	const resolved = normalizeConfig({
		mode: cell('switch'),
		vision: cell({ provider: 'qwen-token-plan-cn', model: 'qwen3.8-flash' }),
		maxTokens: cell(1200),
		label: cell(false),
		instruction: cell('只转录文字')
	})
	assert.equal(resolved.problems, undefined, 'a live cell must not read as broken configuration')
	assert.equal(resolved.mode, 'switch')
	assert.equal(resolved.vision.provider, 'qwen-token-plan-cn')
	assert.equal(resolved.maxTokens, 1200)
	assert.equal(resolved.label, false)
	assert.equal(resolved.instruction, '只转录文字')

	// A cell nested inside a plain object is reached too, and the value itself is
	// never mistaken for one (a plain object with a `get` key but no cosmokit slot).
	assert.equal(plainConfig({ vision: { endpoint: cell({ baseURL: 'https://gateway.example/v1', model: 'm' }) } }).vision.endpoint.baseURL, 'https://gateway.example/v1')
	assert.deepEqual(plainConfig({ get: 'not-a-cell' }), { get: 'not-a-cell' })
	assert.equal(liveValue('digest'), 'digest')
})

test('nameLooksLikeImage matches paths and rejects prose', () => {
	assert.equal(nameLooksLikeImage('look at E:\\shots\\login.PNG', EXTENSIONS), true)
	assert.equal(nameLooksLikeImage('@design/mock.jpeg please', EXTENSIONS), true)
	assert.equal(nameLooksLikeImage('the png format is fine', EXTENSIONS), false)
	assert.equal(nameLooksLikeImage('main.pngx', EXTENSIONS), false)
})

test('promptWantsVision trusts image blocks, image file blocks and image text', () => {
	assert.equal(promptWantsVision([{ type: 'image', attachment: {} }], EXTENSIONS), true)
	assert.equal(promptWantsVision([{ type: 'file', mediaType: 'image/webp' }], EXTENSIONS), true)
	assert.equal(promptWantsVision([{ type: 'file', name: 'diagram.png' }], EXTENSIONS), true)
	assert.equal(promptWantsVision([{ type: 'file', name: 'diagram.svg' }], EXTENSIONS), false)
	assert.equal(promptWantsVision([{ type: 'text', text: 'check shot.jpg' }], EXTENSIONS), true)
	assert.equal(promptWantsVision([{ type: 'text', text: 'data:image/png;base64,AAA' }], EXTENSIONS), true)
	assert.equal(promptWantsVision([{ type: 'text', text: 'what is a PNG file?' }], EXTENSIONS), false)
	assert.equal(promptWantsVision([{ type: 'text', text: 'screenshot of the app' }], EXTENSIONS, /screenshot/iu), true)
	assert.equal(promptWantsVision([], EXTENSIONS), false)
})

test('decideRoute lends the vision route and restores what it lent (switch mode)', () => {
	const base = { vision: VISION, text: TEXT, sticky: false, extensions: EXTENSIONS, lent: undefined }

	assert.deepEqual(decideRoute({ ...base, current: TEXT, content: IMAGE }), { action: 'lend', route: VISION, reason: 'image' })
	assert.deepEqual(decideRoute({ ...base, current: VISION, content: IMAGE }), undefined, 'already on the vision route')
	assert.deepEqual(decideRoute({ ...base, current: VISION, content: PLAIN, lent: TEXT }), { action: 'release', route: TEXT, reason: 'restore' })
	assert.deepEqual(decideRoute({ ...base, current: VISION, content: PLAIN }), { action: 'release', route: TEXT, reason: 'text' })
	assert.deepEqual(decideRoute({ ...base, current: TEXT, content: PLAIN }), undefined, 'nothing to do on the text route')
	assert.deepEqual(decideRoute({ ...base, current: { provider: 'x', model: 'y' }, content: PLAIN, lent: TEXT }), { action: 'forget', reason: 'changed-by-hand' })
	assert.deepEqual(decideRoute({ ...base, current: VISION, content: PLAIN, lent: TEXT, sticky: true }), undefined)
	assert.deepEqual(decideRoute({ ...base, current: VISION, content: PLAIN, text: undefined }), undefined)
})

test('sameModel compares provider and model only', () => {
	assert.equal(sameModel({ provider: 'a', model: 'm' }, { provider: 'a', model: 'm', reasoningEffort: 'high' }), true)
	assert.equal(sameModel({ provider: 'a', model: 'm' }, { provider: 'a', model: 'n' }), false)
	assert.equal(sameModel(undefined, { provider: 'a', model: 'm' }), false)
})

test('digest mode replaces prompt images with the vision answer and never touches the model', async () => {
	const controller = fakeController({ noSelectionApi: true })
	const llm = fakeLlm()
	const attachments = fakeAttachments()
	const ctx = fakeContext(controller, llm, { attachments })
	apply(ctx, { vision: VISION, traceFile: undefined })

	const result = await controller.prompt({ sessionId: 's1', content: IMAGE })

	assert.deepEqual(result, { accepted: true, model: 'deepseek-flash' })
	assert.equal(controller.requests.length, 1, 'the prompt is admitted exactly once')
	const forwarded = controller.requests[0]
	assert.equal(forwarded.content.some((part) => part.type === 'image'), false, 'no image block reaches admission')
	assert.ok(replacementText(forwarded).includes('VISION ROUTER'), 'the prompt carries the vision answer as text')
	assert.equal(controller.calls.length, 0, 'the session model is untouched')
})

test('a route that delivers its answer only as a completed block still counts', async () => {
	// The adapter emits the finished text block as well as any deltas, and a provider
	// that does not stream deltas delivers the whole answer ONLY that way. Reading just
	// `text-delta` produced an empty analysis with a `stop` finish and no error — a
	// failure indistinguishable from the model answering nothing.
	const controller = fakeController({ noSelectionApi: true })
	const llm = fakeLlm({
		chunks: [
			{ type: 'reasoning-delta', text: '让我先想想…' },
			{ type: 'block-end', block: { type: 'text', text: '文字内容: BLOCK ONLY' } },
			{ type: 'finish', reason: 'stop' }
		]
	})
	const trace = join(mkdtempSync(join(tmpdir(), 'image-router-block-')), 'trace.log')
	const ctx = fakeContext(controller, llm, { attachments: fakeAttachments() })
	apply(ctx, { vision: VISION, imageExtensions: EXTENSIONS, traceFile: trace })

	await controller.prompt({ sessionId: 's1', content: IMAGE })
	assert.equal(llm.calls.length, 1, 'the analysis still happens')
	const forwarded = controller.requests[0]
	const text = forwarded.content.map((part) => part.text ?? '').join('\n')
	assert.ok(text.includes('BLOCK ONLY'), 'the completed block is used when no deltas arrive')
	assert.equal(text.includes('让我先想想'), false, 'reasoning is never mistaken for the analysis')
	assert.equal(readFileSync(trace, 'utf8').includes('digest-empty'), false, 'and it is not reported as an empty answer')
	rmSync(join(trace, '..'), { recursive: true, force: true })
})

test('a finish reason reported as an object is read, not swallowed', async () => {
	// The adapter answers `finish.reason` with an OBJECT — `mapStopReason` returns
	// `{ kind: 'error', failure: { code, message } }` — so comparing it to a string
	// missed every failure it reported, including its own "completed response with no
	// content". A diagnosable error became a silent empty answer.
	const controller = fakeController({ noSelectionApi: true })
	const llm = fakeLlm({ chunks: [{ type: 'finish', reason: { kind: 'error', failure: { code: 'SOME_BAD_CODE', message: 'upstream said no' } } }] })
	const trace = join(mkdtempSync(join(tmpdir(), 'image-router-reason-')), 'trace.log')
	const ctx = fakeContext(controller, llm, { attachments: fakeAttachments() })
	apply(ctx, { vision: VISION, imageExtensions: EXTENSIONS, traceFile: trace })

	await controller.prompt({ sessionId: 's1', content: IMAGE })
	const audit = readFileSync(trace, 'utf8')
	assert.ok(audit.includes('digest-failed reason=upstream said no'), 'the adapter message reaches the audit')
	assert.ok(audit.includes('code=SOME_BAD_CODE'), 'and so does its code')
	assert.equal(audit.includes('digest-empty'), false, 'a reported failure is not reported as an empty answer')
	assert.ok(controller.requests[0].content.some((part) => part.type === 'image'), 'and the image is left for the original path to judge')
	rmSync(join(trace, '..'), { recursive: true, force: true })
})

test('a budget spent entirely on reasoning is retried once with room for both', async () => {
	// On `openai-completions` the token budget is shared with the model's own
	// reasoning, so a budget that suits a plain model can be consumed by thinking
	// before the answer starts. The live failure was exactly that: a 900 budget
	// produced reasoning deltas, a finish, and no text at all.
	const controller = fakeController({ noSelectionApi: true })
	const llm = fakeLlm({
		chunks: [],
		chunksPerCall: [
			[{ type: 'reasoning-delta', text: '先想想…' }, { type: 'finish', reason: { kind: 'max-tokens' } }],
			[{ type: 'text-delta', text: '文字内容: 想完了' }, { type: 'finish', reason: { kind: 'stop' } }]
		]
	})
	const trace = join(mkdtempSync(join(tmpdir(), 'image-router-retry-')), 'trace.log')
	const ctx = fakeContext(controller, llm, { attachments: fakeAttachments() })
	apply(ctx, { vision: VISION, imageExtensions: EXTENSIONS, maxTokens: 900, traceFile: trace })

	await controller.prompt({ sessionId: 's1', content: IMAGE })
	assert.equal(llm.calls.length, 2, 'the analysis is attempted twice')
	assert.equal(llm.calls[0].maxTokens, 900, 'the configured budget is tried first')
	assert.ok(llm.calls[1].maxTokens > 900, 'and the retry has room for the reasoning as well as the answer')
	const text = controller.requests[0].content.map((part) => part.text ?? '').join('\n')
	assert.ok(text.includes('想完了'), 'the retry answer is what reaches the prompt')
	const audit = readFileSync(trace, 'utf8')
	assert.ok(audit.includes('digest-retry reason=reasoning-consumed-budget'), 'the retry is audited, so a slow analysis has an explanation')
	assert.ok(audit.includes('digest-retry-ok'), 'and so is its success')
	assert.equal(audit.includes('digest-empty'), false)
	rmSync(join(trace, '..'), { recursive: true, force: true })
})

test('digest mode sends the admitted images to the vision route as a one-shot call', async () => {
	const controller = fakeController({ noSelectionApi: true })
	const llm = fakeLlm()
	const attachments = fakeAttachments()
	const trace = join(mkdtempSync(join(tmpdir(), 'image-router-digest-')), 'trace.log')
	const ctx = fakeContext(controller, llm, { attachments })
	apply(ctx, { vision: VISION, traceFile: trace, maxTokens: 321 })

	await controller.prompt({ sessionId: 'session-7', content: IMAGE })

	assert.equal(controller.calls.length, 0, 'nothing is written to the session model selection')
	assert.equal(llm.calls.length, 1, 'exactly one side call')
	const options = llm.calls[0]
	assert.equal(options.provider, VISION.provider)
	assert.equal(options.model, VISION.model)
	assert.equal(options.maxTokens, 321)
	assert.equal(options.sessionId, 'session-7')
	assert.ok(options.signal !== undefined, 'the side call is cancellable')
	const content = options.messages[0].content
	assert.equal(options.messages[0].role, 'user')
	assert.ok(content[0].text.includes('文字内容'), 'the instruction is the analysis prompt')
	assert.equal(content.filter((part) => part.type === 'image').length, 1)
	assert.deepEqual(content[1].attachment, attachments.admitted[0], 'the admitted reference is what the vision model is asked about')

	const forwarded = controller.requests[0]
	const text = forwarded.content.map((part) => part.text ?? '').join('\n')
	assert.ok(text.includes('图片分析'), 'the replacement names itself')
	assert.ok(text.includes('VISION ROUTER'), 'the analysis text is in the prompt')
	assert.equal(text.includes('shot.png'), false, 'no file name leaks into the prompt: it would look like a readable path')
	assert.ok(text.startsWith('读一下'), 'the user text keeps its place')
	assert.equal(forwarded.content.some((part) => part.type === 'image'), false)
	const audit = readFileSync(trace, 'utf8')
	assert.ok(audit.includes('mounted mode=digest'))
	// The decision line names the route that served the image: "which route was
	// actually used" is the question a saved-looking-ignored configuration raises.
	assert.ok(audit.includes(`digest session=session-7 vision=${VISION.provider}/${VISION.model} images=1`), 'the digest line records the route in force')
	assert.ok(audit.includes('names=shot.png'), 'the audit keeps the original name')
	assert.equal(audit.includes('error='), false)
	rmSync(join(trace, '..'), { recursive: true, force: true })
})

test('digest mode keeps the image when the vision call fails', async () => {
	const controller = fakeController({ noSelectionApi: true })
	const llm = fakeLlm({ chunks: [{ type: 'text-delta', text: 'partial' }, { type: 'finish', reason: 'error' }] })
	const attachments = fakeAttachments()
	const trace = join(mkdtempSync(join(tmpdir(), 'image-router-fail-')), 'trace.log')
	const ctx = fakeContext(controller, llm, { attachments })
	apply(ctx, { vision: VISION, traceFile: trace })

	const result = await controller.prompt({ sessionId: 's1', content: IMAGE })

	assert.deepEqual(result, { accepted: true, model: 'deepseek-flash' }, 'the prompt is still admitted')
	const forwarded = controller.requests[0]
	assert.equal(forwarded.content.some((part) => part.type === 'image'), true, 'the image is left for the original path to judge')
	assert.equal(forwarded.content.some((part) => typeof part.text === 'string' && part.text.includes('图片分析')), false)
	assert.equal(controller.calls.length, 0)
	assert.ok(readFileSync(trace, 'utf8').includes('digest-failed'))
	rmSync(join(trace, '..'), { recursive: true, force: true })
})

test('digest mode leaves image-free prompts alone', async () => {
	const controller = fakeController({ noSelectionApi: true })
	const llm = fakeLlm()
	const attachments = fakeAttachments()
	const ctx = fakeContext(controller, llm, { attachments })
	apply(ctx, { vision: VISION })

	const result = await controller.prompt({ sessionId: 's1', content: PLAIN })

	assert.deepEqual(result, { accepted: true, model: 'deepseek-flash' })
	assert.equal(llm.calls.length, 0)
	assert.equal(attachments.admitted.length, 0)
	assert.deepEqual(controller.requests[0], { sessionId: 's1', content: PLAIN }, 'the request is forwarded untouched')
})

test('digest mode analyses several images in one call and collapses them into one block', async () => {
	const controller = fakeController({ noSelectionApi: true })
	const llm = fakeLlm()
	const attachments = fakeAttachments()
	const ctx = fakeContext(controller, llm, { attachments })
	apply(ctx, { vision: VISION })

	await controller.prompt({
		sessionId: 's1',
		content: [
			WIRE_IMAGE,
			{ type: 'text', text: '这两张对比一下' },
			{ type: 'image', mediaType: 'image/jpeg', data: 'BBBB', name: 'after.jpg' }
		]
	})

	assert.equal(llm.calls.length, 1)
	assert.equal(llm.calls[0].messages[0].content.filter((part) => part.type === 'image').length, 2)
	const forwarded = controller.requests[0]
	assert.equal(forwarded.content.some((part) => part.type === 'image'), false)
	assert.equal(forwarded.content.filter((part) => typeof part.text === 'string' && part.text.includes('图片分析')).length, 1)
	assert.equal(forwarded.content.map((part) => part.text ?? '').join('|'), `[图片分析 · ${VISION.provider}/${VISION.model} · 2 张]\n文字内容: VISION ROUTER\n画面描述: 深蓝色背景|这两张对比一下`)
})

test('digest mode makes no vision call under dryRun', async () => {
	const controller = fakeController({ noSelectionApi: true })
	const llm = fakeLlm()
	const attachments = fakeAttachments()
	const trace = join(mkdtempSync(join(tmpdir(), 'image-router-dry-')), 'trace.log')
	const ctx = fakeContext(controller, llm, { attachments })
	apply(ctx, { vision: VISION, dryRun: true, traceFile: trace })

	await controller.prompt({ sessionId: 's1', content: IMAGE })

	assert.equal(llm.calls.length, 0)
	assert.deepEqual(controller.requests[0], { sessionId: 's1', content: IMAGE })
	assert.ok(readFileSync(trace, 'utf8').includes('digest-dryRun'))
	rmSync(join(trace, '..'), { recursive: true, force: true })
})

test('digest mode survives an unusable attachment store', async () => {
	const controller = fakeController({ noSelectionApi: true })
	const llm = fakeLlm()
	const trace = join(mkdtempSync(join(tmpdir(), 'image-router-admit-')), 'trace.log')
	const ctx = fakeContext(controller, llm, { attachments: fakeAttachments({ fail: true }) })
	apply(ctx, { vision: VISION, traceFile: trace })

	const result = await controller.prompt({ sessionId: 's1', content: IMAGE })

	assert.deepEqual(result, { accepted: true, model: 'deepseek-flash' })
	assert.deepEqual(controller.requests[0], { sessionId: 's1', content: IMAGE })
	assert.equal(llm.calls.length, 0)
	assert.ok(readFileSync(trace, 'utf8').includes('digest-admit-failed'))
	rmSync(join(trace, '..'), { recursive: true, force: true })
})

test('switch mode lends the vision route for an image turn and restores it afterwards', async () => {
	const controller = fakeController()
	const ctx = fakeContext(controller)
	apply(ctx, { mode: 'switch', vision: VISION, text: TEXT, imageExtensions: EXTENSIONS })

	const imageResult = await controller.prompt({ sessionId: 's1', content: EMPTY_IMAGE })
	assert.deepEqual(controller.calls, [VISION])
	assert.deepEqual(imageResult, { accepted: true, model: 'qwen3.8-flash' })

	await controller.prompt({ sessionId: 's1', content: PLAIN })
	assert.deepEqual(controller.calls, [VISION, TEXT], 'the lent route is given back')
	assert.deepEqual(controller.current(), TEXT)
	assert.equal(ctx.logs.warn.length, 0)
})

test('switch mode never overwrites a model the user picked by hand', async () => {
	const controller = fakeController()
	const ctx = fakeContext(controller)
	apply(ctx, { mode: 'switch', vision: VISION, text: TEXT, imageExtensions: EXTENSIONS })

	await controller.prompt({ sessionId: 's1', content: EMPTY_IMAGE })
	const handPicked = { provider: 'deepseek-official', model: 'deepseek-v4-pro' }
	controller.setCurrent(handPicked)

	await controller.prompt({ sessionId: 's1', content: PLAIN })
	assert.deepEqual(controller.calls, [VISION], 'a hand-picked model is left alone')
	assert.deepEqual(controller.current(), handPicked)
	assert.ok(ctx.logs.info.some((message) => message.includes('changed by hand')))
})

test('switch mode holdTurns keeps the lent route across image-free follow-ups', async () => {
	const controller = fakeController()
	const ctx = fakeContext(controller)
	apply(ctx, { mode: 'switch', vision: VISION, text: TEXT, imageExtensions: EXTENSIONS, holdTurns: 1 })

	await controller.prompt({ sessionId: 's1', content: EMPTY_IMAGE })
	await controller.prompt({ sessionId: 's1', content: PLAIN })
	assert.deepEqual(controller.calls, [VISION], 'the first follow-up stays on the lent route')
	assert.deepEqual(controller.current(), VISION)

	await controller.prompt({ sessionId: 's1', content: PLAIN })
	assert.deepEqual(controller.calls, [VISION, TEXT], 'the second follow-up restores it')
})

test('switch mode sticky never gives the route back', async () => {
	const controller = fakeController()
	const ctx = fakeContext(controller)
	apply(ctx, { mode: 'switch', sticky: true, vision: VISION, text: TEXT, imageExtensions: EXTENSIONS })

	await controller.prompt({ sessionId: 's1', content: EMPTY_IMAGE })
	await controller.prompt({ sessionId: 's1', content: PLAIN })
	assert.deepEqual(controller.calls, [VISION])
	assert.deepEqual(controller.current(), VISION)
})

test('switch mode falls back to the configured text route with no lent route on record', async () => {
	const controller = fakeController({ current: VISION })
	const ctx = fakeContext(controller)
	apply(ctx, { mode: 'switch', vision: VISION, text: TEXT, imageExtensions: EXTENSIONS })

	await controller.prompt({ sessionId: 's1', content: PLAIN })
	assert.deepEqual(controller.calls, [TEXT])
})

test('switch mode validates routes through the llm service and installs the resolved route', async () => {
	const controller = fakeController()
	let resolves = 0
	const llm = {
		resolveCallConfig: async ({ provider, model }) => {
			resolves += 1
			return { provider, model, reasoningEffort: 'high' }
		}
	}
	const ctx = fakeContext(controller, llm)
	apply(ctx, { mode: 'switch', vision: VISION, text: TEXT, imageExtensions: EXTENSIONS })

	await controller.prompt({ sessionId: 's1', content: EMPTY_IMAGE })
	await controller.prompt({ sessionId: 's1', content: PLAIN })
	await controller.prompt({ sessionId: 's1', content: EMPTY_IMAGE })
	assert.equal(resolves, 2, 'each route is resolved once and then served from cache')
	assert.deepEqual(controller.calls, [
		{ ...VISION, reasoningEffort: 'high' },
		{ ...TEXT, reasoningEffort: 'high' },
		{ ...VISION, reasoningEffort: 'high' }
	])
})

test('switch mode leaves a cold session unrouted instead of failing', async () => {
	const dir = mkdtempSync(join(tmpdir(), 'image-router-cold-'))
	const trace = join(dir, 'trace.log')
	const controller = fakeController({ resolveError: new Error('session/not-found') })
	const ctx = fakeContext(controller)
	apply(ctx, { mode: 'switch', vision: VISION, text: TEXT, imageExtensions: EXTENSIONS, traceFile: trace })

	const result = await controller.prompt({ sessionId: 'cold', content: EMPTY_IMAGE })
	assert.deepEqual(result, { accepted: true, model: 'deepseek-flash' }, 'the prompt is admitted untouched')
	assert.deepEqual(controller.calls, [])
	assert.equal(ctx.logs.warn.length, 0, 'a cold session is an expected state, not a warning')
	assert.ok(readFileSync(trace, 'utf8').includes('resolve-skipped'))
	rmSync(dir, { recursive: true, force: true })
})

test('switch mode survives an unexpected resolution failure and still admits the prompt', async () => {
	const controller = fakeController({ resolveThrows: true })
	const ctx = fakeContext(controller)
	apply(ctx, { mode: 'switch', vision: VISION, text: TEXT, imageExtensions: EXTENSIONS })

	const result = await controller.prompt({ sessionId: 's1', content: EMPTY_IMAGE })
	assert.deepEqual(result, { accepted: true, model: 'deepseek-flash' })
	assert.deepEqual(controller.calls, [])
	assert.equal(ctx.logs.warn.length, 1)
	assert.ok(ctx.logs.warn[0].includes('routing skipped'))
})

test('switch mode warns once per unusable route and dryRun only logs', async () => {
	const controller = fakeController()
	const ctx = fakeContext(controller, {
		resolveCallConfig: async () => {
			throw new Error('no adapter serves this route')
		}
	})
	apply(ctx, { mode: 'switch', vision: VISION, text: TEXT, imageExtensions: EXTENSIONS })
	await controller.prompt({ sessionId: 's1', content: EMPTY_IMAGE })
	await controller.prompt({ sessionId: 's1', content: EMPTY_IMAGE })
	assert.equal(ctx.logs.warn.length, 1)
	assert.deepEqual(controller.calls, [])

	const dryController = fakeController()
	const dryCtx = fakeContext(dryController)
	apply(dryCtx, { mode: 'switch', vision: VISION, text: TEXT, imageExtensions: EXTENSIONS, dryRun: true })
	await dryController.prompt({ sessionId: 's1', content: EMPTY_IMAGE })
	assert.deepEqual(dryController.calls, [])
	assert.ok(dryCtx.logs.info.some((message) => message.includes('dryRun')))
})

test('apply disables itself on unusable configuration instead of throwing', () => {
	const controller = fakeController()
	const ctx = fakeContext(controller)
	apply(ctx, { text: TEXT })
	assert.equal(ctx.logs.warn.length, 1)
	assert.ok(ctx.logs.warn[0].includes('vision'))

	const disabled = fakeContext(controller)
	apply(disabled, { enabled: false, vision: VISION })
	assert.ok(disabled.logs.info[0].includes('disabled'))
})

test('apply writes an audit trail for switch mode and survives an unwritable one', async () => {
	const dir = mkdtempSync(join(tmpdir(), 'image-router-'))
	const traceFile = join(dir, 'trace.log')
	const controller = fakeController()
	const ctx = fakeContext(controller)
	apply(ctx, { mode: 'switch', vision: VISION, text: TEXT, imageExtensions: EXTENSIONS, traceFile })

	await controller.prompt({ sessionId: 's1', content: EMPTY_IMAGE })
	await controller.prompt({ sessionId: 's1', content: PLAIN })

	const lines = readFileSync(traceFile, 'utf8').trim().split('\n')
	assert.ok(lines[0].includes('apply-entered mode=switch'))
	assert.ok(lines.some((line) => line.includes('inject-fired')))
	const mounted = lines.find((line) => line.includes('mounted'))
	assert.ok(mounted !== undefined, 'the mount line is the proof the router is live')
	assert.ok(mounted.includes('mode=switch'))
	assert.ok(lines.some((line) => line.includes('session=s1 image from=deepseek-official/deepseek-flash to=qwen-token-plan-cn/qwen3.8-flash')))
	assert.ok(lines.some((line) => line.includes('session=s1 restore from=qwen-token-plan-cn/qwen3.8-flash to=deepseek-official/deepseek-flash')))
	rmSync(dir, { recursive: true, force: true })

	const unwritable = fakeController()
	const unwritableCtx = fakeContext(unwritable)
	apply(unwritableCtx, { mode: 'switch', vision: VISION, text: TEXT, imageExtensions: EXTENSIONS, traceFile: join(tmpdir(), 'no-such-dir-xyz', 'trace.log') })
	await unwritable.prompt({ sessionId: 's1', content: EMPTY_IMAGE })
	assert.deepEqual(unwritable.calls, [VISION], 'an unwritable trace file never affects routing')
})

test('apply activates without a session controller and never wraps the prompt there', async () => {
	const controller = fakeController()
	const original = controller.prompt
	const ctx = fakeContext(controller, undefined, { controllerAvailable: false })
	apply(ctx, { vision: VISION })

	assert.deepEqual(ctx.injected, ['tools', 'settings', 'llm,settings,credentials', 'llm', 'sessionController'], 'every service is requested optionally, never as a required dependency')
	assert.equal(controller.prompt, original, 'nothing is wrapped when the service is absent')
	assert.equal(ctx.logs.warn.length, 0)
	await controller.prompt({ sessionId: 's1', content: IMAGE })
	assert.equal(controller.requests.length, 1, 'the prompt still flows through')
})

test('switch mode accepts a facade that re-exports the selection primitives', async () => {
	const controller = fakeController({ flat: true })
	const ctx = fakeContext(controller)
	apply(ctx, { mode: 'switch', vision: VISION, text: TEXT, imageExtensions: EXTENSIONS })
	await controller.prompt({ sessionId: 's1', content: EMPTY_IMAGE })
	assert.deepEqual(controller.calls, [VISION])
})

test('switch mode disables itself when no selection API exists anywhere', () => {
	const controller = fakeController({ noSelectionApi: true })
	const original = controller.prompt
	const ctx = fakeContext(controller)
	apply(ctx, { mode: 'switch', vision: VISION, text: TEXT, imageExtensions: EXTENSIONS })
	assert.equal(controller.prompt, original)
	assert.equal(ctx.logs.warn.length, 1)
	assert.ok(ctx.logs.warn[0].includes('model-selection API'))
})

test('apply registers describe_image with a JSON-Schema definition', () => {
	const controller = fakeController({ noSelectionApi: true })
	const tools = fakeTools()
	const ctx = fakeContext(controller, fakeLlm(), { tools, attachments: fakeAttachments(), fs: fakeFs() })
	apply(ctx, { vision: VISION })

	assert.equal(tools.registered.length, 1)
	const definition = tools.registered[0]
	assert.equal(definition.name, 'describe_image')
	assert.equal(typeof definition.execute, 'function')
	assert.equal(definition.parameters.type, 'object')
	assert.deepEqual(definition.parameters.required, ['file_path'])
	assert.deepEqual(Object.keys(definition.parameters.properties).sort(), ['file_path', 'question'])
	assert.deepEqual(definition.output.render({}, 'text'), [{ type: 'text', text: 'text' }])
	assert.deepEqual(definition.output.schema, { type: 'string' })
})

test('describe_image reads a file and returns the vision analysis', async () => {
	const controller = fakeController({ noSelectionApi: true })
	const tools = fakeTools()
	const llm = fakeLlm()
	const attachments = fakeAttachments()
	const fs = fakeFs()
	const trace = join(mkdtempSync(join(tmpdir(), 'image-router-tool-')), 'trace.log')
	const ctx = fakeContext(controller, llm, { tools, attachments, fs })
	apply(ctx, { vision: VISION, traceFile: trace })

	const definition = tools.registered[0]
	const exec = { signal: undefined, agent: { session: { header: { id: 'session-9', cwd: 'E:\\ws' } } } }
	const text = await definition.execute({ file_path: 'shots/error.png' }, exec)

	assert.equal(text, '文字内容: VISION ROUTER\n画面描述: 深蓝色背景')
	assert.equal(fs.resolved[0].path, 'shots/error.png')
	assert.equal(fs.resolved[0].options.cwd, 'E:\\ws')
	assert.equal(attachments.saved.length, 1)
	assert.equal(attachments.saved[0].mediaType, 'image/png', 'the media type comes from the bytes, not the extension')
	assert.equal(attachments.saved[0].name, 'error.png')
	assert.deepEqual(Array.from(attachments.saved[0].data), Array.from(PNG_BYTES))
	assert.equal(llm.calls.length, 1)
	const vision = llm.calls[0]
	assert.equal(vision.provider, VISION.provider)
	assert.equal(vision.model, VISION.model)
	assert.equal(vision.sessionId, 'session-9')
	assert.ok(vision.messages[0].content[0].text.includes('文字内容'), 'the default analysis instruction is used')
	assert.deepEqual(vision.messages[0].content[1], { type: 'image', attachment: { attachmentId: 'saved-1', mediaType: 'image/png' } })
	assert.equal(controller.requests.length, 0, 'the tool never sends a prompt of its own')
	const audit = readFileSync(trace, 'utf8')
	assert.ok(audit.includes('tool-registered name=describe_image'))
	assert.ok(audit.includes('tool session=session-9 path=E:\\ws\\shots/error.png mediaType=image/png'))
	rmSync(join(trace, '..'), { recursive: true, force: true })
})

test('describe_image folds a question into the instruction', async () => {
	const controller = fakeController({ noSelectionApi: true })
	const tools = fakeTools()
	const llm = fakeLlm()
	const ctx = fakeContext(controller, llm, { tools, attachments: fakeAttachments(), fs: fakeFs() })
	apply(ctx, { vision: VISION })

	await tools.registered[0].execute({ file_path: 'a.png', question: '报错是什么？' }, {})
	assert.ok(llm.calls[0].messages[0].content[0].text.includes('报错是什么？'))
})

test('describe_image refuses a missing file, a directory, and a non-image', async () => {
	const make = (options) => {
		const tools = fakeTools()
		const ctx = fakeContext(fakeController({ noSelectionApi: true }), fakeLlm(), { tools, attachments: fakeAttachments(), fs: fakeFs(options) })
		apply(ctx, { vision: VISION })
		return tools.registered[0]
	}

	await assert.rejects(() => make({ info: undefined }).execute({ file_path: 'gone.png' }, {}), /not found/)
	await assert.rejects(() => make({ info: { type: 'directory', version: 'v' } }).execute({ file_path: 'dir' }, {}), /not a regular file/)
	await assert.rejects(
		() => make({ bytes: Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]) }).execute({ file_path: 'notes.txt' }, {}),
		/not a supported PNG\/JPEG\/WebP\/GIF image/
	)
	await assert.rejects(() => make({}).execute({ file_path: '   ' }, {}), /file_path must be a non-empty string/)
})

test('apply registers no tool when disabled, and tolerates a deployment without one', () => {
	const disabledTools = fakeTools()
	const disabled = fakeContext(fakeController(), fakeLlm(), { tools: disabledTools, attachments: fakeAttachments(), fs: fakeFs() })
	apply(disabled, { vision: VISION, tool: false })
	assert.equal(disabledTools.registered.length, 0)
	assert.deepEqual(disabled.injected, ['settings', 'llm,settings,credentials', 'llm', 'sessionController'], 'a disabled tool is not even requested')

	const bare = fakeContext(fakeController(), fakeLlm(), { attachments: fakeAttachments(), fs: fakeFs() })
	apply(bare, { vision: VISION })
	assert.deepEqual(bare.injected, ['tools', 'settings', 'llm,settings,credentials', 'llm', 'sessionController'], 'the tool, settings, endpoint services and the vision oracle are all requested optionally, so their absence cannot fail the mount')
	assert.equal(bare.logs.warn.length, 0)
})

/**
 * Merge two settings layers the way the HOST does.
 *
 * Deliberately DEEP. The host composes a namespace's value from the registrant's base
 * and the user's section field by field, so a shallow double here hides a real
 * failure: a `provider`/`model` left in the base survived into the section beside the
 * user's `endpoint`, which made the composed route look explicitly chosen and outrank
 * the endpoint the user had configured. A shallow fixture passed for several rounds
 * while the live deployment failed.
 */
function deepMerge(base, patch) {
	const out = { ...base }
	for (const [key, value] of Object.entries(patch ?? {})) {
		const existing = out[key]
		const bothPlain = existing !== null && typeof existing === 'object' && !Array.isArray(existing) && value !== null && typeof value === 'object' && !Array.isArray(value)
		out[key] = bothPlain ? deepMerge(existing, value) : value
	}
	return out
}

/**
 * Apply a patch the way the service's path ops do: a value sets, an explicit
 * `undefined` unsets. A save that merely spread its patch would leave a cleared
 * endpoint in place, which is not what the service does.
 */
function applyUnset(target, patch) {
	const out = { ...target }
	for (const [key, value] of Object.entries(patch ?? {})) {
		if (value === undefined) {
			delete out[key]
			continue
		}
		const existing = out[key]
		const bothPlain = existing !== null && typeof existing === 'object' && !Array.isArray(existing) && value !== null && typeof value === 'object' && !Array.isArray(value)
		out[key] = bothPlain ? applyUnset(existing, value) : value
	}
	return out
}

/**
 * Settings-service double: one namespace whose live value object the test can save into.
 *
 * The base and the user section are kept apart and composed on read, because that is
 * what the service does and the composition is where the bugs live. `state.value` is
 * the composed result, kept for tests that assert on it directly.
 */
function fakeSettings(initial = {}) {
	const state = { base: {}, user: initial, value: { ...initial }, watchers: [] }
	const compose = () => {
		state.value = deepMerge(state.base, state.user)
		return state.value
	}
	return {
		state,
		namespace: undefined,
		schema: undefined,
		options: undefined,
		/** Every upstream `mutate(ns, ops)` the endpoint tier issued, in order. */
		mutations: [],
		register(namespace, schema, options) {
			this.namespace = namespace
			this.schema = schema
			this.options = options
			state.base = options?.base ?? {}
			compose()
			return {
				// The composed value, base included, exactly as the real service answers.
				get: () => deepMerge(state.base, state.user),
				watch: (listener) => {
					state.watchers.push(listener)
				}
			}
		},
		/** Simulate a save from the plugin configuration page. */
		save(patch) {
			state.user = applyUnset(state.user, patch)
			compose()
			for (const listener of state.watchers) listener()
		},
		/** The upstream write path the endpoint tier uses; only paths are touched. */
		async mutate(namespace, ops) {
			this.mutations.push({ namespace, ops })
		}
	}
}

/** Credential-store double: remembers `set(ref, value)` calls and nothing else. */
function fakeCredentials() {
	return {
		sets: [],
		unsets: [],
		async set(ref, value) {
			this.sets.push({ ref, value })
		},
		async unset(ref) {
			this.unsets.push(ref)
		}
	}
}

test('apply registers the editable settings namespace and honours a saved override', async () => {
	const controller = fakeController({ noSelectionApi: true })
	const llm = fakeLlm()
	const settings = fakeSettings()
	const ctx = fakeContext(controller, llm, { attachments: fakeAttachments(), settings })
	apply(ctx, { vision: VISION, imageExtensions: EXTENSIONS })

	assert.equal(settings.namespace, 'image-router', 'the card on the browser side keys to this namespace')
	assert.equal(settings.schema, Config, 'the same schema validates the section and the loader config')
	assert.equal(settings.options.base.vision.provider, undefined, 'the base states no route, or a later endpoint would be shadowed by it')

	await controller.prompt({ sessionId: 's1', content: IMAGE })
	assert.equal(llm.calls[0].provider, VISION.provider)

	// A save on the plugin configuration page must reach the NEXT decision, with no
	// remount and no restart.
	settings.save({ vision: { provider: 'other-route', model: 'other-vision' }, instruction: '只转录文字' })
	await controller.prompt({ sessionId: 's1', content: IMAGE })
	assert.equal(llm.calls[1].provider, 'other-route')
	assert.equal(llm.calls[1].model, 'other-vision')
	assert.equal(llm.calls[1].messages[0].content[0].text, '只转录文字', 'the saved instruction replaces the composed one')
	assert.equal(controller.calls.length, 0, 'a settings save never touches the session model either')
})

test('a settings service without register is a traced no-op, not a failed activation', async () => {
	// 0.2.x deleted the registration API: the entry's own Config IS the section, and
	// the service only projects it (`describe`) and writes through it (`mutate`). A
	// plugin that insisted on `register` there would lose its whole settings half —
	// and one that threw over it would take the boot down with it.
	const controller = fakeController({ noSelectionApi: true })
	const llm = fakeLlm()
	const trace = join(mkdtempSync(join(tmpdir(), 'image-router-projected-')), 'trace.log')
	const settings = {
		describes: 0,
		describe() {
			this.describes++
			return []
		},
		async mutate() {}
	}
	const ctx = fakeContext(controller, llm, { attachments: fakeAttachments(), settings, credentials: fakeCredentials() })
	apply(ctx, { vision: VISION, traceFile: trace })
	await flush()

	assert.equal(settings.register, undefined, 'the double really is the 0.2.x shape')
	assert.ok(readFileSync(trace, 'utf8').includes('settings-unsupported'), 'the skipped registration is audited, not silent')

	// And the plugin still works: the composed entry configuration is already the
	// configuration in force, so routing is unaffected by the missing API.
	await controller.prompt({ sessionId: 's1', content: IMAGE })
	assert.equal(llm.calls[0].provider, VISION.provider)
	rmSync(join(trace, '..'), { recursive: true, force: true })
})

test('apply ignores a settings override that does not validate', async () => {
	const controller = fakeController({ noSelectionApi: true })
	const llm = fakeLlm()
	const settings = fakeSettings()
	const trace = join(mkdtempSync(join(tmpdir(), 'image-router-invalid-')), 'trace.log')
	const ctx = fakeContext(controller, llm, { attachments: fakeAttachments(), settings })
	apply(ctx, { vision: VISION, traceFile: trace })

	settings.save({ mode: 5, maxTokens: 0 })
	await controller.prompt({ sessionId: 's1', content: IMAGE })

	assert.equal(llm.calls.length, 1, 'routing keeps working on the last good configuration')
	assert.equal(llm.calls[0].provider, VISION.provider)
	assert.ok(readFileSync(trace, 'utf8').includes('settings-invalid'), 'the rejected override is audited')
	rmSync(join(trace, '..'), { recursive: true, force: true })
})

test('apply restores the original prompt when the plugin is disposed', () => {
	const controller = fakeController()
	const ctx = fakeContext(controller, undefined, { attachments: fakeAttachments() })
	const original = controller.prompt
	apply(ctx, { vision: VISION })
	assert.notEqual(controller.prompt, original)
	for (const dispose of ctx.disposers) dispose()
	assert.equal(controller.prompt, original)
})

// ── The custom-endpoint tier ────────────────────────────────────────────────
//
// The plugin never speaks a provider wire protocol itself: a user-supplied
// endpoint becomes an `llm-pi-ai` route profile plus one credential reference.
// These cases pin that translation and the precedence between the two tiers.

/** One endpoint configuration as the card would save it. */
const ENDPOINT = { baseURL: 'https://gateway.example/v1', model: 'my-vision-model', apiKey: 'sk-card-typed' }

test('normalizeConfig derives the vision route from a custom endpoint', () => {
	const resolved = normalizeConfig({ vision: { endpoint: ENDPOINT } })
	assert.equal(resolved.problems, undefined, 'an endpoint alone is a complete configuration')
	assert.equal(resolved.endpoint.model, 'my-vision-model')
	assert.deepEqual(resolved.vision, { provider: ENDPOINT_PROVIDER, model: 'my-vision-model' }, 'the derived route is what every routing decision sees')
	assert.equal(resolved.endpoint.api, 'openai-completions', 'the protocol defaults to the OpenAI-compatible one')
	// The credential is read from the declaring layer by the one consumer that writes
	// it, so it never rides on a value the rest of the plugin reads.
	assert.equal(resolved.endpoint.apiKey, undefined, 'the resolved configuration never carries the credential')
})

test('an endpoint outranks a route configured beside it', () => {
	// The Endpoint is the more complete specification — address, model and credential —
	// and its model *is* the route, so it decides. A route beside it is normally the
	// entry's own default, and letting that default win is exactly how a saved endpoint
	// was ignored in the live deployment. A user who wants the other route clears the
	// endpoint instead, and the compose step keeps that as their own choice.
	const resolved = normalizeConfig({ vision: { ...VISION, endpoint: ENDPOINT } })
	assert.equal(resolved.problems, undefined)
	assert.deepEqual(resolved.vision, { provider: ENDPOINT_PROVIDER, model: 'my-vision-model' }, 'the endpoint decides when both are present')
	assert.notEqual(resolved.endpoint, undefined, 'and it stays resolved, so the derived route is available upstream')
})

test('normalizeConfig reports a malformed endpoint instead of disabling silently', () => {
	const noModel = normalizeConfig({ vision: { endpoint: { baseURL: 'https://gateway.example/v1' } } })
	assert.ok(noModel.problems.some((problem) => problem.includes('model must be a non-empty')), 'a missing model is named')

	const badApi = normalizeConfig({ vision: { endpoint: { ...ENDPOINT, api: 'grpc' } } })
	assert.ok(badApi.problems.some((problem) => problem.includes(ENDPOINT_APIS.join(', '))), 'an unsupported protocol lists the accepted set')

	const noRoute = normalizeConfig({})
	assert.ok(noRoute.problems.some((problem) => problem.includes('vision.endpoint')), 'the error tells the user both ways to configure it')
})

test('readEndpoint treats a schema-materialized empty object as unset', () => {
	const problems = []
	assert.equal(readEndpoint({}, 'vision.endpoint', problems), undefined, 'an unset optional object must not read as a broken one')
	assert.deepEqual(problems, [])
	assert.equal(readEndpoint(undefined, 'vision.endpoint', problems), undefined)
	assert.equal(readEndpoint({ baseURL: '   ' }, 'vision.endpoint', problems), undefined)
	assert.ok(problems.some((problem) => problem.includes('model')), 'a half-filled endpoint is still reported')
})

test('routeForEndpoint and the endpoint profile share one provider key', () => {
	const endpoint = readEndpoint(ENDPOINT, 'vision.endpoint', [])
	assert.deepEqual(routeForEndpoint(endpoint), { provider: ENDPOINT_PROVIDER, model: 'my-vision-model' })
})

test('apply writes the custom endpoint upstream as a pi-ai route plus one credential', async () => {
	const controller = fakeController({ noSelectionApi: true })
	const llm = fakeLlm()
	const settings = fakeSettings()
	const credentials = fakeCredentials()
	const ctx = fakeContext(controller, llm, { attachments: fakeAttachments(), settings, credentials })
	apply(ctx, { vision: { endpoint: ENDPOINT } })
	await flush()

	assert.equal(settings.mutations.length, 2, 'the upstream route is written once, then the plaintext key is withdrawn from the configuration')
	const write = settings.mutations[0]
	assert.equal(write.namespace, 'llm-pi-ai', 'the route belongs to the upstream pi-ai adapter, not to this plugin')
	assert.equal(write.ops.length, 1, 'only the path this plugin owns is touched')
	assert.deepEqual(write.ops[0].path, ['providers', ENDPOINT_PROVIDER])
	assert.equal(write.ops[0].op, 'set')
	assert.equal(write.ops[0].value.baseURL, 'https://gateway.example/v1')
	assert.equal(write.ops[0].value.api, 'openai-completions')
	assert.deepEqual(write.ops[0].value.models, [{ id: 'my-vision-model', input: ['text', 'image'] }], 'the entry declares image input, or pi-ai would treat the derived route as text-only')
	assert.equal(write.ops[0].value.apiKeyEnv, ENDPOINT_KEY_REF, 'the profile carries only a reference to the secret')

	assert.deepEqual(credentials.sets, [{ ref: ENDPOINT_KEY_REF, value: 'sk-card-typed' }], 'the key itself goes to the credential store')

	// …and then leaves the configuration. The credential is stored, so the section
	// no longer needs the secret, and on 0.2.x an entry's configuration IS the
	// settings store (the profile patch) — a key left there would sit on disk in
	// clear text, which is the one thing this plugin promises not to do.
	assert.equal(settings.mutations[1].namespace, 'image-router', 'the scrub targets this plugin own section, never the upstream route')
	assert.deepEqual(settings.mutations[1].ops, [{ op: 'unset', path: ['vision', 'endpoint', 'apiKey'] }])
})

test('the endpoint tier routes image work through the derived provider', async () => {
	const controller = fakeController({ noSelectionApi: true })
	const llm = fakeLlm()
	const settings = fakeSettings()
	const ctx = fakeContext(controller, llm, { attachments: fakeAttachments(), settings, credentials: fakeCredentials() })
	apply(ctx, { vision: { endpoint: ENDPOINT } })
	await flush()

	await controller.prompt({ sessionId: 's1', content: IMAGE })
	assert.equal(llm.calls.length, 1)
	assert.equal(llm.calls[0].provider, ENDPOINT_PROVIDER, 'the digest call targets the derived route')
	assert.equal(llm.calls[0].model, 'my-vision-model')
	assert.equal(controller.calls.length, 0, 'the session model is still never touched')
})

test('the endpoint tier withdraws its route when the endpoint is removed, keeping the stored key', async () => {
	const controller = fakeController({ noSelectionApi: true })
	const llm = fakeLlm()
	const settings = fakeSettings()
	const credentials = fakeCredentials()
	const ctx = fakeContext(controller, llm, { attachments: fakeAttachments(), settings, credentials })
	// Realistic order: the entry is configured with a route, and the endpoint arrives
	// from the configuration card afterwards. A profile whose own config declares an
	// endpoint cannot withdraw it from the UI — the base would supply it again — which
	// is correct: the entry's configuration is a default, and the card overrides it.
	apply(ctx, { vision: VISION })
	await flush()
	assert.equal(settings.mutations.length, 0, 'a route-only configuration writes no upstream route')

	settings.save({ vision: { ...VISION, endpoint: ENDPOINT } })
	await flush()
	const routes = () => settings.mutations.filter((mutation) => mutation.namespace === 'llm-pi-ai')
	assert.equal(routes().length, 1, 'saving an endpoint pushes the derived route')
	assert.equal(settings.mutations.length, 2, 'plus the key scrub that follows a stored credential')
	assert.equal(credentials.sets.length, 1)

	// Switching back to a route clears the endpoint rather than merely not mentioning
	// it: a merge keeps a field the patch leaves out, and the service's own save uses
	// `unset` for exactly this.
	settings.save({ vision: { endpoint: undefined, provider: VISION.provider, model: VISION.model } })
	await flush()

	assert.equal(routes().length, 2, 'the withdrawal is one more upstream write')
	assert.deepEqual(routes()[1].ops, [{ op: 'unset', path: ['providers', ENDPOINT_PROVIDER] }])
	assert.equal(credentials.sets.length, 1, 'withdrawing a route never deletes a credential the user may reuse')
	assert.equal(settings.mutations.length, 3, 'no key was retyped, so no further scrub is issued')
})

test('an unchanged endpoint is not rewritten on every settings event', async () => {
	const controller = fakeController({ noSelectionApi: true })
	const llm = fakeLlm()
	const settings = fakeSettings()
	const ctx = fakeContext(controller, llm, { attachments: fakeAttachments(), settings, credentials: fakeCredentials() })
	apply(ctx, { vision: { endpoint: ENDPOINT } })
	await flush()

	// A save that touches only an unrelated field must not re-push the route.
	settings.save({ instruction: '只转录文字' })
	await flush()
	const routes = () => settings.mutations.filter((mutation) => mutation.namespace === 'llm-pi-ai')
	assert.equal(routes().length, 1, 'the upstream route is written once, not once per settings event')
	assert.equal(settings.mutations.length, 2, 'and the one key scrub is not repeated either')

	// Changing the endpoint itself is a new signature and must be pushed.
	settings.save({ vision: { endpoint: { ...ENDPOINT, model: 'other-vision' } } })
	await flush()
	assert.equal(routes().length, 2)
	assert.deepEqual(routes()[1].ops[0].value.models, [{ id: 'other-vision', input: ['text', 'image'] }])
})

test('a deployment without the settings service keeps routing on the explicit route', async () => {
	const controller = fakeController({ noSelectionApi: true })
	const llm = fakeLlm()
	const ctx = fakeContext(controller, llm, { attachments: fakeAttachments() })
	apply(ctx, { vision: VISION })
	await flush()
	assert.equal(ctx.logs.warn.length, 0, 'a missing llm/settings service is not a warning')
	await controller.prompt({ sessionId: 's1', content: IMAGE })
	assert.equal(llm.calls[0].provider, VISION.provider)
})

test('a skipped or failed endpoint write reports itself as not-synced, so it stays retryable', async () => {
	const endpoint = readEndpoint(ENDPOINT, 'vision.endpoint', [])
	const credentials = fakeCredentials()

	// No settings service: nothing can be written, and the caller must be able to
	// tell — an outcome that started with `endpoint-route-ok` would mark the
	// endpoint as done for the process lifetime.
	const skipped = await syncEndpoint({ credentials }, endpoint)
	assert.equal(skipped.startsWith('endpoint-route-ok'), false, 'a skipped write is not reported as synced')

	// A settings service that refuses the write: same contract.
	const refusing = { async mutate() { throw new Error('read-only settings provider') } }
	const failed = await syncEndpoint({ settings: refusing, credentials }, endpoint)
	assert.equal(failed.startsWith('endpoint-route-ok'), false, 'a refused write is not reported as synced')

	// And the real thing does report success, so the signature is only kept then.
	const accepting = fakeSettings()
	const ok = await syncEndpoint({ settings: accepting, credentials }, endpoint)
	assert.equal(ok.startsWith('endpoint-route-ok'), true, 'a completed write is reported as synced')
	assert.equal(accepting.mutations.length, 1)
	assert.deepEqual(credentials.sets, [{ ref: ENDPOINT_KEY_REF, value: 'sk-card-typed' }])
})

// ── The capability oracle behind the model picker ───────────────────────────
//
// The card can only ask `remote.llm.discoverModels(settingsNs, …)`, and the
// namespace it can name is this plugin's own. Registering a discovery handler
// there is what turns that call into "which of this route's models take
// images?" — a question only the Host can answer.

test('modelAcceptsImages trusts a declaration over the model id', () => {
	assert.equal(modelAcceptsImages({ id: 'gpt-4o', inputModalities: ['text', 'image'] }), true)
	assert.equal(modelAcceptsImages({ id: 'gpt-4o', inputModalities: ['text'] }), false, 'an explicit text-only declaration wins over a vision-looking id')
	assert.equal(modelAcceptsImages({ id: 'qwen3.8-flash' }), false, 'a disclosed-nothing id that says nothing stays out')
	assert.equal(modelAcceptsImages({ id: 'qwen-vl-max' }), true, 'an undisclosed route falls back to the id')
	assert.equal(modelAcceptsImages({ id: 'glm-4v' }), true)
	assert.equal(modelAcceptsImages({ inputModalities: ['image'] }), true, 'a declaration alone is enough')
})

test('the plugin registers the vision oracle under its own settings namespace', () => {
	const llm = fakeLlm({ models: { 'some-route': [] } })
	const ctx = fakeContext(fakeController(), llm, { attachments: fakeAttachments() })
	apply(ctx, { vision: VISION })

	assert.equal(llm.discoveries.length, 1, 'exactly one discovery registration')
	assert.equal(llm.discoveries[0].settingsNs, 'image-router', 'the card can only name this namespace')
	assert.equal(typeof llm.discoveries[0].handler, 'function')
})

test('the oracle answers with only the image-capable models of a route', async () => {
	const llm = fakeLlm()
	const ctx = fakeContext(fakeController(), llm, { attachments: fakeAttachments() })
	apply(ctx, { vision: VISION })
	const oracle = llm.discoveries[0].handler
	const listed = {
		'route-a': [
			{ provider: 'route-a', id: 'text-only', name: 'Text', inputModalities: ['text'] },
			{ provider: 'route-a', id: 'vision-one', name: 'Vision', inputModalities: ['text', 'image'] },
			{ provider: 'route-a', id: 'qwen-vl-max', name: 'Undisclosed' },
		]
	}
	llm.models = listed

	const answer = await oracle({ provider: 'route-a' }, undefined)
	assert.deepEqual(answer, [
		{ id: 'vision-one', name: 'Vision' },
		{ id: 'qwen-vl-max', name: 'Undisclosed' }
	], 'text-only stays out, declared and id-recognised image models stay in')
})

test('the oracle answers an empty list for a route it cannot inspect', async () => {
	const llm = fakeLlm()
	const ctx = fakeContext(fakeController(), llm, { attachments: fakeAttachments() })
	apply(ctx, { vision: VISION })
	const oracle = llm.discoveries[0].handler

	assert.deepEqual(await oracle({ provider: 'unregistered' }, undefined), [], 'an unknown route is an answer, not a throw')
	assert.deepEqual(await oracle({}, undefined), [], 'a request naming no provider answers empty')
	assert.deepEqual(await oracle(undefined, undefined), [], 'and so does no request at all')
})

test('discoverVisionModels answers empty without an llm service instead of throwing', async () => {
	const bare = { get: () => undefined }
	assert.deepEqual(await discoverVisionModels('anything', bare), [])
	assert.deepEqual(await discoverVisionModels('anything', undefined), [])
	assert.deepEqual(await discoverVisionModels('   ', { get: () => ({ listModels: async () => [] }) }), [])
})

// ── The schema contract every consumer reads ────────────────────────────────
//
// `Config` is dual-form, and which form loads depends on where the module sits:
// from this checkout nothing resolves schemastery (`schemaForm === 'fallback'`),
// while an installed profile copy reaches it through the running CLI
// (`schemaForm === 'schemastery'` — verified in an isolated profile). Both forms
// must therefore satisfy the same contract, and this test asserts only that
// contract. `safeParse` is deliberately NOT part of it: the fallback happens to
// provide it, the real schemastery does not, and asserting it here would have
// tested the fallback's private surface instead of what the harness reads.

test('Config satisfies every consumer the harness reads it through', () => {
	assert.ok(schemaForm === 'fallback' || schemaForm === 'schemastery', `unexpected schema form ${schemaForm}`)

	// 1. Cordis: the Standard Schema interface.
	assert.equal(Config['~standard'].version, 1)
	assert.equal(typeof Config['~standard'].validate, 'function')

	// 2. The settings service calls the schema to layer defaults (`resolve()`).
	assert.equal(typeof Config, 'function')
	const resolved = Config({ mode: 'switch' })
	assert.equal(resolved.mode, 'switch', 'a supplied field survives resolution')
	assert.equal(resolved.maxTokens, 900, 'documented defaults are materialized')
	assert.equal(typeof Config().enabled, 'boolean')

	// 3. `settings.describe()` calls `schema.toJSON()` for every registered
	//    namespace, and the configuration page renders its form by walking that
	//    descriptor. A descriptor with no field metadata does not merely render an
	//    empty form: the provider/settings directory fails to load
	//    ("加载提供方目录失败"), which takes the model page down with it.
	assert.equal(typeof Config.toJSON, 'function')
	const descriptor = Config.toJSON()
	assert.ok(descriptor !== null && typeof descriptor === 'object')
	if (schemaForm === 'schemastery') {
		assert.ok(Object.keys(descriptor).length > 0, 'a real schemastery descriptor must carry the field graph the page walks')
	} else {
		assert.equal(descriptor.type, 'object', 'the fallback must at least be walkable')
		assert.equal(typeof descriptor.dict, 'object')
	}

	// A surface may reach for a Zod-shaped parse; if it is offered it must answer
	// rather than throw. The real schemastery does not offer it, and nothing in the
	// harness calls it, so its absence is not a defect.
	if (typeof Config.safeParse === 'function') {
		const parsed = Config.safeParse({ mode: 'digest' })
		assert.equal(parsed.success, true)
		assert.equal(parsed.data.mode, 'digest')
	}

	// 4. A 0.2.x configuration surface writes a field only when that path is marked
	//    `volatile` in the entry's own schema (`SettingsForms.write`: "Config field
	//    … is not volatile"), and redacts the ones declared `role: 'secret'`. Both
	//    flags live in `meta`, so they are asserted on the live schema nodes — and
	//    never on an ancestor AND its child, which schemastery rejects.
	if (schemaForm === 'schemastery') {
		const dict = Config.dict ?? {}
		for (const key of LIVE_FIELDS) assert.equal(dict[key]?.meta?.volatile, true, `${key} must be writable from a live surface`)
		assert.notEqual(dict.tool?.meta?.volatile, true, 'a mount-time field must not be offered as live-editable')
		assert.notEqual(dict.traceFile?.meta?.volatile, true)
		assert.equal(dict.vision.meta.volatile, true, 'the vision subtree is covered by its top-level ancestor')
		assert.notEqual(dict.vision.dict.provider?.meta?.volatile, true, 'a child of a volatile node must stay unmarked — schemastery rejects a volatile node inside a volatile one')
		assert.equal(dict.vision.dict.endpoint.dict.apiKey.meta.role, 'secret', 'the credential is redacted on the way out')
		const descriptor = JSON.stringify(Config.toJSON())
		assert.equal(descriptor.includes('"volatile":true'), true, 'the descriptor a form walks carries the marker')
		assert.equal(descriptor.includes('secret'), true, 'and the secret role with it')
	}
})

test('the resolver reaches schemastery through the harness when this file cannot', async () => {
	// A bare import resolves against this file's real path, which for an installed
	// plugin is a profile's node_modules — nowhere near the harness's own packages.
	// Trusting that alone silently downgraded the configuration page, so the resolver
	// also anchors on the running CLI. This runs the module the way a deployment
	// does, with argv[1] set to the harness's own bin.js.
	const { execFileSync } = await import('node:child_process')
	const cli = 'C:/Users/18811/AppData/Roaming/npm/node_modules/@deepseek-ai/dsh/lib/bin.js'
	const probe = [
		`process.argv[1] = ${JSON.stringify(cli)};`,
		`import(${JSON.stringify(new URL('../lib/index.js', import.meta.url).href)})`,
		'  .then((mod) => { console.log(mod.schemaForm + " " + Object.keys(mod.Config.toJSON() ?? {}).length); })',
		'  .catch((error) => { console.log("error " + String(error).slice(0, 80)); });'
	].join('\n')
	let output
	try {
		output = execFileSync(process.execPath, ['-e', probe], { encoding: 'utf8' }).trim()
	} catch {
		// No harness on this machine (a bare CI checkout): the contract test above
		// already covers the fallback, so there is nothing to assert here.
		return
	}
	const [form, keys] = output.split(' ')
	if (form === 'schemastery') {
		assert.ok(Number(keys) > 0, 'the schemastery descriptor must expose the field graph')
	} else {
		assert.equal(form, 'fallback', `unexpected resolver outcome: ${output}`)
	}
})

// ── The browser half's activation contract ──────────────────────────────────
//
// A client plugin declares the modules its factory may reach through
// `dsh.client.inject`. The shell activates an entry only when every declared
// module exists, so a declaration naming a module this deployment does not ship
// leaves the plugin **pending forever**: `apply` never runs, no card registers,
// and the plugin configuration tab renders nothing for it.
//
// Separately, cordis' plugin context is declaration-gated per service: reading a
// service the plugin did not declare throws. The card's render reads `ctx.remote`,
// so that declaration has to exist even though nothing touches it during
// activation — omitting it produced a registration that succeeded and then
// crashed when the tab dispatched it, which reads as a missing option.

test('the client manifest declares the bundles the sidebar entry is seated in', () => {
	// `dsh.client.inject` on 0.2.x names the PACKAGE rows whose client bundles must
	// arrive before this one materializes — it is boot composition, not a service
	// list (the service list is the module's own `inject` export). The sidebar entry
	// is seated in two of them: the layout owns `main`, the sidebar owns
	// `sidebar.panellist`. Naming the packages the shipped panel plugins name keeps
	// this half installable: an unknown row is what leaves an entry pending.
	const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
	const rows = new Set([
		'@deepseek-ai/dsh-api-remotes',
		'@deepseek-ai/dsh-client-ui-layout',
		'@deepseek-ai/dsh-client-ui-sidebar'
	])
	assert.deepEqual(manifest.dsh.client.inject, [...rows], 'declare the three rows the entry is composed after')
	for (const dep of manifest.dsh.client.inject) {
		assert.ok(rows.has(dep), `client inject names a row the runtime does not compose: ${dep}`)
	}
	assert.equal(manifest.dsh.client.platform, 'web')
	assert.equal(typeof manifest.exports['./client'], 'string', 'and the browser half is exported for the module table')
})

test('the browser half activates and registers its card', () => {
	const source = readFileSync(new URL('../client/client.js', import.meta.url), 'utf8')
	let entry
	new Function('window', source)({ __ModuleLoader__: { load: (value) => { entry = value } } })
	const React = {
		createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
		useState: (initial) => [initial, () => {}],
		useEffect: () => {},
		useCallback: (fn) => fn,
		useMemo: (fn) => fn()
	}
	const module = entry.factory((name) => (name === 'react' ? React : (() => { throw new Error(name) })()))

	const registered = []
	const renders = new Map()
	const base = {
		remote: {
			llm: { listProviders: async () => ({ ok: true, value: [] }) },
			settings: {
				describe: async () => ({ ok: true, value: { namespaces: [{ ns: 'image-router', value: {}, writable: true, revision: 1 }] } }),
				mutate: async () => {}
			}
		},
		slots: {
			inject: (name, callback) => {
				registered.push(`inject:${name}`)
				callback()
			},
			register: (options, render) => {
				// A list entry carries `id`, a keyed entry `key`; record whichever the
				// registration shape supplies so the assertion reads the real contract.
				registered.push(`register:${options.name}:${options.key ?? options.id}`)
				assert.equal(typeof render, 'function')
				renders.set(options.name, render)
			},
			entries: (name) => {
				if (name === 'plugins.bundle.config') return [{ options: { key: 'dsh-image-router' } }]
				if (name === 'settings.plugin.item') return [{ options: { key: 'image-router' } }]
				if (name === 'sidebar.panellist') return [{ options: { id: 'image-router' } }]
				if (name === 'main') return [{ options: { key: 'image-router' } }]
				return []
			}
		}
	}
	module.apply(declaredContext(base, module.inject))

	// Every gated service the half reads must be declared, and the Remote table
	// counts per namespace: `remote` alone left `remote.settings` unreadable, which
	// surfaced only when the render asked for the configured routes.
	//
	// `settingsScope` must NOT be among them: it exists only in 0.1.x, and declaring
	// it gated this entry on a service the 0.2.x client runtime never provides — the
	// entry stayed pending and the boot aborted with "1 entry did not activate" on
	// dsh-desktop 0.2.0-rc.2.
	assert.deepEqual(
		module.inject,
		['slots', 'remote', 'remote.settings', 'remote.llm'],
		'declare every gated service, including each Remote namespace the card reads'
	)
	assert.equal(module.inject.includes('settingsScope'), false, 'a 0.1.x-only service must never be a declared dependency')

	// One card, two generations: both claims are made, and each fires only where its
	// owner declares the slot (this double declares both, so both are recorded).
	// Then the sidebar entry and the page it opens. The two must share one id: the
	// layout dispatches `main` by the id the selected row carries, so a mismatch is
	// a row that opens nothing.
	assert.deepEqual(registered, [
		'inject:plugins.bundle.config',
		'register:plugins.bundle.config:dsh-image-router',
		'inject:settings.plugin.item',
		'register:settings.plugin.item:image-router',
		'inject:sidebar.panellist',
		'register:sidebar.panellist:image-router',
		'inject:main',
		'register:main:image-router'
	], 'the settings card keeps both generation slots; the sidebar row and its main panel share one id')

	// Drive the dispatched render under the same gate: this is the call that threw
	// in the browser and left the tab with nothing to draw.
	const renderCard = renders.get('plugins.bundle.config')
	const element = renderCard()
	assert.equal(typeof element.type, 'function', 'the registration renders the card component')
	assert.equal(typeof element.props.remote, 'object', 'the card receives the Remote table')
	assert.equal(typeof element.props.remote.settings.describe, 'function', 'and specifically the namespace table the section is read from')
	assert.equal(typeof element.props.remote.settings.mutate, 'function', 'and the write path it saves through')
	assert.equal(typeof element.props.remote.llm.listProviders, 'function')

	// The sidebar icon and the page component are registered, not just claimed.
	const iconElement = renders.get('sidebar.panellist')({ size: 22, active: true })
	const icon = iconElement.type(iconElement.props)
	assert.equal(icon.type, 'svg', 'the sidebar row gets an inline SVG icon')
	assert.equal(icon.props.width, 22, 'at the edge the sidebar asked for')
	assert.equal(icon.props['aria-hidden'], 'true', 'and stays decorative: the row text is the accessible name')
	const pageElement = renders.get('main')()
	assert.equal(typeof pageElement.type, 'function', 'the main slot renders the page component')
	assert.equal(typeof pageElement.props.remote, 'object', 'which reads the same Remote table')
	const page = pageElement.type(pageElement.props)
	assert.equal(page.type, 'div', 'and draws the page shell')
})

test('the sidebar row label follows the UI language', () => {
	// The list owner re-resolves a label thunk on every projection (row text,
	// accessible name, collapsed tooltip), so the row follows the UI language
	// without being re-registered. This half registers no locale namespace — the
	// card draws its copy inline — so the language is read from the document.
	const source = readFileSync(new URL('../client/client.js', import.meta.url), 'utf8')
	let entry
	new Function('window', source)({ __ModuleLoader__: { load: (value) => { entry = value } } })
	const React = {
		createElement: (type, props) => ({ type, props: props ?? {} }),
		useState: (initial) => [initial, () => {}],
		useEffect: () => {},
		useCallback: (fn) => fn,
		useMemo: (fn) => fn()
	}
	const module = entry.factory((name) => (name === 'react' ? React : (() => { throw new Error(name) })()))

	let label
	module.apply({
		remote: { llm: {}, settings: {} },
		slots: {
			inject: (_name, callback) => callback(),
			register: (options) => { if (options.name === 'sidebar.panellist') label = options.label },
			entries: () => []
		}
	})
	assert.equal(typeof label, 'function', 'the row label is a thunk, not a frozen string')

	const previous = globalThis.document
	try {
		globalThis.document = { documentElement: { lang: 'zh-CN' } }
		assert.equal(label(), '图片路由')
		globalThis.document = { documentElement: { lang: 'en-US' } }
		assert.equal(label(), 'Image Router')
	} finally {
		if (previous === undefined) delete globalThis.document
		else globalThis.document = previous
	}
})

test('the sidebar entry opens a page carrying the configuration form', async () => {
	// The user-facing contract of the sidebar entry: click the row, get the editor.
	// The page draws its own banner and embeds the same form as the bundle card, so
	// the settings section keeps one editor rather than two that drift.
	const source = readFileSync(new URL('../client/client.js', import.meta.url), 'utf8')
	let entry
	new Function('window', source)({ __ModuleLoader__: { load: (value) => { entry = value } } })

	const hooks = []
	let cursor = 0
	const renderElement = (element) => (typeof element.type === 'function' ? element.type(element.props) : element)
	const React = {
		createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat(Infinity).filter((child) => child !== null && child !== undefined && child !== false) }),
		useState(initial) {
			const index = cursor++
			if (hooks.length <= index) hooks[index] = initial
			return [hooks[index], (next) => { hooks[index] = typeof next === 'function' ? next(hooks[index]) : next }]
		},
		useEffect(fn) {
			const index = cursor++
			if (hooks.length <= index) {
				hooks[index] = true
				queueMicrotask(fn)
			}
		},
		useCallback: (fn) => fn,
		useMemo: (fn) => fn()
	}
	const module = entry.factory((name) => (name === 'react' ? React : (() => { throw new Error(name) })()))

	let renderPanel
	module.apply({
		remote: {
			settings: {
				describe: async () => ({
					ok: true,
					value: {
						namespaces: [
							{ ns: 'image-router', value: { mode: 'switch', vision: { provider: 'qwen-token-plan-cn', model: 'qwen3.8-flash' } }, writable: true, revision: 5 },
							// The picker prefers routes this deployment already declares, so the
							// page test supplies one — otherwise the only option is the placeholder.
							{ ns: 'llm-pi-ai', value: { providers: { 'qwen-token-plan-cn': { models: [{ id: 'qwen3.8-flash' }] } } }, writable: true, revision: 5 }
						]
					}
				}),
				mutate: async () => {}
			},
			llm: { listProviders: async () => ({ ok: true, value: [] }) }
		},
		slots: {
			inject: (_name, callback) => callback(),
			register: (options, render) => { if (options.name === 'main') renderPanel = render },
			entries: () => []
		}
	})
	assert.equal(typeof renderPanel, 'function', 'the main slot keeps the page registration')

	const find = (node, predicate, out = []) => {
		if (node === null || node === undefined || typeof node !== 'object') return out
		if (Array.isArray(node)) {
			for (const child of node) find(child, predicate, out)
			return out
		}
		if (predicate(node)) out.push(node)
		find(node.children, predicate, out)
		return out
	}
	const textOf = (element) => (Array.isArray(element.children) ? element.children.join('') : String(element.children))

	// A page pass mounts the panel and then the form it embeds, in that order, so
	// the hook cursor follows the nesting React would use.
	const mount = () => {
		const page = renderElement(renderPanel())
		const formElement = find(page, (node) => typeof node.type === 'function')[0]
		const form = formElement === undefined ? undefined : renderElement(formElement)
		return { page, form }
	}
	cursor = 0
	mount()
	await flush()
	await flush()
	cursor = 0
	const { page, form } = mount()
	assert.ok(form !== undefined, 'the page embeds a component (the shared form)')

	const headings = find(page, (node) => node.type === 'h1')
	assert.equal(headings.length, 1, 'the page draws one banner heading')
	assert.equal(textOf(headings[0]), '图片路由')

	// The card's own banner must not be repeated inside the page.
	const cardHeadings = find(form, (node) => node.type === 'h4')
	assert.equal(cardHeadings.length, 0, 'the panel view omits the card banner the page already draws')

	const selects = find(form, (node) => node.type === 'select')
	assert.ok(selects.length >= 2, 'the vision-source and model pickers draw')
	const optionText = find(selects[1] ?? selects[0], (node) => node.type === 'option').map(textOf)
	assert.ok(optionText.some((label) => label.includes('qwen-token-plan-cn / qwen3.8-flash')), 'the configured route is selectable')

	const buttons = find(form, (node) => node.type === 'button').map(textOf)
	assert.ok(buttons.includes('保存'), 'the editor keeps its save action')
	const pill = find(page, (node) => node.type === 'span' && textOf(node) === 'dsh-image-router')
	assert.equal(pill.length, 1, 'and the page names the package that owns it')
})

test('the action buttons paint their label on the brand fill', () => {
	// The first real render of the panel showed the fill but not the text: the button
	// inherited the page foreground, so "保存" was the theme's near-black primary on
	// the same near-black fill. The shipped buttons pair that fill with
	// `--dsw-alias-label-primary-foreground`, so the bundle must name the pair instead
	// of inheriting — and never inherit onto a filled button again.
	const source = readFileSync(new URL('../client/client.js', import.meta.url), 'utf8')
	const start = source.indexOf('button: {')
	const end = source.indexOf('status:', start)
	assert.ok(start > 0 && end > start, 'the bundle keeps one button style block')
	const block = source.slice(start, end)
	assert.match(block, /background: 'var\(--dsw-alias-brand-primary/, 'the fill is the theme primary')
	assert.match(block, /color: 'var\(--dsw-alias-label-primary-foreground/, 'and the label uses its foreground counterpart')
	assert.equal(/color: 'inherit'/.test(block), false, 'never inherit the page foreground onto the primary fill')
})

test('the card draws a one-liner for the bundle page summary view', async () => {
	// A keyed 0.2.x configuration slot is asked for two views: the bundle page renders
	// `summary` for its row and `page` once the form is opened. Drawing the form in
	// the summary view would put a full editor inside a list row.
	const source = readFileSync(new URL('../client/client.js', import.meta.url), 'utf8')
	let entry
	new Function('window', source)({ __ModuleLoader__: { load: (value) => { entry = value } } })

	const hooks = []
	let cursor = 0
	const renderElement = (element) => (typeof element.type === 'function' ? element.type(element.props) : element)
	const React = {
		createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat(Infinity).filter((child) => child !== null && child !== undefined && child !== false) }),
		useState(initial) {
			const index = cursor++
			if (hooks.length <= index) hooks[index] = initial
			return [hooks[index], (next) => { hooks[index] = typeof next === 'function' ? next(hooks[index]) : next }]
		},
		useEffect(fn) {
			const index = cursor++
			if (hooks.length <= index) {
				hooks[index] = true
				queueMicrotask(fn)
			}
		},
		useCallback: (fn) => fn,
		useMemo: (fn) => fn()
	}
	const module = entry.factory((name) => (name === 'react' ? React : (() => { throw new Error(name) })()))

	let renderCard
	module.apply({
		remote: {
			settings: {
				describe: async () => ({
					ok: true,
					value: {
						namespaces: [{ ns: 'image-router', value: { mode: 'digest', vision: { provider: 'qwen-token-plan-cn', model: 'qwen3.8-flash' } }, writable: true, revision: 3 }]
					}
				}),
				mutate: async () => {}
			},
			llm: { listProviders: async () => ({ ok: true, value: [] }) }
		},
		slots: {
			inject: (_name, callback) => callback(),
			// The sidebar icon and the main panel register too now; keep the card's
			// render only, so driving it here stays the tab's question.
			register: (options, render) => { if (options.name === 'plugins.bundle.config') renderCard = render },
			entries: () => []
		}
	})

	// First pass mounts the card and queues its read; the second renders the state
	// that read produced.
	cursor = 0
	renderElement(renderCard({ view: 'summary' }))
	await flush()
	await flush()
	cursor = 0
	const summary = renderElement(renderCard({ view: 'summary' }))
	assert.equal(summary.type, 'span', 'the summary view is one line of text, not the form')
	const line = (Array.isArray(summary.children) ? summary.children : [summary.children]).join('')
	assert.equal(line.includes('digest'), true, 'and it names the mode in force')
	assert.equal(line.includes('qwen-token-plan-cn / qwen3.8-flash'), true, 'and the route in force')

	cursor = 0
	const page = renderElement(renderCard({ view: 'page' }))
	assert.equal(page.type, 'div', 'the page view still draws the full card')
})

test('the vision picker is populated from the configured routes', async () => {
	// The user-visible failure this guards: the card rendered, the note claimed the
	// list had been capability-filtered, and the picker was still empty. Two causes
	// are covered — the dropdown helper dropped its options (they must be children,
	// never a prop), and `settings.describe()` answers with `namespaces` as an ARRAY
	// of views, so indexing it by namespace name silently found nothing and demoted
	// the picker to the discovery fallback.
	const source = readFileSync(new URL('../client/client.js', import.meta.url), 'utf8')
	let entry
	new Function('window', source)({ __ModuleLoader__: { load: (value) => { entry = value } } })

	const hooks = []
	let cursor = 0
	const renderElement = (element) => (typeof element.type === 'function' ? element.type(element.props) : element)
	const React = {
		createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat(Infinity).filter((child) => child !== null && child !== undefined && child !== false) }),
		useState(initial) {
			const index = cursor++
			if (hooks.length <= index) hooks[index] = initial
			return [hooks[index], (next) => { hooks[index] = typeof next === 'function' ? next(hooks[index]) : next }]
		},
		useEffect(fn) {
			const index = cursor++
			if (hooks.length <= index) {
				hooks[index] = true
				queueMicrotask(fn)
			}
		},
		useCallback: (fn) => fn,
		useMemo: (fn) => fn()
	}
	const module = entry.factory((name) => (name === 'react' ? React : (() => { throw new Error(name) })()))

	const piAi = {
		providers: {
			'qwen-token-plan-cn': { models: [{ id: 'glm-5.2' }, { id: 'qwen3.8-flash' }] },
			huawei: { models: [{ id: 'deepseek-v4-flash' }] }
		}
	}
	let renderCard
	module.apply({
		remote: {
			// Both sections arrive from the same call: `describe()` answers one view per
			// configurable section, and the card reads its own section and the
			// configured pi-ai routes out of it.
			settings: {
				describe: async () => ({
					ok: true,
					value: {
						writable: true,
						hasDocument: true,
						namespaces: [
							{ ns: 'image-router', value: { mode: 'digest', vision: { provider: 'qwen-token-plan-cn', model: 'qwen3.8-flash' } }, writable: true, revision: 1 },
							{ ns: 'llm-pi-ai', value: piAi }
						]
					}
				}),
				mutate: async () => {}
			},
			llm: { listProviders: async () => ({ ok: true, value: [] }), discoverModels: async () => ({ ok: true, value: [] }) }
		},
		slots: {
			inject: (_n, callback) => callback(),
			// The sidebar icon and the main panel register too now; keep the card's
			// render only, so driving it here stays the settings surface's question.
			register: (options, render) => { if (options.name === 'plugins.bundle.config') renderCard = render },
			entries: () => []
		}
	})

	cursor = 0
	renderElement(renderCard())
	await flush()
	await flush()
	cursor = 0
	const tree = renderElement(renderCard())

	const optionValues = []
	const strings = []
	const selects = []
	const walk = (node) => {
		if (node === null || node === undefined) return
		if (typeof node === 'string') {
			strings.push(node)
			return
		}
		if (Array.isArray(node)) {
			for (const child of node) walk(child)
			return
		}
		if (typeof node !== 'object') return
		if (node.type === 'option') optionValues.push(node.props.value)
		if (node.type === 'select') selects.push(node)
		for (const child of node.children ?? []) walk(child)
	}
	walk(tree)

	assert.ok(optionValues.includes('qwen-token-plan-cn\u0000qwen3.8-flash'), 'the configured qwen route/model must be selectable, not merely named in the note')
	assert.ok(optionValues.includes('huawei\u0000deepseek-v4-flash'), 'every configured route contributes its models')
	assert.ok(strings.some((text) => text.includes('来自已配置的 llm-pi-ai 路由')), 'and the note says the list came from the configured routes, not the fallback')
	assert.ok(selects.length >= 2, 'both dropdowns render')
	for (const control of selects) assert.ok((control.children ?? []).length > 0, 'no dropdown may render without any option')
})

test('the browser half reports an unusable slot service instead of throwing at activation', () => {
	// The card is no longer gated on a settings service the runtime may not have, so
	// the remaining activation hazard is the slot ledger itself. A context that
	// refuses it must still be a reported no-op: an activation throw takes the whole
	// shell's plugin load down with it.
	const source = readFileSync(new URL('../client/client.js', import.meta.url), 'utf8')
	let entry
	new Function('window', source)({ __ModuleLoader__: { load: (value) => { entry = value } } })
	const React = {
		createElement: () => null,
		useState: (initial) => [initial, () => {}],
		useEffect: () => {},
		useCallback: (fn) => fn,
		useMemo: (fn) => fn()
	}
	const module = entry.factory((name) => (name === 'react' ? React : (() => { throw new Error(name) })()))

	let warned = 0
	const originalWarn = console.warn
	console.warn = () => { warned++ }
	try {
		module.apply(declaredContext({
			remote: { llm: {}, settings: {} },
			slots: { inject() { throw new Error('no slot ledger in this shell') } }
		}, module.inject))
	} finally {
		console.warn = originalWarn
	}
	assert.equal(warned, 1, 'an unusable slot ledger is reported once, not thrown')
})

// ── The credential never enters this plugin's own configuration ─────────────
//
// The settings section is handed back by `describe()` as the RESOLVED value,
// which includes the user layer, and the section is persisted verbatim. A key
// left in there therefore round-trips into `$DSH_HOME/settings.yaml` as plain
// text — observed live, which is why the composition base strips it and the card
// refuses to seed its editor from a stored key.

test('the settings composition base carries no credential', () => {
	const resolved = normalizeConfig({ vision: { endpoint: { ...ENDPOINT, apiKey: 'sk-live-secret' } } })
	const base = configBase(resolved)
	assert.equal(base.vision.endpoint.apiKey, undefined, 'the key must not reach the settings section')
	assert.equal(base.vision.endpoint.baseURL, 'https://gateway.example/v1', 'everything else about the endpoint survives')
	assert.equal(base.vision.endpoint.model, 'my-vision-model')
	assert.equal(base.vision.endpoint.apiKeyEnv, undefined, 'the default reference is materialized by the Host when it writes the route, not carried in the section')
	assert.equal(base.vision.provider, undefined, 'the route derived from the endpoint is not restated beside it: an explicit route outranks the endpoint')

	// An explicitly chosen reference does travel, because it is configuration.
	const named = configBase(normalizeConfig({ vision: { endpoint: { ...ENDPOINT, apiKeyEnv: 'MY_GATEWAY_KEY', apiKey: 'sk-live-secret' } } }))
	assert.equal(named.vision.endpoint.apiKeyEnv, 'MY_GATEWAY_KEY')
	assert.equal(named.vision.endpoint.apiKey, undefined)

	// The key never survives into the resolved configuration at all: the endpoint tier
	// reads the plaintext from the declaring layer at the one moment it writes the
	// credential, so no later reader of `env.config` can see it.
	assert.equal(resolved.endpoint.apiKey, undefined, 'the resolved configuration must not carry the credential')
})

test('the section base never states an endpoint route as an explicit choice', () => {
	// The base is part of the value the host composes and hands back as the section.
	// When it carried the RESOLVED route beside the endpoint, the section looked like
	// "explicitly chose qwen-token-plan-cn/qwen3.8-flash AND configured an endpoint",
	// and the explicit choice outranks the endpoint — so the configured endpoint was
	// never used. Observed live as
	// `visionKeys=provider,model,endpoint -> qwen-token-plan-cn/qwen3.8-flash` while
	// the section's own file held only `endpoint`.
	const composed = { mode: 'digest', vision: { provider: 'qwen-token-plan-cn', model: 'qwen3.8-flash' } }
	const section = { vision: { endpoint: { baseURL: 'https://gateway.example/v1', model: 'qwen3.8-max', apiKey: 'sk-x', images: true } } }
	const resolved = normalizeConfig({ ...composed, ...section })
	assert.deepEqual(resolved.vision, { provider: ENDPOINT_PROVIDER, model: 'qwen3.8-max' }, 'the endpoint resolves to its own route')

	const base = configBase(resolved)
	assert.deepEqual(Object.keys(base.vision), ['endpoint'], 'the base names only the endpoint, never the route derived from it')
	assert.equal(base.vision.endpoint.apiKey, undefined, 'and never the credential')

	// Round-trip the way the host does: compose base with the user layer, then resolve.
	const handedBack = normalizeConfig({ ...base, ...section })
	assert.deepEqual(handedBack.vision, { provider: ENDPOINT_PROVIDER, model: 'qwen3.8-max' }, 'the composed section still resolves to the endpoint')

	// The live failure exactly: the loader's route is in the configuration when the
	// base is computed (registration time, before any section exists), and the host
	// deep-merges the base into the user's section. A route in the base would therefore
	// survive beside the endpoint — and an endpoint outranks nothing, so the section
	// would resolve to the composed route instead of the endpoint the user saved.
	const loader = normalizeConfig({ mode: 'digest', vision: { provider: 'qwen-token-plan-cn', model: 'qwen3.8-flash' } })
	const liveBase = configBase(loader)
	const liveSection = deepMerge(liveBase, section)
	assert.equal(liveSection.vision.provider, undefined, 'no route may survive the deep merge beside an endpoint')
	assert.deepEqual(normalizeConfig(liveSection).vision, { provider: ENDPOINT_PROVIDER, model: 'qwen3.8-max' }, 'so the endpoint the user saved is the route in force')

	// With no endpoint the base still states no route, and the loader's route remains in
	// force because it lives in the entry's own configuration, which the base layers
	// over rather than replaces.
	const routeOnly = configBase(normalizeConfig({ mode: 'digest', vision: { provider: 'huawei', model: 'glm-5.2' } }))
	assert.deepEqual(routeOnly.vision, {}, 'the base states no route in either case')
})

test('an empty string is absent, not an explicit route', () => {
	// A schema may materialize an unset optional string as `''`. Treating that as
	// "present" made a route look explicitly chosen and silently outrank an endpoint.
	const configured = normalizeConfig({
		mode: 'digest',
		vision: { provider: '', model: '', endpoint: { baseURL: 'https://gateway.example/v1', model: 'qwen3.8-max' } }
	})
	assert.equal(configured.vision.provider, ENDPOINT_PROVIDER, 'empty strings must not shadow the endpoint')
	assert.equal(configured.vision.model, 'qwen3.8-max')
	assert.equal(configured.problems, undefined, 'and they must not be reported as a validation failure')

	// A half-filled explicit route is still malformed, and still refused.
	const broken = normalizeConfig({ mode: 'digest', vision: { provider: 'huawei', model: '' } })
	assert.ok(broken.problems?.some((problem) => problem.includes('vision.model')), 'a missing model is still refused')
})

test('the card never seeds its editor from a stored key', async () => {
	// An older build could have written the key into the user layer, so the snapshot
	// may still contain one. Seeding the draft from it would re-persist the secret on
	// the next unrelated save.
	const source = readFileSync(new URL('../client/client.js', import.meta.url), 'utf8')
	let entry
	new Function('window', source)({ __ModuleLoader__: { load: (value) => { entry = value } } })
	const React = {
		createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
		useState: (initial) => [initial, () => {}],
		useEffect: () => {},
		useCallback: (fn) => fn,
		useSyncExternalStore: (_s, snapshot) => snapshot(),
		useMemo: (fn) => fn()
	}
	const module = entry.factory((name) => (name === 'react' ? React : (() => { throw new Error(name) })()))
	let renderCard
	module.apply({
		remote: { settings: { describe: async () => ({ ok: true, value: { namespaces: [] } }) }, llm: { listProviders: async () => ({ ok: true, value: [] }) } },
		settingsScope: {
			bind: () => ({
				subscribe: () => () => {},
				getSnapshot: () => ({
					value: { mode: 'digest', vision: { endpoint: { baseURL: 'https://x/v1', model: 'm', apiKey: 'sk-stale-secret' } } },
					writable: true,
					revision: 1
				}),
				set: async () => {}
			})
		},
		slots: {
			inject: (_n, callback) => callback(),
			// The sidebar icon and the main panel register too now; keep the card's
			// render only, so driving it here stays the settings surface's question.
			register: (options, render) => { if (options.name === 'plugins.bundle.config') renderCard = render },
			entries: () => []
		}
	})

	const tree = typeof renderCard().type === 'function' ? renderCard().type(renderCard().props) : renderCard()
	const secretLeaks = []
	const walk = (node) => {
		if (node === null || node === undefined) return
		if (typeof node === 'string') {
			if (node.includes('sk-stale-secret')) secretLeaks.push(node)
			return
		}
		if (Array.isArray(node)) { for (const child of node) walk(child); return }
		if (typeof node !== 'object') return
		if (typeof node.props?.value === 'string' && node.props.value.includes('sk-stale-secret')) secretLeaks.push(node.props.value)
		for (const child of node.children ?? []) walk(child)
	}
	walk(tree)
	assert.deepEqual(secretLeaks, [], 'a stored key must never appear in the editor, so it can never be written back')
})

// ── The configuration in force follows the settings layer, whenever it lands ─
//
// The settings section arrives asynchronously, after the environment exists. A
// mount that captured the loader's configuration before that kept routing to the
// composed route for the life of the process — observed live as
// `mounted … vision=<composed route>` while the saved section named an endpoint
// route, and as a digest that never reached the endpoint the user configured.

test('the live configuration reflects a settings section installed after startup', () => {
	const composed = { mode: 'digest', vision: { provider: 'qwen-token-plan-cn', model: 'qwen3.8-flash' }, tool: false }
	const env = createEnv({}, composed, normalizeConfig(composed), () => {})

	assert.deepEqual(env.config.vision, { provider: 'qwen-token-plan-cn', model: 'qwen3.8-flash' }, 'before any section, the loader configuration is in force')
	assert.equal(env.hasOverrides, false)

	// The user's saved section arrives: it names an endpoint, not a route.
	env.setOverrides({ vision: { endpoint: { baseURL: 'https://gateway.example/v1', model: 'qwen3.8-max', images: true } } })

	assert.equal(env.hasOverrides, true)
	assert.deepEqual(env.config.vision, { provider: ENDPOINT_PROVIDER, model: 'qwen3.8-max' }, 'the endpoint the user saved is the route in force, not the composed one')
	assert.equal(env.config.endpoint.baseURL, 'https://gateway.example/v1')

	// A section the disposer clears restores the composed configuration.
	env.setOverrides(undefined)
	assert.deepEqual(env.config.vision, { provider: 'qwen-token-plan-cn', model: 'qwen3.8-flash' }, 'a cleared section restores the composed route')
})

test('an invalid section is refused in favour of the last good configuration', () => {
	const composed = { mode: 'digest', vision: { provider: 'qwen-token-plan-cn', model: 'qwen3.8-flash' } }
	const audit = []
	const env = createEnv({}, composed, normalizeConfig(composed), (line) => audit.push(line))
	env.setOverrides({ mode: 'digest', maxTokens: 0 })
	assert.equal(env.config.maxTokens, 900, 'the last good value survives a bad save')
	assert.ok(audit.some((line) => line.startsWith('settings-invalid')), 'and the refusal is audited')
})

test('the endpoint write preserves fields the Models page added to the route', async () => {
	const endpoint = readEndpoint(ENDPOINT, 'vision.endpoint', [])
	const existing = {
		displayName: 'Renamed By Hand',
		headers: { 'x-tenant': 'acme' },
		timeoutMs: 5_000,
		compat: { thinkingFormat: 'deepseek' },
		models: [{ id: 'stale-model', contextWindow: 1_000 }]
	}
	const op = endpointSettingsOp(endpoint, () => existing)

	assert.equal(op.path[0], 'providers')
	assert.equal(op.path[1], ENDPOINT_PROVIDER)
	assert.deepEqual(op.value.headers, { 'x-tenant': 'acme' }, 'a deployment header survives the card save')
	assert.equal(op.value.timeoutMs, 5_000, 'a route timeout set elsewhere survives')
	assert.deepEqual(op.value.compat, { thinkingFormat: 'deepseek' })
	// The fields this card owns still win.
	assert.equal(op.value.baseURL, 'https://gateway.example/v1')
	assert.equal(op.value.api, 'openai-completions')
	assert.deepEqual(op.value.models, [{ id: 'my-vision-model', input: ['text', 'image'] }], 'the model list is rebuilt from the endpoint rather than merged')
})

test('the endpoint write falls back to a clean profile when no read is possible', () => {
	const endpoint = readEndpoint(ENDPOINT, 'vision.endpoint', [])
	const fromNothing = endpointSettingsOp(endpoint, () => undefined)
	const fromJunk = endpointSettingsOp(endpoint, () => 'not-an-object')
	const fromThrow = endpointSettingsOp(endpoint, () => {
		throw new Error('settings namespace unavailable')
	})
	const expected = { baseURL: 'https://gateway.example/v1', api: 'openai-completions', apiKeyEnv: ENDPOINT_KEY_REF }
	for (const op of [fromNothing, fromJunk, fromThrow]) {
		assert.equal(op.value.baseURL, expected.baseURL)
		assert.equal(op.value.api, expected.api)
		assert.equal(op.value.apiKeyEnv, expected.apiKeyEnv)
	}
})

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

import { apply, decideRoute, nameLooksLikeImage, normalizeConfig, promptWantsVision, sameModel } from '../lib/index.js'

const EXTENSIONS = ['png', 'jpg', 'jpeg', 'webp', 'gif']
const VISION = { provider: 'qwen-token-plan-cn', model: 'qwen3.8-flash' }
const TEXT = { provider: 'deepseek-official', model: 'deepseek-flash' }
const WIRE_IMAGE = { type: 'image', mediaType: 'image/png', data: 'AAAA', name: 'shot.png' }
const EMPTY_IMAGE = [{ type: 'image', attachment: {} }]
const IMAGE = [{ type: 'text', text: '读一下' }, WIRE_IMAGE]
const PLAIN = [{ type: 'text', text: 'plain question' }]

/** Minimal ctx double recording logger calls and collecting effects. */
function fakeContext(controller, llm, { controllerAvailable = true, attachments, fs, tools } = {}) {
	const logs = { info: [], warn: [] }
	const disposers = []
	const injected = []
	const ctx = {
		logs,
		disposers,
		injected,
		tools,
		sessionController: controllerAvailable ? controller : undefined,
		get: (key) => {
			if (key === 'llm') return llm
			if (key === 'attachments') return attachments
			if (key === 'fs') return fs
			if (key === 'tools') return tools
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

/** LLM double: an async stream of chunks, recording every option object. */
function fakeLlm({ chunks = [{ type: 'text-delta', text: '文字内容: VISION ROUTER\n画面描述: 深蓝色背景' }, { type: 'finish', reason: 'stop' }] } = {}) {
	const calls = []
	return {
		calls,
		async *stream(options) {
			calls.push(options)
			for (const chunk of chunks) yield chunk
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

test('digest mode sends the admitted images to the vision route as a one-shot call', async () => {
	const controller = fakeController({ noSelectionApi: true })
	const llm = fakeLlm()
	const attachments = fakeAttachments()
	const trace = join(mkdtempSync(join(tmpdir(), 'vision-router-digest-')), 'trace.log')
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
	assert.ok(audit.includes('digest session=session-7 images=1'))
	assert.ok(audit.includes('names=shot.png'), 'the audit keeps the original name')
	assert.equal(audit.includes('error='), false)
	rmSync(join(trace, '..'), { recursive: true, force: true })
})

test('digest mode keeps the image when the vision call fails', async () => {
	const controller = fakeController({ noSelectionApi: true })
	const llm = fakeLlm({ chunks: [{ type: 'text-delta', text: 'partial' }, { type: 'finish', reason: 'error' }] })
	const attachments = fakeAttachments()
	const trace = join(mkdtempSync(join(tmpdir(), 'vision-router-fail-')), 'trace.log')
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
	const trace = join(mkdtempSync(join(tmpdir(), 'vision-router-dry-')), 'trace.log')
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
	const trace = join(mkdtempSync(join(tmpdir(), 'vision-router-admit-')), 'trace.log')
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
	const dir = mkdtempSync(join(tmpdir(), 'vision-router-cold-'))
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
	const dir = mkdtempSync(join(tmpdir(), 'vision-router-'))
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

	assert.deepEqual(ctx.injected, ['tools', 'sessionController'], 'every service is requested optionally, never as a required dependency')
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
	const trace = join(mkdtempSync(join(tmpdir(), 'vision-router-tool-')), 'trace.log')
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
	assert.deepEqual(disabled.injected, ['sessionController'], 'a disabled tool is not even requested')

	const bare = fakeContext(fakeController(), fakeLlm(), { attachments: fakeAttachments(), fs: fakeFs() })
	apply(bare, { vision: VISION })
	assert.deepEqual(bare.injected, ['tools', 'sessionController'], 'the tool service is requested optionally, so its absence cannot fail the mount')
	assert.equal(bare.logs.warn.length, 0)
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

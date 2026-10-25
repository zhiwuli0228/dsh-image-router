// image-router — browser half (client plugin bundle).
//
// Loaded by dsh-client-modules through the vendored cordis Loader's lazy-CJS
// module table (window.__ModuleLoader__.load), the same shape the shipped ui-*
// bundles emit: the factory body is plain CJS and require() resolves against the
// shell's module table, so only platform seed words may be required.
//
// What it adds is the card that edits the Host settings section `image-router`
// (both halves keep spelling the same id: it is the prefix's settings namespace on
// 0.1.x and the loader entry id on 0.2.x). The Host stays the fact source: this
// half only renders the section and writes to it, and a saved field reaches the
// plugin's next decision without a restart.
//
// **Two generations, one card.** The card reads and writes through the Remote
// settings table (`remote.settings.describe()` / `mutate(ns, ops, revision)`),
// which both generations expose, instead of through the 0.1.x-only `settingsScope`
// client service. Where the card is *mounted* differs by generation, so it is
// claimed in both places and each claim fires only where its slot is declared:
//
//   - 0.1.x: `settings.plugin.item`, keyed by the settings namespace.
//   - 0.2.x: `plugins.bundle.config`, keyed by the bundle's package name.
//
// The `settingsScope` service is deliberately NOT declared. Requiring it made the
// loader gate this entry on a service 0.2.x does not ship, so the entry stayed
// `pending (waiting for service: settingsScope)` and the whole web boot aborted
// with "1 entry did not activate" (observed on dsh-desktop 0.2.0-rc.2).
//
// Defensive by construction: the host does NOT isolate loader-entry factories, so
// one throwing factory takes the whole web shell down ("Failed to load plugins").
// Every seed is resolved inside a try, and a total failure returns a no-op module:
// the card goes missing with one console warning instead of breaking DSH.

window.__ModuleLoader__.load({
	id: 'dsh-image-router',
	factory: (require) => {
		var module = { exports: {} }
		var exports = module.exports
		Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

		// ── Platform seeds ──────────────────────────────────────────────────────
		function requireSeed(name) {
			try {
				return require(name)
			} catch {
				return undefined
			}
		}

		const React = requireSeed('react')
		if (React === undefined || typeof React.createElement !== 'function') {
			console.warn('[image-router] react is unavailable in the shell module table — plugin card disabled')
			exports.name = 'image-router'
			exports.inject = []
			exports.apply = () => {}
			return module.exports
		}

		const h = React.createElement
		/** Namespace the Host section and this card both key to. */
		const NAMESPACE = 'image-router'
		/** This bundle's package name: the key 0.2.x dispatches a bundle's config by. */
		const PACKAGE = 'dsh-image-router'
		/** Upstream namespace the custom endpoint tier writes its route into. */
		const PI_AI_NAMESPACE = 'llm-pi-ai'
		/** Route key the Host derives for a custom endpoint (lib/endpoint.js keeps the same value). */
		const ENDPOINT_PROVIDER = 'image-router-vision'
		/**
		 * The sidebar row id, and the `main` keyed-slot key it opens.
		 *
		 * The sidebar resolves a row's id/label/order from its `sidebar.panellist`
		 * list registration; `ctx.layout.selectPanel(id)` then dispatches the layout's
		 * root-scoped `main` keyed slot by that same id. Two slots, one spelling — an
		 * id registered in only one of them is a row that opens nothing (or a page
		 * nothing can reach).
		 */
		const PANEL_ID = 'image-router'
		/** Row order among the shipped global panels; ties keep registration order. */
		const PANEL_ORDER = 40
		/** Section fields the card edits; each is written as its own path op. */
		const FIELDS = ['mode', 'vision', 'instruction', 'maxTokens', 'timeoutMs', 'label', 'endpoint']

		/**
		 * The section, read and written through the Remote settings table.
		 *
		 * `describe()` answers every configurable namespace with one view; the view
		 * carries the resolved `value`, the namespace `revision` and whether writes
		 * are accepted. `mutate(ns, ops, revision)` applies path-addressed ops — leaf
		 * paths, because a 0.2.x deployment accepts a write only when that exact path
		 * is volatile in the entry's own Config schema, and the plugin declares its
		 * top-level fields (never both an ancestor and its child) volatile.
		 */
		function namespaceClient(remote) {
			return {
				async read() {
					const response = await remote.settings.describe()
					const views = response !== null && typeof response === 'object' && response.ok === true ? response.value?.namespaces : undefined
					const view = Array.isArray(views) ? views.find((candidate) => candidate !== null && typeof candidate === 'object' && candidate.ns === NAMESPACE) : undefined
					if (view === undefined) return undefined
					return {
						value: routeOf(view.value),
						// A view that does not state `writable` is treated as writable: the
						// 0.1.x view carries the flag, and a missing one must not silently
						// turn a working card into a read-only banner.
						writable: view.writable !== false,
						revision: view.revision
					}
				},
				async write(ops, revision) {
					await remote.settings.mutate(NAMESPACE, ops, revision)
				}
			}
		}

		/** One labelled text input. */
		function field(props) {
			return h('label', { style: styles.row, key: props.name }, [
				h('span', { style: styles.label, key: 'l' }, props.label),
				h('input', {
					key: 'i',
					style: styles.input,
					type: props.type ?? 'text',
					value: props.value,
					disabled: props.disabled,
					placeholder: props.placeholder,
					onChange: (event) => props.onChange(event.target.value)
				})
			])
		}

		/**
		 * One labelled dropdown.
		 *
		 * The options have to reach `createElement` as children — arguments after the
		 * props object — because anything left on the props object is not rendered.
		 * Reading `props.options` therefore produced a select with no `<option>` at
		 * all: a blank control, no error, nothing in the console. Both spellings are
		 * accepted so that mistake cannot recur silently.
		 */
		function select(props) {
			const options = props.children ?? props.options ?? []
			return h('label', { style: styles.row, key: props.name }, [
				h('span', { style: styles.label, key: 'l' }, props.label),
				h('select', {
					key: 's',
					style: styles.input,
					value: props.value,
					disabled: props.disabled,
					onChange: (event) => props.onChange(event.target.value)
				}, options)
			])
		}

		/**
		 * Turn a `providers` profile dict into candidate rows.
		 *
		 * Only a route that *declares* its models can be enumerated this way; a
		 * catalog route that declares none is left to the picker's manual entry,
		 * because this card cannot ask an adapter for its catalog without a
		 * round trip per provider.
		 */
		function routeCandidates(piAiValue) {
			const providers = piAiValue !== null && typeof piAiValue === 'object' ? piAiValue.providers : undefined
			if (providers === null || typeof providers !== 'object') return []
			const rows = []
			for (const [route, profile] of Object.entries(providers)) {
				if (profile === null || typeof profile !== 'object') continue
				const models = Array.isArray(profile.models) ? profile.models : []
				for (const entry of models) {
					const id = typeof entry === 'string' ? entry : entry !== null && typeof entry === 'object' ? entry.id : undefined
					if (typeof id !== 'string' || id.length === 0) continue
					rows.push({ provider: route, model: id, label: `${route} / ${id}`, source: 'configured' })
				}
			}
			return rows
		}

		/**
		 * Candidate rows discovered from live provider routes.
		 *
		 * `image-router` is this plugin's own settings namespace, where the Host
		 * registers a discovery handler that answers with **only** the models whose
		 * route declares image input (or whose id is a known vision family when the
		 * route discloses nothing). The harness only falls back to a route's own
		 * discovery when no handler answers for that namespace, so a resolved answer
		 * means the list really was capability-filtered.
		 *
		 * @param remote - the Typert Remote table.
		 * @returns `{ rows, filtered }`; `filtered` is false on the fallback path.
		 */
		async function discoverCandidates(remote) {
			const providers = await remote.llm.listProviders()
			if (!providers || providers.ok !== true) return { rows: [], filtered: false }
			const rows = []
			let filtered = false
			for (const provider of providers.value) {
				try {
					const discovered = await remote.llm.discoverModels('image-router', { provider: provider.id })
					if (!discovered || discovered.ok !== true) continue
					filtered = true
					for (const model of discovered.value) {
						rows.push({ provider: provider.id, model: model.id, label: `${provider.name ?? provider.id} / ${model.id}`, source: 'discovered' })
					}
				} catch {
					/* One unreachable provider must not empty the whole list. */
				}
			}
			return { rows, filtered }
		}

		const styles = {
			card: {
				border: '0.5px solid var(--dsw-alias-border-l4, #d9d9d9)',
				borderRadius: '16px',
				padding: '12px 14px',
				display: 'flex',
				flexDirection: 'column',
				gap: '10px'
			},
			head: { display: 'flex', alignItems: 'baseline', gap: '8px' },
			title: { fontSize: '14px', fontWeight: 500, margin: 0 },
			tag: { fontSize: '11px', opacity: 0.7 },
			row: { display: 'flex', flexDirection: 'column', gap: '4px' },
			label: { fontSize: '12px', opacity: 0.75 },
			input: {
				font: 'inherit',
				fontSize: '13px',
				padding: '6px 8px',
				borderRadius: '8px',
				border: '0.5px solid var(--dsw-alias-border-l3, #cfcfcf)',
				background: 'var(--dsw-specific-input-major, transparent)',
				color: 'inherit',
				width: '100%',
				boxSizing: 'border-box'
			},
			twoUp: { display: 'flex', gap: '8px' },
			stack: { display: 'flex', flexDirection: 'column', gap: '8px' },
			panel: {
				display: 'flex',
				flexDirection: 'column',
				gap: '8px',
				padding: '10px 12px',
				borderRadius: '12px',
				border: '0.5px solid var(--dsw-alias-border-l4, #e2e2e2)',
				background: 'var(--dsw-alias-bg-l2, transparent)'
			},
			eyebrow: { fontSize: '11px', letterSpacing: '0.04em', textTransform: 'uppercase', opacity: 0.55 },
			hint: { fontSize: '12px', opacity: 0.6, margin: 0 },
			actions: { display: 'flex', gap: '8px', alignItems: 'center' },
			button: {
				font: 'inherit',
				fontSize: '13px',
				padding: '5px 12px',
				borderRadius: '14px',
				border: '0.5px solid var(--dsw-alias-border-l3, #cfcfcf)',
				// The brand pair, not `color: inherit`: the fill is the theme's primary
				// (near-black in the light theme), so an inherited label painted black on
				// black — the text vanished, which is how 0.6.0's first panel screenshot
				// read. `label-primary-foreground` is what the shipped buttons pair with
				// this fill, and both shells define it.
				background: 'var(--dsw-alias-brand-primary, #0f1115)',
				color: 'var(--dsw-alias-label-primary-foreground, #ffffff)',
				cursor: 'pointer'
			},
			status: { fontSize: '12px', opacity: 0.7 },
			// ── The main panel page (the sidebar row's destination) ──────────────
			// Geometry follows the shipped entry pages (the plugin manager is the
			// reference): fill the centre column, scroll inside it, cap the reading
			// width, and pad the top by the frame's window-chrome clearance so the
			// heading never lands under a desktop title bar or macOS traffic lights.
			page: {
				boxSizing: 'border-box',
				height: '100%',
				overflow: 'auto',
				display: 'flex',
				flexDirection: 'column',
				alignItems: 'center',
				gap: '20px',
				padding: '0 clamp(20px, 4vw, 44px) 40px'
			},
			pageHead: {
				boxSizing: 'border-box',
				width: '100%',
				maxWidth: '960px',
				display: 'flex',
				justifyContent: 'space-between',
				alignItems: 'flex-start',
				gap: '16px',
				paddingTop: 'calc(28px + var(--dsh-frame-top-clearance, 0px))'
			},
			pageTitle: { margin: 0, fontSize: '20px', fontWeight: 500, lineHeight: '28px' },
			pageIntro: { margin: '4px 0 0', fontSize: '13px', lineHeight: '20px', opacity: 0.7 },
			pagePill: {
				fontSize: '11px',
				opacity: 0.6,
				whiteSpace: 'nowrap',
				border: '0.5px solid var(--dsw-alias-border-l4, #e2e2e2)',
				borderRadius: '999px',
				padding: '2px 8px'
			},
			/** The panel's section frame: the card form, without the card's own banner. */
			formPanel: {
				boxSizing: 'border-box',
				width: '100%',
				maxWidth: '960px',
				display: 'flex',
				flexDirection: 'column',
				gap: '10px',
				padding: '16px',
				borderRadius: '16px',
				border: '0.5px solid var(--dsw-alias-border-l4, #e2e2e2)',
				background: 'var(--dsw-alias-bg-l2, transparent)'
			}
		}

		const text = (value) => (typeof value === 'string' ? value : value === undefined || value === null ? '' : String(value))
		const number = (value) => (typeof value === 'number' && Number.isFinite(value) ? String(value) : text(value))
		const routeOf = (value) => (value !== null && typeof value === 'object' ? value : {})

		/**
		 * The same value with any `apiKey` removed.
		 *
		 * The credential is write-only by design, but the settings snapshot carries
		 * the resolved value — which is the user layer, and older builds stored the
		 * key there. Anything that seeds an editor from that snapshot has to strip it,
		 * or the next save writes the secret back into a plain-text settings file.
		 */
		const withoutKey = (value) => {
			if (value === null || typeof value !== 'object' || Array.isArray(value)) return {}
			const { apiKey, ...rest } = value
			void apiKey
			return rest
		}

		/** One labelled text input. */
		function field(props) {
			return h('label', { style: styles.row, key: props.name }, [
				h('span', { style: styles.label, key: 'l' }, props.label),
				h('input', {
					key: 'i',
					style: styles.input,
					type: props.type ?? 'text',
					value: props.value,
					disabled: props.disabled,
					placeholder: props.placeholder,
					onChange: (event) => props.onChange(event.target.value)
				})
			])
		}

		/**
		 * The plugin configuration card.
		 *
		 * Reads the bound settings scope through `useSyncExternalStore`, keeps edits
		 * in a local draft, and writes every edited field on save. A number that does
		 * not parse is refused locally and reported instead of being sent.
		 *
		 * The vision route has two tiers, and the picker prefers the first:
		 *
		 *  1. **A route this deployment already has.** Candidates are read from the
		 *     `llm-pi-ai` settings section (a route that declares its models) and,
		 *     failing that, from `remote.llm.discoverModels` per live provider. A
		 *     manual text fallback stays available because a catalog route can serve
		 *     an image model this card cannot enumerate.
		 *  2. **A custom endpoint.** The three fields a person can actually supply
		 *     — endpoint, model, key — which the Host turns into an upstream pi-ai
		 *     route. This card only writes them; the Host owns the route and stores
		 *     the key in the credential store, so the key is write-only here.
		 *
		 * `remote` is absent on a deployment without the API-remotes plugin; the
		 * card then degrades to the manual entry it has always had.
		 */
		function Card(props) {
			const remote = props.remote
			const client = React.useMemo(() => (remote === undefined ? undefined : namespaceClient(remote)), [remote])
			const [snapshot, setSnapshot] = React.useState(null)
			const [draft, setDraft] = React.useState(null)
			const [status, setStatus] = React.useState('')
			const [candidates, setCandidates] = React.useState(null)

			/**
			 * Read the section. There is no push channel for a third-party card on
			 * either generation — a 0.1.x scope could be subscribed to, but the service
			 * that bound it is the one 0.2.x removed, so the card re-reads instead:
			 * on mount, after a save, and whenever the user asks for a refresh.
			 */
			const reload = React.useCallback(async () => {
				if (client === undefined) {
					setStatus('这个部署没有 API 远端服务，无法读写配置。')
					return
				}
				try {
					const next = await client.read()
					setSnapshot(next === undefined ? null : next)
					if (next === undefined) setStatus('没有找到 ' + NAMESPACE + ' 这个设置节：请确认插件已挂载且未被禁用。')
				} catch (error) {
					setStatus('读取配置失败：' + (error && error.message ? error.message : String(error)))
				}
			}, [client])
			React.useEffect(() => {
				void reload()
			}, [reload])

			const effective = routeOf(snapshot?.value)
			const writable = snapshot?.writable === true
			const revision = snapshot?.revision

			// Self-report: this component runs only when the tab actually dispatches
			// the card. Combined with the registration report, it separates "the slot
			// never kept my registration" from "the card rendered but drew nothing".
			React.useEffect(() => {
				try {
					window.__imageRouter = { ...(window.__imageRouter ?? {}), cardRendered: true, cardRenderedAt: Date.now() }
				} catch {
					/* a frozen global must never break the card */
				}
			}, [])

			React.useEffect(() => {
				setDraft(null)
			}, [revision])

			const base = draft ?? {
				mode: text(effective.mode),
				vision: { provider: text(routeOf(effective.vision).provider), model: text(routeOf(effective.vision).model) },
				// The stored endpoint is copied WITHOUT its `apiKey`. The settings
				// snapshot carries the resolved value, which may hold a key written by
				// an older build; seeding the editor from it would put the secret back
				// in the draft and round-trip it to settings.yaml on the next save. The
				// field starts empty and only ever carries a freshly typed key.
				endpoint: withoutKey(routeOf(routeOf(effective.vision).endpoint)),
				instruction: text(effective.instruction),
				maxTokens: number(effective.maxTokens),
				timeoutMs: number(effective.timeoutMs),
				label: effective.label === true
			}
			const endpointConfigured = text(base.endpoint.baseURL).length > 0
			const source = draft === null ? (endpointConfigured ? 'endpoint' : 'route') : draft.source
			const value = { ...base, source }
			const edit = (patch) => {
				setStatus('')
				setDraft({ ...value, ...patch })
			}
			const editVision = (patch) => edit({ vision: { ...value.vision, ...patch } })
			const editEndpoint = (patch) => edit({ endpoint: { ...value.endpoint, ...patch } })
			const sameRoute = (row) => row.provider === value.vision.provider && row.model === value.vision.model

			/**
			 * Load the vision-model candidates: configured routes first, then the
			 * live provider discovery as a fallback. Failures are shown, never thrown.
			 */
			const load = async () => {
				if (remote === undefined) {
					setCandidates({ rows: [], note: '这个部署没有 API 远端服务，请在下面直接填写 provider 与 model。' })
					return
				}
				setCandidates({ rows: [], note: '正在读取可用模型…' })
				try {
					const described = await remote.settings.describe()
					// `describe()` answers with `namespaces` as an ARRAY of views
					// (`SettingsDescribeValue.namespaces: SettingsNamespaceView[]`), not a
					// record keyed by name. Indexing it by namespace name yields undefined,
					// which silently demotes the picker to the discovery fallback and its
					// blander note — no error, just a worse list.
					const views = described && described.ok === true ? described.value?.namespaces : undefined
					const piAi = Array.isArray(views) ? views.find((view) => view?.ns === PI_AI_NAMESPACE) : undefined
					const configured = routeCandidates(piAi?.value)
					if (configured.length > 0) {
						setCandidates({ rows: configured, note: `来自已配置的 ${PI_AI_NAMESPACE} 路由（${configured.length} 个模型）。` })
						return
					}
					const discovered = await discoverCandidates(remote)
					setCandidates({
						rows: discovered.rows,
						note: discovered.rows.length === 0
							? '没有发现可枚举的图片模型。请到「设置 → 模型」添加一个支持图片的 provider，或在下面直接填写 provider / model。'
							: discovered.filtered
								? `已按图片能力筛选：${discovered.rows.length} 个模型（宿主读取各路由声明的模态）。`
								: '来自当前已注册的 provider（未能按图片能力筛选）。图片模型通常带 vision / vl / omni 等字样，请自行确认。'
					})
				} catch (error) {
					setCandidates({ rows: [], note: '读取模型列表失败：' + (error && error.message ? error.message : String(error)) + ' —— 你仍然可以手动填写。' })
				}
			}
			React.useEffect(() => {
				void load()
				// eslint-disable-next-line react-hooks/exhaustive-deps
			}, [revision, remote])

			const rows = candidates?.rows ?? []
			const selectable = rows.slice()
			if (endpointConfigured) selectable.push({ provider: ENDPOINT_PROVIDER, model: base.endpoint.model, label: `${ENDPOINT_PROVIDER} / ${base.endpoint.model}（自定义端点）`, source: 'endpoint' })
			else if (!value.vision.provider && !value.vision.model) selectable.push({ provider: '待配置', model: '待配置', label: '尚未配置 vision 路由', source: 'placeholder' })

			const save = async () => {
				if (!writable) {
					setStatus('这个部署的配置是只读的（settings 由 Host 管理）。')
					return
				}
				const maxTokens = Number.parseInt(value.maxTokens, 10)
				const timeoutMs = Number.parseInt(value.timeoutMs, 10)
				if (!Number.isInteger(maxTokens) || maxTokens <= 0) {
					setStatus('maxTokens 必须是正整数。')
					return
				}
				if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
					setStatus('timeoutMs 必须是正整数。')
					return
				}
				// One write carries both tiers. The ops name LEAF paths rather than the
				// whole `vision` object: a 0.2.x deployment accepts a write only where
				// that exact path is volatile in the entry's own Config schema, and the
				// plugin marks TOP-LEVEL fields (a volatile ancestor covers its subtree,
				// which is also why an ancestor and its child are never both marked).
				// The tiers stay mutually exclusive because switching withdraws the other
				// one explicitly — a stale endpoint left behind would outlive the switch.
				const ops = []
				const set = (path, field) => ops.push({ op: 'set', path, value: field })
				const unset = (path) => ops.push({ op: 'unset', path })
				let keyNote = ''
				if (source === 'endpoint') {
					const baseURL = text(value.endpoint.baseURL).trim()
					const model = text(value.endpoint.model).trim()
					if (baseURL.length === 0 || model.length === 0) {
						setStatus('自定义端点需要 baseURL 与 model 都不为空。')
						return
					}
					if (!/^https?:\/\//u.test(baseURL)) {
						setStatus('baseURL 需要是 http(s):// 开头的完整地址（例如 https://gateway.example/v1）。')
						return
					}
					const endpoint = { baseURL, model }
					const api = text(value.endpoint.api).trim()
					if (api.length > 0) endpoint.api = api
					const name = text(value.endpoint.name).trim()
					if (name.length > 0) endpoint.name = name
					const apiKeyEnv = text(value.endpoint.apiKeyEnv).trim()
					if (apiKeyEnv.length > 0) endpoint.apiKeyEnv = apiKeyEnv
					const apiKey = text(value.endpoint.apiKey)
					if (apiKey.length > 0) {
						endpoint.apiKey = apiKey
						keyNote = '（新 key 已交给 Host 写入凭据库，随后会从配置里抹掉）'
					}
					// Declared explicitly because pi-ai's default for a route is
					// text-only, which would make the endpoint useless for images.
					endpoint.images = value.endpoint.images !== false
					unset(['vision', 'provider'])
					unset(['vision', 'model'])
					set(['vision', 'endpoint'], endpoint)
				} else {
					const provider = text(value.vision.provider).trim()
					const model = text(value.vision.model).trim()
					if (provider.length === 0 || model.length === 0) {
						setStatus('vision 的 provider 与 model 都不能为空。')
						return
					}
					unset(['vision', 'endpoint'])
					set(['vision', 'provider'], provider)
					set(['vision', 'model'], model)
				}
				set(['mode'], value.mode)
				set(['instruction'], value.instruction)
				set(['maxTokens'], maxTokens)
				set(['timeoutMs'], timeoutMs)
				set(['label'], value.label === true)
				setStatus('保存中…')
				try {
					if (client === undefined) throw new Error('这个部署没有 API 远端服务，无法写入配置。')
					await client.write(ops, revision)
					// The key was handed over; clear it so it is not kept in the draft.
					if (keyNote) setDraft({ ...value, endpoint: { ...value.endpoint, apiKey: '' } })
					setStatus('已保存 — 下一次判定即刻生效，无需重启。' + keyNote)
					await reload()
					await load()
				} catch (error) {
					setStatus('保存失败：' + (error && error.message ? error.message : String(error)))
				}
			}

			const routeOptions = selectable.map((row) => h('option', {
				key: `${row.provider}/${row.model}`,
				value: `${row.provider}\u0000${row.model}`
			}, (sameRoute(row) ? '● ' : '') + row.label))
			if (selectable.length === 0) routeOptions.push(h('option', { key: 'empty', value: '' }, '（还没有可选项）'))

			const sourcePanel = h('div', { style: styles.panel, key: 'vision-source' }, [
				h('span', { style: styles.eyebrow, key: 'eyebrow' }, 'vision 路由'),
				select({
					name: 'source',
					label: '用哪种方式提供视觉模型',
					value: source,
					disabled: !writable,
					onChange: (next) => edit({ source: next }),
					children: [
						h('option', { key: 'route', value: 'route' }, '① 使用这个部署里已经配置好的模型'),
						h('option', { key: 'endpoint', value: 'endpoint' }, '② 自定义端点（填地址、模型、API Key）')
					]
				}),
				source === 'route'
					? h('div', { style: styles.stack, key: 'route-body' }, [
						select({
							name: 'visionPick',
							label: '视觉模型',
							value: value.vision.provider && value.vision.model ? `${value.vision.provider}\u0000${value.vision.model}` : '',
							disabled: !writable,
							onChange: (next) => {
								const cut = next.indexOf('\u0000')
								if (cut === -1) return
								editVision({ provider: next.slice(0, cut), model: next.slice(cut + 1) })
							},
							children: routeOptions
						}),
						h('div', { style: styles.twoUp, key: 'manual' }, [
							field({
								name: 'visionProvider',
								label: 'provider（用于上面没有的项）',
								value: value.vision.provider,
								disabled: !writable,
								placeholder: 'qwen-token-plan-cn',
								onChange: (next) => editVision({ provider: next })
							}),
							field({
								name: 'visionModel',
								label: 'model',
								value: value.vision.model,
								disabled: !writable,
								placeholder: 'qwen3.8-flash',
								onChange: (next) => editVision({ model: next })
							})
						]),
						h('div', { style: styles.actions, key: 'refresh' }, [
							h('button', { key: 'r', style: styles.button, onClick: () => { void load() } }, '刷新模型列表'),
							h('span', { key: 'n', style: styles.status }, candidates === null ? '读取中…' : candidates.note)
						])
					])
					: h('div', { style: styles.stack, key: 'endpoint-body' }, [
						h('p', { style: styles.hint, key: 'why' }, [
							'留空即交给 Host 写进 ' + PI_AI_NAMESPACE + ' 的一条路由，Key 存进凭据库（',
							h('code', { key: 'c' }, 'IMAGE_ROUTER_VISION_API_KEY'),
							'），不会出现在本插件的配置里。'
						]),
						field({
							name: 'baseURL',
							label: 'baseURL — OpenAI 兼容地址（含 /v1）',
							value: text(value.endpoint.baseURL),
							disabled: !writable,
							placeholder: 'https://gateway.example/v1',
							onChange: (next) => editEndpoint({ baseURL: next })
						}),
						h('div', { style: styles.twoUp, key: 'em' }, [
							field({
								name: 'endpointModel',
								label: 'model',
								value: text(value.endpoint.model),
								disabled: !writable,
								placeholder: 'gpt-4o-mini',
								onChange: (next) => editEndpoint({ model: next })
							}),
							select({
								name: 'api',
								label: '协议',
								value: text(value.endpoint.api) || 'openai-completions',
								disabled: !writable,
								onChange: (next) => editEndpoint({ api: next }),
								children: [
									h('option', { key: 'oc', value: 'openai-completions' }, 'openai-completions'),
									h('option', { key: 'or', value: 'openai-responses' }, 'openai-responses'),
									h('option', { key: 'am', value: 'anthropic-messages' }, 'anthropic-messages')
								]
							})
						]),
						field({
							name: 'apiKey',
							label: 'apiKey — 只写不读；留空则沿用已存的 key',
							type: 'password',
							value: text(value.endpoint.apiKey),
							disabled: !writable,
							placeholder: 'sk-…',
							onChange: (next) => editEndpoint({ apiKey: next })
						}),
						h('div', { style: styles.twoUp, key: 'en' }, [
							field({
								name: 'endpointName',
								label: '显示名（可选）',
								value: text(value.endpoint.name),
								disabled: !writable,
								placeholder: 'Image Router Vision',
								onChange: (next) => editEndpoint({ name: next })
							}),
							field({
								name: 'apiKeyEnv',
								label: '凭据引用名（可选，默认 IMAGE_ROUTER_VISION_API_KEY）',
								value: text(value.endpoint.apiKeyEnv),
								disabled: !writable,
								placeholder: 'IMAGE_ROUTER_VISION_API_KEY',
								onChange: (next) => editEndpoint({ apiKeyEnv: next })
							})
						]),
						h('label', { style: { ...styles.row, flexDirection: 'row', alignItems: 'center', gap: '8px' }, key: 'images' }, [
							h('input', {
								key: 'i',
								type: 'checkbox',
								checked: value.endpoint.images !== false,
								disabled: !writable,
								onChange: (event) => editEndpoint({ images: event.target.checked })
							}),
							h('span', { style: styles.label, key: 'l' }, '声明该端点支持图片输入（默认开；关掉会退化成纯文本路由）')
						])
					])
			])

			// A keyed 0.2.x configuration slot is asked for two views: the bundle page
			// renders `summary` for the row and `page` for the opened form. This sits
			// after every hook so the hook order never depends on the view.
			if (props.view === 'summary') {
				const route = routeOf(effective.vision)
				const endpoint = routeOf(route.endpoint)
				const label = text(endpoint.baseURL).length > 0
					? `${ENDPOINT_PROVIDER} / ${text(endpoint.model)}（自定义端点）`
					: route.provider && route.model
						? `${text(route.provider)} / ${text(route.model)}`
						: '尚未配置'
				return h('span', { style: styles.status }, `图片旁路识别 · ${text(effective.mode) || 'digest'} · ${label}`)
			}

			// The form body is shared by the bundle card and the main panel the sidebar
			// row opens: the panel page draws its own banner, so it takes the body
			// without the card's head and hint rather than nesting a second frame.
			const formBody = [
				sourcePanel,
				field({
					name: 'mode',
					label: 'mode — digest（旁路替换，不改模型）或 switch（临时借用视觉路由）',
					value: value.mode,
					disabled: !writable,
					onChange: (next) => edit({ mode: next })
				}),
				h('label', { style: styles.row, key: 'instruction' }, [
					h('span', { style: styles.label, key: 'l' }, 'instruction — 给视觉模型的指令'),
					h('textarea', {
						key: 'i',
						style: { ...styles.input, minHeight: '72px', resize: 'vertical' },
						value: value.instruction,
						disabled: !writable,
						onChange: (event) => edit({ instruction: event.target.value })
					})
				]),
				h('div', { style: styles.twoUp, key: 'limits' }, [
					field({
						name: 'maxTokens',
						label: 'maxTokens',
						type: 'number',
						value: value.maxTokens,
						disabled: !writable,
						onChange: (next) => edit({ maxTokens: next })
					}),
					field({
						name: 'timeoutMs',
						label: 'timeoutMs',
						type: 'number',
						value: value.timeoutMs,
						disabled: !writable,
						onChange: (next) => edit({ timeoutMs: next })
					})
				]),
				h('label', { style: { ...styles.row, flexDirection: 'row', alignItems: 'center', gap: '8px' }, key: 'label' }, [
					h('input', {
						key: 'i',
						type: 'checkbox',
						checked: value.label === true,
						disabled: !writable,
						onChange: (event) => edit({ label: event.target.checked })
					}),
					h('span', { style: styles.label, key: 'l' }, '在替换文本前加 [图片分析 · provider/model] 标记')
				]),
				h('div', { style: styles.actions, key: 'actions' }, [
					h('button', { key: 'save', style: styles.button, disabled: !writable, onClick: save }, '保存'),
					h('button', {
						key: 'reset',
						style: styles.button,
						disabled: !writable,
						onClick: () => {
							setDraft(null)
							setStatus('已还原为当前生效值。')
						}
					}, '还原'),
					h('span', { key: 'status', style: styles.status }, status)
				])
			]

			// 0.2.x's bundle page asks for `page`; the sidebar panel asks for `panel`.
			// Both draw the same form — the panel omits the card's own banner because
			// the page around it already draws the heading.
			if (props.view === 'panel') return h('div', { style: styles.formPanel, key: 'panel' }, formBody)

			return h('div', { style: styles.card }, [
				h('div', { style: styles.head, key: 'head' }, [
					h('h4', { style: styles.title, key: 't' }, 'image-router · 图片旁路识别'),
					h('span', { style: styles.tag, key: 'g' }, 'namespace: ' + NAMESPACE)
				]),
				h('p', { style: styles.hint, key: 'hint' }, [
					'提示词里的图片会先由下面的视觉路由分析成文字再交给当前模型；会话模型不会被切换。',
					h('br', { key: 'br' }),
					'此处的值覆盖 profile 补丁层的配置，保存后立即生效。'
				]),
				...formBody
			])
		}

		/**
		 * The sidebar row's label.
		 *
		 * A thunk: a list registration's label is re-resolved on every projection
		 * (the sidebar reads it for the row text, the accessible name and the
		 * collapsed tooltip), so the row follows the UI language without being
		 * re-registered. This half registers no locale namespace of its own — the
		 * card draws its copy inline — so the language is read from the document.
		 */
		function panelLabel() {
			try {
				const lang = (typeof document !== 'undefined' && document.documentElement && document.documentElement.lang)
					|| (typeof navigator !== 'undefined' && navigator.language)
					|| 'zh'
				return String(lang).toLowerCase().startsWith('zh') ? '图片路由' : 'Image Router'
			} catch {
				return '图片路由'
			}
		}

		/**
		 * The sidebar row's icon.
		 *
		 * Inline SVG on purpose: a hand-written client bundle may require only the
		 * shell's seed words (`react`), while the shipped bundles import their icons
		 * from `@deepseek-ai/dsh-client-ui-primitives` — a module this factory cannot
		 * reach. `currentColor` keeps the glyph in the sidebar's own colour ramp; the
		 * owner supplies the requested edge (`size`) and the selected state.
		 */
		function PanelIcon(props) {
			const size = typeof props?.size === 'number' && Number.isFinite(props.size) && props.size > 0 ? props.size : 20
			return h('svg', {
				width: size,
				height: size,
				viewBox: '0 0 20 20',
				fill: 'none',
				'aria-hidden': 'true',
				style: { display: 'block', opacity: props?.active === false ? 0.72 : 1 }
			}, [
				h('rect', { key: 'frame', x: 2.6, y: 3.6, width: 14.8, height: 12.8, rx: 3, stroke: 'currentColor', strokeWidth: 1.3 }),
				h('circle', { key: 'sun', cx: 7.1, cy: 8.1, r: 1.25, stroke: 'currentColor', strokeWidth: 1.3 }),
				h('path', { key: 'ridge', d: 'M3.3 14.3 6.9 10.8l2.5 2.3 2.2-2 4.7 4.3', stroke: 'currentColor', strokeWidth: 1.3, strokeLinecap: 'round', strokeLinejoin: 'round' })
			])
		}

		/**
		 * The main panel behind the sidebar row: the configuration page.
		 *
		 * The layout dispatches its root-scoped `main` keyed slot by the id the
		 * selected sidebar row carries (`entryKey`), so this component mounts only
		 * while that row is selected — selecting the conversation unmounts it. It
		 * draws the same form as the bundle card, which keeps one source of truth for
		 * the settings section instead of a second editor that can drift.
		 */
		function Panel(props) {
			React.useEffect(() => {
				try {
					window.__imageRouter = { ...(window.__imageRouter ?? {}), panelRendered: true, panelRenderedAt: Date.now() }
				} catch {
					/* a frozen global must never break the page */
				}
			}, [])
			return h('div', { style: styles.page }, [
				h('header', { style: styles.pageHead, key: 'head' }, [
					h('div', { key: 'heading' }, [
						h('h1', { style: styles.pageTitle, key: 'title' }, panelLabel()),
						h('p', { style: styles.pageIntro, key: 'intro' }, '图片在进入会话之前先由视觉路由分析成文字，会话模型不会被切换；这里保存的值从下一轮起生效。')
					]),
					h('span', { style: styles.pagePill, key: 'pill' }, 'dsh-image-router')
				]),
				h(Card, { key: 'card', remote: props.remote, view: 'panel' })
			])
		}

		const name = 'image-router'

		/**
		 * Every service this half reads, because cordis' plugin context is
		 * declaration-gated: reading an undeclared one throws
		 * `cannot get property "X" without inject`.
		 *
		 * Two shapes of this bite differently, and both were hit here:
		 *
		 *  - A service read during activation (`slots`) fails the loader entry, so
		 *    the plugin never activates at all.
		 *  - A service read only inside the card's render fails *after* a successful
		 *    registration, so the tab dispatches a card that throws and draws
		 *    nothing — which reads exactly like a missing option.
		 *
		 * The Remote table is the subtle part: `remote` is not enough. Each namespace
		 * under it is its own service name and must be declared separately — the
		 * official models section declares `remote`, `remote.credentials`,
		 * `remote.llm` and `remote.settings` as four entries for the same reason.
		 * This card reads `remote.settings` for the section and the configured routes
		 * and `remote.llm` for the capability oracle.
		 *
		 * `settingsScope` is deliberately NOT declared. It existed only in 0.1.x, and
		 * declaring it gated this entry on a service a 0.2.x runtime never provides:
		 * the entry stayed `pending (waiting for service: settingsScope)` and the web
		 * boot aborted with "1 entry did not activate" — the plugin could not be
		 * installed at all on dsh-desktop 0.2.0-rc.2. `remote.settings` carries the
		 * same read/write surface on both generations, so nothing is lost by it.
		 */
		const inject = ['slots', 'remote', 'remote.settings', 'remote.llm']

		/**
		 * Where the card is claimed, one entry per generation.
		 *
		 * `slots.inject` runs its callback only once an owner DECLARES the slot, so
		 * claiming both is how one card serves two generations without sniffing a
		 * version: in a given runtime only one of these is ever declared, so exactly
		 * one card is registered, and the other claim is inert.
		 *
		 *  - `plugins.bundle.config` (0.2.x) — a bundle's own configuration, keyed by
		 *    the bundle's package name, rendered on the bundle's page. Its owner asks
		 *    for two views (`summary` on the row, `page` for the form); the card draws
		 *    the one-liner for `summary`.
		 *  - `settings.plugin.item` (0.1.x) — the plugin-configuration tab, keyed by
		 *    the settings namespace it edits.
		 */
		const CARD_SLOTS = [
			{ name: 'plugins.bundle.config', options: { key: PACKAGE } },
			{ name: 'settings.plugin.item', options: { key: NAMESPACE } }
		]

		/**
		 * Activation report, readable as `window.__imageRouter` in the browser.
		 *
		 * The failure modes on this path are silent by nature — a pending entry and
		 * a card that never rendered both look like "the option is missing" — so the
		 * report records which step was reached instead of leaving it to inference.
		 * It is also the only way to tell which of the two slots a live deployment
		 * declared.
		 */
		const report = { applied: false, slots: false, registered: [], error: undefined }
		const publish = () => {
			try {
				window.__imageRouter = report
			} catch {
				/* a frozen global must not break activation */
			}
		}

		function apply(ctx) {
			report.applied = true
			// Every service below is declared in `inject` above, so these reads are
			// permitted; the plugin context refuses anything undeclared.
			report.slots = ctx.slots !== undefined
			report.remoteNamespaces = ['settings', 'llm'].filter((key) => ctx.remote?.[key] !== undefined)
			publish()
			try {
				// The Remote table is handed to the card as a plain object so a render
				// never touches the gated context: reading a namespace there is exactly
				// what threw `cannot get property "remote.settings" without inject`.
				const remote = { settings: ctx.remote.settings, llm: ctx.remote.llm }

				/**
				 * Read a slot's ledger back after registering into it.
				 *
				 * An owner renders the intersection of what it serves with the entries a
				 * slot actually holds, so "I called register" is a weaker claim than "the
				 * slot kept it". Recording what the slot reports turns a silent absence
				 * into a readable one — for the panel and the sidebar row this is the
				 * only place the outcome of a claim becomes visible.
				 *
				 * @param slotName - the slot that was just registered into.
				 * @param expected - the key/id the entry should carry.
				 */
				const recordLedger = (slotName, expected) => {
					try {
						const entries = ctx.slots.entries(slotName)
						const keyOf = (entry) => entry?.options?.key ?? entry?.options?.id ?? entry?.key ?? entry?.id ?? '?'
						const count = Array.isArray(entries) ? entries.length : -1
						report.ledger = { ...(report.ledger ?? {}), [slotName]: count }
						report.slotHasMine = Array.isArray(entries) ? entries.some((entry) => keyOf(entry) === expected) : false
					} catch (error) {
						report.ledgerReadError = String(error)
					}
				}

				for (const slot of CARD_SLOTS) {
					ctx.slots.inject(slot.name, () => {
						try {
							// The registration options follow the contract the owning
							// surface ships for its own contributions: `name` + the slot's
							// key. `inject` supplies the hooks the card is handed, and this
							// card needs none — it reads the Remote table captured above.
							// `locale` is deliberately NOT declared: this card draws its
							// own copy inline and registers no locale entries, and
							// declaring a copy namespace with nothing under it is a claim
							// the card cannot honour.
							const cardOptions = { name: slot.name, inject: () => ({}), ...slot.options }
							ctx.slots.register(cardOptions, (props) => h(Card, { remote, view: props?.view }))
							report.registered.push(slot.name)
							report.slotOptions = Object.keys(cardOptions)
							// Read the ledger back. An owner renders the intersection of
							// what it serves with the entries this slot actually holds, so
							// "I called register" is a weaker claim than "the slot kept
							// it". Recording what the slot reports turns a silent absence
							// into a readable one.
							try {
								const entries = ctx.slots.entries(slot.name)
								const keyOf = (entry) => entry?.options?.key ?? entry?.key ?? '?'
								report.slotEntryCount = Array.isArray(entries) ? entries.length : -1
								report.slotHasMine = Array.isArray(entries) ? entries.some((entry) => keyOf(entry) === slot.options.key) : false
								report.slotEntryKeys = Array.isArray(entries) ? entries.map(keyOf).slice(0, 12) : []
								report.slotLocaleOfMine = Array.isArray(entries)
									? entries.find((entry) => keyOf(entry) === slot.options.key)?.options?.locale
									: undefined
							} catch (error) {
								report.ledgerReadError = String(error)
							}
							publish()
						} catch (error) {
							report.error = `${slot.name}: ${String(error)}`
							publish()
							console.warn('[image-router] settings card unavailable:', error)
						}
					})
				}

				// ── The sidebar entry, and the page it opens ────────────────────────
				//
				// Two root-scoped slots, one id. The sidebar owns the row: it reads the
				// list registration's `id`/`order`/`label` and calls
				// `ctx.layout.selectPanel(id)` when the row is clicked; the layout then
				// dispatches its `main` keyed slot by that same id. Registering only one
				// of the two gives a row that opens nothing, or a page nothing reaches —
				// so both are claimed, and neither replaces a shipped entry: a list/id
				// registration adds beside what is already there.
				//
				// `slots.inject` again (declaration = claim): a deployment that never
				// declares these slots leaves the claims inert instead of failing the
				// entry, which is what keeps this half installable on both generations.
				ctx.slots.inject('sidebar.panellist', () => {
					try {
						ctx.slots.register({
							name: 'sidebar.panellist',
							id: PANEL_ID,
							order: PANEL_ORDER,
							// A thunk: the owner re-resolves list labels on every projection
							// (row text, accessible name, collapsed tooltip), so the row
							// follows the UI language without being re-registered.
							label: () => panelLabel()
						}, (props) => h(PanelIcon, { size: props?.size, active: props?.active }))
						report.registered.push('sidebar.panellist')
						recordLedger('sidebar.panellist', PANEL_ID)
						publish()
					} catch (error) {
						report.error = `sidebar.panellist: ${String(error)}`
						publish()
						console.warn('[image-router] sidebar entry unavailable:', error)
					}
				})

				ctx.slots.inject('main', () => {
					try {
						ctx.slots.register(
							{ name: 'main', key: PANEL_ID, inject: () => ({}) },
							() => h(Panel, { remote })
						)
						report.registered.push('main')
						recordLedger('main', PANEL_ID)
						publish()
					} catch (error) {
						report.error = `main: ${String(error)}`
						publish()
						console.warn('[image-router] main panel unavailable:', error)
					}
				})
			} catch (error) {
				report.error = String(error)
				publish()
				console.warn('[image-router] settings card unavailable:', error)
			}
		}

		exports.NAMESPACE = NAMESPACE
		exports.FIELDS = FIELDS
		exports.apply = apply
		exports.inject = inject
		exports.name = name
		return module.exports
	}
})

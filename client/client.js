// image-router — browser half (client plugin bundle).
//
// Loaded by dsh-client-modules through the vendored cordis Loader's lazy-CJS
// module table (window.__ModuleLoader__.load), the same shape the shipped ui-*
// bundles emit: the factory body is plain CJS and require() resolves against the
// shell's module table, so only platform seed words may be required.
//
// What it adds is the card in 设置 → 插件 → 插件配置 that edits the Host settings
// namespace `image-router` (lib/settings.js registers it; both halves must keep
// spelling the same namespace). The Host stays the fact source: this half only
// renders the section and writes to it, and a saved field reaches the plugin's
// next decision without a restart.
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
		/** Fields the card edits; each is written as one whole section field. */
		const FIELDS = ['mode', 'vision', 'instruction', 'maxTokens', 'timeoutMs', 'label']

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
			hint: { fontSize: '12px', opacity: 0.6, margin: 0 },
			actions: { display: 'flex', gap: '8px', alignItems: 'center' },
			button: {
				font: 'inherit',
				fontSize: '13px',
				padding: '5px 12px',
				borderRadius: '14px',
				border: '0.5px solid var(--dsw-alias-border-l3, #cfcfcf)',
				background: 'var(--dsw-alias-button-primary-fill, transparent)',
				color: 'inherit',
				cursor: 'pointer'
			},
			status: { fontSize: '12px', opacity: 0.7 }
		}

		const text = (value) => (typeof value === 'string' ? value : value === undefined || value === null ? '' : String(value))
		const number = (value) => (typeof value === 'number' && Number.isFinite(value) ? String(value) : text(value))
		const routeOf = (value) => (value !== null && typeof value === 'object' ? value : {})

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
		 */
		function Card(props) {
			const scope = props.scope
			const snapshot = React.useSyncExternalStore(
				React.useCallback((listener) => scope.subscribe(listener), [scope]),
				React.useCallback(() => scope.getSnapshot(), [scope])
			)
			const effective = routeOf(snapshot?.value)
			const writable = snapshot?.writable === true
			const [draft, setDraft] = React.useState(null)
			const [status, setStatus] = React.useState('')

			React.useEffect(() => {
				setDraft(null)
			}, [snapshot?.revision])

			const value = draft ?? {
				mode: text(effective.mode),
				vision: { provider: text(routeOf(effective.vision).provider), model: text(routeOf(effective.vision).model) },
				instruction: text(effective.instruction),
				maxTokens: number(effective.maxTokens),
				timeoutMs: number(effective.timeoutMs),
				label: effective.label === true
			}
			const edit = (patch) => {
				setStatus('')
				setDraft({ ...value, ...patch })
			}
			const editVision = (patch) => edit({ vision: { ...value.vision, ...patch } })

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
				const vision = { provider: value.vision.provider.trim(), model: value.vision.model.trim() }
				if (vision.provider.length === 0 || vision.model.length === 0) {
					setStatus('vision 的 provider 与 model 都不能为空。')
					return
				}
				setStatus('保存中…')
				try {
					await scope.set('mode', value.mode)
					await scope.set('vision', vision)
					await scope.set('instruction', value.instruction)
					await scope.set('maxTokens', maxTokens)
					await scope.set('timeoutMs', timeoutMs)
					await scope.set('label', value.label === true)
					setStatus('已保存 — 下一次判定即刻生效，无需重启。')
				} catch (error) {
					setStatus('保存失败：' + (error && error.message ? error.message : String(error)))
				}
			}

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
				field({
					name: 'mode',
					label: 'mode — digest（旁路替换，不改模型）或 switch（临时借用视觉路由）',
					value: value.mode,
					disabled: !writable,
					onChange: (next) => edit({ mode: next })
				}),
				h('div', { style: styles.twoUp, key: 'vision' }, [
					field({
						name: 'visionProvider',
						label: 'vision.provider',
						value: value.vision.provider,
						disabled: !writable,
						placeholder: 'qwen-token-plan-cn',
						onChange: (next) => editVision({ provider: next })
					}),
					field({
						name: 'visionModel',
						label: 'vision.model',
						value: value.vision.model,
						disabled: !writable,
						placeholder: 'qwen3.8-flash',
						onChange: (next) => editVision({ model: next })
					})
				]),
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
			])
		}

		const name = 'image-router'
		const inject = ['slots']

		function apply(ctx) {
			try {
				ctx.inject(['settingsScope'], (scoped) => {
					const scope = scoped.settingsScope.bind({ namespace: NAMESPACE })
					scoped.slots.inject('settings.plugin.item', () => scoped.slots.register(
						{ name: 'settings.plugin.item', key: NAMESPACE },
						() => h(Card, { scope })
					))
				})
			} catch (error) {
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

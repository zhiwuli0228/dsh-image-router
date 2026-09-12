# dsh-image-router

给 DeepSeek Harness 用的**图片旁路识别**插件：图片交给视觉模型分析一次，把结果作为文字放回提示词 —— **你的会话模型自始至终不变**。

```
你贴一张截图，问「这个报错怎么修」
      ↓  插件在「提示词准入」之前拦下这次提示词
qwen-token-plan-cn / qwen3.8-flash   ← 一次旁路调用（不改会话路由、不写 model/selection）
      ↓  分析结果替换掉图片，成为提示词里的一段文字
你原本选定的模型（GUI 里显示的那个）继续作答
```

这是 Codex 侧 [image-router](https://github.com/kanchengw/image-router) 的同一套语义：**用完即走的一次调用**，不是把会话切成视觉模型。

覆盖两条路径：

| 场景 | 机制 |
|---|---|
| **提示词里自带图片**（贴图 / 上传） | digest：准入前旁路分析 → 图片块替换为文字（自动，模型无感） |
| **图片文件路径**（「读一下 x.png」） | `describe_image` 工具：模型按需调用 → 返回文字分析（**任何模型都能用，包括纯文本模型**） |

## 两种模式

| | `mode: digest`（默认） | `mode: switch`（可选） |
|---|---|---|
| 会话模型 | **永不改动** | 图片轮次临时借给视觉模型，之后归还 |
| 图片去向 | 旁路分析后替换为文字 | 原样发给视觉模型 |
| 会话历史里 | 留下文字分析（图片块被替换） | 留下图片 |
| 模型选择器 / `[model changed]` 提示 | 不出现 | 会出现 |
| 适用 | 想一直用自己的主力模型 | 想让视觉模型亲自看整轮上下文 |

`auto` / `sticky` 是旧的模式名，仍被接受并映射到 `switch`。

## 配置视觉路由：两条路，都不需要手写 YAML

图片发给谁，由 `vision` 决定。它有**两档**，装好后可以在 **设置 → 插件 → 插件配置** 的卡片里直接切换：

### ① 用这个部署里已经配好的模型

卡片会列出**支持图片输入的模型**供点选，不用记 provider id：

- 优先读 `$DSH_HOME/settings.yaml` 里 `llm-pi-ai` 段已经声明了 `models` 的路由（这正是**设置 → 模型**页写的那些）；
- 否则逐个 provider 调用 `remote.llm.discoverModels('image-router', { provider })`，由**宿主侧的图片能力 oracle** 回答（见下）；
- 下拉里找不到就手填 `provider` / `model`（目录型的路由可以服务卡片枚举不到的模型）。

**图片能力 oracle 是怎么来的**：浏览器唯一的模型类接口是 `remote.llm.discoverModels(settingsNs, request)`，且只能按命名空间提问。本插件因此在自己的命名空间 `image-router` 上注册了一个 discovery handler，用 `ctx.llm.listModels(provider)` 读每条路由的模型，再按 `inputModalities` 过滤：

- 模型**显式声明**了模态 → 声明说了算（声明 `['text']` 的即使 id 里有 `vision` 也剔除）；
- 路由**什么都没披露** → 退回到 id 里的视觉家族特征（`vision` / `vl` / `omni` / `4o` / `gemini` …），因为目录型路由未必公开这个字段；
- 未知/不可达路由 → 空列表，不抛错。

实测：对 `deepseek-official`（4 个模型）只返回 2 个图片模型（`deepseek-flash`、`deepseek-v4-flash-vision-exp`）；审计写 `discover provider=… models=4 imageCapable=2`。

对应的配置就是：

```yaml
- id: image-router
  config:
    vision: { provider: qwen-token-plan-cn, model: qwen3.8-flash }
```

### ② 自定义端点：填 baseURL + 模型 + API Key

没有现成的视觉模型？卡片里切到「自定义端点」，只填三样东西：**地址、模型名、API Key**。

插件**不自己实现协议**，也不自己存密钥 —— 它把这三样翻译成上游本来就有的东西：

| 你填的 | 落到哪里 |
|---|---|
| baseURL / 协议 / 模型 / 显示名 | `$DSH_HOME/settings.yaml` → `llm-pi-ai.providers.image-router-vision`（**只写这一条路径**，你原有的 provider 一个字节都不动） |
| API Key | 凭据库 `$DSH_HOME/.credentials.yaml` → `refs.IMAGE_ROUTER_VISION_API_KEY`；路由里只留**引用名** |
| 图片能力声明 | 模型条目上的 `input: [text, image]` |

也就是说：线协议、模型发现、图片投影、重试全都由 `@deepseek-ai/dsh-llm-pi-ai` 负责，本插件只是"把卡片上的三个字段写成 DSH 的配置"。因此 `dsh web` **不需要重启**，下一次判定就用新路由。

```yaml
- id: image-router
  config:
    vision:
      endpoint:
        baseURL: https://gateway.example/v1
        model: gpt-4o-mini
        api: openai-completions   # 可选：openai-completions / openai-responses / anthropic-messages
        apiKey: sk-…              # 可选：写入凭据库后即从配置里消失（只写不读）
```

几个值得知道的细节：

- **`endpoint` 优先于 `provider/model`**；两者都在时用显式的 `provider/model`，所以老配置不会被动改变行为。
- **API Key 是只写字段**：Host 收到后写进凭据库，不回显、不写进本插件的配置，也不进 trace。
- **凭据存成引用名**：`$DSH_HOME/.credentials.yaml` 的 `refs.IMAGE_ROUTER_VISION_API_KEY`（可用 `apiKeyEnv` 改名）。选引用名而不是泛型 key，是因为 pi-ai 解析 `apiKeyEnv` 走的正是这一层 —— `credentialRef(name)` → `ctx.credentials.resolve(...)`，与你原有的 `QWEN_TOKEN_PLAN_CN_API_KEY` 同一种形态；泛型 key 在这一层解析不到。
- **别关掉「声明支持图片输入」**：pi-ai 对自定义路由的默认模态是 `["text"]`，关掉之后发过去的图片会被投影成占位文字，端点收不到图。
- 想在**设置 → 模型**里管理这条路由也行：它就是一条普通的 `llm-pi-ai` 路由，`displayName`、超时、协议都能在那边继续改。
- 卡片会在审计文件里留一行 `endpoint-route-live … modalities=text+image`，用来回答"我配的端点到底生效了吗"。

## 按需工具 `describe_image`

插件注册一个模型可调的工具（`tool: true`，默认开启）：

```
describe_image(file_path: string, question?: string) -> string
```

- 读文件走部署自己的文件系统服务（同一套沙箱与 cwd 解析），按**字节签名**识别 PNG/JPEG/WebP/GIF（无扩展名也行），落盘成附件，然后做一次旁路调用，返回文字分析。
- `question` 可选：填了就追加到分析指令里（例如「图里的报错是什么？」）。
- **它在纯文本模型上也能用**：图片从不进入会话，`read_image` 的「当前路由必须声明 image」那道门槛对它不适用。
- 失败会抛出可读错误：`not found` / `not a regular file` / `not a supported PNG/JPEG/WebP/GIF image` / `the vision model produced no analysis`。

## 在图形界面里配置

插件注册了一个设置命名空间 `image-router`，并自带浏览器一半：装上后 **设置 → 插件 → 插件配置** 里会出现一张 `image-router · 图片旁路识别` 卡片。

卡片里的 vision 路由有两档（详见上面「配置视觉路由」）：

- **① 已配置模型**：从 `llm-pi-ai` 设置段 + 宿主侧图片能力 oracle（`remote.llm.discoverModels('image-router', …)`）汇总出的下拉，**只列支持图片的模型**，点选即可，另有 `provider` / `model` 手填兜底。
- **② 自定义端点**：填 `baseURL` / `model` / `apiKey`（+ 可选协议、显示名、凭据引用名）。保存后由宿主写进 `llm-pi-ai` 与凭据库，**不重启**即可用。

| 卡片字段 | 生效时机 |
|---|---|
| `mode`、`vision`（两档都算）、`instruction`、`maxTokens`、`timeoutMs`、`label` | **保存后立即生效** —— 下一次提示词、下一次旁路调用、下一次工具调用就用新值，不需要重启 |
| `tool`（是否注册 `describe_image`）、`traceFile`（审计文件路径） | 挂载时确定，改动需要重启 `dsh web`（卡片里没有这两项，免得承诺做不到的事） |

- **卡片显示的是当前生效值**：profile 补丁层的配置作为该设置节的 base，卡片里的保存只是叠在它之上的一层覆盖（落在 `$DSH_HOME/settings.yaml` 的 `image-router:` 段）。
- **写坏不会破坏正在工作的插件**：校验失败的覆盖会被忽略，继续用上一份好配置，并在审计文件里记一行 `settings-invalid …`。
- **端点档只写自己那一条路径**：用 `settings.mutate('llm-pi-ai', [{op:'set', path:['providers','image-router-vision'], value}])`，你原有的 provider 不会被整体覆盖；撤掉端点档时发的是对应的 `unset`，凭据保留（可能还想复用）。这条路径上的 `set` 会**替换**整个 profile 对象，所以写入前先 `settings.get('llm-pi-ai')` 读回现值做合并 —— 你在「设置 → 模型」给这条路由加过的 `headers`、`compat`、`timeoutMs` 不会被一次保存抹掉（实测：预置的 `x-tenant` 头与 5000ms 超时在保存后仍在，而 `models` 被重建为本轮的值）。
- 两半必须用同一个 namespace：宿主 `lib/settings.js` 的 `SETTINGS_NAMESPACE` 与浏览器 `client/client.js` 的 `NAMESPACE`。
- 宿主侧只走 `ctx.inject(['settings'])` + `settings.register(ns, schema, { base })`：**绝不 import `@deepseek-ai/dsh-settings` 的命名导出** —— 上游删过 `installSettingsSection`，而缺失的命名导出是模块求值期 SyntaxError，会让宿主启动失败退出 1（dshmarket 踩过这个坑）。
- 浏览器一半靠 `ctx.remote`（来自 `dsh-api-remotes`，已写进本包 `dsh.client.inject`）读取模型清单；没有远端服务的部署会退化成纯手填，卡片照常渲染。
- 只有注册了命名空间**且**有浏览器一半注册 `settings.plugin.item` 卡片的插件才会出现在那个页面：两者缺一都不会渲染任何东西。

## 为什么需要它

DSH 内置行为是「图来了但模型不收图」时静默降级或直接拒绝：

| 位置 | 内置行为 |
|---|---|
| `dsh-llm/lib/index.js` | 路由模型不声明 `image` 而消息里有图 → `projectImagesForTextModel()` 把图片换成文本占位符 |
| `dsh-api-session-controller/lib/index.js` | Web 提示词准入时校验**当前会话模型**，不声明 `image` 直接抛 `MODEL_DOES_NOT_SUPPORT_IMAGES` |
| `dsh-tool-fs/lib/index.js` | `read_image` 在当前步骤路由不声明 `image` 时拒绝执行 |

digest 模式在**准入之前**就把图片换成文字，所以它同时绕过了上面第一、二道门槛：连纯文本模型也能收到带图的提示词（收到的是文字分析）。

## 实现要点（全部来自实测）

1. **准入前替换**：包装 `sessionController.prompt`，在调用原方法之前改写 `request.content`。图片块被移除、替换成一段文字 —— 因此准入校验看不到图片，不会拒绝、也不需要改模型。
2. **图片内容的两种形态**：wire 形态 `{ type:'image', mediaType, data(base64), name? }`；准入后形态 `{ type:'image', attachment: ImageAttachmentRef }`。插件用 `ctx.attachments.admitPromptContent(images)` 把前者落盘成后者（`dsh-attachment/lib/types/types.d.ts:89-113`）。
3. **旁路调用是标准一次性请求**：`ctx.llm.stream({ provider, model, messages, maxTokens, sessionId, signal })`，消息为 `{ id, role:'user', source:{kind:'plugin', plugin:'image-router'}, content:[{type:'text',…},{type:'image',attachment:ref}] }`。端点、凭证、重试策略、附件解析全部复用部署自己的配置。
   - **不传 `purpose`**：它的类型是封闭枚举 `'compaction' | 'session-title'`（`dsh-llm/lib/types/types.d.ts:443`），自定义值不合法。
   - `signal` 是 `AbortSignal.any([调用方 signal, AbortSignal.timeout(timeoutMs)])`，取消与超时都生效。
   - 这次调用**不写入会话日志**（对比 `dsh-session-title-llm` 会 append 一条 `session/title-llm-request`）。
4. **失败就保留图片**：视觉调用失败（配额、超时、报错）时不替换，把原请求交给原路径，让它给出**真实的**错误（例如 provider 的 429 或模态拒绝），而不是被插件掩盖。
5. **替换文本里不放文件名**：`shot.png` 这种名字会被模型当成可读路径去调 `read_image`，在纯文本模型上换来一条没必要的报错。文件名只留在审计文件里。
6. **必须用可选注入**：`sessionController` 只由 `dsh-web-app` 提供；顶层 `inject` 会让 headless/sdk/acp profile 启动失败（`1 entry did not activate`）。因此用 `ctx.inject(['sessionController'], …)`。
7. **端点档要等三个服务一起就绪**：`ctx.inject(['llm', 'settings', 'credentials'], …)`。只等 `llm` 是个真实的坑 —— 那个回调在 entry 激活时就跑，此时设置节还没注册，`get('settings')` 返回 `undefined`，端点同步被静默跳过，于是在"有 settings 服务的部署"里也永远写不进去（实测踩到，审计里那行 `endpoint-services settings=no` 就是它）。
8. **"跳过"不能算"已完成"**：同步只在真正落盘（`endpoint-route-ok`）后才记下签名，否则一次过早的跳过会让签名永久命中缓存，端点再也不会重试。
9. **密钥只写不读**：`apiKey` 从配置里取走后立即从内存副本上剥掉（不改共享的已解析配置对象），并且**不参与**签名比对 —— 否则同一个端点会不断被判定为"变了"而重复写凭据。
10. **自定义路由必须声明图片模态**：pi-ai 的 `defaultInput` 是 `["text"]`，所以路由的模型条目不写 `input: [text, image]` 就会被当成纯文本模型，图片会被投影成占位文字而不是发到端点。卡片默认开这个开关。
11. **解析探测留痕**：写完后做一次只读的 `llm.resolveModelInfo(provider, model)`，把结果写进审计（`endpoint-route-live … modalities=text+image`）—— 这是"我配的端点到底生效没有"唯一可读的答案。
12. **图片能力 oracle 注册在自己的命名空间上**：`ctx.llm.registerModelDiscovery('image-router', …)`。浏览器唯一能发的模型类请求是 `remote.llm.discoverModels(settingsNs, request)`，而 `settingsNs` 只能填它知道的命名空间 —— 填自己的，才能让这次调用回答"这条路由里哪些模型真收图"，而不是"这条路由有哪些模型"。过滤必须留在宿主：`inputModalities` 从不过河到浏览器。
13. **写入必须"读-改-写"**：`settings.mutate` 的路径操作在 `['providers','image-router-vision']` 上是**整体替换**（`applyPathOp` 里是 `{...section, [head]: op.value}`），而这条路由同时也是「设置 → 模型」页能编辑的路由 —— 直接写会把用户在那边加的 `headers` / `compat` / `timeoutMs` 抹掉。所以先 `settings.get('llm-pi-ai')` 读回现有 profile，把本轮拥有的字段（`displayName`/`api`/`baseURL`/`apiKeyEnv`/`models`）覆盖上去、其余原样保留。读服务用的是 `settings.get(ns)`（返回解析后的值），不是臆造的方法名 —— 这一点正是靠真机验证才发现的（`settings.namespace is not a function`）。

## 已验证

| 环节 | 结论 |
|---|---|
| 单测（digest 替换 / 失败保留 / 多图合并 / dryRun / 工具调用 / 设置覆盖 / 开关模式状态机 / 安全降级 / 审计 / 自定义端点档 / 图片能力 oracle / 上游 profile 合并 / schema 三方消费者契约） | ✅ 54 个用例通过 |
| 挂载进真实 web-profile 树 | ✅ 隔离实例冷启动，审计写 `mounted mode=digest …` |
| **标准 bundle 形态可装载**（包名进 `dsh.profile.bundles` → 包内 `dsh.bundle.patch` → 部署层 config 覆盖 → `Config` 补默认值） | ✅ 隔离实例冷启动实测，`schemastery` 与回退 Standard Schema 两条路径都跑过 |
| 无 `sessionController` 的 profile 仍能启动 | ✅ headless 冷启动 `exit=0`，审计只有 `apply-entered` |
| **digest 端到端：会话模型不变 + 图片被正确识别** | ✅ 隔离实例实测（下方输出） |
| **`describe_image` 注册 + 执行全链路** | ✅ 隔离实例实测（下方输出） |
| switch 端到端（借出→保持→归还） | ✅ 隔离实例实测（`router-sequence-probe`） |
| 设置命名空间注册 | ✅ 隔离实例实测（审计写 `settings-registered ns=image-router`） |
| **自定义端点档写进上游**（真实 web profile，非 mock 服务） | ✅ 隔离实例实测：`settings.yaml` 出现 `providers.image-router-vision`（含 `apiKeyEnv` 引用与 `input: [text, image]`），`.credentials.yaml` 的 `refs` 出现 `IMAGE_ROUTER_VISION_API_KEY`，原有 provider 未变 |
| **端点档写完后路由真的可用** | ✅ 同一实例审计写 `endpoint-route-live provider=image-router-vision model=mock-vision modalities=text+image` |
| **`ctx.llm.stream` 经该路由打到 mock 端点（图片随行）** | ✅ 隔离实例内探针实测：`listProviders()` 出现 `image-router-vision`（**未重启**）、`resolveModelInfo` 报 `["text","image"]`、`admitPromptContent` 得到 `image/png 1x1 70B` 引用、stream 收齐 `block-start → 3×text-delta → block-end → usage → finish:stop`，文本 `MOCK STREAM ANSWER`；mock 侧线上记录 `POST /v1/chat/completions` + `authorization: Bearer sk-ve…` + `sawImage: true` |
| **图片能力 oracle 真的按模态过滤** | ✅ 同一实例实测：`discoverModels('image-router', {provider:'deepseek-official'})` 从 **4 个模型里筛出 2 个**图片模型；自定义端点路由返回 `mock-vision`；未知路由返回 `[]` 而不抛错 |
| **保存不会毁掉用户在模型页对该路由的编辑** | ✅ 同一实例实测：预置 `headers: {x-tenant: acme}` 与 `timeoutMs: 5000` 的派生路由，保存后两者仍在，`models` 被重建为 `[{id: mock-vision, input: [text, image]}]`，过期模型列表消失，其它 provider 未变 |
| **回退 schema 能过 `settings.describe()`** | ✅ 隔离实例实测（审计记 `schema=fallback` 以证明走的是回退形态）：`describe({redactSecrets:true})` 无错返回 8 个命名空间，`image-router` 条目带 `schemaType: object`、13 个 `valueKeys`、`applies: live`。此前真机因缺 `toJSON()` 报 `加载提供方目录失败`，导致所有插件卡片都不渲染 |
| 浏览器半被发现并提供 | ✅ 隔离实例实测（boot manifest 的 combo 清单含 `dsh-image-router/client.js`，取回 200 且内容含本插件模块）；卡片两档的渲染用 React 替身跑过（下拉/端点字段/控件数），**视觉外观**需你在 GUI 里看一眼 |

digest 端到端实测输出（`tools/digest-probe.mjs`）：

```
session model before prompt: deepseek-official/deepseek-flash
prompt accepted (digest ran before admission)
session model after prompt:  deepseek-official/deepseek-flash      ← 模型完全没动
digest session=probe-digest images=1 chars=147 names=probe.png     ← 旁路分析产出 147 字
assistant/message source={provider:'deepseek-official', model:'deepseek-flash'}
  → 「图片上的文字是深蓝背景左上角的两行英文——橙黄色的 "VISION ROUTER" 和其正下方白色的 "PROBE 42"。」
```

`describe_image` 实测输出（`tools/tool-probe.mjs`，直接从活的工具注册表取定义后执行）：

```
describe_image in registry: found
execute ok, 113 chars:
  1. 文字内容：VISION ROUTER / PROBE 42
  2. 画面描述：画面背景为深蓝色。左上角包含两行左对齐的粗体无衬线英文字符……
审计：tool session=probe-tool-session path=…\probe.png mediaType=image/png bytes=2322 chars=113
```

## 安装

这是一个**标准 DSH bundle 插件包**：`package.json` 声明 `dsh.bundle.patch`，包内 `cordis.patch.yml` 只插入一条 loader 条目（部署无关，默认值全在 `Config` 里）。

### A. 从 npm 安装（推荐）

已发布：[`dsh-image-router`](https://www.npmjs.com/package/dsh-image-router)（MIT）。

```powershell
# 1. 装进 profile
dsh plugin --profile web add dsh-image-router

# 2. 把包名加进 profile 的 bundles 列表
#    $DSH_HOME/profiles/web/package.json → dsh.profile.bundles: [..., "dsh-image-router"]

# 3. 在 profile 的 cordis.patch.yml 里写配置覆盖（完整示例见 examples/cordis.patch.yml）
#    - id: image-router
#      config:
#        vision: { provider: <provider>, model: <vision-model> }
#    没有现成的视觉模型也可以只给端点，见下面「配置视觉路由」的 ②。
```

### B. 从 GitHub 安装（等价形态）

```powershell
# 1. 装进 profile（pnpm 转发；也能换成本地 link:）
dsh plugin --profile web add github:zhiwuli0228/dsh-image-router

# 2. 把包名加进 profile 的 bundles 列表
#    $DSH_HOME/profiles/web/package.json → dsh.profile.bundles: [..., "dsh-image-router"]

# 3. 在 profile 的 cordis.patch.yml 里写配置覆盖（完整示例见 examples/cordis.patch.yml）
#    - id: image-router
#      config:
#        vision: { provider: <provider>, model: <vision-model> }
```

没有 GitHub 网络时用本地 checkout（等价形态，pnpm 会把包拷进 profile 的 `node_modules`）：

```powershell
dsh plugin --profile web add file:E:\path\to\dsh-image-router
# 之后同样加进 dsh.profile.bundles，并在 profile 的 cordis.patch.yml 写同 id 的配置覆盖
```

装好后这些配置项也能在 **设置 → 插件 → 插件配置** 的卡片里改（见下），保存即时生效。

然后重启 `dsh web`。

### C. 本地开发 / 不想装依赖：按路径挂载

零安装，只要把仓库放在磁盘上：

```yaml
# $DSH_HOME/profiles/web/cordis.patch.yml
- insert:
    - id: image-router
      name: '<repo>\lib\index.js'      # 绝对路径或 ./-相对路径都接受
      config:
        mode: digest
        vision:
          provider: qwen-token-plan-cn
          model: qwen3.8-flash
        traceFile: '<repo>\trace.log'
```

**改完必须重启 `dsh web`。** profile 补丁层确有 live reload（`patchReload: live`）——实测配置改动会重新 apply，但它不会重新 import 已经加载过的宿主模块，所以**代码**变更只有重启才可靠生效。

### 为什么包内不需要 `node_modules`

`Config` 采用双形态：能解析 `@deepseek-ai/schemastery` 时用它；解析不到则退回一个零依赖的等价实现。**而后者才是实际发布出去的那一份** —— 这个 `import` 从本文件自己的位置解析，宿主的 `node_modules` 在 DSH 安装目录里、不在 profile 往上的解析路径上；实测在真实 profile 中（插件以 `file:` 装进 profile）`schemaForm` 恒为 `'fallback'`。

所以回退形态必须同时满足**三个**消费者，缺任何一个都会在真机上炸：

| 消费者 | 要什么 | 缺了的后果 |
|---|---|---|
| Cordis（loader） | `~standard.validate`（Standard Schema 接口，`cordis/lib/index.js`：`runtime.Config['~standard'].validate(config)`） | 启动失败 |
| settings 服务 `resolve()` | schema **可调用** —— 它直接 `schema(mergeLayers(base, section))` 来叠默认值 | 设置节解析抛 `TypeError: schema is not a function` |
| settings 服务 `describe()` | `schema.toJSON()` | **整个提供方/设置目录加载失败**，于是所有插件卡片都不渲染（实测报错：`加载提供方目录失败: registration.schema.toJSON is not a function`） |

`redactSecrets` 的遍历是防御式的（`node.type` 不认识就原样返回值），所以回退形态不需要 schemastery 的元数据即可安全通过。

插件会在审计的 `apply-entered` 行打出 `schema=fallback|schemastery` —— 这两种形态从外面看不出区别，而"我这儿跑的到底是哪一份"曾是定位真机故障时最难的一环。`@deepseek-ai/schemastery` 因此声明为**可选 peerDependency**（不拉取、用宿主自带），见 `package.json`。

## 配置项

| 键 | 默认 | 说明 |
|---|---|---|
| `mode` | `digest` | `digest`＝旁路分析并替换文字（不改模型）；`switch`＝临时借用视觉路由 |
| `vision` | 必填（二选一） | 旁路调用的路由。**①** `provider` / `model` / 可选 `reasoningEffort`；**②** `endpoint: { baseURL, model, api?, name?, apiKey?, apiKeyEnv?, images? }` —— 由宿主翻译成上游 `llm-pi-ai` 的一条路由。两者同时存在时 ① 优先 |
| `instruction` | 内置（提取文字 + 描述画面） | 给视觉模型的指令 |
| `maxTokens` | `900` | 分析结果上限 |
| `timeoutMs` | `120000` | 单次旁路调用的超时 |
| `label` | `true` | 在替换文本前加 `[图片分析 · provider/model]` 标记 |
| `tool` | `true` | 是否注册 `describe_image`（按路径按需分析图片的模型工具） |
| `traceFile` | 无 | 审计文件：挂载、每次图片分析、工具调用、失败原因 |
| `dryRun` | `false` | 只写审计、不改提示词、不调视觉模型 |
| `text` / `holdTurns` / `sticky` | — | **仅 switch 模式**：归还兜底路由、图片后再保持视觉模型的轮数、永不归还 |
| `imageExtensions` / `hint` | — | **仅 switch 模式**：文本里的图片扩展名/正则判定 |

## 审计与排查

```
mounted mode=digest vision=qwen-token-plan-cn/qwen3.8-flash maxTokens=900 timeoutMs=120000 label=true dryRun=false
tool-registered name=describe_image vision=qwen-token-plan-cn/qwen3.8-flash
digest session=<id> images=1 chars=147 names=probe.png     # 一次成功的旁路分析
tool session=<id> path=<路径> mediaType=image/png bytes=2322 chars=113   # 一次 describe_image 调用
digest-dryRun session=<id> images=2                        # dryRun 下的判定
digest-failed reason=error images=1                        # 视觉调用失败 → 保留图片
digest-empty images=1                                      # 视觉模型没输出文本 → 保留图片
digest-admit-failed <原因>                                 # 图片落盘失败 → 不替换
digest-skipped no attachment service                       # 没有 attachments 服务
tool-failed <原因>                                         # 工具定义没注册成功
session=<id> error=<消息> at=<栈帧>                        # 插件内部异常（已兜住，提示词照常发出）
```

排查顺序：有没有 `mounted mode=digest`（没有 → 没挂上，检查补丁与重启）→ 贴图那一刻有没有 `digest` 行（没有 → 图片没进到插件，看是不是 `file` 而非 `image` 块）→ 有没有 `digest-failed` / `reason=`（旁路调用被拒，通常是额度或该路由不可用）→ 工具是否可用看有没有 `tool-registered`。

## 行为细节与限制

- **会话历史里留下的是文字分析，不是图片**：这是「不切模型」的必然代价（图片块被替换）。附件本身仍持久保存在 `$DSH_HOME/attachments/` 下，审计行也记了文件名。
- **`read_image` 与 `describe_image` 的分工**：`read_image` 是 DSH 自带工具，受「当前步骤路由必须声明 `image`」限制；`describe_image` 是本插件提供的，走旁路调用，**任何模型都能用**。主力换成纯文本模型后，让模型改用 `describe_image` 即可（工具 description 已写明适用场景）。
- **一次提示词一次调用**：同一条提示词里的多张图合并成**一次**视觉调用，产出一个文字块；`describe_image` 每次调用只处理一个文件。
- **准入会等旁路调用**：发送时 `session/prompt` 会等到分析完成才返回（通常几秒到十几秒，受 `timeoutMs` 约束），GUI 的发送按钮在此期间保持等待。
- **旁路调用计入你的额度**：走的是 `vision` 路由的 provider 与凭证（和正常请求同一套配额），但不进会话日志。
- **包装 `sessionController.prompt` 是非官方扩展点**：未来版本若改名/换实现，插件会退化为「不处理 + 记 warning」，不会崩。工具注册走官方 `ctx.tools.register()`，只要 JSON Schema 合法就稳。
- **失败即放行**：任何异常都只写审计 + 一条 warning，提示词照常准入。

## 测试

```powershell
cd <repo>
node --test                  # 标准写法（Node 自带发现，20/22/24 通用）
node test/routing.test.js    # 单进程直跑：没有管道支持的沙箱里用这个
```

> `node --test test/` **不可移植**：Node 20 会扫描目录，Node 22+ 把 `test/` 当成单个入口文件去加载而报 `MODULE_NOT_FOUND`（CI 就是靠多版本矩阵抓到这个的）。

54 个用例：配置归一化与校验（含旧模式名映射、schema 物化出的空对象/空数组、端点档补齐 vision 路由与两档优先级）、图片信号判定、digest 的替换/多图合并/失败保留/无图直通/dryRun/落盘失败、`describe_image` 的注册/读文件/问题透传/缺文件与目录与非图片的拒绝、设置节的注册与「保存后下一轮即生效」、校验失败的覆盖被忽略、自定义端点写入上游路由与凭据（含"跳过/失败不得记为已同步"这一可重试契约、以及"合并而非覆盖上游 profile"）、图片能力 oracle（声明优先于 id、按命名空间注册、过滤、未知路由不抛错、无 llm 服务时退化）、**schema 三方消费者契约（`~standard` / 可调用 / `toJSON`+`safeParse`）**、switch 的借出‑归还‑放弃状态机、手选模型不被覆盖、`holdTurns`、`sticky`、路由校验与缓存、冷会话不路由也不告警、门面两种布局、审计可写与不可写、无 `sessionController` 时不包装、卸载恢复。

CI（`.github/workflows/ci.yml`）在 Ubuntu + Windows × Node 20/22/24 上跑同一套用例，并校验「`dsh.bundle.patch` 指向的文件存在、入口导出 `name`/`Config`/`apply`」这条打包契约。

`tools/` 下五个开发用探针（都可作为一条 `insert` 挂进 profile；路径均按自身位置推导，任意 checkout 可用）：

| 探针 | 用途 |
|---|---|
| `digest-probe.mjs` | 在真实树里跑一次带图提示词，验证「模型不变 + 图片被识别」 |
| `tool-probe.mjs` | 从活注册表取出 `describe_image` 并执行一次，验证工具全链路 |
| `router-sequence-probe.mjs` | switch 模式：借出 → 保持 → 归还 的完整序列 |
| `service-probe.mjs` | 打印各服务的方法形状 |
| `router-call-probe.mjs` | 复刻插件调用链，记录 `{agent}/{error}` 形状与栈 |

## 参考实现

- [kanchengw/image-router](https://github.com/kanchengw/image-router) — Codex++ 的 HTTP 代理：拦截 `image_url`，调 VL API 生成 `[IMAGE ANALYSIS]` 文字后替换图片再转发（本插件 digest 模式即此语义）
- [lll888666/codex-deepseek-vision-fallback](https://github.com/lll888666/codex-deepseek-vision-fallback)
- [rongyaozhixing/codex-vision-plugin](https://github.com/rongyaozhixing/codex-vision-plugin)
- [ningyougan/deepseek-vision-mcp](https://github.com/ningyougan/deepseek-vision-mcp)

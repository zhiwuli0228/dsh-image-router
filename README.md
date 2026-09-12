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

## 按需工具 `describe_image`

插件注册一个模型可调的工具（`tool: true`，默认开启）：

```
describe_image(file_path: string, question?: string) -> string
```

- 读文件走部署自己的文件系统服务（同一套沙箱与 cwd 解析），按**字节签名**识别 PNG/JPEG/WebP/GIF（无扩展名也行），落盘成附件，然后做一次旁路调用，返回文字分析。
- `question` 可选：填了就追加到分析指令里（例如「图里的报错是什么？」）。
- **它在纯文本模型上也能用**：图片从不进入会话，`read_image` 的「当前路由必须声明 image」那道门槛对它不适用。
- 失败会抛出可读错误：`not found` / `not a regular file` / `not a supported PNG/JPEG/WebP/GIF image` / `the vision model produced no analysis`。

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

## 已验证

| 环节 | 结论 |
|---|---|
| 单测（digest 替换 / 失败保留 / 多图合并 / dryRun / 工具调用 / 开关模式状态机 / 安全降级 / 审计） | ✅ 32 个用例通过 |
| 挂载进真实 web-profile 树 | ✅ 隔离实例冷启动，审计写 `mounted mode=digest …` |
| **标准 bundle 形态可装载**（包名进 `dsh.profile.bundles` → 包内 `dsh.bundle.patch` → 部署层 config 覆盖 → `Config` 补默认值） | ✅ 隔离实例冷启动实测，`schemastery` 与回退 Standard Schema 两条路径都跑过 |
| 无 `sessionController` 的 profile 仍能启动 | ✅ headless 冷启动 `exit=0`，审计只有 `apply-entered` |
| **digest 端到端：会话模型不变 + 图片被正确识别** | ✅ 隔离实例实测（下方输出） |
| **`describe_image` 注册 + 执行全链路** | ✅ 隔离实例实测（下方输出） |
| switch 端到端（借出→保持→归还） | ✅ 隔离实例实测（`router-sequence-probe`） |

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

### A. 从 GitHub 安装（推荐）

```powershell
# 1. 装进 profile（pnpm 转发；github: 形式也可以换成 npm 包名或本地 link:）
dsh plugin --profile web add github:zhiwuli0228/dsh-image-router

# 2. 把包名加进 profile 的 bundles 列表
#    $DSH_HOME/profiles/web/package.json → dsh.profile.bundles: [..., "dsh-image-router"]

# 3. 在 profile 的 cordis.patch.yml 里写配置覆盖（完整示例见 examples/cordis.patch.yml）
#    - id: image-router
#      config:
#        vision: { provider: <provider>, model: <vision-model> }
```

然后重启 `dsh web`。

### B. 本地开发 / 不想装依赖：按路径挂载

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

`Config` 采用双形态：宿主能解析 `@deepseek-ai/schemastery`（正常安装，profile 的 `node_modules` 里本来就有）时用它；解析不到时退回一个**等价的 Standard Schema**。Cordis 只通过 Standard Schema 接口消费插件配置（`cordis/lib/index.js`：`runtime.Config['~standard'].validate(config)`），所以两种形态下 loader 校验、默认值、GUI 读取的行为一致 —— 这也是按路径挂载（模块 realpath 在工作区、没有 `node_modules` 可回溯）仍然可用的原因。

`@deepseek-ai/schemastery` 因此声明为**可选 peerDependency**（不拉取、用宿主自带），见 `package.json`。

## 配置项

| 键 | 默认 | 说明 |
|---|---|---|
| `mode` | `digest` | `digest`＝旁路分析并替换文字（不改模型）；`switch`＝临时借用视觉路由 |
| `vision` | 必填 | 旁路调用的路由：`provider` / `model` / 可选 `reasoningEffort` |
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

33 个用例：配置归一化与校验（含旧模式名映射、schema 物化出的空对象/空数组）、图片信号判定、digest 的替换/多图合并/失败保留/无图直通/dryRun/落盘失败、`describe_image` 的注册/读文件/问题透传/缺文件与目录与非图片的拒绝、switch 的借出‑归还‑放弃状态机、手选模型不被覆盖、`holdTurns`、`sticky`、路由校验与缓存、冷会话不路由也不告警、门面两种布局、审计可写与不可写、无 `sessionController` 时不包装、卸载恢复。

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

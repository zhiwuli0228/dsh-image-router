# dsh-image-router

> [!IMPORTANT]
> **当前版本 `0.4.4`，已发布到 npm，适配 DSH `0.1.5-rc.1+`（已在 `0.1.5-rc.1` 上真机验证）。**
> 若你装到的是更早的 `0.1.0`，那是本插件的第一个（已废弃的）构建，会让「设置 → 模型」页加载失败 —— 用 `dsh plugin --profile web add dsh-image-router@latest` 直接装最新版即可。

<div align="center">
  <b style="font-size: 1.15em;">让纯文本模型也能「看图」</b><br />
  图片在进入会话之前，先由你指定的视觉模型转成文字 —— <b>你的会话模型自始至终不变</b>，模型选择器也不会跳。<br /><br />
  <a href="https://www.npmjs.com/package/dsh-image-router"><img alt="npm version" src="https://img.shields.io/npm/v/dsh-image-router" /></a>
  <a href="https://www.npmjs.com/package/dsh-image-router"><img alt="npm downloads" src="https://img.shields.io/npm/dm/dsh-image-router" /></a>
  <a href="https://github.com/zhiwuli0228/dsh-image-router/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/zhiwuli0228/dsh-image-router/actions/workflows/ci.yml/badge.svg" /></a>
  <a href="https://github.com/zhiwuli0228/dsh-image-router/actions/workflows/release.yml"><img alt="release" src="https://github.com/zhiwuli0228/dsh-image-router/actions/workflows/release.yml/badge.svg" /></a>
  <a href="https://opensource.org/licenses/MIT"><img alt="License: MIT" src="https://img.shields.io/badge/License-MIT-yellow.svg" /></a>
  <a href="https://github.com/zhiwuli0228/dsh-image-router/stargazers"><img alt="GitHub stars" src="https://img.shields.io/github/stars/zhiwuli0228/dsh-image-router" /></a><br /><br />
  <a href="https://www.npmjs.com/package/@deepseek-ai/dsh?activeTab=versions"><img alt="支持的 DSH 版本：0.1.5-rc.1+（已在 rc.1 验证）" src="https://img.shields.io/badge/DSH-0.1.5--rc.1%2B_%28verified_rc.1%29-4d6bfe" /></a>
  <a href="#测试"><img alt="tests" src="https://img.shields.io/badge/tests-68_passing-brightgreen" /></a>
  <a href="#-一分钟安装"><img alt="install" src="https://img.shields.io/badge/install-one_command-4d6bfe" /></a><br /><br />
  <img alt="图片旁路识别" src="https://img.shields.io/badge/-图片旁路识别-4d6bfe" />
  <img alt="会话模型不变" src="https://img.shields.io/badge/-会话模型不变-4d6bfe" />
  <img alt="describe_image 工具" src="https://img.shields.io/badge/-describe__image-4d6bfe" />
  <img alt="自定义端点" src="https://img.shields.io/badge/-自定义端点-4d6bfe" />
  <img alt="图形界面配置" src="https://img.shields.io/badge/-图形界面配置-4d6bfe" />
  <img alt="密钥只写不落盘" src="https://img.shields.io/badge/-密钥只写不落盘-4d6bfe" />
</div>

```
你贴一张截图，问「这个报错怎么修」
      ↓  插件在「提示词准入」之前拦下这次提示词
qwen-token-plan-cn / qwen3.8-flash   ← 一次旁路调用（不改会话路由、不写 model/selection）
      ↓  分析结果替换掉图片，成为提示词里的一段文字
你原本选定的模型（GUI 里显示的那个）继续作答
```

## 📑 目录

- [⚡ 一分钟安装](#-一分钟安装)
- [✨ 功能一览](#-功能一览)
- [🖼️ 它长什么样](#️-它长什么样)
- [🧭 给视觉模型的两种方式](#-给视觉模型的两种方式)
- [🔐 安全](#-安全) · [⚠️ 已知限制](#️-已知限制) · [🖥️ 兼容性](#️-兼容性)
- [🛠️ 开发与测试](#️-开发与测试) · [🤝 参与贡献](#-参与贡献)
- [🔍 审计与排查](#-审计与排查)（折叠） · [⚙️ 配置项](#-配置项)（折叠） · [🧩 工作原理](#-工作原理)（折叠）

## ⚡ 一分钟安装

**前置**：已装好 DSH（`dsh web` 能正常跑），Node.js ≥ 20。

**方式一：命令行一条**

```sh
dsh plugin --profile web add dsh-image-router && dsh web
```

**就这一条。** `dsh plugin` 是 pnpm 的薄封装：它把包装进 profile，并**自动**把声明了 `dsh.bundle` 的依赖加进 `dsh.profile.bundles`（按已安装状态 reconcile），不需要手动编辑 `package.json`。卸载同理：`dsh plugin --profile web remove dsh-image-router`。

> 不想走 npm？把 `dsh-image-router` 换成 `github:zhiwuli0228/dsh-image-router` 即为等价形态（前沿代码、未经 registry 校验）。

**方式二：让 DSH 自己装** —— 把下面这段发给任意一个 DSH 会话：

```text
帮我安装 dsh-image-router 图片旁路识别插件（DSH 插件，让纯文本模型也能看图），步骤：
1. 执行 dsh plugin --profile web add dsh-image-router
2. 确认 dsh-image-router 已出现在 $DSH_HOME/profiles/web/package.json 的 dsh.profile.bundles 里
3. 提醒我重启 dsh web
4. 重启后告诉我：打开「设置 → 插件 → 插件配置 → image-router」，视觉模型那栏怎么填
遇到报错先查 https://github.com/zhiwuli0228/dsh-image-router README 的常见问题。
```

**方式三：本地源码**（想改代码时）——见下方〈从源码安装〉。

### 装完 2 步

1. 打开 **设置 → 插件 → 插件配置 → image-router**。
2. 「视觉模型」下拉里选一个支持图片的模型；**没有现成的就切到「自定义端点」**，只填三样：**地址、模型名、API Key** → 保存。

然后随便发一张图 —— 你会看到 `[图片分析 · <你选的模型>]` 开头的文字，代替图片进入会话。

<details>
<summary><b>更新</b></summary>

```sh
# 装/升到最新版
dsh plugin --profile web add dsh-image-router@latest
```

**若它打印 `Already up to date` 却仍是旧版**：pnpm 11 的**发布年龄门槛**（`minimumReleaseAge`）把「刚发布不久」的版本排除在版本解析之外。**全新安装不受影响**（pnpm 会把该版本自动加进排除项，实测发布 20 分钟后 `@latest` 即可装到），但**升级已有依赖**时会把新版本滤掉、解析回旧版 —— 看起来像更新失败，其实是策略挡的。这时显式写出版本号即可，pnpm 会打印 `Added 1 entry to minimumReleaseAgeExclude` 并立即安装：

```sh
dsh plugin --profile web add dsh-image-router@<版本号>
```

改完**硬刷新浏览器**（Ctrl/Cmd+Shift+R）。配置项的改动不需要重启（保存后下一次判定即生效）；插件**代码**的改动需要重启 `dsh web`。

</details>

<details>
<summary><b>常见问题</b></summary>

| 现象 | 原因与解决 |
|---|---|
| 发图后什么都没发生 | 先看审计文件有没有 `mounted mode=digest`。没有 → 插件没挂上，确认包在 `dsh.profile.bundles` 里并重启 `dsh web`。有 → 看贴图那一刻有没有 `digest session=… chars=…` 行。 |
| 卡片不出现，控制台也没有报错 | 浏览器一半的 `inject` 声明了加载器满足不了的依赖，entry 会永久 pending 且毫无提示。当前版本已修正；若仍在旧版本上，升级即可。浏览器里读 `window.__imageRouter` 可看到走到哪一步。 |
| 「设置 → 模型」打不开，或提示「填入各提供方的 API 密钥」 | `0.3.1` 之前版本的已知问题（schema 描述为空导致设置页整体加载失败）。升级即可。 |
| 分析很慢（半分钟以上） | 多半是推理模型把 token 预算花在思考上。插件会自动用更大预算重试一次（审计记 `digest-retry`），但你可以把卡片里的 `maxTokens` 从 `900` 直接改成 `4000` 省掉那一轮；或换非推理的视觉模型。 |
| 分析是空的，收到的是图片占位 | 看审计里的 `digest-empty` / `digest-failed` 行 —— 现在会带上实际收到的 chunk 类型与 finish 原因，据此判断是模型没输出、预算被思考吃光、还是路由配置问题。 |
| 保存端点后仍走别的模型 | 升级到 `0.4.0+`。旧版本会让 profile 里的默认路由遮蔽你保存的端点。 |
| 想彻底移除 | `dsh plugin --profile web remove dsh-image-router`（包会从依赖与 bundles 一起消失）。它写下的派生路由 `Image Router Vision` 与凭据会保留，要清就在 **设置 → 模型** 里删掉那条路由。 |

</details>

<details>
<summary><b>从源码安装 / 开发</b></summary>

```sh
# 1. 装进 profile（file: 指向你的克隆目录）
dsh plugin --profile web add file:E:\path\to\dsh-image-router

# 2. 重启 dsh web
dsh web
```

零安装也可以：不装依赖，直接按路径挂载（见 `examples/cordis.patch.yml`）：

```yaml
# $DSH_HOME/profiles/web/cordis.patch.yml
- insert:
    - id: image-router
      name: '<repo>\lib\index.js'      # 绝对路径或 ./-相对路径都接受
      config:
        mode: digest
        vision: { provider: qwen-token-plan-cn, model: qwen3.8-flash }
        traceFile: '<repo>\trace.log'
```

profile 补丁层有 live reload（`patchReload: live`），实测配置改动会重新 apply —— 但它不会重新 import 已经加载过的宿主模块，所以**代码**变更只有重启才可靠生效。

</details>

## ✨ 功能一览

- **🖼️ 提示词里的图片自动转文字**：贴图 / 上传的图片在准入前被旁路分析，图片块替换成文字分析 —— 连纯文本模型也能收到「带图」的提示词，而它收到的是文字。
- **🔒 会话模型一动不动**：这是与「切换到视觉模型」类方案的根本区别。不写 `model`/`selection`，模型选择器不跳，没有 `[model changed]` 提示，会话历史里留下的是文字分析。
- **🔧 `describe_image` 工具（按需）**：模型可以像调用普通工具那样分析磁盘上的图片文件（`describe_image(file_path, question?)`），**任何模型都能用** —— 因为图片从不进入会话，`read_image` 那道「当前路由必须声明 image」的门槛不适用。
- **🧭 两种给视觉模型的方式**：① 从「设置 → 模型」里已配好的模型中**点选支持图片的**（宿主侧图片能力 oracle 按 `inputModalities` 过滤）；② 填**自定义端点**（baseURL + 模型 + API Key），插件把它翻译成上游 `llm-pi-ai` 的一条普通路由。
- **⚙️ 图形界面配置，保存即生效**：**设置 → 插件 → 插件配置** 里的卡片，改完立刻用于下一次判定（不需要重启、不需要手写 YAML）。
- **🔐 API Key 只写不落盘**：密钥写进凭据库（`refs.IMAGE_ROUTER_VISION_API_KEY`），只留引用名在路由里；解析结果、设置节、卡片草稿三处都会剥掉它，不回显、不写进配置文件、不进审计日志。
- **🧩 不自己实现协议**：线协议、模型发现、图片投影、重试全部交给 `@deepseek-ai/dsh-llm-pi-ai`，插件只负责把卡片上的字段写成 DSH 的配置。
- **🛡️ 失败即放行**：视觉调用失败（配额 / 超时 / 报错）时不替换图片，把原请求交给原路径，让它给出**真实的**错误，而不是被插件掩盖。任何插件内部异常都只写审计 + 一条 warning。
- **📝 审计文件**：挂载、每次分析、用了哪条路由、重试、失败原因都记一行 —— 「我配的端点到底生效了吗」有一个可读的答案。
- **🧪 68 个单测 + 全平台 CI**：Ubuntu + Windows × Node 20/22/24。

## 🖼️ 它长什么样

贴图之后，会话里收到的是这样一段（`label: true` 时会带前缀标记）：

```
[图片分析 · qwen-token-plan-cn/qwen3.8-flash]
1. 文字内容：
设置 / 通用设置 / Theme · 外观 / 模型 / 插件 / Agent 预设 / 插件市场
模型 —— 填入各提供方的 API 密钥即可使用其模型。/ DeepSeek / qwen-token-plan-cn / huawei / Image Router Vision
2. 画面描述：
浅色背景的设置页面。左侧为垂直导航栏，当前选中「模型」；右侧列出四个已配置的模型服务卡片，
每个名称旁有绿色圆点，后三项带红色「删除」按钮；底部两个虚线框按钮「+ 添加提供方」「+ 添加自定义提供方」。
```

模型收到的是**这段文字**，不是图片。审计文件里对应这一行：

```
digest session=<id> vision=image-router-vision/qwen3.8-max images=1 chars=408 names=image.png
```

## 🧭 给视觉模型的两种方式

| | ① 用这个部署里已经配好的模型 | ② 自定义端点 |
|---|---|---|
| 适用 | 你已经在 **设置 → 模型** 里配过某个多模态模型 | 手上有别的视觉 API |
| 要填什么 | 下拉里点一个（**只列支持图片的模型**） | `baseURL` + `model` + `apiKey` |
| 落到哪里 | 无（引用现有路由） | 自动写进 `llm-pi-ai.providers.image-router-vision` + 凭据库；只动这一条路径，你原有的 provider 一个字节都不改 |
| 生效 | 保存后立即（不重启） | 保存后立即（不重启） |

**优先级**：设置节写了端点 → 端点赢；设置节写了路由 → 路由赢；两者都没写 → 用 profile 的默认配置。合并 `vision` 时按字段进行，空值不覆盖有内容的值。

## ⚙️ 配置项

<details>
<summary><b>全部配置项与默认值</b></summary>

| 键 | 默认 | 说明 |
|---|---|---|
| `mode` | `digest` | `digest`＝旁路分析并替换文字（不改模型）；`switch`＝图片轮次临时借用视觉路由，之后归还 |
| `vision` | 必填（二选一） | **①** `provider` / `model` / 可选 `reasoningEffort`；**②** `endpoint: { baseURL, model, api?, name?, apiKey?, apiKeyEnv?, images? }` —— 由宿主翻译成上游 `llm-pi-ai` 的一条路由 |
| `instruction` | 内置（提取文字 + 描述画面） | 给视觉模型的指令 |
| `maxTokens` | `900` | 分析结果上限。**在 `openai-completions` 这类协议上，这个预算与模型自己的思考 token 共享**（pi-ai 源码原文：*reasoning and the answer share `max_tokens` here, so an uncapped reasoning phase can consume the whole response and leave no answer*）。推理模型常把 900 全花在思考上、正文一字不出 —— 此时插件会**自动用更大预算重试一次**（`max(4×, 4096)`，上限 32768），审计记 `digest-retry` / `digest-retry-ok` |
| `timeoutMs` | `120000` | 单次旁路调用的超时 |
| `label` | `true` | 在替换文本前加 `[图片分析 · provider/model]` 标记 |
| `tool` | `true` | 是否注册 `describe_image`（挂载时确定，改动需重启；卡片里没有这一项） |
| `traceFile` | 无 | 审计文件路径（挂载时确定，改动需重启） |
| `dryRun` | `false` | 只写审计、不改提示词、不调视觉模型 |
| `text` / `holdTurns` / `sticky` | — | **仅 switch 模式**：归还兜底路由、图片后再保持视觉模型的轮数、永不归还 |
| `imageExtensions` / `hint` | — | **仅 switch 模式**：文本里的图片扩展名 / 正则判定 |

### 两种模式

| | `mode: digest`（默认） | `mode: switch`（可选） |
|---|---|---|
| 会话模型 | **永不改动** | 图片轮次临时借给视觉模型，之后归还 |
| 图片去向 | 旁路分析后替换为文字 | 原样发给视觉模型 |
| 会话历史里 | 留下文字分析（图片块被替换） | 留下图片 |
| 模型选择器 / `[model changed]` 提示 | 不出现 | 会出现 |

`auto` / `sticky` 是旧的模式名，仍被接受并映射到 `switch`。

</details>

## 🔍 审计与排查

<details>
<summary><b>审计行清单与排查顺序</b></summary>

```
mounted mode=digest vision=image-router-vision/qwen3.8-max maxTokens=900 timeoutMs=120000 label=true dryRun=false
config-resolved overrides=… visionKeys=endpoint -> image-router-vision/qwen3.8-max   # 生效的是哪条路由
endpoint-route-live provider=image-router-vision model=qwen3.8-max modalities=text+image
tool-registered name=describe_image vision=…
digest session=<id> vision=<provider>/<model> images=1 chars=147 names=probe.png   # 一次成功的旁路分析
digest-retry reason=reasoning-consumed-budget budget=900->4096 images=1            # 预算被思考吃光，重试
digest-retry-ok budget=4096 chars=408
tool session=<id> path=<路径> mediaType=image/png bytes=2322 chars=113             # 一次 describe_image 调用
digest-dryRun session=<id> images=2                                                # dryRun 下的判定
digest-failed reason=<消息> code=<码> images=1                                     # 视觉调用失败 → 保留图片
digest-empty images=1 budget=900 chunks=… finish=…                                 # 模型没输出文本 → 保留图片
digest-admit-failed <原因>                                                         # 图片落盘失败 → 不替换
digest-skipped no attachment service                                               # 没有 attachments 服务
settings-invalid <问题>                                                            # 保存的配置没通过校验，沿用上一份
session=<id> error=<消息> at=<栈帧>                                                # 插件内部异常（已兜住，提示词照常发出）
```

**排查顺序**：有没有 `mounted`（没有 → 没挂上）→ 有没有 `config-resolved … -> <路由>`（确认生效的是哪条）→ 贴图那一刻有没有 `digest … chars=`（没有 → 看是 `digest-failed`、`digest-empty` 还是 `digest-skipped`）→ 工具是否可用看有没有 `tool-registered`。

</details>

## 🔐 安全

- **API Key 只写不读**：Host 收到后写进凭据库；`normalizeConfig` 从解析结果里剥掉 `endpoint.apiKey`（`env.config` 的任何读者都看不到密钥），`configBase` 不把它写进设置节，卡片编辑器用 `withoutKey(...)` 播种（旧版本写下的密钥不会被回填进草稿、也就不会被下一次保存写回去）。端点档写凭据时从**声明它的那一层**现场读取明文。
- **凭据存成引用名**：`$DSH_HOME/.credentials.yaml` 的 `refs.IMAGE_ROUTER_VISION_API_KEY`（可用 `apiKeyEnv` 改名）。选引用名而不是泛型 key，是因为 pi-ai 解析 `apiKeyEnv` 走的正是这一层（`credentialRef(name)` → `ctx.credentials.resolve(...)`），与你原有的 provider 同一种形态。
- **只写自己那一条路径**：端点档用 `settings.mutate('llm-pi-ai', [{op:'set', path:['providers','image-router-vision'], …}])`，你原有的 provider 不会被整体覆盖；写入前先读回现值做合并 —— 你在「设置 → 模型」给这条路由加过的 `headers` / `compat` / `timeoutMs` 不会被一次保存抹掉。
- **旁路调用计入你自己的额度**：走的是 `vision` 路由的 provider 与凭证（和正常请求同一套配额），但不写入会话日志。

## ⚠️ 已知限制

- **会话历史里留下的是文字分析，不是图片**：这是「不切模型」的必然代价（图片块被替换）。附件本身仍持久保存在 `$DSH_HOME/attachments/` 下，审计行也记了文件名。
- **准入会等旁路调用**：发送时 `session/prompt` 会等到分析完成才返回（通常几秒到十几秒；推理模型可能 40 秒以上，必要时再加一次重试），GUI 的发送按钮在此期间保持等待。
- **一次提示词一次调用**：同一条提示词里的多张图合并成**一次**视觉调用，产出一个文字块；`describe_image` 每次调用只处理一个文件。
- **`describe_image` 与内置 `read_image` 的分工**：`read_image` 受「当前步骤路由必须声明 `image`」限制；`describe_image` 走旁路调用，任何模型都能用。主力换成纯文本模型后让模型改用后者即可。
- **包装 `sessionController.prompt` 是非官方扩展点**：未来版本若改名 / 换实现，插件会退化为「不处理 + 记 warning」，不会崩。工具注册走官方 `ctx.tools.register()`。
- **switch 模式会出现模型切换提示**：借出视觉路由会写 `model`/`selection`，模型选择器会跳、GUI 会出现 `[model changed]`。想要全程无感请用默认的 `digest`。

## 🖥️ 兼容性

| | |
|---|---|
| DSH | `0.1.5-rc.1+`（已在 `0.1.5-rc.1` 上真机验证） |
| Node.js | ≥ 20（CI 覆盖 20 / 22 / 24） |
| 平台 | Windows / Linux / macOS |
| profile | `web` 验证最充分；headless / sdk / acp 也能激活（`sessionController` 缺席时插件不包装，只注册工具） |

## 🛠️ 开发与测试

```sh
node --test                  # 标准写法（Node 自带发现，20/22/24 通用）
node test/routing.test.js    # 单进程直跑：没有管道支持的沙箱里用这个
```

> `node --test test/` **不可移植**：Node 20 会扫描目录，Node 22+ 把 `test/` 当成单个入口文件去加载而报 `MODULE_NOT_FOUND`。

68 个用例：配置归一化与校验（含旧模式名映射、schema 物化出的空对象/空数组、端点档补齐 vision 路由与两档优先级）、图片信号判定、digest 的替换/多图合并/失败保留/无图直通/dryRun/落盘失败/完成块兜底/对象 finish 原因/预算被思考吃光后重试、`describe_image` 的注册/读文件/问题透传/拒绝路径、设置节的注册与「保存后下一轮即生效」、校验失败被忽略、自定义端点写入上游路由与凭据（含"跳过/失败不得记为已同步"的可重试契约、以及"合并而非覆盖上游 profile"）、图片能力 oracle、**schema 契约**、**浏览器半边激活契约**、**section base 不得遮蔽端点**、switch 的借出‑归还‑放弃状态机、`holdTurns`、`sticky`、冷会话不路由也不告警、审计可写与不可写、无 `sessionController` 时不包装、卸载恢复。

CI（`.github/workflows/ci.yml`）在 Ubuntu + Windows × Node 20/22/24 上跑同一套用例，并校验「`dsh.bundle.patch` 指向的文件存在、入口导出 `name`/`Config`/`apply`」这条打包契约。

<details>
<summary><b>仓库结构</b></summary>

```
lib/index.js      宿主一半：配置归一化、准入前替换、describe_image、审计、端点档
lib/endpoint.js   自定义端点档：翻译成上游 llm-pi-ai 路由 + 凭据
lib/settings.js   设置命名空间注册
client/client.js  浏览器一半：设置卡片（两档选择器、端点表单）
cordis.patch.yml  包内补丁：只插入一条 loader 条目（部署无关）
examples/         配置示例
tools/            五个开发用探针（digest / tool / switch 序列 / 服务形状 / 调用链）
```

</details>

## 🤝 参与贡献

- 改代码走 PR（`feat/*` / `fix/*`）；纯文档可直接推 `main`。
- 提交前自检：`node --test`，并确认 README 里描述的行为与代码一致 —— 本仓库的约定是**每条实现要点都来自实测**，README 里的「已验证」表也是这么攒出来的。
- 报 bug 时请附上审计文件里对应的那几行（`mounted` / `config-resolved` / `digest` 或 `digest-failed`）—— 这条链路上的失败方式大多是静默的，那几行是唯一可读的线索。
- **发版由 CI 完成，不需要在本地发布**。改 `package.json` 的版本号（并同步 README 顶部那行）→ 提交 → 打 tag → 推 tag，剩下的交给 `.github/workflows/release.yml`：

  ```sh
  # 1. 改版本号（package.json 与 README 顶部那行）
  # 2. 提交
  git commit -am "chore: release 0.4.4"
  # 3. 打 tag 并推送 —— 这一步触发发布
  git tag -a v0.4.4 -m "dsh-image-router 0.4.4"
  git push origin main v0.4.4
  ```

  CI 会先跑单测与打包契约检查，再校验 **tag 与 `package.json` 版本一致**（不一致直接失败，避免把错版本发出去），然后发布到 npm 并创建 GitHub Release。用的是 npm **Trusted Publishing（OIDC）**：仓库里不存任何 token，也不需要交互式 2FA，npm 会为产物生成 provenance 签名。也可以在 Actions 页面手动触发，默认是 **dry run**（只打包校验、不发布）。
- **发布是异步的**：`npm publish` 返回成功只代表 registry 受理了。packument 会先更新，tarball 与 `npm install` 可能还要几分钟才可用 —— 刚发完就装会看到 `ERR_PNPM_FETCH_404`，那是传播延迟，不是失败（本项目实测约 5 分钟）。

## 🧩 工作原理

<details>
<summary><b>实现要点（全部来自实测）</b></summary>

1. **准入前替换**：包装 `sessionController.prompt`，在调用原方法之前改写 `request.content`。图片块被移除、替换成一段文字 —— 因此准入校验看不到图片，不会拒绝、也不需要改模型。
2. **图片内容的两种形态**：wire 形态 `{ type:'image', mediaType, data(base64), name? }`；准入后形态 `{ type:'image', attachment: ImageAttachmentRef }`。插件用 `ctx.attachments.admitPromptContent(images)` 把前者落盘成后者。
3. **旁路调用是标准一次性请求**：`ctx.llm.stream({ provider, model, messages, maxTokens, sessionId, signal })`，消息为 `{ id, role:'user', source:{kind:'plugin', plugin:'image-router'}, content:[…] }`。端点、凭证、重试策略、附件解析全部复用部署自己的配置。
   - **不传 `purpose`**：它的类型是封闭枚举 `'compaction' | 'session-title'`，自定义值不合法。
   - `signal` 是 `AbortSignal.any([调用方 signal, AbortSignal.timeout(timeoutMs)])`。
   - 这次调用**不写入会话日志**。
4. **失败就保留图片**：视觉调用失败时不替换，把原请求交给原路径，让它给出真实的错误，而不是被插件掩盖。
5. **替换文本里不放文件名**：`shot.png` 这种名字会被模型当成可读路径去调 `read_image`，在纯文本模型上换来一条没必要的报错。文件名只留在审计文件里。
6. **必须用可选注入**：`sessionController` 只由 `dsh-web-app` 提供；顶层 `inject` 会让 headless/sdk/acp profile 启动失败（`1 entry did not activate`）。
7. **端点档要等三个服务一起就绪**：`ctx.inject(['llm', 'settings', 'credentials'], …)`。只等 `llm` 是个真实的坑 —— 那个回调在 entry 激活时就跑，此时设置节还没注册，`get('settings')` 返回 `undefined`，端点同步被静默跳过。
8. **"跳过"不能算"已完成"**：同步只在真正落盘（`endpoint-route-ok`）后才记下签名。签名初值是 `''` 而不是 `undefined` —— 否则每次启动都会被判成"要撤回"，误发一次 `unset` 把上一次会话写入的路由删掉。
9. **密钥只写不读**：`apiKey` 从配置里取走后立即从解析结果上剥掉，并且**不参与**签名比对 —— 否则同一个端点会不断被判定为"变了"而重复写凭据。
10. **自定义路由必须声明图片模态**：pi-ai 的 `defaultInput` 是 `["text"]`，模型条目不写 `input: [text, image]` 就会被当成纯文本模型，图片会被投影成占位文字而不是发到端点。
11. **解析探测留痕**：写完后做一次只读的 `llm.resolveModelInfo(provider, model)`，把结果写进审计 —— 这是"我配的端点到底生效没有"唯一可读的答案。
12. **图片能力 oracle 注册在自己的命名空间上**：浏览器唯一能发的模型类请求是 `remote.llm.discoverModels(settingsNs, request)`，而 `settingsNs` 只能填它知道的命名空间。过滤必须留在宿主：`inputModalities` 从不过河到浏览器。
13. **写入必须"读-改-写"**：`settings.mutate` 的路径操作在 `['providers','image-router-vision']` 上是**整体替换**，而这条路由同时也是「设置 → 模型」页能编辑的路由 —— 直接写会抹掉用户在那边加的字段。
14. **答复要同时读 delta 和完成块**：`dsh-llm-pi-ai` 把 `text_delta` 映射成 `{type:'text-delta', text}`、把 `text_end` 映射成 `{type:'block-end', block:{type:'text', text}}`。不发增量的 provider **只给后者** —— 只读 delta 会拿到空串，且 finish 是 `stop`、没有任何报错。
15. **`finish.reason` 是对象**：`mapStopReason` 返回 `{ kind: 'stop' | 'max-tokens' | 'error' | … }`，失败细节在 `reason.failure.{code,message}`。拿字符串比会**吞掉适配器报的每一个错误**，把可诊断的失败变成静默的空答复。
16. **token 预算与模型思考共享**：在 `openai-completions` 上 `maxTokens` 作为 `max_completion_tokens` 发出，推理和正文共用。推理模型可能把预算全花在思考上 —— 此时插件自动用 `max(4×, 4096)`（上限 32768）重试一次。
17. **`Config` 的 schema 是双形态的**：能解析 `@deepseek-ai/schemastery` 时用它，否则退回零依赖等价实现。解析是**多锚点**的（本文件位置 → 运行中的 CLI → npm 全局根），因为插件装进 profile 后宿主的 `node_modules` 不在 profile 往上的解析路径上。**设置页是遍历 `schema.toJSON()` 渲染的**，所以一个"字段图为空"的描述会让整个模型页加载失败 —— 这是真机踩到的。

</details>

## ✅ 已验证

| 环节 | 结论 |
|---|---|
| 单测 | ✅ 68 个用例 |
| 挂载进真实 web profile | ✅ 冷启动审计写 `mounted mode=digest …` |
| 标准 bundle 形态可装载（bundles → 包内 patch → 部署层覆盖 → `Config` 补默认值） | ✅ 隔离实例冷启动，`schemastery` 与回退 Standard Schema 两条路径都跑过 |
| 无 `sessionController` 的 profile 仍能启动 | ✅ headless 冷启动 `exit=0` |
| digest 端到端：会话模型不变 + 图片被正确识别 | ✅ 隔离实例实测 |
| `describe_image` 注册 + 执行全链路 | ✅ 隔离实例实测 |
| switch 端到端（借出 → 保持 → 归还） | ✅ 隔离实例实测 |
| 自定义端点档写进上游 | ✅ `settings.yaml` 出现 `providers.image-router-vision`，`.credentials.yaml` 出现引用，原有 provider 未变 |
| **用户保存的端点真的被使用** | ✅ 用真实 profile 的补丁副本 + 真实 `settings.yaml` 冷启动：`config-resolved -> image-router-vision/qwen3.8-max`、`mounted … vision=image-router-vision/qwen3.8-max`、`digest … chars=408` |
| `ctx.llm.stream` 经该路由打到 mock 端点（图片随行） | ✅ 探针实测：`listProviders()` 出现该路由（**未重启**）、`resolveModelInfo` 报 `["text","image"]`、stream 收齐 `block-start → 3×text-delta → block-end → usage → finish:stop`；mock 侧记录 `sawImage: true` |
| 图片能力 oracle 真的按模态过滤 | ✅ 从 4 个模型里筛出 2 个图片模型；未知路由返回 `[]` 而不抛错 |
| 保存不会毁掉用户在模型页对该路由的编辑 | ✅ 预置 `headers` 与 `timeoutMs` 在保存后仍在，其它 provider 未变 |
| **密钥不落配置** | ✅ 真实 `settings.yaml` 中该端点只有 `{baseURL, model, images}`，无 `sk-` 值 |
| 浏览器半被发现并提供 | ✅ 隔离实例实测（boot manifest 含 `client.js`，取回 200）；卡片渲染用 React 替身跑过，**视觉外观**需在 GUI 里看一眼 |

## 🔗 参考实现

- [kanchengw/image-router](https://github.com/kanchengw/image-router) — Codex++ 的 HTTP 代理：拦截 `image_url`，调 VL API 生成 `[IMAGE ANALYSIS]` 文字后替换图片再转发（本插件 digest 模式即此语义）
- [lll888666/codex-deepseek-vision-fallback](https://github.com/lll888666/codex-deepseek-vision-fallback)
- [rongyaozhixing/codex-vision-plugin](https://github.com/rongyaozhixing/codex-vision-plugin)
- [ningyougan/deepseek-vision-mcp](https://github.com/ningyougan/deepseek-vision-mcp)

---

<div align="center">
  <sub>MIT License · Built for the <a href="https://github.com/deepseek-ai/deepseek-harness">DeepSeek Harness</a> ecosystem</sub>
</div>

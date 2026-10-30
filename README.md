# dsh-image-router

> [!IMPORTANT]
> **当前版本 `0.6.2`，已发布到 npm。从 0.6.0 起它是「带左侧栏入口」的 DSH 插件：侧栏多一行「图片路由」，点开是独立配置页（0.2.1 的 `main` keyed 槽 + `sidebar.panellist` list 槽契约），同时保留原来的设置卡片。适配 DSH `0.1.5-rc.1+` 与 `0.2.x`：`0.1.5-rc.1`、`dsh-desktop 0.2.0-rc.2` 为真机验证线；**`0.2.1-rc.5` 是当前桌面线** —— 0.6.2 修掉了 0.2.1 在桌面端最致命的一处不适配：设置节的命名空间是 **loader 条目 id**（bundle 插入的行是 `include:image-router`），而卡片此前只认真名 `image-router`，于是配置页永远是「没有找到设置节」。0.6.2 改为按条目 id 解析（真名 → 后缀 → schema 形状），并同时认领 0.2.1 新增的 `plugins.row.config` 行配置页、补上 `locale/*.json` 标题/描述与 `icon.svg`。另修掉一个更阴的 0.2.x 陷阱：卡片不再把没填的 `instruction` 写成空串（那会让宿主校验拒绝整个条目、插件自我禁用），宿主也把空串视为「用内置指令」—— 已中招的 profile 重启即恢复。0.6.2 同步支持桌面 `0.2.1-rc.5`：12 个契约包逐文件比对，除 CSS 类名哈希 / 构建路径 / 提交号外**零变更**，并在真实 rc.5 运行时上冷启动取证（`apply-entered` → `tool-registered` → `mounted`，boot manifest 里 `dsh-image-router` 与三条 `inject` 照旧）。**
> 若你装到的是更早的 `0.1.0`，那是本插件的第一个（已废弃的）构建，会让「设置 → 模型」页加载失败 —— 用 `dsh plugin --profile web add dsh-image-router@latest` 直接装最新版即可。
> **`0.4.4` 及更早的版本装不进 `0.2.x`**：插件的浏览器半边声明了 0.2.x 已删除的 `settingsScope` 服务，条目永久 pending，web boot 会以 `1 entry did not activate` 中止整次启动（详见〈0.2.x 与 0.1.x 的差异〉）。

<div align="center">
  <b style="font-size: 1.15em;">让纯文本模型也能「看图」</b><br />
  图片在进入会话之前，先由你指定的视觉模型转成文字 —— <b>你的会话模型自始至终不变</b>，模型选择器也不会跳。<br /><br />
  <a href="https://www.npmjs.com/package/dsh-image-router"><img alt="npm version" src="https://img.shields.io/npm/v/dsh-image-router" /></a>
  <a href="https://www.npmjs.com/package/dsh-image-router"><img alt="npm downloads" src="https://img.shields.io/npm/dm/dsh-image-router" /></a>
  <a href="https://github.com/zhiwuli0228/dsh-image-router/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/zhiwuli0228/dsh-image-router/actions/workflows/ci.yml/badge.svg" /></a>
  <a href="https://github.com/zhiwuli0228/dsh-image-router/actions/workflows/release.yml"><img alt="release" src="https://github.com/zhiwuli0228/dsh-image-router/actions/workflows/release.yml/badge.svg" /></a>
  <a href="https://opensource.org/licenses/MIT"><img alt="License: MIT" src="https://img.shields.io/badge/License-MIT-yellow.svg" /></a>
  <a href="https://github.com/zhiwuli0228/dsh-image-router/stargazers"><img alt="GitHub stars" src="https://img.shields.io/github/stars/zhiwuli0228/dsh-image-router" /></a><br /><br />
  <a href="https://www.npmjs.com/package/@deepseek-ai/dsh?activeTab=versions"><img alt="适配的 DSH：0.2.1-rc.3 侧栏槽位契约 + 0.1.5-rc.1 兼容" src="https://img.shields.io/badge/DSH-0.2.1--rc.3_contract_%2B_0.1.5--rc.1-4d6bfe" /></a>
  <a href="#测试"><img alt="tests" src="https://img.shields.io/badge/tests-74_passing-brightgreen" /></a>
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

**先选目标**：装到 **web 版** 还是 **桌面版**。两者是**不同的 profile、不同的 CLI**，插件得分别装；装错了就是“装完没反应”。

| 目标 | profile 目录 | 用哪个 CLI | 装完怎么生效 |
|---|---|---|---|
| **web 版**（`dsh web`） | `$DSH_HOME/profiles/web` | PATH 上的 `dsh`（`npm i -g @deepseek-ai/dsh`） | 重启 `dsh web`，浏览器硬刷新 |
| **桌面版**（DeepSeek Harness App） | `$DSH_HOME/profiles/desktop` | **App 自带的那个**（`…\resources\runtime\cli\bin\dsh.cmd`） | **完全退出 App**（含托盘）再重新打开 |

**前置**：Node.js ≥ 20；桌面版还需要 App 至少完整启动过一次（profile 由 App 初始化）。

**方式一：命令行一条 —— 按目标二选一**

```sh
# 有 web 版：装进 web profile，然后重启 dsh web
dsh plugin --profile web add dsh-image-router && dsh web
```

```powershell
# 有桌面版（Windows）：先完全退出 App，再用 App 自带的 CLI
& "$env:LOCALAPPDATA\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd" plugin --profile desktop add dsh-image-router
```

macOS 是 `/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh`，Linux 见下方〈桌面版装在哪〉。

**方式一·五：用仓库里的安装器（自动挑 CLI / profile）** —— 仅**源码克隆**里有（npm 包不含 `tools/`），但正因如此它知道两个目标各自该用哪个 CLI：

```sh
node tools/install.mjs desktop          # 装桌面版（自动找 App 内置 CLI，检查 App 是否已退出）
node tools/install.mjs web              # 装 web 版（用 PATH 上的 dsh）
node tools/install.mjs desktop --source # 从本地克隆装（file:<repo>）
node tools/install.mjs desktop --dry-run # 只预检 + 打印将执行的命令，不写任何东西
# 等价：pnpm run install:desktop / pnpm run install:web
```

它会先打印 `target / profile / cli / spec / current` 再动手，并在桌面版上拒绝在 App 运行时写入（`--force` 可跳过）。`--home` 会同时作为 `DSH_HOME` 传给 CLI —— 否则 CLI 会按自己的默认家目录装到别处去（这个坑实测踩过一次）。

**就这一条。** `dsh plugin` 是 pnpm 的薄封装：它把包装进 profile，并**自动**把声明了 `dsh.bundle` 的依赖加进 `dsh.profile.bundles`（按已安装状态 reconcile），不需要手动编辑 `package.json`。卸载同理，把 `add` 换成 `remove`，`--profile` 换成对应目标。

> 不想走 npm？把 `dsh-image-router` 换成 `github:zhiwuli0228/dsh-image-router` 即为等价形态（前沿代码、未经 registry 校验）。

<details>
<summary><b>桌面版装在哪 / 为什么不能用 PATH 上的 dsh</b></summary>

桌面 App 不复用 npm 全局安装的 `dsh`：它把整套运行时（Node + pnpm + harness）放在安装目录里，CLI 是

```
<App>\resources\runtime\cli\bin\dsh.cmd          # Windows
/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh   # macOS
```

两个版本可能并不相同（例如本机 npm 全局是 `0.1.5-rc.1`，App 内是 `0.2.1-rc.3`）。用错 CLI 的后果：

- 用旧 CLI 装桌面 profile → 写进去的插件 bundle 由旧运行时解释，App 读不到 / 读错；
- 用任何 CLI 在 **App 运行时**写 desktop profile → `dsh plugin` 自己就会拒绝：`Open DeepSeek Harness Desktop once to initialize its profile, then fully quit it before running dsh plugin --profile desktop.`（它靠 `package.json` 的文件锁保护）；
- 桌面 profile 只能由 App 创建，CLI **不会**替它初始化。

确认自己装到了哪个 profile：

```sh
& "$env:LOCALAPPDATA\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd" plugin --profile desktop list
```

输出里的路径就是真正生效的 profile（本机为 `C:\Users\<you>\.dsh\profiles\desktop`）。

</details>

**方式二：让 DSH 自己装** —— 把下面这段发给任意一个 DSH 会话（把第一句的目标改成 `web` 或 `desktop`）：

```text
帮我安装 dsh-image-router 图片旁路识别插件（DSH 插件，让纯文本模型也能看图），目标：<web 或 桌面版>，步骤：
1. 先确认目标：web 版用 PATH 上的 dsh；桌面版用 App 自带的 CLI（Windows：%LOCALAPPDATA%\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd），且桌面 App 要先完整启动过一次、再完全退出
2. web：执行 dsh plugin --profile web add dsh-image-router；桌面版：执行上面那个 dsh.cmd 的 plugin --profile desktop add dsh-image-router
3. 确认 dsh-image-router 已出现在对应 profile（profiles/web 或 profiles/desktop）package.json 的 dsh.profile.bundles 里
4. 提醒我：web 重启 dsh web；桌面版完全退出并重新打开 App
5. 之后告诉我：左侧栏多出来的「图片路由」行点开是什么样，视觉模型那栏怎么填
遇到报错先查 https://github.com/zhiwuli0228/dsh-image-router README 的常见问题。
```

**方式三：本地源码**（想改代码时）——见下方〈从源码安装〉。

### 装完 2 步

1. 点**左侧栏的「图片路由」行**（0.6.0+：中间栏直接打开配置页；再点会话行回去）；也可以走设置里的同款卡片 —— **设置 → 插件 → 插件配置 → image-router**（0.2.x 上这个页面变成了插件管理页：在 **设置 → 插件** 里找到 `dsh-image-router` 这个 bundle，它的配置区就是同一张卡片）。
2. 「视觉模型」下拉里选一个支持图片的模型；**没有现成的就切到「自定义端点」**，只填三样：**地址、模型名、API Key** → 保存。

然后随便发一张图 —— 你会看到 `[图片分析 · <你选的模型>]` 开头的文字，代替图片进入会话。

<details>
<summary><b>更新</b></summary>

```sh
# web 版：装/升到最新版
dsh plugin --profile web add dsh-image-router@latest
```

```powershell
# 桌面版：先完全退出 App，再用 App 自带的 CLI（或 node tools/install.mjs desktop）
& "$env:LOCALAPPDATA\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd" plugin --profile desktop add dsh-image-router@latest
```

**若它打印 `Already up to date` 却仍是旧版**：pnpm 11 的**发布年龄门槛**（`minimumReleaseAge`）把「刚发布不久」的版本排除在版本解析之外。**全新安装不受影响**（pnpm 会把该版本自动加进排除项，实测发布 20 分钟后 `@latest` 即可装到），但**升级已有依赖**时会把新版本滤掉、解析回旧版 —— 看起来像更新失败，其实是策略挡的。这时显式写出版本号即可，pnpm 会打印 `Added 1 entry to minimumReleaseAgeExclude` 并立即安装：

```sh
dsh plugin --profile web add dsh-image-router@<版本号>
```

改完**硬刷新浏览器**（Ctrl/Cmd+Shift+R）。配置项的改动不需要重启（保存后下一次判定即生效）；插件**代码**的改动需要重启 `dsh web`。桌面版同理：配置改动即时生效，**客户端代码**（`client/client.js`、`locale/`、`icon.svg`）变化要**完全退出并重开 App** —— 它没有浏览器硬刷新那一步。

</details>

<details>
<summary><b>常见问题</b></summary>

| 现象 | 原因与解决 |
|---|---|
| 发图后什么都没发生 | 先看审计文件有没有 `mounted mode=digest`。没有 → 插件没挂上，确认包在 `dsh.profile.bundles` 里并重启 `dsh web`。有 → 看贴图那一刻有没有 `digest session=… chars=…` 行。 |
| 卡片不出现，控制台也没有报错 | 浏览器一半的 `inject` 声明了加载器满足不了的依赖，entry 会永久 pending 且毫无提示。当前版本已修正；若仍在旧版本上，升级即可。浏览器里读 `window.__imageRouter` 可看到走到哪一步、以及卡片最终挂在哪个槽位（`registered`）。 |
| **装完就起不来**：`web boot: 1 entry did not activate`，并指名 `dsh-image-router: pending (waiting for service: settingsScope)` | `0.4.4` 及更早的浏览器半边声明了 0.2.x 已删除的 `settingsScope`。启动时它永久 pending，web boot 等它就绪，于是整次启动被中止（桌面端会在 `%APPDATA%\@deepseek-ai\dsh-desktop\logs\crash-*-web-boot.log` 留一份崩溃日志）。**升级到 `0.5.0+`**；暂时脱困可以把插件从该 profile 的 `dsh.profile.bundles` 里摘掉。 |
| 「设置 → 模型」打不开，或提示「填入各提供方的 API 密钥」 | `0.3.1` 之前版本的已知问题（schema 描述为空导致设置页整体加载失败）。升级即可。 |
| 分析很慢（半分钟以上） | 多半是推理模型把 token 预算花在思考上。插件会自动用更大预算重试一次（审计记 `digest-retry`），但你可以把卡片里的 `maxTokens` 从 `900` 直接改成 `4000` 省掉那一轮；或换非推理的视觉模型。 |
| 分析是空的，收到的是图片占位 | 看审计里的 `digest-empty` / `digest-failed` 行 —— 现在会带上实际收到的 chunk 类型与 finish 原因，据此判断是模型没输出、预算被思考吃光、还是路由配置问题。 |
| 保存端点后仍走别的模型 | 升级到 `0.4.0+`。旧版本会让 profile 里的默认路由遮蔽你保存的端点。 |
| 装完“没反应”，`dsh plugin --profile desktop list` 里也看不到 | 十有八九装进了另一个 profile。桌面版必须用 **App 自带**的 CLI 且 `--profile desktop`（见〈一分钟安装〉的表格）；PATH 上的 `dsh` 版本可能更旧，装到的是 `profiles/web`。 |
| 想彻底移除 | web：`dsh plugin --profile web remove dsh-image-router`；桌面版：完全退出 App 后用 App 自带的 CLI `plugin --profile desktop remove dsh-image-router`（包会从依赖与 bundles 一起消失）。它写下的派生路由 `Image Router Vision` 与凭据会保留，要清就在 **设置 → 模型** 里删掉那条路由。 |

</details>

<details>
<summary><b>从源码安装 / 开发</b></summary>

```sh
# web 版：装进 web profile（file: 指向你的克隆目录）
dsh plugin --profile web add file:E:\path\to\dsh-image-router

# 2. 重启 dsh web
dsh web
```

```powershell
# 桌面版：先完全退出 App，再用 App 自带的 CLI
& "$env:LOCALAPPDATA\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd" plugin --profile desktop add file:E:\path\to\dsh-image-router
# 然后重新打开 App
```

两条等价的一步版本：`node tools/install.mjs web --source` / `node tools/install.mjs desktop --source`。

> **改完代码怎么让它生效**：`file:` 依赖在 profile 里是**拷贝**，不是软链 —— 改完源码必须重跑一次上面的 `add`（或把改动的文件按原相对路径覆盖进 `<profile>\node_modules\dsh-image-router\`），再重启。宿主一侧（`lib/`）重启即生效；客户端一侧（`client/client.js`、`locale/`、`icon.svg`）桌面版必须**完全退出 App 再打开**。

零安装也可以：不装依赖，直接按路径挂载（见 `examples/cordis.patch.yml`），两个目标只是 profile 目录不同：

```yaml
# $DSH_HOME/profiles/web/cordis.patch.yml      ← 桌面版换成 profiles/desktop
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
- **⚙️ 图形界面配置，保存即生效**：两处入口、同一张表单 —— **设置 → 插件 → 插件配置** 里的卡片，以及**左侧栏「图片路由」行打开的那一页**。改完立刻用于下一次判定（不需要重启、不需要手写 YAML）。
- **🧭 左侧栏常驻入口（0.6.0 新增）**：侧栏面板行多一个图标 + 「图片路由」一行，点开在中间栏打开独立配置页，返回会话只需再点会话行 —— 不用每次进设置里翻三层。它注册的是 `sidebar.panellist` 的**新增**一行（`order: 40`），不替换任何内置面板；插件未配置时页面照常打开，只是提示先选视觉路由。
- **🔐 API Key 只写不落盘**：密钥写进凭据库（`refs.IMAGE_ROUTER_VISION_API_KEY`），只留引用名在路由里；解析结果、设置节、卡片草稿三处都会剥掉它，不回显、不写进配置文件、不进审计日志。
- **🧩 不自己实现协议**：线协议、模型发现、图片投影、重试全部交给 `@deepseek-ai/dsh-llm-pi-ai`，插件只负责把卡片上的字段写成 DSH 的配置。
- **🛡️ 失败即放行**：视觉调用失败（配额 / 超时 / 报错）时不替换图片，把原请求交给原路径，让它给出**真实的**错误，而不是被插件掩盖。任何插件内部异常都只写审计 + 一条 warning。
- **📝 审计文件**：挂载、每次分析、用了哪条路由、重试、失败原因都记一行 —— 「我配的端点到底生效了吗」有一个可读的答案。
- **🧪 92 个单测 + 全平台 CI**：Ubuntu + Windows × Node 20/22/24，外加一份打包契约（含「侧栏入口与主面板必须同 id」的断言、以及「手动安装必须点名 desktop / web」的断言）。

## 🧭 左侧栏入口

除了设置里的卡片，插件在侧栏注册一行入口，并把「配置页」注册到布局的主面板槽：

```
┌──── 侧栏 ────┬──────────── 中间栏 ────────────┐
│  ＋ 新会话    │  图片路由          dsh-image-router │
│  …会话…      │  图片在进入会话之前先由视觉路由分析成文字，  │
│  ⬚ 插件      │  会话模型不会被切换；这里保存的值从下一轮起生效。│
│  🖼 图片路由  │  ┌──────────────────────────┐  │
│  ⚙ 设置      │  │ 视觉来源 / 模型 / 端点 / 保存 / 还原 │  │
└──────────────┴──────────────────────────┘
```

- **一行两槽、同一个 id**：侧栏行注册在 `sidebar.panellist`（list 槽，`id: image-router`），配置页注册在 `main`（keyed 槽，`key: image-router`）。侧栏行被点击时布局按该 id 切换中间栏 —— 两个槽里的 id 必须一致，否则就是「点了没反应」或「页面进不去」，单测与打包契约都把这一条钉住了。
- **不碰内置面板**：这是**新增**注册（`order: 40`），不会覆盖 / 移除任何自带行；卸载插件后这一行随之消失。
- **语言跟随界面**：行标签是 thunk（`label: () => ...`），按 `document.lang` 返回「图片路由 / Image Router」，不需要重新注册。
- **图标内联 SVG**：手写客户端包只能 `require('react')`（平台 seed 词），拿不到内置图标包 —— 所以图标用 `currentColor` 内联 SVG，颜色跟随侧栏主题，选中态由宿主传 `active`。
- **降级**：两个槽都用 `slots.inject` 认领（槽被声明才回调）。运行时不声明这两个槽时认领保持惰性，客户端条目照常激活 —— 不会因为侧栏入口把整个 web boot 拖成 pending。

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
| `instruction` | 内置（提取文字 + 描述画面） | 给视觉模型的指令。**留空 = 用内置指令**（0.6.2 起卡片留空写的是 `unset`，而不是 `instruction: ""`）—— 详见下方「空 instruction 会把插件自己关掉」 |
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

### 空 `instruction` 会把插件自己关掉（0.2.x 陷阱，0.6.2 修复）

0.2.x 上「条目自己的 `Config` 就是设置节」，所以卡片保存时写回的每个键都是**真实配置值**。旧版卡片每次保存都会把 `instruction` 一并写回，而这个字段没填过时读到的就是空串 —— 于是 profile 补丁里凭空多出：

```yaml
- id: image-router
  config:
    instruction: ""
```

宿主侧校验把它当非法值（`instruction must be a non-empty string`），`apply` 在注册任何东西**之前**就返回：插件装好了、条目 `active`、工具却不存在，看上去就是「怎么弄都不生效」，而证据只有日志里一行 warn（审计文件里是 `apply-disabled problems=…`）。

0.6.2 两头都改了：卡片留空改发 `unset`（不再写空串，且顺手清掉旧值），宿主把空串/纯空白当作「用内置指令」。已经中招的 profile **不需要手改**，重启后即可恢复；再点一次保存会把那个空串删掉。

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
| DSH `0.1.5-rc.1+`（CLI：`dsh web` / headless / sdk / acp） | 真机验证。设置节走 `settings.register`，卡片挂在 `settings.plugin.item`；侧栏入口（若该版本声明 `sidebar.panellist` / `main`）同一套代码。 |
| DSH `0.2.x`（`dsh-desktop 0.2.0-rc.2`） | 真机验证。设置节＝条目自己的 `Config`，卡片挂在 `plugins.bundle.config`。 |
| DSH `0.2.1`（`dsh-desktop 0.2.1-rc.3` → **`0.2.1-rc.5`** 内嵌运行时） | 两条桌面线都真机取证：侧栏行、`main` 页、`plugins.bundle.config` 卡片三者都注册且 `active`（`Slots.listSubTree` 的 `occupants` 可读），rc.5 上还额外跑了一次完整冷启动。0.6.2 起另加两件当时缺的东西：① 设置节按 **loader 条目 id** 解析（该运行时是 `include:image-router`，不是 `image-router`），② 认领 0.2.1 新增的 `plugins.row.config` 行配置页（`<包名>#<补丁里声明的行 id>`），宿主递来的 `form` 直接写、不再猜命名空间。**再重启一次桌面 App 即可看到修复后的配置页**（装在 profile 里的副本是拷贝，不是软链）。 |
| Node.js | ≥ 20（CI 覆盖 20 / 22 / 24） |
| 平台 | Windows / Linux / macOS |
| profile | `web` / `desktop` 验证最充分；headless / sdk / acp 也能激活（`sessionController` 缺席时插件不包装，只注册工具） |

## 🧬 0.2.x 与 0.1.x 的差异

两代换了客户端服务名与设置模型，插件对两者都支持，靠**能力探测**而不是版本号判断：

| | 0.1.x | 0.2.x |
|---|---|---|
| 设置节的来源 | `settings.register(ns, schema, { base })`，插件的 `base` 层叠在用户节之下 | **条目自己的 `Config` 就是该节**（`ns` = loader 条目 id），服务只投影（`describe`）与写入（`mutate`） |
| 可写字段 | 无限制 | 只有 schema 里标了 `volatile` 的路径可写（插件标的是顶层字段，`vision` 覆盖其子树） |
| `volatile` 字段怎么读 | 标记对解析无影响，值就是普通值 | **标记会改变解析**：该字段解析成 cosmokit 实时取值器（`{ get(), [Symbol(cosmokit.volatile.write)] }`），`~standard.validate`（loader 交给 `apply` 的那份）也一样。插件因此先把配置解包（`plainConfig`）再判读；官方 pi-ai 也是 `config.providers.get()` 这么读的 |
| 配置落在哪 | `$DSH_HOME/settings.yaml` 的节（0.2.x 启动时会被导入并改名 `.imported`） | 该 profile 的补丁层（`cordis.patch.yml`） |
| 卡片挂在哪 | `settings.plugin.item`，按设置命名空间 key | `plugins.bundle.config`，按包名 key（在插件页上该 bundle 的页里）；0.2.1 起另有 `plugins.row.config`，key 是 `<包名>#<补丁里声明的行 id>`（`dsh-image-router#image-router`），行上多出「配置」入口 |
| 设置命名空间长什么样 | 插件自己 `register('image-router', …)`，就是这一个名字 | **loader 条目 id**：bundle 补丁插入的行被组合成 `include:<行 id>`（`include:image-router`），`dsh-settings` 用 `entry.options.id` 当 `ns`。0.6.2 起卡片按条目 id 解析：真名 → `<分隔符><真名>` 后缀 → schema 形状（含 `vision`/`maxTokens`/`timeoutMs`），写回同一个 id |
| 页面表单谁给 | 没有，卡片自己读写 `settingsScope` | 0.2.1 的配置槽会把条目自己的 `form`（`{ state, mutate }`）作为 prop 递进来；卡片优先用它（不再需要命名空间），没有 `form` 时才回落到 `remote.settings` |
| 侧栏入口 | 两侧都有 `sidebar.panellist`（list 槽）与 `main`（keyed 槽）；行 id 即主面板 key | 同左；布局按当前面板 id 以 `entryKey` 分发 `main` |
| 浏览器侧绑定 | `settingsScope` 服务 + `scope.set(field, value)` | 没有；一律走 `remote.settings.describe()` / `mutate(ns, ops, revision)` |
| 密钥 | 卡片写进节，Host 随即取走存进凭据库 | 同上，并且 Host 存完凭据后会**把明文从配置里 `unset`**（否则它会留在 profile 补丁里） |
| `package.json` 的 `dsh.client.inject` | 声明客户端模块依赖 | 官方包把它写成**客户端包名行**（参考 `plugin-manager`：`api-remotes` + `locale` + `layout` + `sidebar`）。0.6.0 起插件改同一形状：`@deepseek-ai/dsh-api-remotes`、`@deepseek-ai/dsh-client-ui-layout`、`@deepseek-ai/dsh-client-ui-sidebar` —— 这三行是侧栏入口所在的组合。真正的服务闸门仍是模块自己的 `inject` 列表（`slots`/`remote`/`remote.settings`/`remote.llm`） |

**为什么必须这么做**：0.4.4 把 `settingsScope` 写进了浏览器半边的 `inject`。0.2.x 的 web boot 会遍历每个客户端条目，凡是 `fiber.state !== 'active'` 就报错退出，pending 的还会列出解析不到的服务名 —— 于是整次启动被一句 `web boot: 1 entry did not activate … pending (waiting for service: settingsScope)` 中止，配置写什么都没用，因为这一步发生在读取配置之前。现在两半都只用两代都有的服务（客户端 `slots` / `remote` / `remote.settings` / `remote.llm`，宿主侧 `settings` / `llm` / `credentials` / `tools` / `fs` / `attachments` / `sessionController`），缺 `settings.register` 时只记一行 `settings-unsupported`。

## 🛠️ 开发与测试

```sh
node --test                  # 标准写法（Node 自带发现，20/22/24 通用）
node test/routing.test.js    # 单进程直跑：没有管道支持的沙箱里用这个
node tools/check-contract.mjs   # 打包契约（CI 跑的就是它）
```

> `node --test test/` **不可移植**：Node 20 会扫描目录，Node 22+ 把 `test/` 当成单个入口文件去加载而报 `MODULE_NOT_FOUND`。

**打包契约**由 `tools/check-contract.mjs` 一处定义，`ci.yml` 与 `release.yml` 都调它，所以两边不会漂移、你也能跑 CI 跑的同一份。它守住五件事:① 声明的补丁文件存在;② 声明的浏览器一半存在且真的注册了侧栏入口与主面板(字符串断言：`sidebar.panellist` 行 + `name: 'main'` 页);③ 入口导出满足 loader 消费的那套(含 `Config` 必须能答 Cordis 的 `~standard.validate`、settings 服务的调用与 `toJSON()` 字段图 —— 断言的是**两种 schema 形态都满足的契约**,`safeParse` 刻意不在其中,因为 fallback 有而真 schemastery 没有);④ `dsh.client.inject` 里写着侧栏入口所在的两个包行(`ui-layout` / `ui-sidebar`);⑤ **README 顶部那行版本号与 `package.json` 一致** —— 这两个文件靠人手同步,而 npm 页面显示一个、registry 服务另一个,除此之外没人会发现它们漂移。

74 个用例：配置归一化与校验（含旧模式名映射、schema 物化出的空对象/空数组、端点档补齐 vision 路由与两档优先级）、图片信号判定、digest 的替换/多图合并/失败保留/无图直通/dryRun/落盘失败/完成块兜底/对象 finish 原因/预算被思考吃光后重试、`describe_image` 的注册/读文件/问题透传/拒绝路径、设置节的注册与「保存后下一轮即生效」、**0.2.x 式服务（没有 `register`）只记审计不失败**、校验失败被忽略、自定义端点写入上游路由与凭据（含"跳过/失败不得记为已同步"的可重试契约、"合并而非覆盖上游 profile"、以及**密钥写进凭据库后从配置里抹掉**）、图片能力 oracle、**schema 契约（含 `volatile` 与 secret 标记，且不得父子同时标）**、**浏览器半边激活契约（四个槽位各挂一次：两代设置卡片 + 侧栏行 + 主面板；`inject` 不得再出现 `settingsScope`；summary/panel 视图分离；侧栏行与主面板必须同 id；行标签跟随界面语言；侧栏图标为内联 SVG）**、**section base 不得遮蔽端点**、switch 的借出‑归还‑放弃状态机、`holdTurns`、`sticky`、冷会话不路由也不告警、审计可写与不可写、无 `sessionController` 时不包装、卸载恢复。

CI（`.github/workflows/ci.yml`）在 Ubuntu + Windows × Node 20/22/24 上跑同一套用例，并跑上面那份打包契约。

<details>
<summary><b>仓库结构</b></summary>

```
lib/index.js             宿主一半：配置归一化、准入前替换、describe_image、审计、端点档
lib/endpoint.js          自定义端点档：翻译成上游 llm-pi-ai 路由 + 凭据
lib/settings.js          设置命名空间注册
client/client.js         浏览器一半：设置卡片 + 侧栏入口（图标行 + 配置页，共用同一张表单）
cordis.patch.yml         包内补丁：只插入一条 loader 条目（部署无关）
examples/                配置示例
tools/check-contract.mjs 打包契约（两个工作流共用）
tools/release.mjs        发版准备：同步两处版本号 → 校验 → 提交 → 打 tag
tools/*-probe.mjs        五个运行时探针（digest / tool / switch 序列 / 服务形状 / 调用链）
```

</details>

## 🤝 参与贡献

- 改代码走 PR（`feat/*` / `fix/*`）；纯文档可直接推 `main`。
- 提交前自检：`node --test` 与 `node tools/check-contract.mjs`，并确认 README 里描述的行为与代码一致 —— 本仓库的约定是**每条实现要点都来自实测**，README 里的「已验证」表也是这么攒出来的。
- 报 bug 时请附上审计文件里对应的那几行（`mounted` / `config-resolved` / `digest` 或 `digest-failed`）—— 这条链路上的失败方式大多是静默的，那几行是唯一可读的线索。
- **发版**：一条命令准备，一个 tag 发布。版本号写在两个文件里（`package.json` 与 README 顶部），`release.mjs` 会同时改掉、并在打 tag 前跑完契约检查与单测 —— **CI 会拒绝的东西，本地就先拒绝掉**：

  ```sh
  node tools/release.mjs 0.4.5          # 改版本号 → 校验 → 提交 → 打 tag（不推送）
  git push origin main v0.4.5           # 这一步触发发布
  # 想一步到底：node tools/release.mjs 0.4.5 --push
  # 只看会发生什么：node tools/release.mjs 0.4.5 --dry-run
  ```

  它还会拦住几种"不可撤销"的情形：工作树脏（tag 会指向一个不存在的树）、版本号不递增、tag 已存在、该版本已在 npm 上（版本号不可覆盖）。`--push` 是**显式选填**的 —— 不可逆的那一步应该是决定,而不是某个参数的副作用。

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
18. **客户端条目的 `inject` 是一道硬闸门，声明错就是启动不了**：0.4.4 声明了 `settingsScope`（0.2.x 已删除），条目永久 pending，web boot 以 `1 entry did not activate` 中止。现在两半只声明两代都有的服务；跨代差异一律走**能力探测**（有没有 `settings.register`、哪个槽位被声明），不猜版本号。
19. **可写路径必须是 `volatile`**：0.2.x 的 `SettingsForms.write` 会拒绝任何不在条目 schema `volatile` 路径上的写入。标记只打**顶层字段**（`vision` 覆盖 `vision.endpoint.*`），因为 schemastery 拒绝 volatile 套 volatile；且标记直接写在 `meta` 上（`meta.volatile` / `meta.role='secret'`），因为两代 schemastery 的 API 不一致 —— `3.18.2` 没有 `.volatile()`，它的 `.role('secret')` 也不写 `meta.role`（实测 `meta` 仍是 `{}`）。
20. **卡片写叶子路径，不写整个 `vision`**：`mutate` 的每个 op 路径都要单独过 `volatile` 校验，所以切换两档时要显式 `unset` 另一档（`vision.provider` / `vision.endpoint`），不能指望"整体覆盖"。
21. **密钥写进凭据库后要从配置里抹掉**：0.1.x 的节本来就不留它；0.2.x 的条目配置**就是** profile 补丁，留一份明文等于把 key 落盘。存完凭据后补一条 `mutate(ns, [{op:'unset', path:['vision','endpoint','apiKey']}])`，审计记 `endpoint-key-scrubbed`。
22. **同一张卡片挂两个槽位**：`slots.inject` 只在**槽位被声明**时才回调，所以同时认领 `settings.plugin.item`（0.1.x，按设置命名空间 key）与 `plugins.bundle.config`（0.2.x，按包名 key）是安全的 —— 任一运行时只会声明其中一个，另一个静默不触发。`plugins.bundle.config` 的 owner 会要 `summary` 与 `page` 两种视图，summary 只画一行。
23. **`volatile` 字段在 0.2.x 上不是"值"**：schemastery 会把标了 `meta.volatile` 的字段解析成 cosmokit 实时取值器（`{ get(), [Symbol(cosmokit.volatile.write)] }`），**`~standard.validate` 也一样** —— 也就是 loader 交给 `apply` 的那份配置。第一版移植直接把标记写进 schema，结果 `normalizeConfig` 把取值器当对象、判定配置非法并自我禁用；因为 `traceFile` 是在"无 problem"的返回里才解析的，审计文件干脆是空的，只有真机冷启动才暴露出来。现在 `apply` 与 `normalizeConfig` 都先过 `plainConfig`（递归解包，同时避开"普通对象恰好有 `get`"的误判），官方 pi-ai 读它的 volatile `providers` 用的是同一件事：`config.providers.get()`。

</details>

## ✅ 已验证

| 环节 | 结论 |
|---|---|
| 单测 | ✅ 92 个用例（77 路由/宿主/客户端 + 15 安装器） |
| **桌面 `0.2.1-rc.5` 同步（0.6.2）** | ✅ ① **契约比对**：把 npm 上 12 个 rc.5 包（`dsh` / `dsh-settings` / `dsh-plugin-manager` / `dsh-client-ui-settings` / `dsh-client-ui-layout` / `dsh-client-ui-sidebar` / `dsh-client-modules` / `dsh-app-boot` / `dsh-package-manifest` / `dsh-web-app` / `dsh-api-remotes` / `dsh-llm-pi-ai`）与 `dsh-desktop 0.2.1-rc.3` 的 `app.asar` 逐文件比对：104 个文件字节相同，差异只有 `package.json` 版本号、两个客户端 bundle 的 CSS 类名哈希/构建路径、以及 `dsh-client-modules` 里的提交号常量。② **真机冷启动**：用 rc.5 在独立 `DSH_HOME` 起 `dsh web --port 0 --no-open`，审计依次写 `apply-entered mode=digest … schema=schemastery`、`tool-registered name=describe_image`、`vision-oracle-registered ns=image-router`、`mounted …`；页面 boot manifest 里 `dsh-image-router` 的 `inject` 仍是那三条（`dsh-api-remotes` / `dsh-client-ui-layout` / `dsh-client-ui-sidebar`）。③ **桌面安装包本体**：把 `deepseek-harness-0.2.1-rc.5-win-x64.exe`（sha512 校验通过）里的 `app-64.7z` 解出来，用其中的 `resources/runtime/cli/bin/dsh.cmd`（`runtime.json` → `desktopVersion: 0.2.1-rc.5`）重复上述冷启动，再用 Edge 打开：侧栏行「图片路由」（含内联 SVG 图标）与它的独立配置页都正常渲染；把 `instruction` 留空点「保存」，profile 里**没有** `instruction` 键（走的是 `unset`），控制台无报错。 |
| **手动安装按目标（desktop / web）** | ✅ 用 `dsh-desktop 0.2.1-rc.3` **自带**的 CLI 真机取证：`…\resources\runtime\cli\bin\dsh.cmd --version` → `0.2.1-rc.3`（PATH 上的是 `0.1.5-rc.1`，两者不同），`plugin --profile desktop list` 读出真实 profile `C:\Users\…\.dsh\profiles\desktop` 与 `dsh-image-router@file:…`；安装器在一个**全新临时 `DSH_HOME`** 上真装了一次 web profile：profile 被初始化、`dependencies` 写入 `file:` 规格、`dsh.profile.bundles` 自动补上 `dsh-image-router`，退出码 0（同时实测出两个必须修的坑：`.cmd` 直接 `spawnSync` 是 `EINVAL`、`--home` 必须转成子进程的 `DSH_HOME`） |
| **0.2.x 客户端契约（无 `settingsScope`）** | ✅ 真机（离线运行时）验证：把 `dsh-desktop 0.2.0-rc.2` 内嵌的运行时从 `app.asar` 解出、以独立 `DSH_HOME` 起 `dsh-web`，插件在 0.2.0 上完成挂载（审计见下），boot manifest 里列出 `dsh-image-router` 客户端条目；渲染器那一侧（卡片外观）仍需在 GUI 里看一眼 |
| **0.2.1 设置节命名空间（0.6.2 修复）** | ✅ 于 `dsh-desktop 0.2.1-rc.3` 运行时取证：`Config.listConfigs` 把本插件列为 `{"id":"include:image-router","patchId":"image-router"}`，`dsh-settings` 的 `describe()` 以 `entry.options.id` 为 `ns`，宿主日志同时反复记 `settings-unsupported register=undefined`（0.2.x 没有 `settings.register`）。因此旧版把 `ns` 写死成 `image-router` 时，桌面端永远匹配不到设置节。0.6.2 改为解析 + 缓存到 Remote 表上（读到的 id 同时用于写回），并优先使用宿主递来的 `form`；两条路径各有单测（`include:` 前缀解析 + 写回、`form` 优先且不经 `remote.settings.mutate`） |
| **空 `instruction` 不再自我禁用（0.6.2 修复）** | ✅ 两条路径都有单测：宿主 `normalizeConfig` 把 `instruction: ""` / 纯空白当作「未设置」并回落内置指令（`apply` 照常注册 `describe_image`，无 warn）；卡片保存时对空白指令发 `unset(['instruction'])` 而不是 `set` 空串（Remote 路径与宿主 `form` 路径各一条）。现场证据来自用户机器的 `cordis.patch.yml`：`instruction: ""` 被写进条目配置后，`apply` 直接 `apply-disabled problems=instruction must be a non-empty string`，插件因此永远不生效 |
| **0.2.1 侧栏入口契约** | ✅ 对 npm 发布的 `0.2.1-rc.3` 包取证：`dsh-client-ui-layout` 的 `main` 是根作用域 keyed 槽、按 `entryKey`（当前面板 id）分发；`dsh-client-ui-sidebar` 渲染 `sidebar.panellist` list 行并解析 `id`/`order`/`label`，点击时 `ctx.layout.selectPanel(id)`；官方 `plugin-manager` 即以此形态注册侧栏行 + 主面板。0.2.1 真机槽位查询：`sidebar.panellist` 占用者含 `{"registrant":"image-router","id":"image-router","order":40,"active":true}`、`plugins.bundle.config` 含 `{"key":"dsh-image-router","active":true}`、`main` 的 key 域含 `image-router` —— 注册与激活都成立，唯一断掉的是设置节查找。本插件的单测断言：五个槽位各注册一次、行与页共用 `image-router`、行标签跟随 `document.lang`、图标为内联 SVG、面板视图渲染同一张表单且不再画卡片标题 |
| **侧栏入口真机渲染（0.1.5 线）** | ✅ 独立 `DSH_HOME` + `dsh --profile verify` + 本机 Edge（Playwright 驱动）真机渲染：侧栏出现「图片路由」行（含内联 SVG 图标），点击后中间栏切换到配置页（`<h1>图片路由</h1>`、`保存`/`还原`、视觉来源表单）；页面内 `window.__imageRouter.registered = ["main","sidebar.panellist","settings.plugin.item"]`、`ledger = { main: 1, "sidebar.panellist": 1 }`、`slotHasMine: true`，无 console / page 错误。这次渲染还抓到一个单测看不见的缺陷：按钮 `color: inherit` 让「保存」在黑底上不可见 —— 已改为 `label-primary-foreground` 并补了断言 |
| **0.2.x 宿主半边激活** | ✅ 真实 0.2.0 运行时冷启动审计：`apply-entered … schema=schemastery`、`tool-registered name=describe_image`、`settings-unsupported register=undefined`、`vision-oracle-registered ns=image-router`、`endpoint-services settings=yes credentials=yes`、`mounted mode=digest …` |
| **0.2.x 的 `volatile` 实时取值器** | ✅ 实测：0.2.0 侧 `Config({mode:'digest'}).mode` 是 `{ get(), [Symbol(cosmokit.volatile.write)] }`，`.get()` 得值；0.1.5 侧（schemastery 3.18.2）同一标记对解析无影响 —— 第一版实现漏了解包，正是靠这次冷启动（审计文件为空 = 配置在校验阶段就被拒）才发现的 |
| **0.2.x 可写字段的标记** | ✅ 在 0.2.0 的 schemastery（3.18.4）与 0.1.5 的（3.18.2）上分别读 `Config.dict`：11 个顶层字段带 `meta.volatile`、`vision.endpoint.apiKey` 带 `meta.role='secret'`、父子不同时标记。写路径本身（`remote.settings.mutate` 的 volatile 校验）只有单测与 0.2.0 服务源码两处证据，**尚未在 GUI 里点过保存** |
| 0.1.x↔0.2.x 跨代：`settings` 服务没有 `register` | ✅ 单测：只记 `settings-unsupported`，条目照常激活、路由照常工作 |
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

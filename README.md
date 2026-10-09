# QQ Bot Fleet · 多机器人群聊机队

一个支持本地与云端部署的 QQ 多机器人项目：统一管理 bot1～6 的运行、AI 路由和共享能力，在保留独立账号、会话与人格的同时，提供群聊协调、互动玩法、语音及翻唱。

**本仓库为脱敏源码版，不是免配置整合包。** 不包含作者的 QQ 登录状态、密钥、群号、聊天记录、私人人格、训练录音、音色权重或歌曲。首次使用需配置自己的账号和 AI，并创建自己的人格；语音和翻唱需另行准备模型与环境。所有机器人及共享服务默认关闭。

[首次配置](deployment/FIRST-RUN.md) · [部署与迁移](deployment/README.md) · [更新记录](deployment/CHANGES.md) · [安全说明](SECURITY.md) · [第三方声明](THIRD-PARTY-NOTICES.md)

## 功能与边界

| 功能 | 当前提供的能力 |
| --- | --- |
| 统一控制 | 网页管理 bot1～6 启停、AI 提供方、部署配置与共享服务；只管理此入口启动的进程 |
| 独立机器人 | bot1/2 走 QQ 官方机器人接口；bot3～6 走 OneBot/NapCat，各账号独立登录、会话和工作目录 |
| 多 AI 接入 | 每个 bot 可选择提供方与模型，使用自己的 `base_url` 和 `api_key` |
| 共享人格 | 用户自己的角色卡存入共享库，各 bot 可分别选择，也可共享同一人格 |
| 群聊协调 | 唤醒者与监听群名单、必须 @ 的群、发言协调及共享群记忆模块 |
| 互动玩法 | bot2 作为玩法控制入口，包含圆桌、猜角色、次元场景及多种存档互动玩法 |
| 聊天语音 | 共享 GPT-SoVITS 服务、自己的音频预处理/训练及音色分配，支持文字、智能语音、语音优先模式 |
| 翻唱 | 自备 RVC/Applio 模型，导入主唱或完整歌曲；完整歌曲可先分离人声与伴奏，再转换并混音 |
| 性能机制 | 共享推理队列、翻唱缓存与相同计算任务复用；首次加载模型和首次生成仍可能耗时 |

桥接代码与 DSH agent 引擎保留，不将工具型机器人简化成一次性聊天请求。具体工具能否成功执行取决于模型能力、权限与部署环境；不要因为接入成功就默认具备电脑控制、文件产出或视觉能力。

## 环境要求

- Node.js **>= 22.13.0** 和 npm。
- bot1/2：自己的 QQ 官方机器人应用凭据，以及该通道的 OpenID。
- bot3～6：自行安装/部署 NapCat，使用自己的 QQ 扫码并配置 OneBot 正向 WebSocket、HTTP 和访问令牌。
- 云端：目标服务器的 Docker 与 Docker Compose。
- 语音/翻唱：另行安装 GPT-SoVITS、Applio/RVC、Python、FFmpeg 和相关模型；训练及 GPU 推理不包含在默认聊天镜像中。

## 本地快速开始

下载或克隆本仓库，进入项目目录。以下命令在 Windows PowerShell 或 Linux shell 中分别执行：

```sh
git clone https://github.com/GooChen55/qq-bot.git
cd qq-bot
npm ci
npm ci --prefix bot3
npm ci --prefix bot4
npm ci --prefix bot5
npm ci --prefix bot6
node deployment/cli.mjs init --mode local
```

初始化不会登录账号或启动机器人，也不会覆盖已有部署配置。生成：

| 路径 | 用途 | 是否提交 |
| --- | --- | --- |
| `deployment/config.json` | bot 开关、AI 路由、账号、管理员、监听群和人格选择 | 否 |
| `deployment/.env` | AI 密钥、官方凭据、OneBot 令牌与推理环境配置 | 否 |
| `data/` | 私有人格、会话、记忆、登录卷、训练数据、音色、歌曲与缓存 | 否 |

### 1. 配置 AI 与自己的账号

编辑 `deployment/config.json`：

- 在 `providers.main` 填写 API 根地址、模型名称与协议。
- 只将需要的 bot 的 `enabled` 改为 `true`。
- bot1/2 的 `admin_ids`、`group_ids` 使用官方通道 OpenID，不是数字 QQ/群号。
- bot3～6 填自己的 `qq`、OneBot 地址；`admin_ids` 为可唤醒的 QQ 号，`group_ids` 为监听群号。
- bot3～6 默认只允许管理员唤醒；设 `group_any: true` 可允许监听群中的任何群友唤醒。
- `mention_required_groups` 是“必须 @ 才唤醒”的群，缺省等于监听群列表；设为空数组可取消这层强制 @ 限制，但并不代表每条消息都会得到回复。不在该列表的允许群中，合法 @ 仍可唤醒。

在 `deployment/.env` 填入对应秘密，例如 `AI_API_KEY`、`BOT4_ONEBOT_TOKEN`；官方机器人使用 `BOT1_APP_ID`/`BOT1_APP_SECRET` 等。不要把真实密钥写进 README 或提交到 GitHub。

新手建议先启用一个机器人，例如 bot4；验证收发正常后，再启用其他机器人、玩法或语音。

### 2. 启动与控制面板

```sh
node deployment/cli.mjs doctor
node deployment/cli.mjs start
```

打开 [本地控制面板](http://127.0.0.1:9990)，将自己的 `data/deployment-token` 文件内容输入令牌框。也可双击 `deployment/local/start.cmd`。

只打开面板、不自动启动已启用的机器人：

```sh
node deployment/cli.mjs start --panel-only
```

面板支持 AI 配置、各 bot 启停/重启、共享服务启停、创建私有人格。保存配置后，重启受影响的机器人。不要同时运行同一账号的旧实例与新实例；新面板不会接管其他入口启动的进程，也不会自动添加 Windows 开机自启。

## 接入不同 AI

`providers` 可以定义多个提供方；`bots.<id>.provider` 选择提供方，`bots.<id>.model` 可单独覆盖模型。下面仅是配置片段，需合并进初始化生成的完整配置：

```json
{
  "providers": {
    "main": {
      "base_url": "https://your-provider.example/v1",
      "api_key_env": "AI_API_KEY",
      "api": "openai-completions",
      "model": "your-model",
      "context_window": 64000,
      "max_tokens": 4096,
      "reasoning": "off"
    },
    "second": {
      "base_url": "https://another-provider.example/v1",
      "api_key_env": "SECOND_AI_API_KEY",
      "api": "openai-completions",
      "model": "another-model"
    }
  }
}
```

`.env` 中配置各自的密钥。支持 `openai-completions`、`openai-responses`、`anthropic-messages`；不兼容的原生接口需适配或网关，不能保证任意网站只填 URL/key 就能用。

- `base_url` 是供应商规定的 API 根地址，不要填写到 `/chat/completions`。
- `context_window`、`max_tokens` 和推理等级需按实际模型能力设置。
- 工具/玩法需要合适的模型能力；识图需视觉模型并配置 `input: ["text", "image"]`。
- 面板不回显已保存的 API key；推荐使用环境变量。
- 重启后旧会话可能仍绑定原模型，必要时创建新会话，不必删除聊天历史。

```sh
node deployment/cli.mjs check-ai --provider main
```

此命令会发送极短请求，可能产生少量 API 费用；仅验证连接及响应格式，不代表工具/视觉功能已经验收。

## 人格、语音与翻唱

### 创建自己的人格

在面板“创建自己的私有人格”填写角色设定并分配 bot，或导入自己的文本：

```sh
node deployment/cli.mjs persona --id my_persona --name "我的角色" --file /path/to/persona.txt --bots bot3,bot4
```

Windows 改用自己的绝对路径。首次只有中性群友模板，不含作者角色卡。替换已有 ID 必须显式使用 `--overwrite`，重启目标 bot 后生效。

### 用自己的录音训练聊天音色

配置 GPT-SoVITS/Python/FFmpeg 环境并启用 `services.voice` 后，使用单一说话人的授权素材：

```sh
node deployment/cli.mjs voice-create --id my_voice --name "我的音色" --speaker speaker --language ja --audio /path/to/audio.mp3
node deployment/cli.mjs voice-prepare --id my_voice
node deployment/cli.mjs voice-projects
# 预处理完成后，听音频并人工审核返回路径中的 review.csv。
node deployment/cli.mjs voice-train --id my_voice --reviewed
# 训练完成后，查询实际发布的音色 ID，再分配给 bot。
node deployment/cli.mjs voice-profiles
node deployment/cli.mjs voice-assign --bot bot6 --profile my_voice --reply-mode smart
```

`--profile` 必须使用服务实际返回的 ID，示例名称不保证与训练输出一致。日语录音必须配日文逐字标注，中文译文不能代替；没有日文文本可先自动识别再审核。

自动回复模式：`text`（文字，仍可按需语音）、`smart`（智能语音）、`always`（语音优先，失败回退文字）。重启目标 bot 后生效。完整训练流程与环境变量见 [首次使用指南](deployment/FIRST-RUN.md)。

### 翻唱

聊天音色与翻唱模型不同：GPT-SoVITS 权重不能直接当作 RVC 模型。

配置自己的 Applio/RVC 环境，启用 `services.cover`，在共享翻唱面板登记授权模型的 `.pth`、可选 `.index`、来源及模型 ID，为各 bot 选择模型，再导入自己的完整歌曲或主唱。面板在本机 9882，令牌位于 `data/shared/cover-data/control-token`。

示例命令（使用实际 QQ @，歌曲 ID 来自导入后的歌曲库）：

```text
@bot6 /点歌 列表
@bot6 /翻唱 歌曲ID
@bot6 /翻唱 完整语音 歌曲ID
@bot6 /翻唱 状态
```

默认发送短语音试听与完整 MP3；完整语音能否发送取决于 QQ/NapCat 的实际限制。完整歌曲首次需要分离人声、模型推理及混音，缓存命中会减少计算；纯歌词或只有伴奏不能单独产生翻唱。

## 群聊玩法

配置 bot2 官方账号、管理员及群 OpenID，开启 `services.activities`。控制命令必须在群中明确 @bot2，开始/结束等操作需管理员权限，避免一条斜杠指令同时唤醒所有 bot。

```text
@bot2 /玩法 帮助
@bot2 /玩法 开启 猜角色 动漫角色
@bot2 /玩法 状态
@bot2 /玩法 结束
@bot2 /辩论 开始 AI 是否适合当群管理员
```

圆桌等跨账号协作还需配置官方群 OpenID 到数字群号的映射、阵容及参与机器人；首次不包含作者的映射与名单，不是开启 bot2 就自动完成群绑定。所需机器人和服务应使用同一部署数据卷。

## 云端部署

目标服务器先安装 Node.js 与 Docker/Compose。进入项目目录：

```sh
npm ci
node deployment/cli.mjs init --mode cloud
# 编辑 deployment/config.json 和 deployment/.env，启用自己的账号，例如 bot4。
docker compose --env-file deployment/.env -f deployment/cloud/compose.yml --profile bot4 up -d --build
```

仅运行官方 bot1/2 时不需要 NapCat profile；运行多个桥接账号可重复添加 `--profile bot3`、`--profile bot4` 等。

云端配置使用 `ws://napcat-bot4:3001`、`http://napcat-bot4:3000` 等容器地址。在相应 NapCat WebUI 中启用正向 WebSocket 3001、HTTP 3000，监听 0.0.0.0，令牌与项目配置一致，再使用自己的 QQ 扫码。各账号独立登录卷，应用共享 `/data`；容器中的 localhost 不是其他容器。

管理端口默认仅绑定宿主机回环地址。可使用 SSH 隧道：

```sh
ssh -L 9990:127.0.0.1:9990 -L 6094:127.0.0.1:6094 user@server
```

| 服务 | 宿主机访问端口 |
| --- | --- |
| 部署面板 | 9990 |
| NapCat bot3 / bot4 / bot5 / bot6 | 6093 / 6094 / 6095 / 6096 |

Compose 使用持久化数据目录；`restart: unless-stopped` 是容器重启策略，不是添加 Windows 开机启动任务。正式部署应在 `.env` 中将 `NAPCAT_IMAGE` 固定到自己验证过的版本/tag/digest。

聊天镜像不含 GPU 训练/推理环境。远程语音或翻唱需配置 `VOICE_SERVICE_URL`/`COVER_SERVICE_URL` 等，并处理访问鉴权、路径及共享文件卷；远程结果不会因填 URL 自动出现在 NapCat 本地。详见 [部署说明](deployment/README.md)。

## 目录结构

```text
deployment/         CLI、配置示例、网页管理、Windows 入口与 Docker Compose
bot3/ ... bot6/     桥接与工具代码；暂保留差异，避免功能丢失
shared/             群聊协调、玩法、语音、翻唱等共享模块
debate/             圆桌与玩法编排
data/               运行时私有数据，首次初始化后生成，不提交
```

## 测试、发布与隐私

```sh
npm run test:deploy
npm run test:runtime
npm run test:panel
npm run test:official
npm run test:privacy
node deployment/cli.mjs export
```

测试涵盖配置、面板鉴权、真实 DSH 自定义提供方、桥接模拟收发、官方 SDK 适配及脱敏。模型与 OneBot 测试使用隔离模拟服务，不调用收费 AI，不向真实 QQ 发消息。GitHub Actions 配置了 Linux 回归检查。

再发布时只使用导出的 `dist/github-source-...`，不要上传带有旧账号数据的工作目录。导出依据 `deployment/public-files.json` 逐文件白名单，扫描明显密钥、硬编码账号/音色和本机已知私人标识，并生成 SHA256 清单。新增文件必须审核后加入白名单；扫描不能证明未知格式的隐私绝对不存在。

已验证：Windows 回归与发布校验、Compose 静态配置检查。尚需实际环境验收：云端容器启动、真实 QQ 登录、GPU 训练/推理、模型效果，以及不同供应商的工具与视觉能力。同机共享 JSON 不等于跨机器自动同步，混合本地/云端部署需另行设计中心服务。

### 常见问题

- **面板无法连接：** 先运行 `start`，确认端口未冲突，使用自己数据目录里的访问令牌。
- **bot 没有回复：** 检查启用状态、自己的 QQ/官方凭据、OneBot 连接、唤醒者/允许群名单、是否正确 @；查看 `data/logs/`。
- **语音不可用：** 源码不带权重，需自己的推理环境、训练或导入音色并正确分配。
- **翻唱慢：** 首次分离与加载模型需要计算；先做短试听/预生成，后续相同素材及参数可复用缓存。
- **人格似乎没变：** 保存自己的角色卡并分配 bot，重启该 bot；必要时另开会话，检查是否仍在运行旧实例。
- **只有中文译文：** 不直接拿来标注日语录音；先 ASR 生成日文，再人工审核。

## 授权与使用责任

本项目集成 DSH、QQ 官方插件、SnowLuma、NapCat、GPT-SoVITS、Applio 等组件，各组件有自己的许可证与使用条款；详见 [第三方声明](THIRD-PARTY-NOTICES.md)。当前未为全部既有代码擅自添加统一 MIT 等许可证，请先核实来源与再分发权限。

请仅使用自己有权使用的账号、角色素材、声音和歌曲。不要把管理令牌、未鉴权推理服务或私人数据暴露到公网，也不要让普通群友获得电脑执行权限。

主要许可已做初步核对：DSH、QQ 官方插件、GPT-SoVITS、Applio、audio-separator 为 MIT；NapCat 与 SnowLuma 为受限非商业许可，修改版公开发布、商用及部分衍生使用需要进一步核实或书面授权。当前仓库为私有，仅上传桥接项目源码与依赖声明，不携带这些组件的安装包或修改后的依赖。私有仓库不等于自动获得第三方授权，也不改变素材权利。具体版本、来源和待核实项见第三方声明。

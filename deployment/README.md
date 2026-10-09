# 统一部署指南

这是现有项目的新部署层，不会移动或删除旧账号、人格、权重和聊天记录。原 Windows 控制台继续可用；通过新入口启动的实例使用独立 data。先迁移一台验证，不能同时运行同账号的两份实例。

入口与配置示例见 [源码 README](../PUBLIC-README.md)。

新使用者请按 [首次使用指南](FIRST-RUN.md) 重新配置自己的账号、人格和音色。发布包不包含作者资料；下面的“迁移”仅用于你自己的私有部署，不能将私人备份加入 GitHub。

## 实例隔离

- 源码只读复用；配置放 deployment/config.json/.env；生成后的账号、会话、人格、权重放 data。
- 本地/云端使用同一 CLI 与配置 schema；区别主要是 OneBot 地址、数据挂载及进程启动方式。
- bot1/2 官方通道需要 AppID/AppSecret/OpenID；bot3～6 的账号、会话、DSH_HOME 独立。
- 默认配置所有 bot 停用、语音/翻唱/玩法服务停用，不会误登录或群发。
- 每个 bot 可以选择 provider 和 model；模型路由由 DSH pi-ai 插件生成，保留 agent 引擎，不把它替换成单次聊天请求。
- 配置改变后重启目标 bot。重启保留记忆；不同模型已有会话的显式模型选择可能需要创建新会话。
- 新实例以部署配置中的 admin_ids、group_ids、mention_required_groups 和 persona 为准：prepare/启动会更新派生的名单与人格分配，不修改历史、音色或人格正文。不要同时用旧面板编辑新实例的派生名单。
- bot1/2 安装固定版本官方 SDK 并应用幂等适配补丁，接入共享唤醒名单、自动语音、翻唱；bot2 继续作为玩法唯一入口。补丁结构不匹配时拒绝启动，不猜测修改第三方代码。

## 迁移现有本机数据

先停止待迁移 bot，再做离线备份。旧 data 包含敏感数据，不能加入 GitHub 源码包。

将该 bot 的 state、home/dsh-home、workspace、roles 复制到新 data 对应子目录（不要复制 node_modules）；共享人格库、群记忆、名单及语音/翻唱数据分别复制到 data/persona、data/runtime、data/shared，表情库复制到 data/shared/stickers。清理复制的进程锁只针对已确认停止的实例。当前版本 prepare 会生成配置、模型 overlay 与默认预设，所以先把要保留的人格正文放到 data/persona/library/<id>.txt，在配置指定 persona，再生成预设。不要先启动空实例后直接覆写整个 data。老的 Windows 路径、Python 虚拟环境、node_modules、QQ 登录状态不能直接当作 Linux 环境使用，应重装依赖并重新扫码。

目前不是“一键跨机器同步全部数据”：部分机器人在本机、部分在云端时，共享 JSON 文件不会自动保持一致。推荐整套协调服务与参与玩法的机器人处于同一部署卷；跨机器共享需要中心服务进一步适配，不要用双向文件同步制造竞争。

## 语音与翻唱

默认聊天容器不包含 GPU 运行环境、训练权重或音源。语音/翻唱保留原模块且支持平台与地址配置，需另行准备环境：

- 本机 Windows 默认沿用项目里的 GPT-SoVITS/Applio 路径；Linux 配置 VOICE_PYTHON、GPT_SOVITS_DIR、COVER_PYTHON、COVER_RUNTIME_DIR、COVER_FFMPEG、COVER_FFPROBE。
- 每个音色/翻唱模型 JSON 内的权重、参考音频、索引路径必须改成当前主机可访问的路径。歌曲与缓存也有原主机路径，不会仅复制 metadata 就自动迁好。
- 本地服务：services.voice/cover 开启后由新 supervisor 启动，必须先关闭旧同端口服务。
- 远程服务：设置 VOICE_SERVICE_URL、COVER_SERVICE_URL、COVER_API_KEY。服务须处于私有网络，不能直接把无鉴权 GPT-SoVITS 接口暴露公网。
- NapCat 发完整翻唱文件需要本地路径；同机/同卷可直接发。远程推理结果需下载到机器人与 NapCat 同路径挂载的 outputs 后再上传。
- 声音克隆训练与效果、模型授权不随部署自动解决；GPU 镜像和 Linux 实测需在目标主机验收。

## 发布与备份

export 工具生成独立源代码目录与 SHA256 清单。配置、登录卷、人格原素材、历史、权重和音源不会导出。不要在旧工作根直接执行 git add -f。敏感数据离线加密备份，自行管理；源码仓库建议先私有，核查所有来源许可后再公开。

无论云端还是本机，保留一套有效账号实例。旧 Windows 图形面板不管理新 supervisor 的进程；新网页面板只管理自己启动的进程，不能借“停止 bot”去结束其他应用。

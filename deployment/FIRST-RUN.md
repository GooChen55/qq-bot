# 新使用者首次配置：不继承作者的私人资料

发布包只有代码和通用占位模板。账号、API 密钥、管理员/群号、人格正文、音频、训练项目、音色权重、歌曲、历史和登录状态均不随包分发。不要从作者机器复制 data，也不要导入别人的 QQ 登录卷。

## 1. 安装并配置自己的账号

按 README 安装依赖，执行 `node deployment/cli.mjs init --mode local`（服务器用 cloud）。所有 bot、语音和翻唱默认关闭。

在 deployment/config.json 中填写自己的 provider/model、QQ 号、admin_ids、group_ids；在 deployment/.env 中填写自己的 AI key、OneBot token 或官方 AppID/AppSecret。先登录自己的 NapCat 账号并设置 OneBot，再启用对应 bot。bot1/2 使用自己的官方机器人应用凭据，不是扫码个人 QQ。

管理令牌只在首次启动时生成，位于自己的 data/deployment-token。NapCat 登录卷、账号身份检查和机器人互相识别均来自自己的私有配置，没有固定 QQ 号或隐含作者管理员。

## 2. 创建自己的共享人格

默认只有中性“自然群友”模板；它不是作者人格。可以在部署面板的“创建自己的私有人格”粘贴自己的提示词、填写 ID 和分配 bot，也可通过文本文件导入：

```sh
node deployment/cli.mjs persona --id my_persona --name "我的角色" --file /path/to/my-persona.txt --bots bot3,bot4
```

Windows 使用自己的绝对路径。重复 ID 默认拒绝覆盖，需要替换时显式带 --overwrite。正文与清单仅写入 data/persona/library，部署配置记录各 bot 的 persona ID。重启对应 bot 后生成新预设，聊天历史不会因此删除。不同 bot 可选择不同人格；也可以共享同一张卡。

## 3. 使用自己的素材训练聊天音色

准备 GPT-SoVITS V3 LoRA、Whisper 和 Python/FFmpeg 环境；.env 中设置 GPT_SOVITS_DIR、VOICE_PYTHON，按平台配置 VOICE_FFMPEG。把 services.voice 设为 true 后启动共享服务。基础预训练模型需自行按上游说明获取，发布包不含模型。

使用单一说话人的授权录音。源语言必须与录音一致：日语音频选 ja，中文译文不能作为日语逐字标注；可以先 ASR 自动生成日文再人工审核。

```sh
node deployment/cli.mjs voice-create --id my_voice --name "我的音色" --speaker speaker --language ja --audio /path/to/recording1.mp3 --audio /path/to/recording2.wav
node deployment/cli.mjs voice-prepare --id my_voice
node deployment/cli.mjs voice-projects
# 等待预处理完成，听音频并审核返回路径中的 review.csv。
# included=1 纳入训练，0 排除；text 必须是实际说出的原文。
node deployment/cli.mjs voice-train --id my_voice --reviewed
# 等待训练完成并自动发布，再查询实际生成的音色 ID。
node deployment/cli.mjs voice-profiles
node deployment/cli.mjs voice-assign --bot bot6 --profile my_voice --reply-mode smart
```

--profile 必须使用 voice-profiles 实际返回的 ID；示例不保证训练输出一定叫 my_voice。text 表示自动文字回复（仍可按需语音），smart 为智能语音，always 为语音优先且失败时回退文本。重启目标 bot 后生效。原始输入、审核表、训练结果和参考音频只保存在自己的 data/shared/voice-data，不进入源码包。

Linux/GPU 环境需按上游实际验证；聊天 Docker 镜像不提供 GPU 训练环境。不要把没有鉴权的语音训练 API 暴露到公网。远程服务中的音频路径必须是服务端可访问的路径，CLI 不会上传客户端任意文件。

## 4. 使用自己的翻唱音色和歌曲

GPT-SoVITS 聊天音色不是 RVC 翻唱权重。需要在自己的 Applio/RVC 环境训练，或导入经过授权的 .pth/.index。

启用 services.cover、配置 COVER_RUNTIME_DIR/COVER_PYTHON 等并启动服务后，在受令牌保护的共享翻唱面板登记自己的模型 ID、权重绝对路径和来源；为各 bot 选择模型。面板地址为本机 9882，令牌位于 data/shared/cover-data/control-token。不要公开这个令牌。

每个模型保存在 data/shared/cover-data/models/<自选ID>/；不绑定任何动漫角色、不下载作者使用的音色，也不会自动启用。再导入自己的歌曲，确认素材与模型授权，预生成试听，通过后才勾选 QQ 发送。

## 5. 再发布与备份

只发布 `node deployment/cli.mjs export` 新生成的源代码目录。导出检查会对比本机已知账号、密钥、音色/训练/人格标识，并拒绝常见硬编码账户与语音 ID；只报告文件和规则，不输出秘密本身。检查不能证明任意未知格式的个人信息绝对不存在，公开前仍应人工审阅新增代码。

发布文件由 deployment/public-files.json 逐项列出；新增文件必须先审核再加入，未列出的文件不会自动发布。私有运行目录、符号链接和越界路径会被拒绝；白名单文件丢失也会中止导出。

自己的 .env、config.json、data 和登录卷仅用于私有备份。源码导出不负责迁移私人资料，也不会抹掉你本机的资料。共享人格/音色不会自动跨两台服务器同步。

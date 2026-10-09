# 第三方许可与发布范围

核对日期：2026-10-09。本文件是主要组件的初步清单，不是完整的传递依赖审计，也不是法律意见。上游可能改变版本或许可，实际使用与再分发必须按所用版本的许可证、随附声明和服务条款核实。

## 主要组件

| 组件 | 核对依据 | 许可/关键要求 | 本仓库分发方式 |
| --- | --- | --- | --- |
| DeepSeek Harness | npm `@deepseek-ai/dsh@0.1.5-rc.1` 声明及[上游 LICENSE](https://github.com/deepseek-ai/deepseek-harness/blob/master/LICENSE) | MIT；再分发相关代码时保留版权与许可声明 | npm 依赖，不携带 node_modules |
| QQ 官方插件 | `@tencent-connect/dsh-qqbot@0.5.0` 随附许可及[上游 LICENSE](https://github.com/tencent-connect/dsh-qqbot/blob/main/LICENSE) | MIT；QQ 平台和账号规则另行适用 | 启动时安装，项目提供适配补丁，不上传安装后的包 |
| GPT-SoVITS | [上游 LICENSE](https://github.com/RVC-Boss/GPT-SoVITS/blob/main/LICENSE) | MIT；预训练权重及语料的授权需分别核实 | 用户另行安装运行环境与模型 |
| Applio | [上游 LICENSE](https://github.com/IAHispano/Applio/blob/main/LICENSE) | MIT；不等于赋予第三方音色或歌曲使用权 | 用户另行安装运行环境与 RVC 模型 |
| audio-separator | [上游 LICENSE](https://github.com/nomadkaraoke/python-audio-separator/blob/main/LICENSE) | MIT；具体分离模型、关联库有各自许可 | 依赖声明与调用脚本，模型另行获取 |
| NapCatQQ | [上游 LICENSE](https://github.com/NapNeko/NapCatQQ/blob/main/LICENSE) | Limited Redistribution License；限制商用，对修改/再分发有额外条件，许可文本部分条款需向作者明确 | 仅提供外部运行/镜像配置，不上传 QQ 客户端、NapCat 源码或二进制 |
| SnowLuma SDK/MCP | 锁定包 `@snowluma/sdk@1.14.9`、`@snowluma/mcp@1.14.10` 均声明 `SEE LICENSE IN LICENSE`；参见[上游根许可](https://github.com/SnowLuma/SnowLuma/blob/main/LICENSE)和[SDK 包声明](https://github.com/SnowLuma/SnowLuma/blob/main/packages/sdk/package.json) | 源码可见非商业许可，非 OSI 开源许可；公开修改版、商业用途及部分基于本软件的项目需要书面授权 | 仅依赖声明与项目自己的调用/修补脚本，不上传依赖源码、修改后的包或原生组件 |

## 需要优先核实的限制

SnowLuma 上游根许可允许一定范围的非商业使用，但限制商业用途、公开修改版/衍生版，并对基于它开发或分发另一个项目另设要求。所用 SDK/MCP 的 npm 包声明指向 LICENSE，但本次安装包中未发现随附 LICENSE 文件，不能据此推定 SDK 是 MIT 或无限制可用；应向上游确认这两个具体版本的适用许可和桥接项目的授权边界。

项目安装过程会进行 SnowLuma ESM 扩展名兼容修补；私有存储自己的桥接脚本不代表可公开再分发修补后的第三方包。未经核实不要发布整合安装包、商业托管或代搭服务。

NapCat 使用自定义限制许可，不能按普通 MIT 组件处理。公开/修改/商用前，应阅读全文并就不清楚的授权范围向作者确认。

项目中维护者有权授权的原创代码与文档采用根目录 LICENSE 中的非商业使用许可，不覆盖第三方内容。**公开或私有仅是可见性设置，不会消除许可证义务或自动获得授权。** 本项目没有将全部代码统一改为 MIT，也不将“源码可见”描述为“任意自由使用”。

## 代码、模型与素材是不同的权利层

- MIT 等代码许可通常允许使用和修改，但再分发相关代码仍要保留版权与许可声明；具体以全文为准。
- 预训练权重、RVC 音色、参考音频、训练录音和数据集可能采用独立许可，不能从代码许可推导模型许可。
- 歌曲、伴奏、录音、角色素材和人物声音还涉及素材授权、相关平台条款以及所在地区的适用规则，不能因为使用 AI 工具而默认可公开或商用。
- QQ 服务、API 提供商、Docker 基础镜像、FFmpeg 构建及其他传递依赖分别遵循自身条款与许可。公开镜像或整合包时需按实际构建重新核对，而不是只查看这张表。

## 本次上传范围

只发布经过逐文件白名单及隐私检查的项目源码、测试、部署示例和文档。不包含 node_modules、第三方客户端或整合运行包、登录状态、API 密钥、账号/群名单、聊天历史、作者人格、训练录音、权重、音色、歌曲及缓存。

第三方组件通过 npm、上游镜像或用户自己的独立环境获取。将来如需纳入第三方代码，必须另行核实再分发权限，保留对应完整许可与版权声明并更新发布白名单。当前清单不构成“所有代码、模型和素材已获得公开/商用授权”的保证。

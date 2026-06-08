## 这是一个openclaw 的微信channel分析插件，旨在将微信的channel提取出来。形成一个可以给其他agent使用的插件。

插件源码地址： @wechat-bot

## 当前方案重点

本项目采用本地 fork `openclaw-weixin/` 的方案，而不是直接依赖发布包 `@tencent-weixin/openclaw-weixin`。

核心目标是：

- `wx-channel-wrapper` 依赖本地 workspace 包 `openclaw-weixin`。
- 本地 fork 需要直接修改源码，移除 `openclaw/plugin-sdk/*` 等 OpenClaw SDK 依赖。
- wrapper/demo 不应依赖 `openclaw` 包。
- `openclaw-weixin/` 在本项目中作为独立微信 channel 能力库使用，不再作为标准 OpenClaw 插件入口使用。
- wrapper 只复用本地 fork 中的底层能力：登录、账号存储、收消息、发消息、context token、sync buf 等。
- 不要重新实现微信 channel 协议；应尽量复用 `openclaw-weixin/` 已有源码，只移除 OpenClaw 运行时耦合。

验证目标：`pnpm why openclaw` 不应显示 wrapper/demo/fork 引入 `openclaw` 的依赖路径。

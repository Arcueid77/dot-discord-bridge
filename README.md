# dot-discord-bridge

[English](README.en.md)

在你与 Discord bot 的私聊里使用原来的 ChatGPT dot。这个仓库负责 Discord 收发；安装、MCP Tunnel 和多渠道管理由 [DotBridge 总仓库](https://github.com/Arcueid77/dot-bridge) 提供。


可以让 dot 把收到的图片、语音或文件直接发回原私聊，例如“把这张图发回来”。桥会按附件编号读取，不需要来回传递很长的编码文本。仍需符合本渠道的格式和大小限制；无法作为语音发送的已识别音频，可以明确选择作为文件回复。

TXT、Markdown、JSON、CSV 等文本附件会提供可读的文字摘录，支持 UTF-8 和带标记的 UTF-16；过长时明确标记为截断，原文件仍可读取。PDF／Office 文本摘录复用受保护的 Linux 处理环境；格式未被提取时保留原件。

运行主机可使用持续开机的 Linux 或 Windows 电脑，Linux 支持 systemd。macOS 尚未验证，欢迎试用并反馈。

## 使用前准备

需要 Node.js 24.15 以上、25 以下，以及一个你有权使用的 Discord bot。

1. 在 [Discord Developer Portal](https://discord.com/developers/applications) 中创建或找到应用，添加 Bot。将 bot token 存入运行主机的私有配置文件。
2. 使用安装链接把 bot 加入你自己的服务器。这个私聊用法选择 `bot` scope 即可，不需要管理员权限。打开 bot 的个人资料，进入与它的一对一私聊，先发一条文字。
3. 在 Discord 设置中开启开发者模式，复制你本人的用户 ID，以及刚才与 bot 的私聊频道 ID。不要填写服务器 ID、服务器频道 ID、bot 用户 ID 或群组私聊 ID。
4. 按下面的格式准备凭据文件，再到总仓库配置渠道、官方 MCP Tunnel 和原 dot 的消息订阅。

凭据文件内容如下，所有值都需要替换，ID 保留为字符串：

```json
{
  "botToken": "YOUR_BOT_TOKEN",
  "ownerId": "YOUR_DISCORD_USER_ID",
  "conversationId": "YOUR_BOT_DM_CHANNEL_ID"
}
```

Linux 上将私有目录设为 `0700`、文件设为 `0600`，属主为最终运行用户。Windows 按总仓库的私有文件说明配置 ACL。不要把凭据提交到 Git 或粘贴到聊天里。

启动时会核对 token 对应的 bot，并检查频道确实是 bot 与你之间的一对一私聊。仅本人私聊时只订阅 `DIRECT_MESSAGES`，按私聊权限接入。群规则会按下文选择额外 intent。设置好后，从本人私聊发送文字，dot 的回复会回到同一私聊。

运行配置可以从 [discord.env.example](docs/discord.env.example) 开始，调整路径并保存为私有的 `discord.env`。其中 `DISCORD_CREDENTIALS_FILE` 指向上面的 JSON 文件；`CALLBACK_HOSTS` 要等原 dot 的真实订阅流程给出域名后再填写。准备完成后，单独运行渠道的命令是：

```sh
node --env-file=/etc/dot-bridge/discord/discord.env scripts/run-live.js --confirm-live
```

长期运行、与其他渠道共用一个 Tunnel 时，请使用总仓库的服务管理入口。

## 当前用法与限制

- 接收文字，回复最多 20,000 字符的完整回答。超过 Discord 一条文字的 2,000 字符时，默认以完整 `answer.txt` 文件完成回复；受保护策略也可选择持久分段。
- 可读取私聊中的图片、语音和文件，也可回复图片、音频或文件；每个附件最多 5 MiB，可附带 2000 字符以内的说明。
- 图片支持 JPEG、PNG、GIF、WebP。音频作为可下载的音频附件发送，不生成 Discord 原生语音便笺的波形界面。
- 语音转写由共享 core 中已配置的本地转写程序处理。未配置时仍可取得音频文件，但不会自动获得转写文字。
- 默认只接收绑定用户的指定私聊；服务器频道与论坛线程需显式配置受保护规则。机器人、消息编辑和应用互动命令仍不进入 dot；本人管理使用文本命令。
- 断线会自动重连，并在 Discord 仍允许恢复会话时接续事件。会话失效后不会回补离线历史；需要时请重新发送消息。
- 发送结果不明确时不会自动重发。Discord 的 nonce 去重只在平台规定的短时间内有效。
- 升级前已保存的附件缺少文件引用，读取时需要在原私聊重新发送。原消息被删除、附件移除或超过大小限制时，会明确报告附件不可用。

同一个 bot 同时只运行一个消费实例。迁移时保留原存储密钥和数据库，并先停止旧实例；总仓库提供统一启停和回滚说明。

如果连接一直失败，检查 bot token、私聊频道绑定、主机到 Discord HTTPS/WSS 的出网，以及平台是否限制了会话启动。连接成功后，在原 dot 刷新现有 Tunnel 工具目录，并订阅 `discord.message.created`，限定 `conversation=owner`。只有 Discord 连接成功、原 dot 订阅有效时，新消息才会进入回答流程。订阅失败先保留脱敏错误和时间，修正原因后再尝试。

## 平台资料

- [Discord Gateway 与 intent](https://docs.discord.com/developers/events/gateway)
- [发送消息与 nonce](https://docs.discord.com/developers/resources/message#create-message)
- [DotBridge 统一安装与运行](https://github.com/Arcueid77/dot-bridge)

## 定时消息

新增主动文字和固定提醒：目标只允许已绑定的本人私聊，主动发送默认关闭。管理员批准后可设置 `DOT_BRIDGE_OUTBOUND=owner-text`；原 dot 通过发送、保存提醒、查询、修改和取消工具管理，不需要重建事件订阅。每条最多 2,000 字符，重复提醒需有结束日期。

详见[定时消息使用指南](https://github.com/Arcueid77/dot-bridge/blob/main/docs/scheduled-messages.md)。


## 处理提示、上下文与聊天内管理

在私有环境文件里设置 `DOT_BRIDGE_INTERACTION_POLICY_FILE`，指向运行用户持有的 JSON 文件。Linux 目录 `0700`、文件 `0600`；Windows 使用私有 ACL。先以本人私聊配置开始：

```json
{
  "version": 1,
  "feedback": {"enabled": true, "reaction": true, "typing": true, "streaming": true, "lease_seconds": 60},
  "context": {"max_messages": 20, "max_chars": 12000},
  "replies": {"long_text": "file"},
  "management": {"enabled": true},
  "groups": []
}
```

收到消息后可显示接收提示；原 dot 读取消息或明确开始处理后显示有时限的 typing。完成、取消、失败或到期后清理提示。`get_discord_context` 提供同一会话、话题和成员范围内的保留历史及引用。

本人私聊可使用 `/help`、`/status`、`/queue`、`/subscription`、`/cancel [编号]`。取消作用于尚未发送的桥接回复；发送中和结果不明的记录保留核对。订阅由原 dot／平台按真实有效期续订。

`get_discord_reply_status` 查询最终投递：`none` 表示尚未排队，`pending` 表示已排队，`processing` 表示最终消息正在写出，`sent` 表示平台确认。处理提示有独立的租约；开始处理后仍需提交本次最终回答。`uncertain` 保持人工核对，不自动补发。

原 dot 使用 `begin_discord_reply` 开始真实处理，用 `append_discord_reply` 提交从序号 1 起连续增长的完整累计文本，最后以 `reply_to_discord` 完成同一条消息。短回答直接完成即可。长文默认完整文件；将 `replies.long_text` 设为 `chunks` 可启用有持久确认的原生分段。

## 可配置群与话题

新群默认关闭。在同一策略的 `groups` 中加入经本人确认的群或频道规则：

```json
{
  "conversation_id": "REPLACE_WITH_VERIFIED_GROUP_OR_CHANNEL_ID",
  "enabled": true,
  "members": "all",
  "mention": true,
  "auto_reply": "off",
  "reply_in_thread": true,
  "context_scope": "sender"
}
```

`members` 可选 `owner`、`allowlist`、`all`；白名单模式填写 `allow_from`。`auto_reply` 可选 `off`、`keywords`、`all`，关键词模式填写 `keywords`。只有对应模式才填写白名单或关键词。真实 @ 与自动触发按 OR 组合。`context_scope` 默认 `sender`，也可显式设为 `group`；会话与话题始终分开。

启用前先处理在途回复，再协调原任务的唯一订阅改为 `conversation=configured`。按真实订阅流程完成切换，保留原数据库和去重状态。原 dot 的群任务按源会话处理，私聊记忆保持私密。平台权限和新增接收范围由操作者确认。

Discord 的真实 @ 模式使用服务器消息 intent；关键词／全消息模式还需要 Message Content intent，并在官方后台明确启用。论坛规则填写父频道 ID，回复保留实际线程；已配置的普通频道也可直接使用频道 ID。回复抑制额外 mentions。

配置字段的范围与私有文件要求见[统一交互说明](https://github.com/Arcueid77/dot-bridge/blob/main/docs/new-channels.md#统一交互与群聊规则)。

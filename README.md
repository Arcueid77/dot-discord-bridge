# dot-discord-bridge

在你与 Discord bot 的私聊里使用原来的 ChatGPT dot。这个仓库负责 Discord 收发；安装、MCP Tunnel 和多渠道管理由 [DotBridge 总仓库](https://github.com/Arcueid77/dot-bridge) 提供。

## 使用前准备

需要 Node.js 24.15 以上、25 以下，以及一个你有权使用的 Discord bot。

1. 在 [Discord Developer Portal](https://discord.com/developers/applications) 中找到 bot 的应用。将 bot token 存入运行主机的私有配置文件。
2. 让你的 Discord 账号能与这个 bot 私聊，先发一条文字。
3. 在 Discord 设置中开启开发者模式，复制你本人的用户 ID，以及刚才私聊的频道 ID。
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

启动时会核对 token 对应的 bot，并检查频道确实是 bot 与你之间的一对一私聊。只订阅 `DIRECT_MESSAGES`；这个用法不需要申请服务器消息内容的特权 intent。设置好后，从本人私聊发送文字，dot 的回复会回到同一私聊。

运行配置可以从 [discord.env.example](docs/discord.env.example) 开始，调整路径并保存为私有的 `discord.env`。其中 `DISCORD_CREDENTIALS_FILE` 指向上面的 JSON 文件；`CALLBACK_HOSTS` 要等原 dot 的真实订阅流程给出域名后再填写。准备完成后，单独运行渠道的命令是：

```sh
node --env-file=/etc/dot-bridge/discord/discord.env scripts/run-live.js --confirm-live
```

长期运行、与其他渠道共用一个 Tunnel 时，请使用总仓库的服务管理入口。

## 当前用法与限制

- 接收文字，回复文字，单条回复最多 2000 字符。不会将一条长回复自动拆成多条。
- 图片、文件和语音目前只传递类型、文件名等信息，不下载或识别媒体；语音不会自动转写。
- 仅接收绑定用户在指定私聊里的新消息。群聊、服务器频道、机器人消息、消息编辑和互动命令不进入 dot。
- 断线会自动重连，并在 Discord 仍允许恢复会话时接续事件。会话失效后不会回补离线历史；需要时请重新发送消息。
- 发送结果不明确时不会自动重发。Discord 的 nonce 去重只在平台规定的短时间内有效。

同一个 bot 同时只运行一个消费实例。迁移时保留原存储密钥和数据库，并先停止旧实例；总仓库提供统一启停和回滚说明。

如果连接一直失败，检查 bot token、私聊频道绑定、主机到 Discord HTTPS/WSS 的出网，以及平台是否限制了会话启动。`connected` 只表示 Discord 连接状态；dot 接到消息还需要原插件的有效订阅。

## 平台资料

- [Discord Gateway 与 intent](https://docs.discord.com/developers/events/gateway)
- [发送消息与 nonce](https://docs.discord.com/developers/resources/message#create-message)
- [DotBridge 统一安装与运行](https://github.com/Arcueid77/dot-bridge)

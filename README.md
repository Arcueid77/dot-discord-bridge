# dot-discord-bridge

在你与 Discord bot 的私聊里使用原来的 ChatGPT dot。这个仓库负责 Discord 收发；安装、MCP Tunnel 和多渠道管理由 [DotBridge 总仓库](https://github.com/Arcueid77/dot-bridge) 提供。

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

启动时会核对 token 对应的 bot，并检查频道确实是 bot 与你之间的一对一私聊。只订阅 `DIRECT_MESSAGES`；这个用法不需要申请服务器消息内容的特权 intent。设置好后，从本人私聊发送文字，dot 的回复会回到同一私聊。

运行配置可以从 [discord.env.example](docs/discord.env.example) 开始，调整路径并保存为私有的 `discord.env`。其中 `DISCORD_CREDENTIALS_FILE` 指向上面的 JSON 文件；`CALLBACK_HOSTS` 要等原 dot 的真实订阅流程给出域名后再填写。准备完成后，单独运行渠道的命令是：

```sh
node --env-file=/etc/dot-bridge/discord/discord.env scripts/run-live.js --confirm-live
```

长期运行、与其他渠道共用一个 Tunnel 时，请使用总仓库的服务管理入口。

## 当前用法与限制

- 接收文字，回复最多 20,000 字符的完整回答。超过 Discord 一条文字的 2,000 字符时，改为同一次最终回复发送一份 `answer.txt` 文件，不截断或分成多条发送。
- 可读取私聊中的图片、语音和文件，也可回复图片、音频或文件；每个附件最多 5 MiB，可附带 2000 字符以内的说明。
- 图片支持 JPEG、PNG、GIF、WebP。音频作为可下载的音频附件发送，不生成 Discord 原生语音便笺的波形界面。
- 语音转写由共享 core 中已配置的本地转写程序处理。未配置时仍可取得音频文件，但不会自动获得转写文字。
- 仅接收绑定用户在指定私聊里的新消息。群聊、服务器频道、机器人消息、消息编辑和互动命令不进入 dot。
- 断线会自动重连，并在 Discord 仍允许恢复会话时接续事件。会话失效后不会回补离线历史；需要时请重新发送消息。
- 发送结果不明确时不会自动重发。Discord 的 nonce 去重只在平台规定的短时间内有效。
- 升级前已保存的附件缺少文件引用，读取时需要在原私聊重新发送。原消息被删除、附件移除或超过大小限制时，会明确报告附件不可用。

同一个 bot 同时只运行一个消费实例。迁移时保留原存储密钥和数据库，并先停止旧实例；总仓库提供统一启停和回滚说明。

如果连接一直失败，检查 bot token、私聊频道绑定、主机到 Discord HTTPS/WSS 的出网，以及平台是否限制了会话启动。连接成功后，在原 dot 刷新现有 Tunnel 工具目录，并订阅 `discord.message.created`，限定 `conversation=owner`。只有 Discord 连接成功、原 dot 订阅有效时，新消息才会进入回答流程。订阅失败先保留脱敏错误和时间，修正原因后再尝试。

## 平台资料

- [Discord Gateway 与 intent](https://docs.discord.com/developers/events/gateway)
- [发送消息与 nonce](https://docs.discord.com/developers/resources/message#create-message)
- [DotBridge 统一安装与运行](https://github.com/Arcueid77/dot-bridge)

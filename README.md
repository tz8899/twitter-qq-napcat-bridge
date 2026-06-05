# X/Twitter → QQ NapCat 转发桥

把 X/Twitter 指定账号的新推文转发到 QQ。桥接流程是：`twapi` 抓取推文 → 本项目组装 OneBot 消息段 → NapCat 通过 QQ 发送消息。

## 功能

- 监控一个或多个 X/Twitter 账号
- 支持私聊或群聊目标
- 文字和图片合并为同一条 QQ 消息发送
- 自动修正部分 Twitter/Nitter 图片地址
- 图片先下载到本地缓存，再交给 NapCat 发送
- 使用 `state.json` 记录最新推文，避免重启后重复推送历史内容

## 运行要求

- Node.js 18 或更高版本
- 已运行的 `twapi` 服务，例如：`http://127.0.0.1:30192`
- 已运行的 NapCat / OneBot HTTP 服务，例如：`http://127.0.0.1:3002`
- NapCat 容器或进程需要能访问图片缓存目录

## 安装

```bash
git clone https://github.com/YOUR_NAME/twitter-qq-napcat-bridge.git
cd twitter-qq-napcat-bridge
cp config.example.json config.json
```

本项目只使用 Node.js 内置模块，不需要安装第三方依赖。

## 配置

编辑 `config.json`：

```json
{
  "twapiUrl": "http://127.0.0.1:30192",
  "napcatApiUrl": "http://127.0.0.1:3002",
  "napcatToken": "YOUR_NAPCAT_ONEBOT_TOKEN",
  "intervalSeconds": 30,
  "fetchCount": 5,
  "imageCacheHostPath": "/path/on/host/napcat/cache",
  "imageCacheContainerPath": "/path/in/napcat/container/cache",
  "monitors": [
    {
      "username": "example_account",
      "targetType": "private",
      "targetId": "YOUR_QQ_USER_ID"
    },
    {
      "username": "another_example_account",
      "targetType": "group",
      "targetId": "YOUR_QQ_GROUP_ID"
    }
  ]
}
```

字段说明：

| 字段 | 说明 |
| --- | --- |
| `twapiUrl` | `twapi` 服务地址 |
| `napcatApiUrl` | NapCat / OneBot HTTP API 地址 |
| `napcatToken` | NapCat OneBot 访问令牌 |
| `intervalSeconds` | 轮询间隔，单位秒 |
| `fetchCount` | 每次从 `twapi` 拉取的推文数量 |
| `imageCacheHostPath` | 桥接程序写入图片的宿主机目录 |
| `imageCacheContainerPath` | NapCat 进程读取同一批图片时看到的目录 |
| `monitors[].username` | 要监控的 X/Twitter 用户名，不带 `@` |
| `monitors[].targetType` | `private` 表示私聊，`group` 表示群聊 |
| `monitors[].targetId` | QQ 用户 ID 或群号 |

如果桥接程序和 NapCat 在同一个文件系统内运行，可以把 `imageCacheContainerPath` 配成和 `imageCacheHostPath` 一样。

如果 NapCat 在 Docker 里运行，需要确保：

- `imageCacheHostPath` 是宿主机上的真实目录
- `imageCacheContainerPath` 是该目录映射到容器内后的路径
- NapCat 能从 `imageCacheContainerPath` 读取文件

## 启动

前台运行：

```bash
node bridge.js
```

后台运行：

```bash
nohup node bridge.js >> bridge.log 2>&1 &
```

## 检查运行状态

查看桥接进程：

```bash
pgrep -af "bridge.js"
```

查看桥接日志：

```bash
tail -f bridge.log
```

查看 NapCat 日志：

```bash
docker logs --tail 100 <napcat_container_name>
```

## 数据流

```text
X/Twitter account
  ↓
twapi
  ↓
bridge.js
  ├─ 读取新推文
  ├─ 下载图片到缓存目录
  ├─ 组装 OneBot 消息段
  └─ 更新 state.json 去重
  ↓
NapCat OneBot HTTP API
  ↓
QQ 私聊 / QQ 群
```

## 隐私和安全

不要提交以下文件或目录：

- `config.json`：包含 NapCat token、QQ ID、监控账号等真实运行配置
- `state.json`：包含运行状态和真实推文 ID
- `bridge.log` / `*.log`：包含账号、消息内容、目标 ID、错误和成功记录
- `cache/`：包含下载过的图片缓存
- `.env` / `.env.*`：可能包含令牌或其他私密配置

本仓库提供的 `config.example.json` 只包含占位符。公开仓库里不应该出现真实 token、QQ 号、监控账号或运行日志。

## 常见问题

### 重启后会不会重复发送旧推文？

启动时会把当前能看到的最新推文作为基线，之后只发送更晚的新推文。运行过程中也会更新 `state.json`。

### 图片发不出去怎么办？

优先检查三件事：

1. 图片是否已经下载到 `imageCacheHostPath`
2. NapCat 是否能通过 `imageCacheContainerPath` 读到同一张图片
3. NapCat 日志里是否有 OneBot 图片发送错误

### 为什么图片要先下载到本地？

QQ/NapCat 对外链图片的兼容性不稳定。先下载到本地，再通过 OneBot 图片段发送，成功率更高，也更容易排查路径和权限问题。

## License

MIT
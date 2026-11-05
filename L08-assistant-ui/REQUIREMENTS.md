# L08 会话列表和查询结果卡

5173 继续用官网 Thread。这次只补两件事：左侧列表接到现有线程接口，`query_data` 画成结果卡。

HARNESS（`L07-streaming/public/index.html`）不动。不改 SSE 事件名和字段。不加语音、附件、点赞、排队发送、模型切换、Assistant Cloud。

## 已有接口

| 调用 | 返回 |
|---|---|
| `GET /api/threads?userId=` | `{ threads: ThreadRecord[] }`，不含 `sessionFile` |
| `GET /api/threads/:threadId/history?userId=` | `{ thread, messages: { role, text }[] }` |
| `POST /chat` | body `{ message, userId, threadId }`。`threadId` 首次出现时服务端 `openOrCreate` |

`ThreadRecord`：`threadId`、`userId`、`title`、`turns`、`createdAt`、`updatedAt`。标题由服务端用首条用户消息前 60 字写入。

历史文本已把工具收成「调用 query_data」这样的一行，并去掉系统注入的用户偏好。恢复时只回放 `user` / `assistant` 文本。刷新后不再出现当时那张结果卡。

403「这个线程属于其他用户」、404「线程不存在」按空列表或空历史处理，不把错误写进对话。

## 会话列表

用 `useRemoteThreadListRuntime`（`@assistant-ui/core` 的 `RemoteThreadListAdapter`）。`runtimeHook` 里仍是现在的 `useLocalRuntime` + `createSalesChatModel`。

| 方法 | 行为 |
|---|---|
| `list` | `GET /api/threads?userId=`。`remoteId = threadId`，`title`，`lastMessageAt = updatedAt`，`status = "regular"` |
| `initialize` | 传入 id 若以 `__LOCALID_` 开头则改用 `crypto.randomUUID()`，否则沿用。返回 `{ remoteId }`。不在这里发消息 |
| `fetch` | 在 `list` 结果里找该 id |
| `generateTitle` | `createAssistantStream`（`assistant-stream`）写入首条用户消息前 60 字。不另开改标题接口 |
| `rename` / `archive` / `delete` | `throw new Error("当前服务端不支持改标题、归档或删除")` |
| `unstable_useAdapters` | 返回 history：`load` 调 history 接口，`ExportedMessageRepository.fromArray`；`append` 空实现，持久化仍由 `/chat` 完成 |

发消息用的 `threadId`：`run` 的 `unstable_threadId` 不是 `__LOCALID_` 时用它，否则用 `onThreadIdChange` 记下的 remoteId。

切换当前用户会换一个 adapter 实例，列表按该用户重拉。越权建议仍通过 `userForPrompt` 切到王小姐。

## 查询结果卡

`defineToolkit` 里 `query_data` 为 `type: "backend"`，`render` 用结果卡。进行中显示「正在调用 query_data」。

从 `result` 文本取：

- 首行以「已拦截」或「无法查询」开头：整卡标为未执行，只显示这一行
- `查询条件：`
- `本次命中 N 行`
- `结果：`
- 有则显示 `本期：`、`基期：`、`比率：`

全文留在卡片里的折叠区。guard / audit 仍只在「轨迹」里。

## 不做

- 不给 L07 加改标题、归档、删除接口
- 不把历史里的工具调用还原成结果卡
- 不改 HARNESS 课页

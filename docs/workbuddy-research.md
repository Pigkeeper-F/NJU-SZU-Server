# WorkBuddy 云端科研讨论

每次调用会在当前腾讯授权账号下新建一个云端任务，并把本轮提交的讨论文本发给腾讯。工作台通过服务端 OAuth 访问令牌连接，登录本机 WorkBuddy 客户端不会给工作台授予云端权限。[腾讯 WorkBuddy 开放平台接口](https://open.workbuddy.cn/docs/openapi)

## 授权

在腾讯开放平台创建第三方应用并配置 OAuth 回调地址。为应用绑定 `user.task.invokable` 和 `user.task.readable`，分别用于创建讨论任务以及在沙箱准备期间查询本次任务。通过 OAuth 2.1 授权码流程取得用户同意；回调时验证 `state`，由服务端使用应用凭据换取用户的 `access_token`。将此令牌通过部署环境的秘密配置注入 `WORKBUDDY_ACCESS_TOKEN`，再启动工作台服务。令牌过期后由部署方刷新或重新授权。[腾讯认证授权与云端任务文档](https://open.workbuddy.cn/docs/openapi)

## 调用与结果

`require('./tools/workbuddy-research').composeWorkBuddy(messages, options)` 返回 `Promise<string>`。每条输入消息包含 `role` 和字符串 `content`；支持 `system`、`user`、`assistant`。可传入 `signal` 取消，`timeoutMs` 默认 120000。服务端也可显式传入 `accessToken`。测试通过 `fetchImpl` 注入模拟传输。

创建任务时仅发初始化说明。取得腾讯返回的任务地址和专用票据后，程序建立 SSE 接收连接，并使用同一连接编号提交 JSON-RPC 调用。完成协议初始化和会话加载后才发送讨论文本。只有本会话、本轮正常结束的助手正文会交回工作台。历史回放、其他会话的片段和工具消息会被剔除。[腾讯 ACP 通道文档](https://open.workbuddy.cn/docs/openapi) · [ACP 消息与结束条件](https://agentclientprotocol.com/protocol/v1/prompt-turn)

客户端声明禁用本机文件和终端能力，也不连接 MCP 工具。工具授权请求会收到取消应答。服务端报告工具调用、超时或用户取消时，工作台中止本轮并尝试通知云端取消；已创建的云端任务可能仍保留在腾讯账号下。[ACP 工具授权](https://agentclientprotocol.com/protocol/v1/tool-calls)

## 本地验证

在仓库根目录运行 `node tools/test-workbuddy-research.js`。测试使用内存中的 SSE 和 HTTP 响应，覆盖并发会话、沙箱准备、权限不足、读取文件请求、超时与取消。腾讯账号的实际可用性需使用具有上述权限的有效令牌验证。

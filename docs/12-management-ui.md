# 管理 UI 使用与验收边界

管理界面由文档服务同源提供，入口为 `/ui/`，与 A2A 和管理 API 使用同一个服务和 Bearer 身份。独立 AC-29 已通过本地浏览器验收，不属于 P0 AC-01 至 AC-26，也不代表 WeKnora 全量 UI 已复刻。最终机器状态见 [acceptance.json](../evidence/final/acceptance.json)。

## 启动与登录

`npm run dev` 和 `npm start` 的 pre-script 会构建 `web/` 到 `dist/ui/`；也可手动运行 `npm run build:ui`。开发服务默认入口为 `http://127.0.0.1:4328/ui/`。`/ui/` 缺少构建产物时会提示构建命令；A2A API 仍可单独使用。

登录时粘贴服务签发的访问令牌。前端通过 `GET /api/manage/me` 验证后，把 token 放在当前标签页的 `sessionStorage`；它不使用 cookie，也不跨站发送。退出会清除当前标签页的凭据与近期任务缓存。此界面没有账号密码、SSO 或公网部署流程；服务目前只监听 loopback。

`/api/manage/me` 返回当前主体 `{id, tenantId, scopes}` 和服务能力 `{indexing, natural, uploads}`。只有在索引服务启用时才显示检索能力；自然语言能力依据当前是否配置模型；上传能力依据后端上传接口是否存在。功能按钮只反映当前返回的能力和已读权限，实际请求仍由服务端重新认证并执行 ACL。

## 同源管理 API

管理请求必须带当前 Bearer token。同源 Origin（若请求带 Origin）必须匹配服务的 `PUBLIC_BASE_URL` origin；不启用跨域 CORS。身份、tenant 和主体 ID 均从 token 解析，body 不接收 `tenantId`。管理响应设置 `Cache-Control: no-store`，错误格式为 `{error:{code,message}}`。创建或轮换主体时的新 token 只在该次成功响应中返回，不提供再次读取接口。

| 路由 | 权限与用途 |
|---|---|
| `GET /api/manage/principals` | 当前 tenant 管理员查看主体 scope、撤销状态和创建时间，不返回 token hash |
| `POST /api/manage/principals` | 严格接受 `{id, scopes}`，创建新主体，返回 `{principal, token}`；ID 已存在时409，不隐式轮换 |
| `POST /api/manage/principals/:id/rotate` / `.../:id/revoke` | 轮换或撤销其他主体；web 禁止操作当前主体，返回409并提示用 admin CLI |
| `GET /api/manage/knowledge-bases/:id/members` | 管理员查看当前 tenant KB 的有效成员和原始成员 grants |
| `PUT /api/manage/knowledge-bases/:id/members/:principalId` / `DELETE ...` | 管理员写入或撤销成员 scope；成员 scope 仅允许 `knowledge:read/write/delete`，不能授予 `knowledge:admin` |
| `GET /api/manage/knowledge-bases/:id/permissions` | 普通主体只查看自己的有效 KB scope；管理员返回全部 KB scope |
| `POST /api/manage/tasks/:id/retry` | 对自己拥有的可重试失败保存/索引任务发起索引重试，不要求 tenant admin |

普通主体的有效 KB 权限为“主体全局 scope ∩ KB membership grants”；例如全局只读主体即使收到 KB 写入/删除 grants，UI 也只会显示读取权限。管理员成员列表展示原始 grants，以便管理员检查配置。无有效 scope 的普通主体看不到权限范围；A2A 写、读、删操作还会由后端再次验证全局和 KB 两层 ACL。

重试请求必须且只能包含 `{requestId}`。服务在同一 source task 和 requestId 下返回同一个 retry task，原 task 仍须由调用主体拥有，当前 KB 写权限仍有效，源文档版本和字节必须保持有效，原失败需标记为 retryable；同一源版本不能同时执行两个 retry。遇到提交状态未知时应复用原 requestId，不能另发一个 ID 来“试试看”。前端将待确认的 retry ID 保存在当前标签页 sessionStorage，关掉标签页会失去该标签页状态；是否能恢复已受理任务仍应先从任务中心核对。重试只针对保存后索引失败的路径，不是通用任务重跑。

`document.get` 的 A2A 请求 `input.limit` 范围是1至16,384个Unicode code point，缺省100；内容超过单页时由 `truncated` 与 `nextCursor` 继续读取。界面的规范化正文预览默认读取8192项并支持“加载更多”。编辑纯文本/Markdown时，界面会另行使用当前版本的认证原文件下载；仅当原文件是有效UTF-8且不超过256 KiB时才填入文本编辑器，不会把PDF/DOCX/HTML的规范化预览伪装成原文件。其它格式或超限文本应上传新文件替换，编辑历史版本也不会写回当前版本。

## 当前浏览器证据

Ego Lite / Chromium 使用独立临时数据库和合成文档，基址为 `http://127.0.0.1:4330`（临时测试端口）。[浏览器记录](../evidence/ui/browser.json) 的33项检查均通过，包括 token 登录、建库、上传/真实索引、原文字节下载、检索locator、只读与撤权、Markdown编辑、上传v2、删除、任务筛选、28条分页、权限成员迟到响应保护、未知提交恢复和移动端操作。375px 视口下 root 与 body 宽度均为375px，无水平溢出；菜单开关和 Dialog Escape 焦点归还也通过。验收使用两套独立临时数据库，没有污染持久开发库。

索引重试最终证据见 [retry-final.json](../evidence/ui/retry-final.json)：注入5次HTTP503后由真实 Embedding 恢复，retry task 完成、generation 为ready、semantic search命中原文v1；同一requestId重放返回同一task，原文仍只有v1，成功后再次提交新retry被拒绝。未知写入/无效202响应的恢复证据见 [malformed-response-recovery.json](../evidence/ui/malformed-response-recovery.json) 与 [uncertain-submit.json](../evidence/ui/uncertain-submit.json)：关闭编辑器再打开后仍能用原requestId和原payload恢复同一task与知识库。之前的 `retry-tasks.json` 是generation修复前的中间记录，不作为最终重试验收依据。

截图：

- [空知识库视图](../evidence/ui/desktop-empty-library.png)
- [桌面知识库视图](../evidence/ui/desktop-library.png)
- [检索引用与版本详情](../evidence/ui/search-citation.png)
- [失败索引任务与重试入口](../evidence/ui/failed-index-task.png)
- [主体与 KB 权限](../evidence/ui/access-control.png)
- [375px 导航菜单](../evidence/ui/mobile-menu.png)
- [375px 文档列表](../evidence/ui/mobile-library.png)
- [未知提交后同 requestId 恢复](../evidence/ui/uncertain-submit.json)

## 明确不在本次 UI 范围

管理界面没有实现 `document.answer`、OCR/扫描 PDF、Wiki、知识图谱、数据源同步、多节点管理、SSO、完整 RBAC 工作区或公网部署。源码和合同中的这些路线图项目不会因为 `/ui/` 可打开而被视为已验收。

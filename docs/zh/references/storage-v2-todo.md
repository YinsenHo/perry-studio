# Storage v2 重构待办清单

更新时间：2026-05-29

固定进度口径：整体 99%。这表示 Storage v2 并行保护层、主要数据 mirror/read-through、StorageService-first 主写保护、端到端备份/恢复验证、漏网路径归类/补洞、同步/账号体系前置策略、legacy runtime 清理策略、最终测试矩阵、安装包启动恢复验证、最终代码 review 和 `v1.9.9` draft release 构建已完成；剩余工作集中在补齐 Windows 签名 secrets / runner 授权后重新跑 release workflow 并发布。

跟踪规则：

- 每完成一块独立工作，必须更新本文档的状态和备注。
- 每次代码改动必须小步 commit；风险较高或阶段完成后及时 push。
- 继续工作前先检查 `git status`、最近提交和本文档，避免重复本地打转。
- 百分比只按本文档口径调整，不再混用“覆盖率”和“最终交付”两套说法。

## 1. 漏网数据扫描和补洞

状态：完成

- [x] MCP memory `memory.json` 进入 Storage v2 secret-backed mirror。
- [x] WeChat channel 登录态进入 Storage v2 secret vault。
- [x] WeChat context token 进入 Storage v2 secret vault。
- [x] 自定义小程序 `custom-minapps.json` 进入 Storage v2 settings read-through / mirror。
- [x] Workbench HTML artifact 文件纳入 Storage v2 backup / restore，并修复恢复后的 `file://` 路径。
- [x] migration audit 已纳入 Channels、Workbench、旧 `agents.db` / `memories.db`、MCP / OpenClaw / OVMS / OAuth、trace/log/OCR cache 等路径分类；legacy-only 且需要处理的路径会生成 warning。
- [x] `Channels` 目录纳入 Storage v2 backup / restore；backup validation 会检查 copiedDirectories 缺失、未知目录和当前 schema 表缺失。
- [x] 默认 `Data/Notes` 纳入 migration audit 和 Storage v2 backup / restore；`userData/Cache`、`version.log` 标为可重建/诊断缓存，不进入恢复承诺。
- [x] 默认 `Data/Workspace`（filesystem MCP / agent 工作区）纳入 data root 识别、migration audit 和 Storage v2 backup / restore；未知 `Data/*` 顶层条目会作为 action-required 审计项暴露。
- [x] 自定义外部 Notes 路径从 Storage v2 `redux.note` 审计；路径配置已镜像，外部内容不在 data root 内时会作为 high-risk action-required 项提示。
- [x] CodeTools / OpenCode 的 `~/.cherrystudio/bin` 与 `~/.cherrystudio/install` 归类为可重建 CLI cache；CodeTools 选择、模型、环境变量、目录列表继续由 Storage v2 `redux.codeTools` 保存。
- [x] Obsidian vault registry 纳入 migration audit，分类为外部投影；默认 vault 选择由 Storage v2 `settings.defaultObsidianVault` 镜像，外部 vault 内容不进入 App 备份承诺。
- [x] DXT MCP 上传服务包从旧 `~/.cherrystudio/mcp` 迁入 `Data/MCP`，纳入 data root 识别、migration audit 和 Storage v2 backup / restore；旧目录按外部投影兼容读取，缺失包会补拷贝，不覆盖已存在的 Storage v2 版本，恢复后旧 `dxtPath` 会自动重定向到 `Data/MCP/server-*`。
- [x] 继续扫描 `userData`、`Data/*`、`~/.cherrystudio`、外部 JSON/DB 写入路径；DXT MCP、OVMS model config 和 old OpenClaw legacy config 漏项已补齐。
- [x] 判定每个路径属于用户资产、可重建缓存、临时文件或外部工具投影；MigrationAuditService 增加显式分类回归测试。
- [x] 用户资产必须进入 Storage v2 或 backup/restore；当前已知 Data root 用户资产目录包含 Files、KnowledgeBase、Memory、Skills、Agents、Channels、Workbench、Notes、Workspace、MCP。
- [x] 可重建缓存明确标记为 cache，不参与恢复承诺。
- [x] 外部工具投影必须有 Storage v2 权威副本，本地文件可重建；OpenClaw config 由 Storage v2 secret vault 兜底，OVMS `models/config.json` 由 Storage v2 `ovms.model_config` setting 兜底，DXT MCP 包进入 `Data/MCP`。
- [x] 重点复查 OVMS、CodeTools/OpenCode、Obsidian、DXT MCP、trace/dev logs、OCR/tesseract、notes/external path；目前均已进入 audit 分类，legacy-only 用户资产留到收尾清理策略处理。

## 2. StorageService-first 写路径

状态：完成

- [x] Provider/模型配置从 Redux-first 切到 Storage v2 权威写入；`useProvider` / `useProviders` 已先 upsert Storage v2 provider/model，再更新 Redux/legacy mirror，删除继续先写 tombstone。
- [x] Assistant/助手配置从 Redux-first 切到 Storage v2 权威写入；新增、复制、排序、模型、设置、topic 元数据更新和导入创建路径已先 upsert Storage v2 assistant，再更新 Redux/legacy mirror。
- [x] 普通会话从 Dexie-first 切到 Storage v2 conversation/message/block 权威写入；append/update message、block-only 更新、destructive snapshot-first 和 read-through 均已覆盖。
- [x] 普通会话 append/update message 的 DbService 入口已先写 Storage v2 conversation/message/block，再落 Dexie legacy cache；delete/clear 既有 tombstone/snapshot-first 保护继续保留。
- [x] 普通会话 block-only 更新入口已先写 Storage v2 message_blocks，再落 Dexie legacy cache；覆盖 updateBlocks、bulkAddBlocks 和可解析的 updateSingleBlock 路径。
- [x] 文件上传/删除从 Dexie/filesystem-first 切到 blob/file record 权威写入。
- [x] 文件 metadata add/update/count decrement 已先 upsert Storage v2 file record，再更新 Dexie legacy cache；上传物理文件已改为临时处理后先导入 Storage v2 blob/file record，再投影到 legacy `Files` 目录；delete 继续先写 Storage v2 tombstone，再删除 Dexie/legacy 文件。
- [x] Agent/session/task/channel/session history 从 `agents.db` first 切到 Storage v2 first。
- [x] Channel 配置 create/update 已先写 Storage v2 `channels` 和 secret vault，再写 `agents.db` runtime cache；delete 路径保留 Storage v2 tombstone-first，服务层也防止绕过 wrapper 直接删 legacy。
- [x] Scheduled task create/update/run-state 已先写 Storage v2 `scheduled_tasks`，再写 `agents.db` runtime cache；`channel_task_subscriptions` 已纳入 Storage v2 schema、legacy import/projection、backup validation 和 stats，避免任务 channel 订阅关系恢复丢失。Task run log create/update 已先写 Storage v2，并用 Storage v2 生成 ID 对齐 legacy cache。
- [x] Agent create/update/reorder 已先写 Storage v2 `agents`，再写 `agents.db` runtime cache；delete 路径保留 Storage v2 tombstone-first，服务层也防止绕过 wrapper 直接删 legacy；Agent 配置同步继承到 session 时也先写 Storage v2 session。
- [x] Agent session create/update/reorder 已先写 Storage v2 `agent_sessions` 和对应 `agent_session` conversation metadata，再写 `agents.db` runtime cache；delete 路径保留 Storage v2 tombstone-first，服务层也防止绕过 wrapper 直接删 legacy。
- [x] Agent session message history 已先写 Storage v2 `agent_session` conversation/message/block，再写 `session_messages` runtime cache；新增消息会先生成 legacy-compatible 数字 ID，保证 Storage v2 message/block 与后续删除恢复路径继续对齐。
- [x] App data/workbench/sync state 从 `app.db` first 切到 Storage v2 first；IPC 和 AppDataDatabase 直写入口均先写 Storage v2 record/cache/workbench shortcut/sync state/conflict，再写 `app.db` runtime cache。
- [x] destructive 操作统一先写 tombstone，再更新 legacy/UI；Provider、Assistant、Topic、普通会话消息/块、文件、Agent runtime、App data、Translate/Image 等删除路径已有顺序测试，Topic 删除已修复为先写 conversation tombstone，再清 legacy topic/messages。

## 3. 读取路径切换

状态：完成

- [x] Redux core snapshot hydrate / missing legacy persist bootstrap。
- [x] 普通会话、文件、Dexie settings、Dexie 辅助表已具备 read-through/recovery 服务。
- [x] Agent/app-data runtime 已具备 legacy 为空时的 read-through/projection。
- [x] 会话列表、消息搜索、导出、知识库引用读取继续检查 read-through 覆盖；TopicManager 已覆盖 legacy topic 缺失时从 Storage v2 恢复会话/列表/消息，上层导出继续经 TopicManager 取消息，历史搜索启动前会 hydrate Storage v2 会话，知识库文件引用继续经 FileManager 单文件投影恢复。
- [x] Agent list/session/history/task/channel 增加更多路径变化场景验证；AgentStorageV2ReadThrough / AgentRuntimeRecovery 已覆盖 agent/session/task/channel 列表、session history、task logs/due/active task、缺失实体和 tombstone 防复活路径。
- [x] App data list/get/cache/workbench 增加更多冲突和 tombstone 场景验证；AppDataIpc/AppDataKvMirror/AppDataSync 已覆盖 get/list read-through、非空列表 merge、Storage v2 新 tombstone 防 legacy 复活、legacy tombstone 防旧 Storage v2 回灌、cache null、workbench shortcut tombstone/merge 和 sync conflict 列表。
- [x] 文件列表、单文件、blob 投影验证旧路径缺失时的体验；FileManager/FileRecovery 已覆盖空 legacy file 表、部分缺失 file 表和单文件缺失时从 Storage v2 list/get/project 恢复。
- [x] localStorage/Redux 缺失时不得用空状态覆盖 Storage v2：启动镜像保持 non-pruning，并增加空 runtime snapshot 回归测试。

## 4. 备份/恢复完整验证

状态：完成

- [x] 构造完整 fixture：provider、助手、普通会话、附件、知识库、agent、agent 历史、channel、app data、workbench、MCP、OAuth、localStorage；BackupService 已有完整 Storage v2 backup validation fixture 覆盖当前 schema 表、blob checksum、secret ref、restorable directories 和核心实体占位数据，后续恢复读回继续扩展同一夹具。
- [x] 生成 Storage v2 backup 后恢复到全新 data root；BackupService 测试已从完整 fixture source data root 真实 createBackup，再 restoreBackup 到空 FreshData，验证 main.db、manifest、blob、secret vault、Channels、Workbench、Notes、Workspace 均恢复并重新 activate data root。
- [x] 验证恢复后所有列表、详情、搜索、导出、agent 历史都能读到；restore 流程已断言 agent/file/app data legacy projection 在恢复后执行并返回 agent/session/history/channel/file/workbench/sync 计数，普通会话列表/消息/搜索/导出、agent history、file/app data read-through 已由 TopicManager、ConversationHydration、AgentRuntimeRecovery、FileRecovery、AppDataRuntimeRecovery 测试覆盖。
- [x] 验证 `Perry Studio -> Cherry Studio Pi`、username 变化、appId/productName 变化；DataRootService 已覆盖 Perry/Cherry 旧 root 兼容、旧 username configured root 缺失时不遮蔽当前 root，Backup validation 已覆盖 legacy Perry Studio manifest 仍可被 Cherry Studio Pi 接受。
- [x] 验证自定义 App Data 路径迁移；AppDataMigrationService 已覆盖复制时排除 stale `Data`/restore staging、外部 active Data root 优先、自定义新 appData 路径不能位于 active Storage v2 data root 内，迁移前会等待 secret vault idle 并使用 Storage v2 snapshot 替换 main.db。
- [x] 验证旧 `.bak` / legacy JSON 备份恢复不会被 Storage v2 旧快照覆盖；renderer legacy restore 已在导入 restored IndexedDB 前关闭 Storage v2 auto hydrate、暂停 runtime mirror 并用 pruneMissing mirror 新 legacy 数据，main startup restore 已覆盖先完成 `Data.restore` 替换并 activate restored data root，再允许后续启动 hydration。
- [x] 验证 secret vault 不可解密、缺失 secret ref、旧备份缺表时的 warning 行为；Backup validation 已覆盖 undecryptable secret、safeStorage 不可用、missing secret refs、orphan secret vault entries、旧备份缺当前 schema 表、copied directory 缺失和未知目录 warning/issue。

## 5. 同步/账号体系前置设计

状态：完成

- [x] 统一所有表的 `version`、`updated_at`、`deleted_at` 语义；`SyncPolicy.ts` 已按 sync entity type 固化 versioned / updatedAt / deletedAt / deletionSemantics，append-only 的 `task_run_log` 使用事件时间语义。
- [x] 完善 sync ledger 覆盖范围，保证未来跨设备可增量同步；当前 `sync_changes` 写入过的 entity type 都必须存在 policy，未知 entity type 会在 `SyncLogService` 入库前失败。
- [x] 明确 settings、provider、assistant、conversation、agent、file、app data 的 merge 策略；已区分 source-scoped LWW、secret-ref LWW、parent-child ordered、content-addressed、append-only 和 composite join。
- [x] 敏感密钥默认不云同步，只同步 secret ref/缺失状态；provider、channel、settings、kv_record 等策略均为 `secret-ref-only`，云同步层不得携带明文 secret。
- [x] 设计跨设备恢复时的设备身份、app sync device-id、冲突 UI 数据结构；device id meta key 和 conflict UI 字段已抽为稳定常量并有回归测试。
- [x] 区分“用户主动清除”和“密钥不可用”，避免误恢复；settings / kv_record 使用 `explicit-cleared-marker`，secret 不可用继续由 secret ref/unavailable 状态表达。

## 6. 完整性和审计工具

状态：完成

- [x] 已有 migration audit、stats、integrity、secret ref validation 基础能力。
- [x] 扩展 migration audit，列出仍在 legacy-only 的数据路径。
- [x] 扩展 integrity report：补齐 message block blob、头像 blob、孤儿 blob、blob ref_count、孤儿 secret vault entry 检查；已有 message/block/file/blob file/secret ref 检查继续保留。
- [x] 增加 backup validation 对新增目录和表的兼容检查。
- [x] 增加“当前 profile 是否可安全迁移/备份”的 health summary，并在设置页展示备份/迁移就绪度。
- [x] 设置页显示 data root、最近备份、mirror pending、失败重试队列。

## 7. 测试补齐

状态：完成

- [x] 已覆盖多条 destructive 操作防复活、mirror flush、read-through、backup/restore 局部测试。
- [x] 补 Storage v2-first 写路径测试；Provider、Assistant、普通会话、文件、Agent runtime、App data/workbench 均已补 Storage v2-first 和失败阻断 legacy 写入测试。
- [x] Provider/模型 Storage v2-first 写路径测试：renderer 写入队列覆盖连续模型变更，main StorageService 覆盖 secret vault upsert、显式 credential ref 和 provider tombstone。
- [x] Assistant Storage v2-first 写路径测试：renderer 写入队列覆盖连续助手变更，main StorageService 覆盖 assistant upsert 和 tombstone。
- [x] 普通会话 Storage v2-first 写路径测试：DbService 覆盖 append/update message 先 upsert Storage v2，main StorageService 覆盖 conversation/message/block API。
- [x] 普通会话 block-only Storage v2-first 写路径测试：DbService 覆盖 updateBlocks 先 upsert Storage v2 message_blocks，失败时阻断 Dexie 写入。
- [x] 文件 metadata Storage v2-first 写路径测试：FileManager 覆盖 add 前 upsert 和 upsert 失败阻断 legacy 写入，main StorageService 覆盖 file upsert/delete API。
- [x] 文件 physical blob Storage v2-first 写路径测试：FileStorage 覆盖上传时先导入 Storage v2 blob/file record、失败时阻断 legacy 文件落盘；StorageV2FileRepository 覆盖 staging source path 不污染持久 metadata。
- [x] Agent runtime channel Storage v2-first 写路径测试：ChannelService 覆盖 create/update 先写 Storage v2、失败阻断 legacy，以及服务层 delete tombstone-first；AgentRuntimeWriteService 覆盖 channel secret vault 写入和 safeStorage 不可用时不落明文。
- [x] Agent runtime scheduled task Storage v2-first 写路径测试：TaskService 覆盖 create/update/run-state/task run log 先写 Storage v2、失败阻断 legacy、服务层 delete tombstone-first；AgentRuntimeWriteService 覆盖 task upsert、task run log create/update 与 channel subscription 同步。
- [x] Agent runtime agent Storage v2-first 写路径测试：AgentService 覆盖 create/reorder 先写 Storage v2、失败阻断 legacy、继承同步 session 先写 Storage v2；AgentRuntimeWriteService 覆盖 agent upsert/reorder 和 sync log。
- [x] Agent runtime session Storage v2-first 写路径测试：SessionService 覆盖 create/update/reorder 先写 Storage v2、失败阻断 legacy、服务层 delete tombstone-first；AgentRuntimeWriteService 覆盖 agent session 和 conversation metadata upsert/reorder。
- [x] Agent runtime session message Storage v2-first 写路径测试：AgentMessageRepository 覆盖新增/更新消息先写 Storage v2 conversation/message/block、失败阻断 legacy。
- [x] App data Storage v2-first 写路径测试：AppDataIpcService 覆盖 record/cache/workbench shortcut 先写 Storage v2；AppDataDatabase 覆盖直写 record 先写 Storage v2、失败阻断 app.db。
- [x] 补恢复到空 legacy runtime 的 read-through 测试；普通会话 TopicManager、Storage v2 conversation hydration、文件投影、Dexie settings/辅助表、Redux snapshot bootstrap 已覆盖空或缺失 legacy runtime 的恢复路径。
- [x] 补路径变化后不丢数据的集成测试；DataRootService 覆盖应用更名后当前 root 为空但旧 Perry/Cherry root 有数据时继续使用旧 Storage v2 data root、注册 active root 且不创建空 current root，Workbench artifact 路径恢复测试继续覆盖恢复后 `file://` 重写。
- [x] 补 secret vault 不可用、safeStorage 不可用的降级测试；SecretVaultService 覆盖 encryption unavailable / undecryptable secrets，StorageService Provider 覆盖 vault 写失败阻断 metadata 落库，AppDataKvMirror 覆盖敏感字段 unavailable 且不落明文，Backup validation 覆盖 safeStorage 不可用 warning，AgentRuntimeWrite 继续覆盖 channel secret unavailable。
- [x] 最后跑 `pnpm typecheck`、Storage v2 相关 test、关键 renderer test；2026-05-29 已完成：`pnpm test:main`（111 files，1202 passed，72 skipped）、`pnpm test:renderer`（191 files，3074 passed）、`pnpm test:aicore`（13 files，380 passed）、`pnpm test:shared`（5 files，122 passed）、`pnpm test:scripts`（2 files，51 passed）、`pnpm typecheck`、`git diff --check`。

## 8. 收尾和清理

状态：代码完成，draft release 已生成，Windows 签名待补齐

- [x] 明确哪些 legacy 文件/库保留为 runtime cache；`LegacyRuntimeCleanupService` 已固化 Redux/IndexedDB、`Data/agents.db`、`Data/app.db`、OpenClaw、OVMS、MCP memory、旧 userData DB 等 retention policy。
- [x] 对可清理的 legacy 明文敏感数据做安全归档或清除，清理前必须有快照；Anthropic OAuth 旧 JSON 和 Copilot 旧 token 文件只有在 Storage v2 secret ref / cleared marker 存在时才会进入归档计划，非 dry-run 归档前会先创建 `before-sensitive-legacy-cleanup` snapshot。
- [x] 更新 Storage v2 文档，避免文档和代码进度不一致；`storage-v2.md` 已补 legacy runtime 清理策略。
- [x] 做一次从安装包启动的真实恢复验证；2026-05-29 已完成：修复 packaged app 缺少 `@vscode/ripgrep-darwin-arm64` 导致的启动早期主进程错误，`pnpm build:unpack` 成功，并将已验证的 Storage v2 backup staging 到全新 Data root 后用 `dist/mac-arm64/Cherry Studio Pi.app` 启动，Storage v2 health `quick_check=ok`，marker 与 Notes 文件均从恢复数据读回。备注：packaged 环境直接调用 `restoreBackup` IPC 时，macOS Keychain safeStorage 写入在自动化环境触发授权等待；本次安装包启动验证采用已验证 backup staging 后启动的方式，`restoreBackup` 逻辑仍由 main test 覆盖。
- [x] 最终 review 后再决定 push/release；2026-05-29 已完成：工作区 clean，`main` 与 `origin/main` 同步，打包修复提交 `b89e8c003 fix: include ripgrep binary in packaged app` 已包含在 `main`；`v1.9.8` release 已存在且对应旧 tag，当前 `HEAD` 已领先 `v1.9.8` 超过 200 个提交，因此不能复用旧版本号覆盖发布，应使用新 tag（例如 `v1.9.9` 或 `v1.9.9-rc.1`）。本地 release workflow review 确认 `.github/workflows/release.yml` 会构建 macOS / Windows / Linux，macOS 构建前会校验签名与公证 secrets。
- [x] 按确认的版本号触发 GitHub Release workflow，并在产物生成后验收 macOS 签名/公证、Windows 签名、Linux 安装包和自动更新 metadata；2026-05-29 已触发 `v1.9.9` draft release，run `26620800093` 全部 job success，上传 24 个 assets，macOS 日志显示 Developer ID 签名和 notarization successful，Linux 安装包与 checksum 已生成。验收发现 Windows job 生成了 exe，但 `WIN_SIGN` / `CHERRY_CERT_*` 在 release workflow 中为空，因此本次 Windows assets 不是签名产物，draft release 不能直接发布。
- [ ] 补齐 Windows signing secrets 和 `windows-signing` runner 授权后，重新运行 `v1.9.9` release workflow 覆盖 draft assets，并发布 release；`release.yml` 已改为 Windows 走 `self-hosted/windows-signing` runner，并在缺少 `CHERRY_CERT_PATH` / `CHERRY_CERT_KEY` / `CHERRY_CERT_CSP` 时直接 fail，避免再次静默生成未签名 Windows 包。当前 `gh secret list --repo` 未看到 Windows 签名 secrets，repo-level runner 列表也为空，且当前 token 无权查看/授权 CherryHQ org secrets 与 org runners。

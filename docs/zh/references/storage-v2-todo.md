# Storage v2 重构待办清单

更新时间：2026-05-29

固定进度口径：整体 75%。这表示 Storage v2 并行保护层、主要数据 mirror/read-through、backup/restore 骨架已经完成，剩余工作集中在 StorageService-first 主写路径、端到端恢复验证、同步冲突策略和最后一批 legacy-only 漏洞。

跟踪规则：

- 每完成一块独立工作，必须更新本文档的状态和备注。
- 每次代码改动必须小步 commit；风险较高或阶段完成后及时 push。
- 继续工作前先检查 `git status`、最近提交和本文档，避免重复本地打转。
- 百分比只按本文档口径调整，不再混用“覆盖率”和“最终交付”两套说法。

## 1. 漏网数据扫描和补洞

状态：进行中

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
- [ ] 继续扫描 `userData`、`Data/*`、`~/.cherrystudio`、外部 JSON/DB 写入路径。
- [ ] 判定每个路径属于用户资产、可重建缓存、临时文件或外部工具投影。
- [ ] 用户资产必须进入 Storage v2 或 backup/restore。
- [ ] 可重建缓存明确标记为 cache，不参与恢复承诺。
- [ ] 外部工具投影必须有 Storage v2 权威副本，本地文件可重建。
- [x] 重点复查 OVMS、CodeTools/OpenCode、Obsidian、trace/dev logs、OCR/tesseract、notes/external path；目前均已进入 audit 分类，OVMS / unknown external content 仍保留后续 authority 决策。

## 2. StorageService-first 写路径

状态：进行中

- [x] Provider/模型配置从 Redux-first 切到 Storage v2 权威写入；`useProvider` / `useProviders` 已先 upsert Storage v2 provider/model，再更新 Redux/legacy mirror，删除继续先写 tombstone。
- [x] Assistant/助手配置从 Redux-first 切到 Storage v2 权威写入；新增、复制、排序、模型、设置、topic 元数据更新和导入创建路径已先 upsert Storage v2 assistant，再更新 Redux/legacy mirror。
- [ ] 普通会话从 Dexie-first 切到 Storage v2 conversation/message/block 权威写入。
- [x] 普通会话 append/update message 的 DbService 入口已先写 Storage v2 conversation/message/block，再落 Dexie legacy cache；delete/clear 既有 tombstone/snapshot-first 保护继续保留。
- [x] 普通会话 block-only 更新入口已先写 Storage v2 message_blocks，再落 Dexie legacy cache；覆盖 updateBlocks、bulkAddBlocks 和可解析的 updateSingleBlock 路径。
- [ ] 文件上传/删除从 Dexie/filesystem-first 切到 blob/file record 权威写入。
- [x] 文件 metadata add/update/count decrement 已先 upsert Storage v2 file record，再更新 Dexie legacy cache；delete 继续先写 Storage v2 tombstone。物理文件 blob/上传复制权威化仍待后续处理。
- [ ] Agent/session/task/channel 从 `agents.db` first 切到 Storage v2 first。
- [ ] App data/workbench/sync state 从 `app.db` first 切到 Storage v2 first。
- [ ] destructive 操作统一先写 tombstone，再更新 legacy/UI。

## 3. 读取路径切换

状态：进行中

- [x] Redux core snapshot hydrate / missing legacy persist bootstrap。
- [x] 普通会话、文件、Dexie settings、Dexie 辅助表已具备 read-through/recovery 服务。
- [x] Agent/app-data runtime 已具备 legacy 为空时的 read-through/projection。
- [ ] 会话列表、消息搜索、导出、知识库引用读取继续检查 read-through 覆盖。
- [ ] Agent list/session/history/task/channel 增加更多路径变化场景验证。
- [ ] App data list/get/cache/workbench 增加更多冲突和 tombstone 场景验证。
- [ ] 文件列表、单文件、blob 投影验证旧路径缺失时的体验。
- [x] localStorage/Redux 缺失时不得用空状态覆盖 Storage v2：启动镜像保持 non-pruning，并增加空 runtime snapshot 回归测试。

## 4. 备份/恢复完整验证

状态：未完成

- [ ] 构造完整 fixture：provider、助手、普通会话、附件、知识库、agent、agent 历史、channel、app data、workbench、MCP、OAuth、localStorage。
- [ ] 生成 Storage v2 backup 后恢复到全新 data root。
- [ ] 验证恢复后所有列表、详情、搜索、导出、agent 历史都能读到。
- [ ] 验证 `Perry Studio -> Cherry Studio Pi`、username 变化、appId/productName 变化。
- [ ] 验证自定义 App Data 路径迁移。
- [ ] 验证旧 `.bak` / legacy JSON 备份恢复不会被 Storage v2 旧快照覆盖。
- [ ] 验证 secret vault 不可解密、缺失 secret ref、旧备份缺表时的 warning 行为。

## 5. 同步/账号体系前置设计

状态：未完成

- [ ] 统一所有表的 `version`、`updated_at`、`deleted_at` 语义。
- [ ] 完善 sync ledger 覆盖范围，保证未来跨设备可增量同步。
- [ ] 明确 settings、provider、assistant、conversation、agent、file、app data 的 merge 策略。
- [ ] 敏感密钥默认不云同步，只同步 secret ref/缺失状态。
- [ ] 设计跨设备恢复时的设备身份、app sync device-id、冲突 UI 数据结构。
- [ ] 区分“用户主动清除”和“密钥不可用”，避免误恢复。

## 6. 完整性和审计工具

状态：进行中

- [x] 已有 migration audit、stats、integrity、secret ref validation 基础能力。
- [x] 扩展 migration audit，列出仍在 legacy-only 的数据路径。
- [x] 扩展 integrity report：补齐 message block blob、头像 blob、孤儿 blob、blob ref_count、孤儿 secret vault entry 检查；已有 message/block/file/blob file/secret ref 检查继续保留。
- [x] 增加 backup validation 对新增目录和表的兼容检查。
- [x] 增加“当前 profile 是否可安全迁移/备份”的 health summary，并在设置页展示备份/迁移就绪度。
- [x] 设置页显示 data root、最近备份、mirror pending、失败重试队列。

## 7. 测试补齐

状态：进行中

- [x] 已覆盖多条 destructive 操作防复活、mirror flush、read-through、backup/restore 局部测试。
- [ ] 补 Storage v2-first 写路径测试。
- [x] Provider/模型 Storage v2-first 写路径测试：renderer 写入队列覆盖连续模型变更，main StorageService 覆盖 secret vault upsert、显式 credential ref 和 provider tombstone。
- [x] Assistant Storage v2-first 写路径测试：renderer 写入队列覆盖连续助手变更，main StorageService 覆盖 assistant upsert 和 tombstone。
- [x] 普通会话 Storage v2-first 写路径测试：DbService 覆盖 append/update message 先 upsert Storage v2，main StorageService 覆盖 conversation/message/block API。
- [x] 普通会话 block-only Storage v2-first 写路径测试：DbService 覆盖 updateBlocks 先 upsert Storage v2 message_blocks，失败时阻断 Dexie 写入。
- [x] 文件 metadata Storage v2-first 写路径测试：FileManager 覆盖 add 前 upsert 和 upsert 失败阻断 legacy 写入，main StorageService 覆盖 file upsert/delete API。
- [ ] 补恢复到空 legacy runtime 的 read-through 测试。
- [ ] 补路径变化后不丢数据的集成测试。
- [ ] 补 secret vault 不可用、safeStorage 不可用的降级测试。
- [ ] 最后跑 `pnpm typecheck`、Storage v2 相关 test、关键 renderer test。

## 8. 收尾和清理

状态：未完成

- [ ] 明确哪些 legacy 文件/库保留为 runtime cache。
- [ ] 对可清理的 legacy 明文敏感数据做安全归档或清除，清理前必须有快照。
- [ ] 更新 Storage v2 文档，避免文档和代码进度不一致。
- [ ] 做一次从安装包启动的真实恢复验证。
- [ ] 最终 review 后再决定 push/release。

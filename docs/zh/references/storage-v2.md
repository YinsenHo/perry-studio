# Cherry Studio Pi Storage v2 架构设计

状态：实施中
目标版本：Storage v2
适用范围：本地数据、同步迁移、账号体系、跨设备恢复、备份恢复

## 背景

Cherry Studio Pi 当前的数据分散在多个存储中：

- Redux persist / Local Storage：模型服务商配置、系统设置、助手配置等。
- Dexie / IndexedDB：普通对话、消息块、文件元信息、部分 settings。
- `Data/agents.db`：Pi agent、agent session、agent 对话历史、skills、channels、tasks。
- `Data/app.db`：app scoped records、workbench shortcuts、WebDAV sync 状态。
- `Data/Files`、`Data/KnowledgeBase`、`Data/Memory`、`Data/Skills`、`Data/Agents`：文件实体、知识库、记忆库、skill 文件、agent 工作区。
- electron-store：主进程启动前需要读取的一部分系统设置。

这套方案可以支撑当前产品，但不适合作为长期的用户唯一数据副本。用户数据只保存在本地时，任何静默丢失、路径变更、迁移失败、备份不完整、schema 升级事故都会变成严重问题。Storage v2 的目标是把这些数据提升为“本地优先、可迁移、可恢复、可同步”的用户资产。

## 设计目标

1. 结构化用户数据有且只有一个权威数据库。
2. Renderer 不再直接持久化关键数据，只把 Redux 作为运行时 UI cache。
3. 普通聊天和 Pi agent 聊天进入统一 conversation/message 模型。
4. 大文件、附件、知识库原文件和生成物进入统一 blob store。
5. API key、OAuth token、服务账号私钥等敏感数据不再明文放在 Local Storage 或普通数据库中。
6. 数据目录拥有稳定身份，不再因为产品名、appId、GitHub 仓库名或 Electron userData 默认路径变化而让用户以为数据丢失。
7. 所有核心实体为同步做好准备：稳定 ID、版本号、更新时间、设备 ID、软删除、变更日志。
8. 迁移和备份必须可回滚、可校验、可恢复。

## 非目标

- Storage v2 不要求第一阶段就实现云端账号服务。
- Storage v2 不要求把所有文件内容塞进 SQLite。
- Storage v2 不把 Redux、IndexedDB、electron-store 立刻删除；它们会先降级为 cache 或 legacy source。
- Storage v2 不在没有用户授权的情况下跨设备同步敏感密钥。

## 总体架构

```text
Renderer
  React / Redux runtime cache
        |
        | typed IPC / API
        v
Main Process
  StorageService
    - repositories
    - migrations
    - backup / restore
    - sync ledger
    - secret references
        |
        +--> main.db          structured authoritative data
        +--> blobs/           content-addressed file store
        +--> secrets vault    OS keychain or encrypted local vault
        +--> manifest.json    profile and data-root identity
```

Storage v2 的关键边界是：所有可长期保存的用户数据必须通过主进程 `StorageService` 写入。Renderer 可以缓存，但不能作为权威数据源。

## 数据根目录

Storage v2 引入稳定的数据根目录，而不是直接把 Electron `app.getPath('userData')` 当成产品身份。

推荐布局：

```text
~/.cherrystudio/config/config.json
  dataRoots:
    - profileId: default
      app: cherry-studio-pi
      path: /Users/<user>/CherryStudioPiData
      active: true

<dataRoot>/
  manifest.json
  main.db
  main.db-wal
  main.db-shm
  blobs/
    sha256/
      ab/
        abcdef...
  snapshots/
    2026-05-28T10-00-00-before-v2.db
  backups/
  exports/
  temp/
  legacy/
    indexeddb/
    local-storage/
    agents.db
    app.db
```

`manifest.json` 示例：

```json
{
  "format": "cherry-studio-pi-storage",
  "version": 2,
  "profileId": "default",
  "workspaceId": "01JZ...",
  "createdAt": "2026-05-28T00:00:00.000Z",
  "lastOpenedBy": {
    "appId": "com.cherryai.cherrystudio-pi",
    "productName": "Cherry Studio Pi",
    "version": "1.9.8"
  }
}
```

启动时应按以下顺序定位数据：

1. `CHERRY_STUDIO_STORAGE_V2_ROOT`，仅开发和诊断使用。
2. `~/.cherrystudio/config/config.json` 中的 active data root。
3. 当前 Electron userData 下是否存在 Storage v2 manifest。
4. 旧 Cherry Studio Pi / Perry Studio / Cherry Studio 目录探测。
5. 如果发现多个候选目录，进入数据目录选择和迁移 UI，不静默创建空库。

## 权威数据库

结构化数据统一进入 `<dataRoot>/main.db`。建议继续使用 SQLite/libSQL + Drizzle migrations。

数据库基础设置：

```sql
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;
```

备份和迁移不得直接复制正在写入的 DB 文件，必须使用 SQLite backup API 或 `VACUUM INTO`。

## Schema 分组

### 基础表

```text
profiles
  id
  name
  avatar_blob_id
  created_at
  updated_at

accounts
  id
  provider
  subject
  email
  display_name
  created_at
  updated_at

devices
  id
  name
  platform
  public_key
  created_at
  last_seen_at
```

账号体系上线前，`profiles` 和 `devices` 也要先存在，这样本地数据和未来账号绑定不会重新洗牌。

### 设置

```text
settings
  key
  value_json
  scope
  updated_at
  updated_by_device_id
  version
  deleted_at
```

设置不再散落在 Redux persist 和 electron-store。主进程启动前需要读取的设置，可以通过 `StorageBootstrap` 读取少量 boot settings cache，但 cache 必须能从 `main.db` 重建。

### 模型服务商和模型

```text
providers
  id
  type
  name
  api_host
  enabled
  sort_order
  config_json
  created_at
  updated_at
  deleted_at
  version

models
  id
  provider_id
  name
  group_name
  capabilities_json
  config_json
  enabled
  sort_order
  created_at
  updated_at
  deleted_at

provider_credentials
  provider_id
  credential_kind
  secret_ref
  updated_at
  updated_by_device_id
```

`secret_ref` 指向 secrets vault。默认不跨设备同步密钥；如果未来支持同步，必须经过用户恢复密码或账号密钥进行端到端加密。

### 助手和 agent

```text
assistants
  id
  name
  description
  prompt
  model_id
  settings_json
  avatar_blob_id
  tags_json
  sort_order
  created_at
  updated_at
  deleted_at
  version

assistant_versions
  id
  assistant_id
  snapshot_json
  created_at
  created_by_device_id

agents
  id
  type
  name
  description
  instructions
  model_id
  plan_model_id
  small_model_id
  accessible_paths_json
  mcps_json
  allowed_tools_json
  configuration_json
  avatar_blob_id
  sort_order
  created_at
  updated_at
  deleted_at
  version

agent_versions
  id
  agent_id
  snapshot_json
  created_at
  created_by_device_id

agent_sessions
  id
  agent_id
  name
  inherited_config_json
  current_config_json
  sort_order
  created_at
  updated_at
  deleted_at
  version
```

agent session 保留配置快照是必要的。用户修改 agent 默认配置时，不应该悄悄改变旧 session 的历史语义；需要明确策略：只同步仍等于旧默认值的字段，或要求用户选择是否应用到既有 session。

### 统一对话模型

普通助手对话和 agent session 对话统一使用：

```text
conversations
  id
  kind                       -- assistant_chat | agent_session
  owner_type                 -- assistant | agent
  owner_id
  session_id                 -- agent session 可填
  title
  pinned
  archived
  sort_order
  created_at
  updated_at
  deleted_at
  version

messages
  id
  conversation_id
  role                       -- user | assistant | system | tool
  status
  parent_id
  request_id
  model_id
  provider_id
  token_usage_json
  metadata_json
  created_at
  updated_at
  deleted_at
  version

message_blocks
  id
  message_id
  type                       -- main_text | thinking | tool | image | file | error ...
  ordinal
  text
  payload_json
  blob_id
  created_at
  updated_at
  deleted_at
  version
```

这会替代 Dexie 的 `topics.messages` 大 JSON 和 `message_blocks` 表，也会替代 `agents.db.session_messages.content` 中嵌套的 JSON 历史。

### 文件和 blob store

```text
blobs
  id                         -- sha256
  algorithm
  size
  mime
  ext
  storage_path
  checksum
  created_at
  ref_count

files
  id
  blob_id
  original_name
  display_name
  source
  metadata_json
  created_at
  updated_at
  deleted_at
```

文件写入流程：

1. 写入 `<dataRoot>/temp`。
2. 计算 sha256。
3. 原子移动到 `blobs/sha256/<prefix>/<hash>`。
4. 在同一事务中写入 `blobs` 和 `files` 引用。
5. 失败时清理 temp；启动时也要清理孤儿 temp 文件。

### Skills、任务和外部通道

```text
skills
  id
  name
  description
  folder_name
  source
  source_url
  namespace
  author
  tags_json
  content_hash
  created_at
  updated_at
  deleted_at

agent_skills
  agent_id
  skill_id
  enabled
  created_at
  updated_at

scheduled_tasks
  id
  agent_id
  name
  prompt
  schedule_type
  schedule_value
  timeout_minutes
  next_run
  last_run
  last_result
  status
  created_at
  updated_at
  deleted_at

task_run_logs
  id
  task_id
  session_id
  run_at
  duration_ms
  status
  result_json
  error

channels
  id
  type
  name
  agent_id
  session_id
  config_json
  is_active
  active_chat_ids_json
  permission_mode
  created_at
  updated_at
  deleted_at
```

Skill 文件仍然放在 `<dataRoot>/Skills/<folder>`，DB 存元数据和启用关系。agent workspace 下的 `.claude/skills` 仍可使用 symlink，但 symlink 是可重建的派生状态，不是权威数据。

### 知识库

```text
knowledge_bases
  id
  name
  model_id
  embedding_model_id
  rerank_model_id
  settings_json
  created_at
  updated_at
  deleted_at

knowledge_items
  id
  knowledge_base_id
  source_type
  source_uri
  file_id
  content_hash
  status
  metadata_json
  created_at
  updated_at
  deleted_at
```

向量索引可以继续是知识库内部实现，但索引必须能从 `knowledge_items` 和 blob store 重建。权威元数据进入 `main.db`。

## Secrets vault

敏感字段包括：

- provider API key。
- OAuth access token / refresh token。
- AWS secret access key。
- Vertex service account private key。
- WebDAV / S3 密码。
- 外部通道 bot token 和 app secret。

默认策略：

```text
macOS      Keychain
Windows    Credential Manager / DPAPI
Linux      Secret Service，缺失时使用本地加密 vault 并提示用户
```

`main.db` 只保存 `secret_ref`。备份默认不包含 secrets 明文。恢复到新设备后，用户可以重新输入密钥；未来账号体系可以提供端到端加密的 secret sync。

## 同步模型

Storage v2 从第一天就维护 sync ledger，即使云同步还没上线。

```text
sync_changes
  id
  entity_type
  entity_id
  operation                 -- upsert | delete
  payload_json
  base_version
  version
  device_id
  created_at

sync_tombstones
  entity_type
  entity_id
  deleted_at
  device_id
  version

sync_state
  key
  value_json
  updated_at

sync_conflicts
  id
  entity_type
  entity_id
  local_snapshot_json
  remote_snapshot_json
  base_version
  created_at
  resolved_at
```

合并规则：

- 消息：append-only，按 `created_at + id` 合并。
- message block：同 message 内按 `ordinal` 合并；同一 block 冲突保留两个版本。
- 设置：last-write-wins。
- 助手和 agent：保存版本历史；冲突时保留本地和远端两个版本，由用户选择。
- 文件：按 sha256 去重。
- 删除：软删除和 tombstone，不能立即物理删除。
- secrets：默认不同步。

## 备份和恢复

备份包结构：

```text
backup.zip
  metadata.json
  manifest.json
  main.db
  blobs/
  secrets/
  KnowledgeBase/
  Memory/
  Skills/
  Agents/
```

备份要求：

1. `main.db` 使用 backup API 或 `VACUUM INTO` 生成一致快照。
2. blob store 根据 DB 引用复制，不复制孤儿文件。
3. 备份内写入 counts 和 checksums。
4. 恢复前校验 manifest、DB quick_check、blob checksums。
5. 恢复使用 staging 目录，全部校验通过后原子切换。
6. 旧数据至少保留到用户确认或下一次成功启动后。

当前落地恢复策略：

- 设置页可选择 Storage v2 backup 目录并先做校验。
- 校验会读取 `metadata.json`、检查 backup `main.db` 的 `quick_check` / `integrity_check`，并确认 DB 引用的 blob 文件在备份目录中存在且 sha256 checksum 匹配。
- 恢复前会自动创建 `pre-restore` 备份。
- 当前 `main.db` / `manifest.json` / `blobs` / `secrets` / `KnowledgeBase` / `Memory` / `Skills` / `Agents` 会先归档到 `legacy/pre-restore-*`，再从备份目录恢复。`Memory/memories.db` 备份使用 `VACUUM INTO`，避免直接复制正在写入的 SQLite DB。
- 恢复前会尽量关闭知识库和记忆库的打开连接，降低恢复时旧句柄继续写入的风险。
- 恢复成功后会自动开启 `storage_v2.runtime.auto_hydrate`，确保下一次启动会从 Storage v2 恢复 settings、providers、assistants、knowledge、memory、mcp、note、preprocess、websearch 和 topic 列表。
- 恢复成功后会暂停 Renderer -> Storage v2 mirror，直到应用重启，避免旧运行时缓存把恢复后的数据库覆盖掉。
- 恢复成功后会把 Storage v2 中的 agent、session、agent 对话历史、skills、tasks、channels 投影回当前运行时仍在读取的 `Data/agents.db`，并把原 `agents.db` 归档到 `legacy/pre-restore-*`。
- 恢复成功后会把 Storage v2 blob store 中的附件复制回 `Data/Files`，遇到同名但内容不同的旧文件会先归档再覆盖，确保旧对话中的图片和附件路径可用。
- 恢复成功后会把 Storage v2 中的 app scoped records、cache、sync state、sync conflicts 和 workbench shortcuts 投影回当前运行时仍在读取的 `Data/app.db`，并尽量从 secrets vault 还原被引用的敏感字段。
- 恢复后要求重启应用，让所有窗口和缓存重新连接到恢复后的数据库；普通聊天读取会在 Dexie 为空或开启启动恢复时从 Storage v2 read-through 回填消息、消息块和文件 metadata。

## 迁移策略

Storage v2 必须渐进迁移，不能一次性替换所有读写路径。

### 阶段 0：只读盘点

- 扫描当前 Local Storage、IndexedDB、`Data/agents.db`、`Data/app.db`、`Data/Files`。
- 生成迁移报告：数据量、表数量、孤儿文件、疑似损坏记录。
- 不写入新库，不改变用户数据。

### 阶段 1：建立 StorageService 和 main.db

- 新增 `<dataRoot>/manifest.json`。
- 新增 `<dataRoot>/main.db`。
- 新增 migrations、repositories、health check。
- Renderer 通过 IPC 调用 StorageService。

### 阶段 2：迁移设置、providers、assistants

- 从 Redux persist 迁移 `settings`、`llm`、`assistants`。
- Redux 仍保留 runtime cache，但启动时从 StorageService hydrate。
- 写入操作改为 StorageService 优先，Redux 只跟随更新。

### 阶段 3：迁移普通聊天

- Dexie `topics` -> `conversations` / `messages`。
- Dexie `message_blocks` -> `message_blocks`。
- Dexie `files` -> `files` / `blobs`。
- 完成后 Dexie 消息只读 fallback 一段时间。

### 阶段 4：合并 agent 数据

- `Data/agents.db.agents` -> `agents`。
- `sessions` -> `agent_sessions` + `conversations`。
- `session_messages` -> `messages` / `message_blocks`。
- `skills` / `agent_skills` / `tasks` / `channels` 迁移到 `main.db`。

### 阶段 5：迁移 app.db scoped records

- 能结构化的 scope 迁入对应表。
- 暂时无法结构化的保留到 `kv_records` 兼容表。
- workbench shortcuts 迁入正式表。

### 阶段 6：迁移 secrets

- 识别 Local Storage 和 app DB 中的敏感字段。
- 写入 OS keychain 或 encrypted vault。
- DB 中替换为 `secret_ref`。
- 迁移完成后清理 legacy 明文，清理前必须有快照。

### 阶段 7：切换权威读写

- StorageService 成为唯一权威写入口。
- Redux persist blacklist 扩大到所有关键业务数据。
- Dexie 仅保留临时 cache 或完全移除。
- 旧库进入只读恢复窗口，最终归档到 `legacy/`。

## 数据目录迁移和改名保护

为避免“换 username / 改 productName / 改 appId 后用户以为数据没了”，启动时必须执行 data root discovery：

1. 查 `~/.cherrystudio/config/config.json`。
2. 查当前 app userData。
3. 查已知旧目录名。
4. 查 portable data。
5. 查用户上次选择的数据目录。

如果发现旧目录有数据而当前目录为空，不允许静默初始化新库。必须：

- 自动绑定旧目录；或
- 提示用户选择迁移；或
- 进入恢复模式。

数据目录迁移使用两阶段提交：

```text
copy to <newRoot>.staging
verify db quick_check
verify row counts
verify blob checksums
write manifest
switch config pointer
keep old root as rollback
```

## 可靠性要求

- 所有写操作必须经过事务。
- 所有删除默认软删除。
- 关键 migration 前自动快照。
- 启动时执行 DB health check。
- 检测到 DB 损坏时进入恢复流程，不创建空库覆盖。
- `main.db` schema migration 必须幂等。
- blob 写入必须原子 rename。
- 备份恢复必须 staging + 校验 + 原子切换。
- 所有迁移任务要有进度、日志、可重试和可回滚状态。

## Renderer 状态边界

Storage v2 后 Redux 的定位：

- 可以保存当前 tab、hover、临时输入、展开折叠、modal 状态。
- 可以缓存 StorageService 返回的业务实体。
- 不保存唯一副本。
- 不保存 API key、token、聊天历史、助手、agent、文件元数据等关键数据。

IndexedDB 的定位：

- 可以作为搜索索引、渲染 cache、临时离线 cache。
- 不作为权威数据源。
- 可以从 `main.db` 和 blob store 重建。

## 最小落地接口

第一批主进程接口：

```text
storage.healthCheck()
storage.getDataRoot()
storage.setDataRoot(path)
storage.createSnapshot(reason)
storage.createBackup(reason)
storage.getMigrationStatus()
storage.getStats()
storage.runMigrationStep(step)
storage.importLegacyReduxSnapshot(snapshot, { dryRun })
storage.importLegacyDexieSnapshot(snapshot, { dryRun })
storage.importLegacyAgentDb({ dryRun, dbPath })
storage.importLegacyAppDb({ dryRun, dbPath })

settings.get(key)
settings.set(key, value)

providers.list()
providers.upsert(provider)
providers.setCredential(providerId, secret)

assistants.list()
assistants.upsert(assistant)

conversations.list(owner)
conversations.get(id)
messages.list(conversationId, cursor)
messages.append(conversationId, message)
messages.updateBlocks(messageId, blocks)
```

这些接口足够支撑阶段 1 到阶段 3。

## 开放问题

1. Linux 无 Secret Service 时，是否强制用户设置本地 vault 密码，还是允许低安全模式。
2. 账号体系上线后，profile 与 account 是一对一还是一对多。
3. WebDAV 同步是否继续支持，还是只作为备份通道，真正同步走账号服务。
4. 普通助手和 Pi agent 的 prompt/version 是否需要完整时间旅行 UI。
5. 旧 Cherry Studio 数据迁移到 Cherry Studio Pi 时，是否默认全量迁移或只迁移用户显式选择的数据域。

## 推荐实施顺序

1. 合入本设计文档并确认 schema 方向。
2. 新增 `StorageService` scaffold、`main.db` 初始化和 health check。
3. 做只读迁移盘点报告。
4. 迁移 settings / providers / assistants。
5. 迁移普通聊天。
6. 迁移 agent 数据。
7. 迁移 secrets。
8. 上同步和账号体系。

## 当前落地状态

当前代码已经完成 Storage v2 的安全并行骨架：

- `StorageService`、data root discovery、`manifest.json`。
- `main.db` 初始化、`PRAGMA quick_check`、`VACUUM INTO` snapshot。
- Storage v2 backup 入口，可生成一致 DB 快照并复制 `blobs` / `secrets` / `KnowledgeBase` / `Memory` / `Skills` / `Agents` 到带 stats 与 integrity metadata 的备份目录。
- Storage v2 backup 会同时保存 `KnowledgeBase` 和 `Memory` 目录，其中 `Memory/memories.db` 通过 `VACUUM INTO` 生成一致快照。
- Storage v2 restore 入口，可校验 backup 目录，恢复前创建 pre-restore 备份，并把旧文件归档到 `legacy/pre-restore-*` 后再恢复。
- 只读迁移审计报告。
- Storage v2 stats / integrity 统计与完整性检查接口，用于迁移后校验核心表数量、SQLite integrity、foreign key、孤儿记录、缺失 blob 文件和 blob checksum mismatch。
- Storage v2 core snapshot 只读接口，可把 settings、providers、assistants、knowledge、memory、mcp、note、preprocess、websearch、assistant topics 合成为未来启动 hydrate 使用的安全快照；provider / LLM / MCP env / knowledge preprocess / document preprocess / websearch secrets 默认不解密。
- sync ledger 基础写入：settings、providers、assistants、conversations、files、knowledge bases/items 写入时同步记录 `sync_changes`；显式删除会写入 `sync_tombstones`，避免删除的数据在恢复或未来同步时复活。
- settings / providers / assistants repositories。
- conversations / messages 只读查询接口，迁移后可以校验普通对话和 agent session 历史。
- legacy Redux snapshot 导入入口，默认 `dryRun`；导入会把已删除的 providers / assistants 标记为 tombstone，并额外镜像 knowledge、memory、mcp、note、preprocess、websearch 等 Redux 配置。
- provider API key、Vertex private key、AWS secret、CherryIn token 通过 Electron `safeStorage` 写入本地 secret vault；`dryRun` 时只报告不写入。
- MCP server env、知识库预处理服务、文档预处理服务、网页搜索服务的敏感字段会写入 secret vault，`main.db` 只保存 secret ref；恢复 runtime cache 时再按需还原。
- knowledge bases/items 已进入结构化表，可在保留 Redux runtime 兼容快照的同时，用 `knowledge_bases` / `knowledge_items` 作为未来同步、重建索引和迁移校验的权威元数据。
- legacy Dexie `topics` / `message_blocks` / `files` 导入入口，普通对话可写入统一 `conversations` / `messages` / `message_blocks`，文件可按 sha256 写入 blob store；完整导入会纳入 orphan Dexie topic，并可 prune 已删除的 topic / file。
- legacy `Data/agents.db` 导入入口，覆盖 agents、sessions、session messages、skills、agent skills、tasks、task logs、channels。
- channel secret 字段导入时写入 secret vault；如果当前系统不可用，则跳过敏感明文并保留 warning。
- legacy `Data/app.db` 导入入口，app scoped records、cache、sync state/conflicts、workbench shortcuts 可迁入 `kv_records` / sync tables，并会扫描常见 secret 字段写入 secret vault。
- Renderer 侧提供完整 legacy migration runner，可一次性 dry-run 或按顺序迁移 Redux、Dexie、`agents.db`、`app.db`，实际导入前默认先创建 snapshot。
- 设置页的数据设置中已加入“统一存储”控制面，可查看 data root、health、legacy audit、Storage v2 stats，并触发 dry-run、导入、snapshot、backup。
- 设置页可手动触发 Storage v2 完整性检查。
- dry-run / 导入的结果会写入 `migration_runs`，应用重启后仍可追溯最近迁移历史。
- Renderer 已加入 Redux -> Storage v2 mirror middleware：`settings`、`llm`、`assistants`、`knowledge`、`memory`、`mcp`、`note`、`preprocess`、`websearch` 变更会低频写入 Storage v2，应用退出 flush 时也会同步落库。该 mirror 会去掉助手 topic runtime 数据，避免聊天历史重复塞进 settings。
- Renderer 已加入普通对话 -> Storage v2 mirror：普通聊天消息、消息块、清空/删除等 IndexedDB 写入会按 topic 防抖镜像到 `conversations` / `messages` / `message_blocks`，并只同步当前对话引用到的文件元信息。
- Renderer 已加入普通对话 / 文件显式删除 tombstone：删除 topic 或文件时会写入 Storage v2 软删除，避免恢复后复活。
- Renderer 已加入 Storage v2 -> 普通对话 read-through：启动恢复开启时优先从 Storage v2 读取普通聊天消息；Dexie cache 为空时也会从 Storage v2 回填消息、消息块和文件 metadata。
- Renderer 已加入文件元信息 -> Storage v2 mirror：附件新增、更新、引用计数变化会同步到 blob/file tables。
- Renderer / Main 已加入 Pi agent -> Storage v2 mirror：agent session 消息、agent/session/task/channel 等本地 IPC 写操作进入 `agents.db` 后会低频导入 Storage v2，应用退出 flush 时也会同步落库。
- 设置页提供手动“从 Storage v2 恢复运行时缓存”入口，可把 Storage v2 核心快照恢复到 Redux runtime cache；同时提供默认关闭的启动恢复开关，开启后会在 Redux ready 通知前从 Storage v2 hydrate runtime cache。

当前阶段仍不接管既有 Redux、IndexedDB、`agents.db` 或 `app.db` 的业务读写。
StorageService-first 写路径和 legacy 归档清理仍是后续步骤。

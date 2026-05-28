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

1. `CHERRY_STUDIO_STORAGE_V2_ROOT`，仅开发和诊断使用，显式设置时优先。
2. 任意候选目录中格式和版本匹配的 Storage v2 manifest。
3. `~/.cherrystudio/config/config.json` 中仍然存在的 active data root。
4. 当前 Electron userData 下已有旧库数据的 `Data` 目录。
5. 旧 Cherry Studio Pi / Perry Studio / Cherry Studio 目录中已有旧库数据的 `Data` 目录。
6. 当前 Electron userData 的 `Data` 目录。
7. 如果发现多个候选目录，进入数据目录选择和迁移 UI，不静默创建空库。

当前实现会在非 `CHERRY_STUDIO_STORAGE_V2_ROOT` 场景下，把选中的 Storage v2 data root 回写到
`~/.cherrystudio/config/config.json` 的 `dataRoots` 中，并保留既有 `appDataPath` 配置。读取配置时只采纳
`app` 为空，或等于 `cherry-studio-pi` / `perry-studio` / `cherry-studio` 的 active entry，且只有格式和版本匹配的 `manifest.json` 才会被视为有效
Storage v2 根目录。这样产品名、仓库名或 Electron 默认 `userData` 路径变化后，下一次启动仍能优先找到同一个
Storage v2 数据根。没有 manifest 的过渡期也会优先选择包含 `agents.db` / `app.db` / `Files` / `KnowledgeBase`
等旧数据的目录，避免重命名后在新的空 userData 里静默创建空库，让用户误以为本地数据丢失。
如果全局配置里登记的 active data root 只是一个空目录，运行时会继续优先选择当前或旧路径里有 manifest / `main.db`
/ legacy runtime 数据的真实数据根；空配置根只作为没有任何数据根时的兜底，避免陈旧配置覆盖用户本地数据。
候选根下的目录型数据（如 `Files` / `KnowledgeBase` / `Memory` / `blobs`）必须非空才会被视为真实数据，避免新建空目录抢占旧数据根。

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
  version
```

文件写入流程：

1. 写入 `<dataRoot>/temp`。
2. 计算 sha256。
3. 原子移动到 `blobs/sha256/<prefix>/<hash>`。
4. 在同一事务中写入 `blobs` 和 `files` 引用；如果同一个 file id 改指向新 blob，会同时重算旧 blob 和新 blob 的 `ref_count`。
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
  version

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
  version

task_run_logs
  id
  task_id
  session_id
  run_at
  duration_ms
  status
  result_json
  error
  version

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
  version
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
  version

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
  version
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
- 校验会读取 `metadata.json`、检查 backup `main.db` 的 `quick_check` / `integrity_check`，确认 DB 引用的 blob 文件在备份目录中存在且 sha256 checksum 匹配，并校验 `secrets/vault.json` 的 vault 结构和 DB 中所有 secret ref 是否能找到对应密钥。
- 恢复前会自动创建 `pre-restore` 备份。
- 当前 `main.db` / `manifest.json` / `blobs` / `secrets` / `KnowledgeBase` / `Memory` / `Skills` / `Agents` 会先归档到 `legacy/pre-restore-*`，再从备份目录恢复。`Memory/memories.db` 备份使用 `VACUUM INTO`，避免直接复制正在写入的 SQLite DB。
- 恢复前会尽量关闭知识库和记忆库的打开连接，降低恢复时旧句柄继续写入的风险。
- 恢复成功后会自动开启 `storage_v2.runtime.auto_hydrate`，确保下一次启动会从 Storage v2 恢复 settings、providers、assistants、所有持久化 Redux 配置 slice 和 topic 列表。
- 恢复成功后会暂停 Renderer -> Storage v2 mirror，直到应用重启，避免旧运行时缓存把恢复后的数据库覆盖掉。
- 主进程 `ConfigManager` 会把 electron-store 设置写入 `config.*` scope；单项写入失败会保留待重试队列，Storage v2 snapshot / backup / restore 前会 strict flush 这条队列并全量 mirror 当前 config，恢复成功后也会把 Storage v2 中的主进程 `config.*` 设置覆盖回 electron-store，保证重启后托盘、快捷键、选择助手、更新通道等主进程系统设置能跟随备份恢复。
- 恢复成功后会把 Storage v2 中的 agent、session、agent 对话历史、skills、tasks、channels 投影回当前运行时仍在读取的 `Data/agents.db`，并把原 `agents.db` 归档到 `legacy/pre-restore-*`。
- restore、agent / app-data / file runtime projection 的归档移动会检测跨磁盘 `EXDEV`，失败时回退到 copy + delete；重复投影时会自动选择不冲突的归档文件名，避免自定义 data root 与 Electron `userData` 不在同一磁盘，或上次归档仍存在时中断恢复或投影。
- 恢复成功后会把 Storage v2 blob store 中的附件复制回 `Data/Files`，遇到同名但内容不同的旧文件会先归档再覆盖，确保旧对话中的图片和附件路径可用。
- 恢复成功后会把 Storage v2 中的 app scoped records、cache、sync state、sync conflicts 和 workbench shortcuts 投影回当前运行时仍在读取的 `Data/app.db`，并尽量从 secrets vault 还原被引用的敏感字段。
- auto hydrate 标记、主进程 config 回填和上面这些 legacy runtime 投影都发生在权威 Storage v2 数据已经恢复之后；如果某个后置步骤失败，恢复结果会返回 warning 而不是把已经完成的主库恢复误报成失败。应用重启后仍可通过 Storage v2 auto hydrate、手动 hydrate 和 read-through 继续恢复运行时缓存。
- 恢复成功后会用恢复后的 manifest 重新激活当前 data root，让全局 data root config 跟随备份中的 workspace/profile 元数据更新。
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
- 新增 migrations、repositories、health check；启动时会执行幂等 schema column migration，并把 `storage_meta.schema_version`
  写为当前 DB schema 版本，避免早期实验版 `main.db` 缺少新增列后在导入、备份或恢复时崩溃。
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
conversations.sync(snapshot)
conversations.upsert(metadata, pruneMissingMessages?)
messages.list(conversationId, cursor)
messages.append(conversationId, message)
messages.upsert(conversationId, message)
messages.updateBlocks(messageId, blocks, pruneMissing?)
files.upsert(file)
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

- `StorageService`、data root discovery、`manifest.json`；manifest、appDataPath 和全局 data root config 都使用临时文件原子 rename 写入，选中的 data root 会登记到 `~/.cherrystudio/config/config.json`，避免产品名或 userData 默认路径变化后丢失入口。
- 自定义 App Data 路径变更会同步把新路径下的 `Data` 注册为 active Storage v2 data root；复制数据前会先执行 renderer `handleSaveData()` strict flush，再让主进程 strict flush electron-store config 和 agent mirror，复制数据时会排除旧 `Data` 和 `.restore` staging 标记，再把当前 active data root 通过 Storage v2 snapshot 复制到新路径，避免真正的 active root 在自定义路径或旧 Perry/Cherry 根下时被漏掉，也避免直接复制正在写入的 `main.db`；如果用户选择不复制数据，也会在新 `Data` 下创建 fresh manifest，避免全局 `dataRoots` 中旧的 active 根在重启后重新抢占。
- `main.db` 初始化、`PRAGMA quick_check`、`VACUUM INTO` snapshot；Storage v2 主库事务和 snapshot 通过进程内 exclusive queue 串行化，避免多个 mirror / 迁移入口并发时在同一 SQLite/libSQL 连接上互相抢 `BEGIN IMMEDIATE`。
- Storage v2 backup 入口，可生成一致 DB 快照，并在等待 secret vault 写队列落盘、按当前 DB secret ref 清理未引用的 vault secret 后复制 `blobs` / `secrets` / `KnowledgeBase` / `Memory` / `Skills` / `Agents` 到带 stats、secret prune 结果与 integrity metadata 的备份目录；Renderer 手动触发 snapshot / backup 前会按 Redux、durable localStorage、普通对话、文件、Dexie settings、Dexie 辅助表、agent 的顺序 strict flush mirror 队列，若任一队列因 Storage v2 写入失败、仍保留待重试任务，或 Storage v2 IPC 暂不可用时仍存在待落盘任务，会直接阻断本次保护点流程；主进程 StorageService 也会在 snapshot / backup / restore 前 strict flush electron-store config 和 agent mirror，并对完整 config 快照做一次 mirrorAll，避免绕过 renderer 入口或早前 config mirror 临时失败时漏掉最近的主进程系统设置。
- Storage v2 backup 会同时保存 `KnowledgeBase` 和 `Memory` 目录，其中 `Memory/memories.db` 通过 `VACUUM INTO` 生成一致快照。
- 旧版 `userData/agents.db` 迁入稳定 `Data/agents.db` 时，如果目标库已存在，会把旧库及 `-wal` / `-shm` sidecar 归档到 `Data/legacy/pre-storage-v2-agents-*`，不会覆盖当前活跃 agent runtime 数据；跨磁盘移动失败时会回退到 copy + unlink。
- 旧版 `userData/memories.db` 迁入稳定 `Data/Memory/memories.db` 时，如果目标库已存在，会把旧库及 `-wal` / `-shm` sidecar 归档到 `Data/Memory/legacy/pre-storage-v2-memory-*`，不会覆盖当前活跃 memory 数据；跨磁盘移动失败时会回退到 copy + unlink。MemoryService 初始化前也会主动执行一次该安全迁移，避免只依赖历史 Redux migration 导致旧记忆库留在旧 userData。
- MemoryService 的新增、恢复、更新、单条删除、按用户清空记忆和删除非默认用户都会把 memory 行变更与 history 写入放进同一个事务；删除会保留 memory 软删除行并写入 DELETE history，避免未来同步或恢复时因为半成功写入、硬删缺少 tombstone 而复活旧记忆或丢失删除证据。
- 旧的本地 / WebDAV / S3 / 坚果云 / 局域网备份入口仍然保留，但在复制 `IndexedDB` / `Local Storage` / `Data` 或生成旧版 `data.json` 前会先执行 `handleSaveData()`，确保 Redux、普通聊天、文件、Dexie settings、Dexie 辅助表、agent 和 durable localStorage 的 Storage v2 mirror 以 strict flush 落盘，降低刚改完就备份时漏掉最近数据的风险。复制 `Data` 时会使用当前选中的 active data root；如果存在 Storage v2 `main.db`，备份包内的 `main.db` 会替换为 `VACUUM INTO` 生成的一致快照，并移除复制过程中带上的 `main.db-wal` / `main.db-shm`。
- 旧的 direct / legacy 备份恢复在 staging `Data.restore` 时也会使用当前选中的 active data root，而不是固定写到 Electron `userData/Data.restore`；启动恢复和重置流程因此能在自定义 data root、产品改名或旧 Perry/Cherry 数据根被重新选中时命中同一套恢复目录。
- 旧的 direct 备份如果是 `skipBackupFile` 生成的运行时缓存备份、没有可恢复的 `Data` payload，恢复 staging 完成后会显式关闭一次 `storage_v2.runtime.auto_hydrate`，避免下一次启动用当前旧 Storage v2 快照覆盖刚恢复的 `IndexedDB` / `Local Storage`。
- Storage v2 restore 入口，可校验 backup 目录，恢复前创建 pre-restore 备份，并把旧文件归档到 `legacy/pre-restore-*` 后再恢复。
- 旧版 `.bak` / JSON 备份恢复开始写 legacy IndexedDB 前，会先暂停 renderer runtime mirror 到重启，避免清表和批量写入期间把半成品旧运行态抢跑镜像到 Storage v2；恢复成功后，会先清空当前所有 legacy IndexedDB 表，再写入备份中存在的表，避免备份缺失的旧表残留当前数据；随后会把刚恢复的 legacy IndexedDB（普通会话、message blocks、files、Dexie settings 和辅助表）全量导入 Storage v2，恢复导入会忽略重启前旧 Redux 中存在但恢复后的 Dexie 中不存在的 topic，并优先使用消息中的 assistantId，避免旧运行态 topic 污染恢复结果；同时 prune 缺失的普通会话、文件，并给缺失的 Dexie settings / 辅助表行写删除标记，再显式关闭一次 `storage_v2.runtime.auto_hydrate`，避免用户之前开启过 Storage v2 启动恢复时，下一次启动用旧 Storage v2 快照覆盖刚恢复的 legacy localStorage / IndexedDB；如果这次导入失败，legacy 恢复仍完成并保留关闭 auto hydrate 的保护，避免旧 Storage v2 快照抢跑覆盖恢复结果。
- 只读迁移审计报告；会以当前 active data root 作为 `Data` 目录审计目标，并提示多个 Storage v2 manifest、缺失的已配置 data root，以及活动根之外仍存在旧版数据目录的风险。
- Storage v2 stats / integrity 统计与完整性检查接口，用于迁移后校验核心表数量、SQLite integrity、foreign key、孤儿记录、缺失 blob 文件、blob checksum mismatch，以及 DB secret ref 是否能在 vault 中找到对应密钥。
- Storage v2 backup 校验在扫描 secret ref 时会兼容早期备份缺少后续新增表/列的情况：缺失 schema source 会记录 warning 并继续扫描其余表；校验会报告缺失/无效 secret ref，也会把备份中已经不被 DB 引用的 vault secret、当前设备无法解密的 safeStorage secret 作为 warning，避免旧备份因非关键新表不存在而无法通过校验，同时降低过期 token 被长期带进备份、跨设备恢复后用户误以为密钥仍可用的风险。
- Storage v2 core snapshot 只读接口，可把 settings、providers、assistants、所有持久化 Redux 配置 slice、assistant topics、legacy Dexie settings 和 Dexie 辅助表合成为未来启动 hydrate 使用的安全快照；provider / LLM / app settings / MCP env / Nutstore / OCR / code tools env / Copilot headers / knowledge preprocess / document preprocess / websearch secrets 默认不解密，并且会剔除历史异常数据里残留的同类明文字段，避免 `includeSecrets:false` 导出泄漏旧明文密钥。
- sync ledger 基础写入：settings、providers、assistants、conversations、messages/message blocks、files、knowledge bases/items、agent/session/skill/task/channel、agent skill、task run log、app `kv_records` 写入时同步记录 `sync_changes`；除无行版本的关系表外，账本使用实体当前版本，显式删除会写入 `sync_tombstones`，避免删除的数据在恢复或未来同步时复活。
- settings / providers / assistants repositories。
- 模型 provider 新增、删除、排序、字段更新、模型列表更新、Vertex / AWS Bedrock 敏感配置更新，以及默认 / quick / 翻译模型切换后会主动 flush Redux -> Storage v2 mirror，降低 API key、服务端地址、service account private key、默认模型这类关键设置在防抖窗口内丢失的风险；provider 模型列表更新时，缺失模型会写 `deleted_at` 软删除，而不是物理删除 `models` 行；仍存在或重新出现的模型会走 upsert 并清空 `deleted_at`，避免重复保存 provider 时主键冲突，也避免自定义模型删除证据在未来同步/恢复中丢失。
- assistant 新增、复制、插入、删除、排序、编辑、默认助手更新、模型和 settings 更新后会主动 flush Redux -> Storage v2 mirror；assistant topic 消息仍由普通对话 mirror 负责，核心 assistant 元数据不会只依赖低频防抖写入。provider、assistant、assistant topic、assistant preset 和 MCP server 删除会等待 Redux mirror strict flush 成功，避免本地配置和敏感连接信息在恢复时复活。
- 网页搜索 provider/订阅源/压缩设置、文档预处理 provider/default provider、OCR provider/image provider/config 写入后也会主动 flush Redux -> Storage v2 mirror；这些配置可能包含 API key、basic auth、OCR/预处理服务端地址，不能只等待低频防抖。网页搜索订阅源删除或整表替换会等待 strict flush 成功，避免订阅源列表在恢复后回退。
- code tools 的 CLI、模型、终端、环境变量和当前目录切换会主动 flush Redux -> Storage v2 mirror；删除目录、清空目录和重置 code tools 设置会等待 strict flush 成功，避免本地工作区和环境变量配置在恢复时回退。
- Storage v2 Redux mirror 还会对所有持久化 Redux 配置 slice 跳过 1.2 秒防抖并立即 flush；普通聊天流仍由 conversation mirror 负责，避免高频消息把 settings 表写爆，同时兜住设置页直接 dispatch 的路径。画作历史删除会在相关文件 tombstone 成功后要求 Redux mirror strict flush，再返回删除操作，避免图片历史这种本地资产在恢复时复活。
- conversations / messages 查询与普通对话直接写入接口，迁移后可以校验普通对话和 agent session 历史；普通聊天 mirror 已优先通过单会话原子 `conversation.sync` 写入 Storage v2，并保留 `conversation.upsert`、`message.upsert`、`message_blocks.upsert` 作为后续更细粒度主写路径，删除的消息和消息块会补 tombstone。
- legacy Redux snapshot 导入入口，默认 `dryRun`；导入会把已删除的 providers / assistants 标记为 tombstone，并额外镜像所有持久化 Redux 配置 slice。
- legacy Redux 导入支持局部 snapshot：只有传入 `llm.providers` 或 `assistants.assistants` 时才会 prune 对应实体；localStorage-only mirror、settings-only mirror 这类小域写入不会把缺失的数据域误判为空列表而删除 Storage v2 里的 provider / assistant。
- provider API key、Vertex private key、AWS secret、CherryIn token 通过 Electron `safeStorage` 写入本地 secret vault；`dryRun` 时只报告不写入。
- secret vault 写入使用进程内串行队列和临时文件原子 rename；secret ref 到 vault id 的转换保留 URL 编码片段，避免 owner/kind 包含空格或斜杠时无法找回密钥；只有 vault 文件不存在时才会初始化空 vault，已存在但无效或不可读时会拒绝继续写入，降低并发写入覆盖、崩溃截断和二次覆盖导致密钥丢失的风险。vault 支持按 Storage v2 当前引用集合清理未引用 secret，避免 logout、删除 provider/channel 或旧迁移残留的敏感值长期留在本地备份里。
- 应用设置中的 S3 / API Server 凭据、MCP server env / OAuth、Anthropic OAuth、Nutstore token、OCR API key、code tools 环境变量、Copilot 敏感 headers、Copilot GitHub access token、知识库预处理服务、文档预处理服务、网页搜索服务的敏感字段会写入 secret vault，`main.db` 只保存 secret ref；恢复 runtime cache 时再按需还原。模型 provider 的新密钥如果因为安全存储不可用而无法写入 vault，会清理旧 credential ref，避免后续恢复出过期旧密钥。Copilot access token 读取时优先走 Storage v2 secret vault，旧 `.copilot_token` 文件只作为兼容 fallback；fallback 成功后会自愈镜像到 Storage v2，logout 会先写入清除标记再删除旧文件，清除标记写入失败会保留 legacy token 文件并中止 logout，避免旧 token 复活。MCP OAuth client 信息、access/refresh token、code verifier 会作为整份 OAuth 状态写入 secret vault，旧 `mcp/oauth/*_oauth.json` 只作为兼容 fallback；删除 MCP server 或 OAuth clear 会先写清除标记再删除旧 JSON，清除标记失败时保留 legacy 文件，避免旧 OAuth 凭据恢复。Anthropic OAuth access/refresh token 同样优先读取 Storage v2 secret vault，旧 `oauth/anthropic.json` 只作为兼容 fallback；clear credentials 会先写清除标记再删除旧 JSON，清除标记失败时保留 legacy 文件。OpenClaw 的 `~/.openclaw/openclaw.json` 仍作为外部进程运行时投影文件保留，但同步 provider 时会先把包含 gateway token/provider apiKey 的整份配置镜像到 Storage v2 secret vault，成功后再写外部投影文件，避免界面显示同步成功但备份/迁移缺少 OpenClaw 敏感配置；如果本地投影文件缺失或不可解析，会优先用 Storage v2 快照恢复再继续同步。WeChat channel 登录态按 tokenPath hash 写入 Storage v2 secret vault，旧 `Channels/weixin_bot_*.json` 只作为兼容 fallback；会话过期清除凭据时会先写清除标记再删除旧文件，清除标记失败时保留 legacy 文件，避免旧登录态复活。
- 语言、当前 memory 用户、onboarding 完成状态、隐私协议确认状态等 durable localStorage 值，以及 MCP 市场/服务商登录 token（MCPRouter、ModelScope、蓝耘、TokenFlux、302.AI、百炼）虽然仍由现有页面读写 localStorage，但 Storage v2 mirror / 手动迁移会把它们纳入快照；语言、当前 memory 用户、MCP token、onboarding、隐私确认这类不一定伴随 Redux action 的写入会主动触发一次 localStorage mirror，并默认立即 flush，失败时会保留当前快照并延迟重试；其中 MCP provider token 会写入 secret vault，runtime cache 恢复时再写回 localStorage。被用户清除的 token 会通过显式 `clearedMcpProviderTokenKeys` 列表记录并在恢复时删除，避免把 safeStorage 不可用或 secret 缺失误判为“用户已清除 token”，也避免浏览器本地小配置和敏感 token 成为迁移和备份恢复的漏网数据。
- knowledge bases/items 已进入结构化表，可在保留 Redux runtime 兼容快照的同时，用 `knowledge_bases` / `knowledge_items` 作为未来同步、重建索引和迁移校验的权威元数据；如果 core snapshot 中缺少 `redux.knowledge`，或只有空的 `knowledge.bases` 但结构化知识库表中仍有数据，启动恢复会从结构化表重建 `knowledge.bases`，避免 Redux 兼容快照缺失或空快照抢占时知识库列表直接变空。
- 知识库创建、删除、改名、设置编辑、排序、条目新增/删除、笔记内容更新和迁移新增条目后会主动 flush Redux -> Storage v2 mirror；知识库文件 / URL / sitemap / 目录 / 视频添加、条目刷新、条目更新和知识库列表更新这类低频资产操作会等待 flush 完成后再继续触发后续队列；删除知识库或删除条目会要求 Redux mirror strict flush 成功，笔记条目会先 strict flush `knowledge_notes` 删除标记再删除 Dexie 行；删除知识库会先等待关联笔记内容表写入删除标记，再暂停 Redux mirror、一次性移除知识库和助手 / preset 引用并统一 strict flush，避免知识库这类用户资产只停留在低频防抖写入队列里，或因临时写入失败在未来恢复中复活。
- 主进程 API server 的知识库 list/get/search 已在 Redux runtime cache 不可用或为空时回退读取 Storage v2 结构化知识库表；搜索链路会在 Redux provider 不可用或缺失时回退读取 Storage v2 provider 与 secret vault 中的 API key，知识库运行时索引仍沿用现有 KnowledgeService。
- legacy Dexie `topics` / `message_blocks` / `files` 导入入口，普通对话可写入统一 `conversations` / `messages` / `message_blocks`，缺失的消息和消息块使用软删除并记录变更；删除整段会话时也会为子消息和消息块写入 tombstone，文件可按 sha256 写入 blob store；完整导入会纳入 orphan Dexie topic，并可 prune 已删除的 topic / file。
- legacy Dexie `settings` 导入和运行时 mirror 已纳入 Storage v2 `settings` 表的 `dexie-settings` scope，覆盖用户头像、provider logo、pinned models、翻译偏好、MCP provider 服务列表等仍散落在 IndexedDB 的配置；Dexie settings hook 现在默认立即 flush，因此翻译页、迷你翻译、划词翻译等直接 `db.settings.put/delete` 的写入也会自动落到 Storage v2。头像 / provider logo / pinned models 的新增或更新会立即 flush，头像和 provider logo 删除会先 strict flush `null` 标记再删除 legacy Dexie 行，MCP provider 服务列表抓取成功后也会立即 flush；如果 Storage v2 临时不可写，Dexie settings mirror 会保留待同步 key 并延迟重试，避免立即重试形成紧循环。quick phrases、自定义翻译语言、翻译历史、知识库笔记这几张 Dexie 辅助表会以 `dexie.table.<table>.<id>` 行级记录进入 `dexie-table:<table>` scope，新增、更新和删除都会在关键用户操作后立即 flush；快捷短语、自定义翻译语言和翻译历史的删除会先 strict flush Storage v2 tombstone 再删除 legacy Dexie 行，清空翻译历史前也会先 read-through 补齐 Storage v2-only 历史行再批量写 tombstone，避免路径变化或崩溃后旧辅助数据复活；快捷短语删除后的剩余短语排序重排也会同步写回 Storage v2，避免恢复后顺序回退；Storage v2 read-through 会把缺失的 active 行投影回 Dexie，值为 `null` 的记录只作为删除标记参与防复活判断，不会被投影成 legacy 行；prune 已经是 `null` 的删除标记时不会重复写入，避免无意义递增版本和制造同步噪音。
- legacy `Data/agents.db` 导入入口，覆盖 agents、sessions、session messages、skills、agent skills、tasks、task logs、channels；导入时只把旧库中实际存在的表视为权威来源，旧版 schema 缺少某张表时不会把 Storage v2 中对应数据批量标记删除；session messages 表缺失时也不会用空历史覆盖已有 agent conversation。
- channel secret 字段导入时写入 secret vault；如果当前系统不可用，则跳过敏感明文并保留 warning。
- legacy `Data/app.db` 导入入口，app scoped records、cache、sync state/conflicts、workbench shortcuts 可迁入 `kv_records` / sync tables，并会扫描常见 secret 字段写入 secret vault；导入时只 prune 旧库中实际存在的表，旧版 app.db 缺少 cache、workbench shortcut 或 sync 表时不会删除 Storage v2 里的对应数据；新的 app-data set/delete、app-cache set/delete、workbench shortcut upsert/install 已先写 Storage v2 再写 legacy `app.db`，WebDAV app-data sync 下载记录、sync state 和 sync conflicts 也已先写 Storage v2 再写 legacy `app.db`，常见敏感字段仍会转成 secret ref；WebDAV app-data sync 上传前会把 legacy `app.db` 记录和 Storage v2 记录按 key 合并，同 key 取更新时间/版本更新的一条，避免 legacy 非空但只包含部分数据时漏同步 Storage v2 中的新记录。`appData.get`、`appData.list`、`appCache.get`、workbench shortcut list、WebDAV sync status、WebDAV sync last-hash 和 app sync `device-id` 在 legacy runtime 读不到数据时会从 Storage v2 read-through 回退读取并还原 secret ref，避免旧库缺失 sync state 时把单边更新误判成冲突或生成新的设备身份；`app.db` 初始化本身也会优先复用 Storage v2 中的 `device-id`，没有旧值时才生成并镜像新的设备 ID；若 legacy 已有 `device-id` 但早前 Storage v2 镜像失败，后续启动会用该 legacy 值自愈补写 Storage v2，避免跨设备同步身份只留在旧 `app.db`。legacy app-data 和 Storage v2 app-data 读取都会区分“缺行”“合法 null”“删除墓碑”，避免从 Storage v2 读回旧值，或把合法 null 当成缺失后触发错误投影；`appData.list` 会在 legacy app records 非空时继续合并 Storage v2 app records，同 key 取更新时间/版本更新的一条，并用 tombstone 过滤已删除记录，避免普通列表漏掉 Storage v2-only 行或复活旧值；workbench shortcut list 也会在 legacy shortcut 表非空或只有 tombstone 时合并 Storage v2 shortcut，按更新时间保留最新状态，避免旧 active shortcut 或旧 Storage v2 active shortcut 被误复活。`appData.get` 在单个 key 缺失时、`appData.list` / workbench shortcut list 和 WebDAV app-data sync 在 legacy app records 或 shortcut 表为空时，会先用非 prune 模式把选中的 legacy data root 中仍存在的 `app.db` 合并进 Storage v2，再把 Storage v2 投影回当前 `Data/app.db` 后继续读取/同步，避免投影重建时覆盖尚未镜像的 legacy 行；如果运行时投影临时失败，`appData.list` 和 WebDAV app-data sync 会直接读取 Storage v2 记录，避免把已有本地权威数据当成空列表。
- Renderer 侧提供完整 legacy migration runner，可一次性 dry-run 或按顺序迁移 Redux、Dexie、`agents.db`、`app.db`；实际导入前会先 flush 所有 mirror 队列，再默认创建一次顶层 snapshot，内部 `agents.db` / `app.db` 导入会复用这次保护点，不再额外生成重复 snapshot。
- 设置页的数据设置中已加入“统一存储”控制面，可查看 data root、health、legacy audit、Storage v2 stats，并触发 dry-run、导入、snapshot、backup。
- 设置页可手动触发 Storage v2 完整性检查。
- dry-run / 导入的结果会写入 `migration_runs`，应用重启后仍可追溯最近迁移历史。
- 主进程 `ConfigManager` 的 electron-store 设置会在启动时从 Storage v2 的 `config.*` 设置补空缺，再把现有 electron-store 快照镜像回 Storage v2；之后每次 `configManager.set()` 都会进入带延迟重试的 Storage v2 mirror 队列，覆盖托盘、快捷键、选择助手、更新通道、开发者模式等主进程系统设置。Storage v2 备份恢复时会以备份内 `config.*` 为准覆盖并 prune 当前 electron-store 中缺失的旧 key，避免本机残留配置污染恢复后的状态；如果早期备份完全没有 `config.*` 记录，则不会 prune 当前 electron-store，避免把缺失镜像能力误判为“备份要求清空配置”。
- Renderer 已加入 Redux -> Storage v2 mirror middleware：所有持久化 Redux 配置 slice 的变更会立即写入 Storage v2，应用退出 flush 时也会同步落库。该 mirror 会去掉助手 topic runtime 数据，避免聊天历史重复塞进 settings；启动阶段会先暂停 mirror，`persist/REHYDRATE` 不直接写 Storage v2，待 Storage v2 自动恢复完成或确认跳过后再用最终 Redux 状态统一 mirror，避免旧 runtime cache 抢跑覆盖恢复数据。如果当前 Electron `userData` 下的 Redux persist cache 缺失，即使用户没有显式开启 `storage_v2.runtime.auto_hydrate`，启动流程也会先尝试从 Storage v2 恢复核心 runtime cache；这样产品名、appId、用户名或数据路径变化后，默认初始 Redux 不会先把 Storage v2 中已有的 provider、assistant、settings 覆盖掉。启动完成后的第一轮 Redux mirror 也会以非 prune 模式合并写入，只有后续用户明确编辑、排序、删除等 Redux action 触发的 mirror 才有删除缺失 provider / assistant / knowledge 记录的权限；即使后续 runtime action 产生的快照内容和启动快照完全相同，也会重新以 prune 模式写入一次，避免启动期非 prune 合并留下的旧行无法被清理。
- 应用关闭、直接退出或系统关机时，主进程会 strict flush electron-store config 和 agent mirror，并向主窗口发送带 request id 的 `App_SaveData`；Renderer 完成 `handleSaveData()` 后必须回传 ack，主进程才认为退出保存链路完成。若主进程 flush 临时失败，也会继续尝试 Renderer 保存并汇总错误，避免单侧失败导致另一侧待落盘数据被跳过。
- Renderer 已加入普通对话 -> Storage v2 mirror：普通聊天消息、消息块等高频写入会按 topic 防抖镜像到 `conversations` / `messages` / `message_blocks`；topic 新增、标题/置顶/排序/所属 assistant 等低频元信息变更会立即 flush 对应 topic mirror；清空/删除消息和删除消息块会在操作返回前主动 flush mirror，降低崩溃窗口内漏写 tombstone 的风险。非破坏性 topic mirror 在 prune 前会先用非 prune conversation sync 合并当前 Dexie topic，再从 Storage v2 回填 Dexie 后执行最终 prune，避免用户在路径变化后直接发送/编辑消息时，用局部 Dexie cache 覆盖 Storage v2 中已有历史；删除、清空和移除 block 会标记为 destructive flush，跳过预回填，让 prune 正常写 tombstone。写入 Storage v2 失败或构建 Dexie topic 快照时临时读失败，都会保留待同步 topic 并按 destructive 标记重试，避免临时故障后直接丢掉 mirror 任务；mirror 只在 Dexie 明确存在该 topic cache 时写回，避免 Storage v2 read-through 尚未 seed Dexie 时把 Redux 里的空 topic 误当作清空会话，并只同步当前对话引用到的文件元信息。
- Renderer 已加入普通对话 / 文件显式删除 tombstone：删除 topic 或文件时会写入 Storage v2 软删除，避免恢复后复活；单个 topic 删除、清空助手全部 topic、删除助手这类破坏性入口会先等待 legacy runtime 删除和 Storage v2 tombstone 路径完成，再更新助手列表 Redux runtime cache，`assistants` reducer 不再直接触发异步删除副作用；文件删除会先确认 Storage v2 tombstone 写入成功，再删除 legacy IndexedDB metadata 和本地文件，批量文件删除也会在任一 tombstone 失败时向上抛错，降低 UI 已删除但权威库尚未落盘的崩溃窗口。
- Renderer 已加入 Storage v2 -> 普通对话 read-through：启动恢复开启时优先从 Storage v2 读取普通聊天消息；Dexie cache 为空、消息块表缺失，Dexie 只投影了部分 Storage v2 topic，或 Dexie 中已有空 topic 但 Storage v2 中存在消息时，也会从 Storage v2 补齐消息、消息块、topic 元信息和文件 metadata。历史消息搜索、TopicManager 导出/知识库读取等仍从 legacy Dexie 投影读取的入口，会在 Dexie topic cache 为空、部分 topic 缺失、空 topic 需要复核或单个 topic 缺失时先从 Storage v2 恢复，避免产品名、appId 或 userData 路径变化后历史搜索、导出和知识库抽取短暂显示为空。Storage v2 中存在但消息数为 0 的 topic 会被视为权威空会话并回填空 Dexie cache，避免清空后的 topic 又从旧 IndexedDB 消息中复活；当 Storage v2 恢复删除了旧 file/image block 时，Dexie 会清理不再被任何 message block 引用的旧文件 metadata，但不会删除本地物理文件或反向写 Storage v2 tombstone，避免恢复后的文件列表出现孤儿记录。
- Renderer 已加入文件元信息 -> Storage v2 mirror：附件新增、更新、引用计数变化会通过 `file.upsert` 同步到 blob/file tables；如果 FileManager 的直接 `file.upsert` 失败，会把对应文件放回 file mirror 队列并立即 flush / 保留待重试任务，避免附件 metadata 只停留在 legacy Dexie；待同步文件在 flush 前已从 Dexie 消失时会补写 file tombstone，避免恢复后复活。
- Renderer 已加入文件 read-through：Storage v2 提供文件列表、单文件和 blob 投影 legacy `Data/Files` 的 IPC；文件页和 `FileManager.allFiles()` 会从 Storage v2 补齐 legacy `db.files` 中缺失的 active 文件 metadata 和 blob，即使 legacy 文件表已有部分数据也不会漏掉 Storage v2-only 文件；`FileManager.getFile()` 遇到单个文件缺失时也会按 id 恢复，降低附件、文件页和知识库文件在 userData 路径变化后短暂消失的概率。
- Renderer 已加入 Dexie settings read-through：用户头像/自定义 provider logo、pinned models、mention models 面板、MCP provider 服务列表、翻译页设置、迷你翻译和划词翻译读取 legacy `db.settings` 为空时，会按 `dexie.settings.<id>` 从 Storage v2 恢复；值为 `null` 的记录仍视为删除标记，不会重新写回 legacy。头像等显式删除会立即 flush 删除标记，避免删除后的读穿透把旧配置恢复回来。MCP provider token 因服务端 401/403 被清除时会等待 durable localStorage strict flush 成功，避免旧 token 从 Storage v2 恢复回来。
- Renderer 已加入 Dexie 辅助表 read-through：快速短语、自定义翻译语言和翻译历史在列表读取时会从 Storage v2 对应 `dexie-table:*` scope 补齐 legacy 表中缺失的 active 行，即使 legacy 表并非空表也不会漏掉 Storage v2 中已有的用户资产；知识库笔记按条读取、编辑、迁移或列表渲染时如果 legacy 行缺失，也会按 `dexie.table.knowledge_notes.<id>` 从 Storage v2 单条恢复，降低 userData 路径变化或旧库局部缺行导致用户资产短暂消失的概率。快捷短语、翻译语言、翻译历史和知识库笔记的新增、更新、删除会立即 flush 对应行或删除标记；新增自定义翻译语言前也会先恢复 Storage v2 中已有语言再判重，避免 legacy 只有部分数据时写出重复语言。
- Renderer / Main 已加入 Pi agent -> Storage v2 mirror：agent session 消息、agent/session/task/channel 等本地 IPC、本地 HTTP API、定时任务、claw MCP 工具和外部 channel 写操作进入 `agents.db` 后会导入 Storage v2，消息 exchange 持久化和 headless channel/scheduler exchange 完成后会立即 flush agent mirror，失败时保留待重试任务并安排延迟重试；agent 创建/更新/排序、session 创建/更新/排序、task 创建/更新/运行日志、channel 创建/更新，以及 skill 安装/更新/启停都会在成功写入 legacy 后立即 flush agent mirror；agent mirror 每次执行 prune 导入前会先用非 prune seed 合并当前 legacy，再从 Storage v2 投影回 `agents.db`，避免用户在路径变化后第一步直接创建/编辑 agent 时，用不完整 legacy runtime prune 掉 Storage v2 中已有的 agent/session/task/channel；agent/session/message/task/channel 删除会先确认目标存在并写 Storage v2 direct tombstone，其中 session 与对应 agent conversation 在同一事务内 tombstone，再删除 legacy runtime 并要求 strict mirror 成功，skill 卸载也会先写 Storage v2 skill tombstone，再删除全局 skill 目录和 legacy row 并 strict flush；若 tombstone 写入失败会保留 legacy 行不动，降低删除后崩溃或 Storage v2 临时不可写导致旧数据复活的风险；agent 删除现在会在 legacy `agents.db` 保留删除墓碑并清理 sessions/tasks/agent_skills、解绑 channel，普通用户创建的 agent 和内置 agent 都不会因为硬删丢掉本地删除证据；手动 legacy 导入和完整迁移仍默认保留 snapshot。Agent list/get/session/task/channel/message-history read 在 legacy runtime 为空、缺失或 agent 列表只包含部分可见 agent 时，会先用非 prune 模式把选中的 legacy data root 中仍存在的 `agents.db` 合并进 Storage v2，再串行投影 Storage v2 回当前 `agents.db` 后重读，避免投影重建时覆盖尚未镜像的 agent/session/task/channel 行；task/channel create 和 agent message persist 会先尝试恢复对应 runtime，再执行旧库写入；内置 agent 启动初始化前也会先尝试从 Storage v2 恢复，并且 legacy 里已有删除墓碑的 agent 不会被旧 Storage v2 数据复活；该 read-through / write-before-recovery 已覆盖 IPC、本地 HTTP API、调度器任务扫描/手动运行、Pi runtime 历史上下文加载、channel manager 启动/同步和 channel message session 解析，用于覆盖产品名或 userData 路径变化后的本地恢复场景。
- 主进程启动后、内置 agent 初始化前，会先 flush 待处理的 agent mirror，并把选中 data root 下的 `agents.db` / `app.db` 以非 prune 模式主动 seed 到 Storage v2。启动 seed 默认不额外创建 snapshot，避免每次打开应用产生重复保护点；相同启动周期内并发调用会复用同一个 in-flight promise；`agents.db` 和 `app.db` 的启动 seed 相互隔离，单侧失败只进入 warning，不会阻断另一侧旧库导入。这样即使用户刚经历产品名或 userData 路径变化，也能在首次进入 agent/app-data 读路径之前尽量完成旧库导入，同时不会把尚未镜像到当前 legacy runtime 的 Storage v2 行误判为删除；agent runtime 和 app-data runtime read-through 在 seed 当前 legacy 失败时会放弃本次 Storage v2 投影，避免旧 Storage v2 快照覆盖当前 legacy tombstone 或新写入行；内置 agent 初始化成功后也会立即 flush agent mirror，避免启动早期崩溃漏掉自动创建的内置 agent/session。
- Agent legacy 投影会保留 deleted agent tombstone，但只把 session、task、agent skill 等子表挂到可见 agent；如果旧 Storage v2 中残留了已删除 agent 下的 active 子行，投影会跳过这些子行，channel 也会恢复为未绑定 agent，避免删除 agent 后因为子表残留又出现孤儿 session/task。
- Agent / app-data 的 Storage v2 -> legacy runtime 并发读穿透会复用正在执行的投影；如果正在执行的投影没有命中当前请求，后续请求会按自己的 key/session/filter 重新检查 Storage v2，再决定是否投影，避免首屏并发读被无关的 false 结果压掉。
- 主进程 `getDataPath()` 已开始解析 Storage v2 稳定数据根：优先使用显式环境变量、已登记 active data root、当前路径已有数据、旧 Cherry/Perry 路径中的 manifest 或 legacy 数据，最后才回落到当前 Electron `userData/Data`。这让文件目录、知识库向量库、Skills、Agent 工作区、Channels、Workbench artifact 等仍走 legacy 文件系统 API 的模块，也能尽量落到同一个稳定 data root，降低产品名、appId 或 username 变化后在新空目录里继续写入的风险。`getDefaultDataPath()` 保留为“当前 Electron userData/Data”专用入口，供 data root discovery 做当前路径候选扫描。
- Filesystem MCP 默认工作区已改为 `getDataPath('Workspace')`，并补上路径边界和 symlink escape 校验；它不再固定落到当前 Electron `userData/Data/Workspace`，也不会在跟随符号链接时越过配置的 Workspace 根目录。
- 旧备份/重置留下的 `.restore` 目录会在 `app.whenReady()` 后第一时间完成切换，早于 Storage v2 config hydrate/mirror、启动 seed、窗口创建和 renderer 加载，避免恢复/重置启动时旧运行态先写回新库。每次恢复解压前会先清空 restore temp 目录，避免上一次失败残留的 `metadata.json` / `Data` 影响本次格式判断和恢复内容。factory reset 会先在 `Data.restore` 中预置全新的 Storage v2 manifest，再暂停 renderer mirror、清理 localStorage / IndexedDB 并重启；如果新 Data root staging 失败，不会先清掉 renderer runtime cache。切换完成后会立即把这个新路径重新注册为 active data root，避免旧产品名、旧用户名或旧配置里的 data root 继续优先命中，造成用户误以为重置失败或旧数据复活。
- 设置页提供手动“从 Storage v2 恢复运行时缓存”入口，可把 Storage v2 核心快照恢复到 Redux runtime cache；同时提供默认关闭的启动恢复开关，开启后会在 Redux ready 通知前从 Storage v2 hydrate runtime cache。自动恢复只把真实 runtime 数据视为可恢复内容，不会因为 Storage v2 内部 `storage-v2` 设置元数据存在就把空库误判成可恢复快照。

当前阶段仍不完全接管既有 Redux、IndexedDB、`agents.db` 或 `app.db` 的业务读写；其中 Redux、普通对话、文件、Pi agent 和 app-data 写入已经开始双写 / mirror 到 Storage v2，读取路径仍按模块逐步切换。
StorageService-first 写路径和 legacy 归档清理仍是后续步骤。

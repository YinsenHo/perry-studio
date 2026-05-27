---
name: knowledge
description: Cherry Studio Pi 知识库 CLI。用户想查看知识库、搜索知识库内容、定位知识库配置或用知识库资料回答问题时使用。
tags:
  - cherry-studio-pi
  - knowledge
  - rag
---

# Knowledge Skill

Use `perry-knowledge` to inspect and search the user's configured Cherry Studio Pi knowledge bases.

## Commands

```bash
perry-knowledge list
perry-knowledge get <base-id>
perry-knowledge search "query text" --count 5
perry-knowledge search "query text" --base <base-id> --count 8
perry-knowledge open
```

Prefer `search` over broad exports. Quote the user's exact query when possible, then summarize the returned chunks with the source knowledge base name.

If no knowledge base is configured or the embedding provider is unavailable, open the knowledge page and explain the specific missing prerequisite briefly.

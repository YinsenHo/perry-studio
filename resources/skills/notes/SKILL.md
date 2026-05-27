---
name: notes
description: Cherry Studio Pi 笔记模块 CLI。用户想创建、读取、搜索、更新、删除或打开 Cherry Studio Pi 笔记时使用。
tags:
  - cherry-studio-pi
  - notes
  - markdown
---

# Notes Skill

Use `perry-notes` for Cherry Studio Pi notes. Notes are Markdown files under the user's configured notes directory, and the CLI keeps paths inside that directory.

## Commands

```bash
perry-notes list
perry-notes read "note/path"
perry-notes search "keyword" --limit 50
perry-notes create "Meeting summary" "# Meeting summary"
perry-notes create "Draft" "content" --parent "projects"
perry-notes update "Meeting summary" "new markdown content"
perry-notes delete "Meeting summary"
perry-notes open
```

Before overwriting or deleting notes, confirm the target path with the user unless they explicitly requested that exact action. Prefer creating a new note for summaries, drafts, and extracted information.

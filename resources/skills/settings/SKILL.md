---
name: settings
description: Cherry Studio Pi 设置菜单 CLI。用户想查看、打开或调整服务商、模型、通用、显示、数据、环境依赖、MCP、Skills、联网搜索、记忆、API Server、快捷短语、快捷键等设置时使用。
tags:
  - cherry-studio-pi
  - settings
---

# Settings Skill

Use the `perry-settings` CLI before giving UI-only instructions. It talks to the running Cherry Studio Pi API and uses the current agent API key automatically.

## Commands

```bash
perry-settings sections
perry-settings get
perry-settings get navbarPosition
perry-settings set navbarPosition '"left"'
perry-settings open environment
```

Supported safe `set` paths include `language`, `targetLanguage`, `theme`, `fontSize`, `navbarPosition`, `assistantIconType`, `messageStyle`, `defaultPaintingProvider`, and `enableDeveloperMode`.

For unsupported or sensitive settings, open the relevant section and guide the user through the UI instead of inventing hidden state changes:

```bash
perry-settings open provider
perry-settings open mcp
perry-settings open api-server
```

Never print full API keys, tokens, passwords, or secret values. The CLI redacts them by default; keep them redacted in your response.

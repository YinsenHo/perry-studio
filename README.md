# Cherry Studio Pi

Cherry Studio Pi is a fork of [Cherry Studio](https://github.com/CherryHQ/cherry-studio), a cross-platform desktop client for working with multiple LLM providers on macOS, Windows, and Linux.

This fork keeps Cherry Studio's application foundation and AGPL-3.0 license, while replacing the agent runtime with [pi](https://github.com/earendil-works/pi). The goal is to keep the familiar Cherry Studio experience, but make agent execution feel calmer, more autonomous, and better suited to long-running workspace tasks.

## What Changed

- Replaced the previous agent runtime with the pi agent runtime.
- Preserved MCP support and automatic tool approval behavior.
- Improved agent task rendering so tool activity is summarized instead of flooding the chat.
- Softened transient tool errors and retry states in the conversation UI.
- Injected the configured agent display name into the runtime identity prompt.
- Updated the application name, package metadata, deep-link protocol, and app icon for Cherry Studio Pi.

## Features

- Multi-provider chat for OpenAI-compatible services and common LLM vendors.
- Agent mode for coding, file operations, dependency installation, MCP tools, and long-running tasks.
- MCP server integration with tool calling, OAuth, and runtime status handling.
- Knowledge base, web search, notes, translation, backup, and local data management.
- Cross-platform desktop packaging through Electron.

## Development

```bash
pnpm install
pnpm dev
```

For a production build:

```bash
pnpm build
pnpm build:mac
```

Use the platform-specific build script that matches your target environment.

## Upstream

Cherry Studio Pi is based on Cherry Studio. The original project, documentation, contributors, and ecosystem remain available at:

- Upstream repository: <https://github.com/CherryHQ/cherry-studio>
- Upstream documentation: <https://docs.cherry-ai.com>

## License

This project keeps the original open-source license unchanged.

Cherry Studio Pi is licensed under the GNU Affero General Public License v3.0. See [LICENSE](./LICENSE) for details.

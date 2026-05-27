---
name: painting
description: Cherry Studio Pi 绘图模块 CLI。用户想查看绘图服务商、绘图历史、默认绘图服务商，或需要跳转到绘图模块时使用。
tags:
  - cherry-studio-pi
  - painting
  - image
---

# Painting Skill

Use `perry-painting` for Cherry Studio Pi's drawing module state and navigation.

## Commands

```bash
perry-painting providers
perry-painting list
perry-painting list zhipu_paintings
perry-painting default
perry-painting default zhipu
perry-painting open
```

The CLI manages module state and history. It does not synthesize images by itself. When the user asks to create an image inside Cherry Studio Pi, check the default provider and open the drawing module if the generation needs UI-side provider credentials or upload controls.

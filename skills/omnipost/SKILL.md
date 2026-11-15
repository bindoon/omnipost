---
name: omnipost
description: Draft articles and videos to WeChat, Xiaohongshu, X, WeChat Channels, and Douyin with the local Omnipost CLI and Chrome extension. Use when the user asks to publish, stage, fill, or hand off a post, article, or video to these platforms. Never click public publish.
---

# Omnipost

把一篇文章或一条视频交接到本机 Omnipost。扩展只生成草稿或填写当前发布页，不点击发表、发布或 Post。

## 先确认命令

优先使用已安装的 `omnipost`。没有这个命令时，在 Omnipost 仓库里运行 `node cli.mjs`。需要从 npm 安装时再用 `npm install -g omnipost`。

桥接没开时，在后台启动 `omnipost serve`。令牌在本机 `.local/config.json`，不要打印到对话里，也不要写进仓库。

```sh
omnipost doctor
```

`connected` 不是 `true` 时，让用户在 Chrome 加载本仓库构建出的 `dist`，把 `omnipost pair` 的令牌贴进工作台的「连接 AI」，然后再执行。不要自己打开平台去点公开发布。

## 交接

文章：

```sh
omnipost draft '/绝对路径/article.md' --platforms wechat,xiaohongshu,x --stage
```

视频：

```sh
omnipost video '/绝对路径/video.mp4' \
  --title '短标题' \
  --description-file '/绝对路径/简介.txt' \
  --platforms xiaohongshu,x,channels,douyin \
  --stage
```

`--stage` 只把素材交给扩展，不自动打开平台。视频号和抖音即使不加 `--stage` 也不会自动打开编辑器。用户明确要求自动写入草稿时，小红书、X、公众号可以去掉 `--stage`；那仍然只保存草稿。

标题超限要停下来问用户，不要截断。平台文案不同时用 `--overrides` 指向 JSON。

## 把结果交还给人

用 `omnipost status TASK_ID` 查看状态。

- `ready`：素材已在扩展里。视频号和抖音需要用户打开对应的新视频发布页，点扩展图标，在侧栏选择这条内容并「填入这个页面」。
- `draft_ready`：平台草稿已保存，把编辑入口交给用户。
- `needs_attention` 或 `failed`：说明卡在哪一步。不要重试已经保存成功的平台，不要为了“完成”去点发表。

封面和 AI 声明留在平台里由用户确认。

---
name: omnipost
description: Draft and fill posts with the local Omnipost CLI and Chrome extension. For videos, prepare platform-native scheduling on Xiaohongshu, WeChat Channels, and Douyin. Native schedule submission requires explicit user authorization.
---

# Omnipost

把一篇文章或一条视频交接到本机 Omnipost。普通任务停在草稿或页面填充。用户明确要求提前提交视频定时预约时，可按下方定时流程操作。

## 先确认命令

优先使用已安装的 `omnipost`。没有这个命令时，在 Omnipost 仓库里运行 `node cli.mjs`。需要从 npm 安装时再用 `npm install -g omnipost`。

桥接没开时，在后台启动 `omnipost serve`。令牌在本机 `.local/config.json`，不要打印到对话里，也不要写进仓库。

```sh
omnipost doctor
```

`connected` 不是 `true` 时，先每 2 秒再查一次 `omnipost doctor`，最多等 40 秒。扩展会用已经保存的令牌自动重连。仍未连接时，请用户看工作台右上角：显示「正在连接 AI」就再等一会儿；只有从未配对时，才把 `omnipost pair` 的令牌贴进「连接 AI」一次。不要每次任务都要求重新粘贴令牌。不要自己打开平台去点公开发布。

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
  --platforms xiaohongshu,x,channels,douyin,bilibili,youtube,instagram \
  --stage
```

`--stage` 只把素材交给扩展，不自动打开平台。视频号、抖音、B 站、YouTube、Instagram 的普通交接任务在当前页填充。小红书和抖音可用下文的显式参数提交原生定时，B 站原生定时可打开并填入投稿页。用户明确要求自动写入草稿时，小红书、X、公众号可以去掉 `--stage`。

标题超限、正文超限、小红书/抖音/视频号正文里的链接或微信号、抖音超过 5 个话题、B 站超过 10 个标签、YouTube 标签里的 `<` `>`，都要停下来问用户，不要截断，也不要改成能发出去的样子。视频号短标题要有 6～16 个字符。B 站和 YouTube 的标签放在 overrides 的 `tags` 里，用空格或逗号分隔。

## 把结果交还给人

用 `omnipost status TASK_ID` 查看状态。

- `ready`：素材已在扩展里。视频号、抖音、B 站、YouTube、Instagram 需要用户打开对应的新视频发布页，点扩展图标，在侧栏选择这条内容并「填入这个页面」。YouTube 的上传页一旦选中视频就会存成私享视频。Instagram 从首页 `https://www.instagram.com/` 的创作弹窗填入。
- `draft_ready`：平台草稿已保存，把编辑入口交给用户。
- `needs_attention` 或 `failed`：说明卡在哪一步。不要重试已经保存成功的平台，不要为了“完成”去点发表。

任务里带了封面图时，小红书、视频号、抖音和 B 站会在封面弹窗里上传对应图片。小红书会尝试选 3:4，抖音有横竖页签时分别上传。裁切和 AI 声明仍由用户在平台确认。话题必须点中同名联想才算成功；没有点中时，状态说明里会写出话题名。

## 视频定时

为视频任务附上 `--schedule-at '2026-11-20T07:00:00+08:00'` 和 `--collection '平台显示的合集名'`。先用 `doctor` 确认 `nativeVideoSchedule`。需要在当前页操作时，用 `--stage` 导入，然后在侧栏点「填入素材和定时」。

小红书或抖音已有明确的定时提交授权时，附上 `--submit-scheduled`，同时保留视频、两张封面、平台文案和实际合集名。先排除作品管理中已有的同一集。只有 `scheduled` 附平台回执才算已提交。`schedule_ready` 表示编辑器已写入时间。`schedule_unconfirmed` 先查作品管理，再判断是否有必要恢复；勿重复投稿。视频号在侧栏填入后由人在原页核对提交。

B 站使用 `--platforms bilibili --schedule-at`，先查 `doctor.nativeBilibiliSchedule`。合集可省略，`--overrides` 的 `bilibili.category` 可指定分区。核对 B 站 4:3 首页封面、16:9 空间封面和原生定时时间后，在投稿页确认提交。

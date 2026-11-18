import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import vm from "node:vm";
import * as model from "../extension/shared/model.js";
import * as target from "../extension/shared/target.js";
const task = () =>
  model.validateTask({
    id: "staged-video",
    kind: "video",
    title: "虚与实",
    platforms: ["x"],
    delivery: "manual",
    assets: [
      { id: "v", name: "v.mp4", size: 20, role: "video", type: "video/mp4" },
    ],
  });
test("目标限定原发布页，拒绝同域其他页、伪造域名与重复上传", () => {
  const j = task();
  j.results = { x: { state: "ready" } };
  assert.equal(
    target.assertTarget(j, { url: "https://x.com/compose/post" }),
    "x",
  );
  for (const url of [
    "https://x.com/home",
    "https://x.com.evil.test/compose/post",
    "https://channels.weixin.qq.com/platform/post/create",
  ])
    assert.throws(() => target.assertTarget(j, { url }));
  j.results.x.state = "needs_attention";
  assert.equal(
    target.assertTarget(j, { url: "https://x.com/compose/post" }),
    "x",
  );
  j.results.x.state = "draft_ready";
  assert.throws(
    () => target.assertTarget(j, { url: "https://x.com/compose/post" }),
    /处理记录/,
  );
  j.results.x.state = "failed";
  assert.equal(
    target.assertTarget(j, { url: "https://x.com/compose/post" }),
    "x",
  );
  const channels = task();
  channels.platforms = ["channels"];
  channels.results = { channels: { state: "needs_attention" } };
  assert.equal(
    target.assertTarget(channels, {
      url: "https://channels.weixin.qq.com/platform/post/create",
    }),
    "channels",
  );
  assert.equal(
    target.assertTarget(channels, {
      url: "https://channels.weixin.qq.com/platform/post/coverEdit?objectId=export%2Fabc",
    }),
    "channels",
  );
  const douyin = task();
  douyin.platforms = ["douyin"];
  douyin.results = { douyin: { state: "ready" } };
  assert.equal(
    target.assertTarget(douyin, {
      url: "https://creator.douyin.com/creator-micro/content/upload",
    }),
    "douyin",
  );
  assert.throws(() =>
    target.assertTarget(douyin, {
      url: "https://creator.douyin.com/creator-micro/home",
    }),
  );
  assert.equal(
    target.surfaceFor("https://creator.xiaohongshu.com/publish/publish"),
    "panel",
  );
  assert.equal(
    target.surfaceFor("https://channels.weixin.qq.com/platform/post/create"),
    "panel",
  );
  assert.equal(
    target.surfaceFor("https://creator.douyin.com/creator-micro/home"),
    "panel",
  );
  assert.equal(target.surfaceFor("https://mp.weixin.qq.com/"), "panel");
  assert.equal(target.surfaceFor("https://example.com/"), "workbench");
});
test("素材交接不建平台页；点击插件保留标签；填充用原页并保持只填充", async () => {
  const jobs = new Map(),
    created = [],
    injected = [],
    messages = [];
  let listener, clicked;
  const side = [],
    updated = [];
  let pageUrl = "https://x.com/compose/post";
  const chrome = {
    runtime: {
      id: "ext",
      getURL: (p) => "chrome-extension://ext/" + p,
      onMessage: { addListener: (f) => (listener = f) },
    },
    storage: { local: { get: async () => ({}), set: async () => {} } },
    tabs: {
      onUpdated: { addListener() {} },
      onActivated: { addListener() {} },
      get: async (id) => ({
        id,
        url: pageUrl,
        status: "complete",
        windowId: 1,
      }),
      create: async (o) => {
        created.push(o);
        return { id: 99, ...o };
      },
      update: async (id, options) => updated.push({ id, ...options }),
      query: async () => [{ id: 42, url: pageUrl }],
      sendMessage: async (id, m) => {
        messages.push({ id, m });
        return {
          ok: true,
          result: {
            state: "needs_attention",
            persisted: false,
            message: "已填入",
            editorUrl: "https://x.com/compose/post",
          },
        };
      },
    },
    windows: { update: async () => {} },
    scripting: { executeScript: async (o) => injected.push(o) },
    action: { onClicked: { addListener: (f) => (clicked = f) } },
    sidePanel: {
      setOptions: async (o) => side.push(o),
      open: async (o) => side.push({ open: o.tabId }),
    },
    alarms: { onAlarm: { addListener() {} }, create() {} },
  };
  const source = (
    await fs.readFile(
      new URL("../extension/background.js", import.meta.url),
      "utf8",
    )
  ).replace(/^import[\s\S]*?from\s+["'][^"']+["'];\s*/gm, "");
  vm.runInNewContext(source, {
    ...model,
    ...target,
    chrome,
    console,
    URL,
    URLSearchParams,
    Map,
    Promise,
    Date,
    WebSocket: { OPEN: 1 },
    get: async (_, id) => jobs.get(id),
    put: async (_, j) => jobs.set(j.id, structuredClone(j)),
    all: async () => [],
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
  });
  const send = (message) =>
    new Promise((resolve) =>
      listener(
        message,
        { id: "ext", url: "chrome-extension://ext/workbench.html" },
        resolve,
      ),
    );
  assert.equal((await send({ type: "START", task: task() })).ok, true);
  for (
    let i = 0;
    i < 20 && jobs.get("staged-video")?.results.x.state !== "ready";
    i++
  )
    await new Promise(setImmediate);
  assert.equal(jobs.get("staged-video").results.x.state, "ready");
  const marked = await send({
    type: "MARK_PUBLISHED",
    id: "staged-video",
    platform: "x",
    published: true,
  });
  assert.equal(marked.ok, true);
  const stamp = jobs.get("staged-video").published.x;
  assert.match(stamp, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(
    (
      await send({
        type: "MARK_PUBLISHED",
        id: "staged-video",
        platform: "wechat",
        published: true,
      })
    ).ok,
    false,
  );
  assert.equal(created.length, 0);
  assert.equal(
    (
      await send({
        type: "START",
        task: model.validateTask({
          id: "auto-channels",
          kind: "video",
          title: "视频的短标题",
          platforms: ["channels"],
          assets: [
            {
              id: "v2",
              name: "v.mp4",
              size: 20,
              role: "video",
              type: "video/mp4",
            },
          ],
        }),
      })
    ).ok,
    true,
  );
  for (
    let i = 0;
    i < 20 && jobs.get("auto-channels")?.results.channels.state !== "ready";
    i++
  )
    await new Promise(setImmediate);
  assert.equal(jobs.get("auto-channels").results.channels.state, "ready");
  assert.match(jobs.get("auto-channels").results.channels.message, /发布页/);
  assert.equal(created.length, 0);
  await clicked({ id: 42, url: "https://x.com/compose/post" });
  assert.equal(created.length, 0);
  assert.equal(side[0].open, 42);
  assert.equal(side[1].tabId, 42);
  assert.match(side[1].path, /panel\.html\?tabId=42/);
  await clicked({
    id: 43,
    url: "https://creator.xiaohongshu.com/publish/publish?source=official",
  });
  assert.equal(created.length, 0);
  assert.equal(side[2].open, 43);
  assert.match(side[3].path, /panel\.html\?tabId=43/);
  assert.equal(
    (await send({ type: "FILL_CURRENT", id: "staged-video", tabId: 42 })).ok,
    true,
  );
  for (let i = 0; i < 20 && !messages.length; i++)
    await new Promise(setImmediate);
  assert.equal(created.length, 0);
  assert.equal(injected[0].target.tabId, 42);
  assert.equal(messages[0].id, 42);
  assert.equal(messages[0].m.task.fillOnly, true);
  await clicked({ id: 7, url: "https://example.com/" });
  assert.match(created[0].url, /workbench\.html$/);
  assert.doesNotMatch(created[0].url, /targetTab/);
  for (
    let i = 0;
    i < 20 && jobs.get("staged-video").results.x.state !== "needs_attention";
    i++
  )
    await new Promise(setImmediate);
  assert.equal(jobs.get("staged-video").results.x.state, "needs_attention");
  assert.equal(jobs.get("staged-video").published.x, stamp);
  assert.equal(
    (
      await send({
        type: "MARK_PUBLISHED",
        id: "staged-video",
        platform: "x",
        published: false,
      })
    ).ok,
    true,
  );
  assert.equal(jobs.get("staged-video").published.x, undefined);
  assert.equal(
    (await send({ type: "FILL_CURRENT", id: "staged-video", tabId: 42 })).ok,
    true,
  );
  for (let i = 0; i < 20 && messages.length < 2; i++)
    await new Promise(setImmediate);
  assert.equal(messages.length, 2);
  assert.equal(messages[1].m.task.fillOnly, true);
  for (let i = 0; i < 10; i++) await new Promise(setImmediate);
  pageUrl =
    "https://mp.weixin.qq.com/cgi-bin/appmsg?action=list_card&type=77&token=current-token";
  await clicked({ id: 42, url: pageUrl });
  assert.equal(side.at(-2).open, 42);
  assert.match(side.at(-1).path, /panel\.html\?tabId=42/);
  const navigation = await send({
    type: "OPEN_PLATFORM",
    platform: "wechat",
    kind: "article",
    tabId: 42,
  });
  assert.equal(navigation.ok, true);
  assert.equal(new URL(updated.at(-1).url).searchParams.get("type"), "10");
  assert.equal(
    new URL(updated.at(-1).url).searchParams.get("token"),
    "current-token",
  );
  const createdBeforeWechat = created.length;
  const article = model.validateTask({
    id: "staged-wx",
    kind: "article",
    title: "公众号文章",
    markdown: "正文",
    platforms: ["wechat"],
    delivery: "manual",
    assets: [],
    prepared: { wechat: "<p>正文</p>", media: [] },
  });
  assert.equal((await send({ type: "START", task: article })).ok, true);
  for (
    let i = 0;
    i < 20 && jobs.get(article.id)?.results.wechat.state !== "ready";
    i++
  )
    await new Promise(setImmediate);
  pageUrl = target.editorUrl("wechat", "article", pageUrl);
  assert.equal(
    (await send({ type: "FILL_CURRENT", id: article.id, tabId: 42 })).ok,
    true,
  );
  for (let i = 0; i < 20 && messages.length < 3; i++)
    await new Promise(setImmediate);
  assert.equal(created.length, createdBeforeWechat);
  assert.equal(injected.at(-1).target.tabId, 42);
  assert.equal(messages.at(-1).m.task.platform, "wechat");
  assert.equal(messages.at(-1).m.task.fillOnly, true);
  const before = created.length;
  const auto = model.validateTask({
    id: "auto-x-bg",
    kind: "video",
    title: "虚与实",
    platforms: ["x"],
    assets: [
      { id: "v3", name: "v.mp4", size: 20, role: "video", type: "video/mp4" },
    ],
  });
  for (let i = 0; i < 10; i++) await new Promise(setImmediate);
  assert.equal((await send({ type: "START", task: auto })).ok, true);
  for (let i = 0; i < 30 && created.length === before; i++)
    await new Promise(setImmediate);
  assert.equal(created.at(-1).active, false);
  assert.match(created.at(-1).url, /compose\/post/);
});

test("公众号入口使用当前会话的新文章地址，旧图文与已有草稿不能作为填充目标", () => {
  const list =
    "https://mp.weixin.qq.com/cgi-bin/appmsg?begin=0&count=10&type=77&action=list_card&token=current-session&lang=zh_CN";
  const url = target.editorUrl("wechat", "article", list);
  const params = new URL(url).searchParams;
  assert.equal(params.get("token"), "current-session");
  assert.equal(params.get("t"), "media/appmsg_edit_v2");
  assert.equal(params.get("type"), "10");
  assert.equal(params.get("isNew"), "1");
  assert.ok(Number(params.get("timestamp")) > 0);
  assert.equal(target.pageRole(url).role, "editor");
  assert.equal(target.pageRole(list).role, "site");
  assert.equal(
    target.pageRole("https://member.bilibili.com/platform/upload/video/frame")
      .role,
    "editor",
  );
  assert.equal(
    target.pageRole("https://studio.youtube.com/channel/UC1/videos/upload")
      .role,
    "editor",
  );
  assert.equal(
    target.pageRole(
      "https://studio.youtube.com/channel/UCtGHsC4k5P5rB84C4OpzADQ",
    ).role,
    "site",
  );
  assert.equal(
    target.editorUrl(
      "youtube",
      "video",
      "https://studio.youtube.com/channel/UCtGHsC4k5P5rB84C4OpzADQ",
    ),
    "https://studio.youtube.com/channel/UCtGHsC4k5P5rB84C4OpzADQ/videos/upload?d=ud",
  );
  assert.equal(
    target.editorUrl("youtube", "video"),
    "https://www.youtube.com/upload",
  );
  assert.equal(target.pageRole("https://www.instagram.com/").role, "editor");
  assert.equal(
    target.pageRole("https://www.instagram.com/reels/").role,
    "site",
  );
  assert.equal(target.surfaceFor("https://www.instagram.com/reels/"), "panel");
  const job = model.validateTask({
    id: "wx",
    kind: "article",
    title: "文章",
    markdown: "正文",
    platforms: ["wechat"],
    assets: [],
  });
  job.results = { wechat: { state: "needs_attention" } };
  assert.equal(target.assertTarget(job, { url }), "wechat");
  for (const invalid of [
    list,
    url + "&appmsgid=1",
    url.replace("appmsg_edit_v2", "appmsg_edit"),
    url.replace("type=10", "type=77"),
    url.replace("isNew=1", "isNew=0"),
  ]) {
    assert.equal(target.pageRole(invalid).role, "site");
    assert.throws(() => target.assertTarget(job, { url: invalid }), /新的创作/);
  }
  job.results.wechat.state = "draft_ready";
  assert.throws(() => target.assertTarget(job, { url }), /处理记录/);
  const noSession = new URL(
    target.editorUrl(
      "wechat",
      "article",
      "https://mp.weixin.qq.com.evil.test/?token=stolen",
    ),
  );
  assert.equal(noSession.searchParams.get("token"), null);
  assert.equal(noSession.searchParams.get("action"), "list_card");
});

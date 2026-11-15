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
    target.surfaceFor(
      "https://channels.weixin.qq.com/platform/post/create",
    ),
    "panel",
  );
  assert.equal(
    target.surfaceFor("https://creator.douyin.com/creator-micro/home"),
    "panel",
  );
  assert.equal(target.surfaceFor("https://mp.weixin.qq.com/"), "workbench");
  assert.equal(target.surfaceFor("https://example.com/"), "workbench");
});
test("素材交接不建平台页；点击插件保留标签；填充用原页并保持只填充", async () => {
  const jobs = new Map(),
    created = [],
    injected = [],
    messages = [];
  let listener, clicked;
  const side = [];
  const chrome = {
    runtime: {
      id: "ext",
      getURL: (p) => "chrome-extension://ext/" + p,
      onMessage: { addListener: (f) => (listener = f) },
    },
    storage: { local: { get: async () => ({}), set: async () => {} } },
    tabs: {
      onUpdated: { addListener() {} },
      get: async (id) => ({
        id,
        url: "https://x.com/compose/post",
        status: "complete",
        windowId: 1,
      }),
      create: async (o) => {
        created.push(o);
        return { id: 99, ...o };
      },
      update: async () => {},
      query: async () => [],
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
  assert.equal(created.length, 0);
  assert.equal(
    (
      await send({
        type: "START",
        task: model.validateTask({
          id: "auto-channels",
          kind: "video",
          title: "短标题",
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
  assert.equal(side[0].tabId, 42);
  assert.match(side[0].path, /panel\.html\?tabId=42/);
  assert.equal(side[1].open, 42);
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
});

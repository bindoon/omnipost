import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import vm from "node:vm";
import { parseHTML } from "linkedom";
import * as model from "../extension/shared/model.js";

test("侧栏用封面辨认草稿，并从顶部打开完整工作台", async () => {
  const { document } = parseHTML(
    '<html><body><div id="app"></div></body></html>',
  );
  const jobs = [
    {
      id: "old",
      kind: "video",
      title: "旧视频",
      description: "更早的一条",
      createdAt: "2026-11-01T00:00:00.000Z",
      platforms: ["douyin"],
      results: { douyin: { state: "ready", message: "待填充" } },
      assets: [],
    },
    {
      id: "v1",
      kind: "video",
      title: "虚与实到底是什么",
      description: "虚，就是气血少",
      createdAt: "2026-11-16T00:00:00.000Z",
      platforms: ["douyin"],
      results: { douyin: { state: "ready", message: "待填充" } },
      assets: [
        {
          id: "cover-1",
          role: "cover-portrait",
          name: "c.png",
          type: "image/png",
          size: 4,
        },
        {
          id: "cover-wide",
          role: "cover-landscape",
          name: "wide.png",
          type: "image/png",
          size: 4,
        },
      ],
    },
  ];
  const opened = [];
  const placed = [];
  const source = (
    await fs.readFile(new URL("../extension/panel.js", import.meta.url), "utf8")
  ).replace(/^import[\s\S]*?from\s+["'][^"']+["'];\s*/gm, "");
  class PreviewURL extends URL {
    static createObjectURL() {
      return "blob:thumb";
    }
    static revokeObjectURL() {}
  }
  vm.runInContext(
    source,
    vm.createContext({
      document,
      location: { search: "" },
      URL: PreviewURL,
      URLSearchParams,
      Blob,
      atob,
      Uint8Array,
      console,
      ...model,
      chrome: {
        runtime: {
          id: "a".repeat(32),
          async sendMessage(message) {
            if (message.type === "STATE")
              return { ok: true, jobs, bridge: { connected: false } };
            if (message.type === "TARGET")
              return {
                ok: true,
                target: { id: 7, platform: "douyin", role: "editor" },
              };
            if (message.type === "UI_ASSET")
              return { ok: true, chunks: [btoa("png")] };
            if (message.type === "OPEN_WORKBENCH") {
              opened.push(message.type);
              return { ok: true };
            }
            if (message.type === "PLACE_COVER") {
              placed.push(message);
              return { ok: true };
            }
            return { ok: true };
          },
        },
        tabs: {
          query: async () => [{ id: 7 }],
          onUpdated: { addListener() {} },
          onActivated: { addListener() {} },
        },
        storage: { onChanged: { addListener() {} } },
      },
    }),
  );
  await new Promise(setImmediate);
  await new Promise(setImmediate);
  assert.deepEqual(
    [...document.querySelectorAll("h2")].map((el) => el.textContent),
    ["虚与实到底是什么", "旧视频"],
  );
  const thumb = document.querySelector("[data-thumb-for=v1]");
  assert.equal(thumb.querySelector("img").getAttribute("src"), "blob:thumb");
  assert.equal(document.querySelector("[data-delete]"), null);
  const guide = document.querySelector("[data-action=workbench]");
  assert.match(guide.textContent, /打开完整工作台/);
  guide.click();
  await new Promise(setImmediate);
  assert.deepEqual(opened, ["OPEN_WORKBENCH"]);
  assert.match(document.body.textContent, /按住封面向左拖/);
  assert.match(document.body.textContent, /下载竖封面/);
  assert.match(document.body.textContent, /下载横封面/);
  const portrait = document.querySelector("[data-download-for=cover-1]");
  const landscape = document.querySelector("[data-download-for=cover-wide]");
  assert.equal(portrait.getAttribute("download"), "c.png");
  assert.equal(portrait.getAttribute("href"), "blob:thumb");
  assert.equal(portrait.getAttribute("aria-disabled"), null);
  assert.equal(landscape.getAttribute("download"), "wide.png");
  assert.equal(landscape.getAttribute("href"), "blob:thumb");
  document.querySelector("[data-cover-id=cover-1]").click();
  await new Promise(setImmediate);
  await new Promise(setImmediate);
  const dialog = document.querySelector("dialog");
  assert.match(dialog.textContent, /按住封面向左拖到上传区/);
  assert.equal(placed.length, 0);
  dialog.querySelector("[data-place]").click();
  await new Promise(setImmediate);
  assert.equal(placed[0].id, "v1");
  assert.equal(placed[0].assetId, "cover-1");
  assert.equal(placed[0].tabId, 7);
});

test("公众号侧栏在草稿列表提供新建引导，进入文章编辑器后显示文章填充并允许失败后重试", async () => {
  const { document } = parseHTML(
    '<html><body><div id="app"></div></body></html>',
  );
  const jobs = [
    {
      id: "article",
      kind: "article",
      title: "文章标题",
      description: "摘要",
      assets: [],
      platforms: ["wechat"],
      results: { wechat: { state: "failed", message: "上次未找到编辑器" } },
    },
    {
      id: "video",
      kind: "video",
      title: "不该显示的视频",
      assets: [],
      platforms: ["x"],
      results: {},
    },
  ];
  let role = "site",
    updated;
  const sent = [];
  const source = (
    await fs.readFile(new URL("../extension/panel.js", import.meta.url), "utf8")
  ).replace(/^import[\s\S]*?from\s+["'][^"']+["'];\s*/gm, "");
  vm.runInNewContext(source, {
    document,
    location: { search: "?tabId=7" },
    URLSearchParams,
    URL,
    console,
    ...model,
    chrome: {
      runtime: {
        sendMessage: async (message) => {
          sent.push(message);
          if (message.type === "STATE") return { ok: true, jobs };
          if (message.type === "TARGET")
            return { ok: true, target: { id: 7, platform: "wechat", role } };
          return { ok: true };
        },
      },
      tabs: {
        onUpdated: { addListener: (fn) => (updated = fn) },
        onActivated: { addListener() {} },
      },
      storage: { onChanged: { addListener() {} } },
    },
  });
  await new Promise(setImmediate);
  assert.match(document.body.textContent, /新的创作 → 文章/);
  assert.equal(document.querySelector("[data-fill]"), null);
  document.querySelector("[data-action=open-editor]").click();
  await new Promise(setImmediate);
  const navigation = sent.find((m) => m.type === "OPEN_PLATFORM");
  assert.equal(navigation.kind, "article");
  assert.equal(navigation.tabId, 7);
  role = "editor";
  updated(7, { status: "complete" });
  await new Promise(setImmediate);
  assert.match(document.body.textContent, /上次未找到编辑器/);
  assert.doesNotMatch(document.body.textContent, /不该显示的视频/);
  const button = document.querySelector('[data-fill="article"]');
  assert.ok(button);
  button.click();
  await new Promise(setImmediate);
  assert.equal(sent.find((m) => m.type === "FILL_CURRENT").tabId, 7);
  assert.match(document.body.textContent, /复制微信正文/);
});

test("跳到发布页时侧栏跟着当前标签更新，不用关掉再打开", async () => {
  const { document } = parseHTML(
    '<html><body><div id="app"></div></body></html>',
  );
  const jobs = [
    {
      id: "new-video",
      kind: "video",
      title: "手麻，都是气血不通吗",
      createdAt: "2026-11-16T00:00:00.000Z",
      platforms: ["douyin"],
      results: { douyin: { state: "ready" } },
      assets: [],
    },
  ];
  let tabId = 3;
  let activated;
  const source = (
    await fs.readFile(new URL("../extension/panel.js", import.meta.url), "utf8")
  ).replace(/^import[\s\S]*?from\s+["'][^"']+["'];\s*/gm, "");
  vm.runInNewContext(source, {
    document,
    location: { search: "?tabId=3" },
    URLSearchParams,
    URL,
    console,
    ...model,
    chrome: {
      runtime: {
        sendMessage: async (message) => {
          if (message.type === "STATE") return { ok: true, jobs };
          if (message.type === "TARGET")
            return {
              ok: true,
              target:
                tabId === 9
                  ? { id: 9, platform: "douyin", role: "editor" }
                  : { id: tabId, role: "other", platform: null },
            };
          return { ok: true };
        },
      },
      tabs: {
        query: async () => [{ id: tabId }],
        onUpdated: { addListener() {} },
        onActivated: { addListener: (fn) => (activated = fn) },
      },
      storage: { onChanged: { addListener() {} } },
    },
  });
  await new Promise(setImmediate);
  assert.match(document.body.textContent, /当前页不是支持的发布页/);
  tabId = 9;
  activated({ tabId: 9, windowId: 1 });
  await new Promise(setImmediate);
  await new Promise(setImmediate);
  assert.match(document.body.textContent, /手麻，都是气血不通吗/);
  assert.doesNotMatch(document.body.textContent, /当前页不是支持的发布页/);
});

test("X 中断后侧栏保留提示并可重试，已保存草稿仍禁止重复填充", async () => {
  const { document } = parseHTML(
    '<html><body><div id="app"></div></body></html>',
  );
  const job = {
    id: "interrupted-x",
    kind: "video",
    title: "视频",
    assets: [],
    platforms: ["x"],
    results: {
      x: {
        state: "needs_attention",
        message: "扩展曾中断，请检查现有草稿后再重试",
      },
    },
  };
  let changed;
  const sent = [];
  const source = (
    await fs.readFile(new URL("../extension/panel.js", import.meta.url), "utf8")
  ).replace(/^import[\s\S]*?from\s+["'][^"']+["'];\s*/gm, "");
  vm.runInNewContext(source, {
    document,
    location: { search: "?tabId=7" },
    URLSearchParams,
    URL,
    console,
    ...model,
    chrome: {
      runtime: {
        sendMessage: async (m) => {
          sent.push(m);
          if (m.type === "STATE") return { ok: true, jobs: [job] };
          if (m.type === "TARGET")
            return {
              ok: true,
              target: { id: 7, platform: "x", role: "editor" },
            };
          return { ok: true };
        },
      },
      tabs: {
        onUpdated: { addListener() {} },
        onActivated: { addListener() {} },
      },
      storage: {
        onChanged: {
          addListener(fn) {
            changed = fn;
          },
        },
      },
    },
  });
  await new Promise(setImmediate);
  assert.match(document.body.textContent, /扩展曾中断/);
  assert.ok(document.querySelector('[data-fill="interrupted-x"]'));
  document.querySelector('[data-fill="interrupted-x"]').click();
  await new Promise(setImmediate);
  assert.equal(sent.find((m) => m.type === "FILL_CURRENT").tabId, 7);
  job.results.x = { state: "draft_ready", message: "已保存" };
  changed({ "publisher.lastUpdate": {} });
  await new Promise(setImmediate);
  assert.equal(document.querySelector("[data-fill]"), null);
});

test("打开发布页后，刚点的视频排在侧栏最上面并标为待提交", async () => {
  const { document } = parseHTML(
    '<html><body><div id="app"></div></body></html>',
  );
  const jobs = [
    {
      id: "new",
      kind: "video",
      title: "较新的一条",
      createdAt: "2026-11-18T00:00:00.000Z",
      platforms: ["douyin"],
      results: { douyin: { state: "ready" } },
      assets: [],
    },
    {
      id: "picked",
      kind: "video",
      title: "经络的名字",
      createdAt: "2026-11-17T00:00:00.000Z",
      platforms: ["douyin"],
      results: { douyin: { state: "ready" } },
      assets: [],
    },
  ];
  const source = (
    await fs.readFile(new URL("../extension/panel.js", import.meta.url), "utf8")
  ).replace(/^import[\s\S]*?from\s+["'][^"']+["'];\s*/gm, "");
  vm.runInNewContext(source, {
    document,
    location: { search: "?tabId=7&focus=picked" },
    URLSearchParams,
    URL,
    console,
    ...model,
    chrome: {
      runtime: {
        sendMessage: async (message) => {
          if (message.type === "STATE") return { ok: true, jobs };
          if (message.type === "TARGET")
            return {
              ok: true,
              target: { id: 7, platform: "douyin", role: "editor" },
            };
          return { ok: true };
        },
      },
      tabs: {
        query: async () => [{ id: 7 }],
        onUpdated: { addListener() {} },
        onActivated: { addListener() {} },
      },
      storage: { onChanged: { addListener() {} } },
    },
  });
  await new Promise(setImmediate);
  await new Promise(setImmediate);
  assert.deepEqual(
    [...document.querySelectorAll("h2")].map((el) => el.textContent),
    ["经络的名字", "较新的一条"],
  );
  const first = document.querySelector(".card");
  assert.equal(first.classList.contains("pending"), true);
  assert.match(first.textContent, /待提交/);
  assert.doesNotMatch(
    document.querySelectorAll(".card")[1].textContent,
    /待提交/,
  );
});

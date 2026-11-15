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
      id: "v1",
      kind: "video",
      title: "虚与实到底是什么",
      description: "虚，就是气血少",
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
      ],
    },
  ];
  const opened = [];
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
            return { ok: true };
          },
        },
        tabs: {
          query: async () => [{ id: 7 }],
          onUpdated: { addListener() {} },
        },
        storage: { onChanged: { addListener() {} } },
      },
    }),
  );
  await new Promise(setImmediate);
  await new Promise(setImmediate);
  const thumb = document.querySelector("[data-thumb-for=v1]");
  assert.equal(thumb.querySelector("img").getAttribute("src"), "blob:thumb");
  assert.equal(document.querySelector("[data-delete]"), null);
  const guide = document.querySelector("[data-action=workbench]");
  assert.match(guide.textContent, /打开完整工作台/);
  guide.click();
  await new Promise(setImmediate);
  assert.deepEqual(opened, ["OPEN_WORKBENCH"]);
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
      tabs: { onUpdated: { addListener: (fn) => (updated = fn) } },
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

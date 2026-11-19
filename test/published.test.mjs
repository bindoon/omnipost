import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import vm from "node:vm";
import { parseHTML } from "linkedom";
import {
  compactTitle,
  titlesMatch,
  parseCount,
  matchPublished,
  formatLikes,
} from "../extension/shared/published.js";
import { worksUrl } from "../extension/shared/target.js";

test("标题去掉空白和话题后，截断的平台标题仍能对上，过短的不行", () => {
  assert.equal(
    compactTitle("经络的名字，其实是一个地址 #中医"),
    "经络的名字其实是一个地址",
  );
  assert.equal(
    titlesMatch("经络的名字，其实是一个地址", "经络的名字，其实是一个地址"),
    true,
  );
  assert.equal(
    titlesMatch("经络的名字，其实是一个地址", "经络的名字，其实是一个地"),
    true,
  );
  assert.equal(titlesMatch("手麻都是气血不通吗", "手麻"), false);
  assert.equal(titlesMatch("气血不通", "气血通畅的人不会手麻"), false);
  assert.equal(parseCount("1.2万"), 12000);
  assert.equal(parseCount("1,234"), 1234);
  assert.equal(formatLikes(12000), "1.2万赞");
  assert.equal(formatLikes(86), "86赞");
});

test("只有唯一标题才算已发布，撞标题或没有点赞文本都不误记", () => {
  const items = [
    { title: "经络的名字，其实是一个地址", likesText: "点赞 86" },
    { title: "另一条", likesText: "3.5万赞" },
    { title: "重复的标题", likesText: "1" },
    { title: "重复的标题", likesText: "2" },
  ];
  const matched = matchPublished(
    [
      { id: "a", title: "经络的名字，其实是一个地址" },
      { id: "b", title: "没有的标题啊" },
      { id: "c", title: "重复的标题" },
    ],
    items,
  );
  assert.equal(matched.a.found, true);
  assert.equal(matched.a.likes, 86);
  assert.equal(matched.b.found, false);
  assert.equal(matched.c.found, false);
  assert.match(matched.c.reason, /不唯一/);
});

async function readWorks(body, url) {
  const { document } = parseHTML(`<html><body>${body}</body></html>`);
  const source = await fs.readFile(
    new URL("../extension/content/published.js", import.meta.url),
    "utf8",
  );
  let listener;
  vm.runInNewContext(source, {
    document,
    location: new URL(url),
    chrome: {
      runtime: {
        id: "ext",
        onMessage: { addListener: (fn) => (listener = fn) },
      },
      dom: {},
    },
    URL,
  });
  return new Promise((resolve) =>
    listener({ type: "READ_WORKS" }, { id: "ext" }, resolve),
  );
}

test("作品列表读出标题和点赞，登录页不假装已经对上", async () => {
  const page = await readWorks(
    '<div class="video-item"><a class="title" href="https://www.bilibili.com/video/BV1">经络的名字，其实是一个地址</a><span>点赞 1.2万</span></div>',
    "https://member.bilibili.com/platform/upload-manager/video",
  );
  assert.equal(page.ok, true);
  assert.equal(page.items[0].title, "经络的名字，其实是一个地址");
  assert.equal(page.items[0].likesText, "1.2万");
  assert.equal(page.loggedOut, false);
  assert.equal(
    worksUrl("youtube", "https://studio.youtube.com/channel/UCabc/videos"),
    "https://studio.youtube.com/channel/UCabc/videos",
  );
});

test("作品卡片内嵌套的标题只读一次，两个同名作品仍算两条", async () => {
  const page = await readWorks(
    `<main>
      <article><div class="note-title"><span class="title">同名的作品标题</span></div></article>
      <article><div class="note-title">同名的作品标题</div></article>
      <article><div class="note-title"><span class="title">只有一条的标题</span></div></article>
    </main>`,
    "https://creator.xiaohongshu.com/new/note-manager",
  );
  assert.equal(page.items.length, 3);
  const matched = matchPublished(
    [
      { id: "ambiguous", title: "同名的作品标题" },
      { id: "unique", title: "只有一条的标题" },
    ],
    page.items,
  );
  assert.deepEqual(matched.ambiguous, { found: false, reason: "标题不唯一" });
  assert.equal(matched.unique.found, true);
});

test("作品卡片明确显示定时或审核状态时不标为已发", async () => {
  const page = await readWorks(
    `<main>
      <div class="content-item"><div class="title">已经预约的作品</div><p>定时发布 2026年11月25日 07:00</p><span>审核中</span></div>
      <div class="content-item"><div class="title">仍在审核的作品</div><span>审核中</span></div>
      <div class="content-item"><div class="title">定时发布功能指南</div><div><button><span>定时发布</span></button></div><span hidden>草稿</span><span>点赞 26</span></div>
    </main>`,
    "https://creator.douyin.com/creator-micro/content/manage",
  );
  const matched = matchPublished(
    [
      { id: "scheduled", title: "已经预约的作品" },
      { id: "reviewing", title: "仍在审核的作品" },
      { id: "published", title: "定时发布功能指南" },
    ],
    page.items,
  );
  assert.deepEqual(matched.scheduled, {
    found: false,
    reason: "平台状态为「定时发布」",
  });
  assert.deepEqual(matched.reviewing, {
    found: false,
    reason: "平台状态为「审核中」",
  });
  assert.equal(matched.published.found, true);
  assert.equal(matched.published.likes, 26);
});

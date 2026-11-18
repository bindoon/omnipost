import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { WebSocket } from "ws";
import { startBridge } from "../bridge/server.mjs";
import { X_REPLY_ENABLED } from "../extension/shared/model.js";
const token = "a".repeat(64);
const task = (id = "job-1", platforms = ["x"]) => ({
  id,
  kind: "article",
  title: "测试标题",
  markdown: "# 测试标题\n\n完整正文。",
  assets: [],
  platforms,
  mode: "draft",
});
async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "publisher-bridge-"));
  const b = await startBridge({ port: 0, dataDir: dir, token });
  t.after(async () => {
    await b.close();
    await fs.rm(dir, { recursive: true, force: true });
  });
  const root = "http://127.0.0.1:" + b.port;
  async function req(route, method = "GET", body, headers = {}) {
    const r = await fetch(root + route, {
      method,
      headers: {
        Authorization: "Bearer " + token,
        "Content-Type": "application/json",
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: r.status, value: await r.json() };
  }
  return { b, dir, root, req };
}
function inbox(ws) {
  const values = [],
    waiters = [];
  ws.on("message", (raw) => {
    const m = JSON.parse(raw);
    const w = waiters.shift();
    if (w) w(m);
    else values.push(m);
  });
  return () =>
    values.length
      ? Promise.resolve(values.shift())
      : new Promise((resolve, reject) => {
          const timer = setTimeout(
            () => reject(new Error("WS message timeout")),
            3000,
          );
          waiters.push((v) => {
            clearTimeout(timer);
            resolve(v);
          });
        });
}
async function worker(t, b, capabilities = ["manual-stage"]) {
  const ws = new WebSocket("ws://127.0.0.1:" + b.port + "/worker");
  const next = inbox(ws);
  t.after(() => ws.terminate());
  await new Promise((resolve, reject) => {
    ws.once("open", resolve);
    ws.once("error", reject);
  });
  ws.send(JSON.stringify({ type: "hello", token, capabilities }));
  assert.equal((await next()).type, "hello");
  return { ws, next };
}
const saved = {
  state: "draft_ready",
  persisted: true,
  evidence: "平台返回独立草稿ID",
  draftUrl: "https://x.com/compose/articles/edit/123",
  message: "草稿已保存",
};
async function until(check) {
  for (let i = 0; i < 50; i++) {
    const value = await check();
    if (value) return value;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error("Condition timeout");
}
test("桥接需要令牌并拒绝普通网页来源，健康检查不会暴露任务正文", async (t) => {
  const { req, root } = await fixture(t);
  assert.equal((await fetch(root + "/jobs")).status, 401);
  assert.equal(
    (await req("/jobs", "GET", undefined, { Origin: "https://evil.example" }))
      .status,
    403,
  );
  const health = await req("/health");
  assert.equal(health.value.connected, false);
  assert.equal("token" in health.value, false);
  const origin = "chrome-extension://" + "a".repeat(32);
  const preflight = await fetch(root + "/health", {
    method: "OPTIONS",
    headers: {
      Origin: origin,
      "Access-Control-Request-Method": "GET",
      "Access-Control-Request-Headers": "authorization",
      "Access-Control-Request-Private-Network": "true",
    },
  });
  assert.equal(preflight.status, 204);
  assert.equal(
    preflight.headers.get("access-control-allow-private-network"),
    "true",
  );
  assert.equal(preflight.headers.get("access-control-allow-origin"), origin);
});
test("AI 提交→模拟扩展领取与保存回包→AI 得到草稿链接；同一任务重复提交不重复分发", async (t) => {
  const { b, req } = await fixture(t);
  const w = await worker(t, b);
  assert.equal((await req("/jobs", "POST", task())).status, 201);
  const m = await w.next();
  assert.equal(m.type, "task");
  assert.deepEqual(m.task.platforms, ["x"]);
  assert.match(m.task.prepared.x, /完整正文/);
  w.ws.send(
    JSON.stringify({
      type: "result",
      id: m.task.id,
      platform: "x",
      result: saved,
    }),
  );
  await w.next();
  const result = await req("/jobs/job-1");
  assert.equal(result.value.results.x.state, "draft_ready");
  assert.equal(result.value.results.x.draftUrl, saved.draftUrl);
  assert.equal((await req("/jobs", "POST", task())).status, 200);
  assert.equal((await req("/jobs/job-1/retry/x", "POST", {})).status, 409);
});
test(
  "X 回复暂时关闭时桥接拒绝新的回复任务",
  { skip: X_REPLY_ENABLED },
  async (t) => {
    const { req } = await fixture(t);
    const res = await req("/jobs", "POST", {
      kind: "x_reply",
      platforms: ["x"],
      mode: "review",
      targetUrl: "https://x.com/Author/status/123?s=20",
      description: "给原帖补一个例子。",
    });
    assert.equal(res.status, 400);
    assert.match(res.value.error, /暂时关闭/);
  },
);
test(
  "X 回复通过本地桥接交给扩展审阅，原帖去重且结果独立于平台草稿",
  { skip: !X_REPLY_ENABLED },
  async (t) => {
    const { b, req } = await fixture(t);
    const w = await worker(t, b);
    const reply = {
      kind: "x_reply",
      platforms: ["x"],
      mode: "review",
      targetUrl: "https://x.com/Author/status/123?s=20",
      description: "给原帖补一个例子。",
    };
    assert.equal(
      (await req("/jobs", "POST", { ...reply, mode: "publish" })).status,
      400,
    );
    assert.equal(
      (
        await req("/jobs", "POST", {
          ...reply,
          targetUrl: "https://x.com.evil.example/Author/status/123",
        })
      ).status,
      400,
    );
    assert.equal((await req("/jobs", "POST", reply)).status, 201);
    const { task: received } = await w.next();
    assert.equal(received.id, "x-reply-123");
    assert.equal(received.targetUrl, "https://x.com/author/status/123");
    w.ws.send(
      JSON.stringify({
        type: "result",
        id: received.id,
        platform: "x",
        result: saved,
      }),
    );
    assert.equal((await w.next()).type, "error");
    w.ws.send(
      JSON.stringify({
        type: "result",
        id: received.id,
        platform: "x",
        result: { state: "review_ready" },
      }),
    );
    assert.equal((await w.next()).type, "ack");
    const { value } = await req("/jobs/x-reply-123");
    assert.equal(value.results.x.state, "review_ready");
    assert.equal(value.results.x.draftUrl, undefined);
    assert.equal((await req("/jobs", "POST", reply)).status, 200);
    assert.equal(
      (await req("/jobs", "POST", { ...reply, description: "改稿" })).status,
      409,
    );
  },
);
test("失败平台可单独重试，已经保存的平台不再次创建草稿", async (t) => {
  const { b, req } = await fixture(t);
  const w = await worker(t, b);
  await req("/jobs", "POST", task("split", ["wechat", "x"]));
  await w.next();
  w.ws.send(
    JSON.stringify({
      type: "result",
      id: "split",
      platform: "wechat",
      result: { state: "needs_attention", message: "需要登录" },
    }),
  );
  await w.next();
  w.ws.send(
    JSON.stringify({
      type: "result",
      id: "split",
      platform: "x",
      result: saved,
    }),
  );
  await w.next();
  assert.equal((await req("/jobs/split/retry/wechat", "POST", {})).status, 200);
  const retry = await w.next();
  assert.deepEqual(retry.task.platforms, ["wechat"]);
  assert.equal((await req("/jobs/split")).value.results.x.state, "draft_ready");
});
test("断线后保留不确定状态，重新连接不会自动重复提交；状态落盘可恢复", async (t) => {
  const { b, req, dir } = await fixture(t);
  const w = await worker(t, b);
  await req("/jobs", "POST", task("disconnect"));
  await w.next();
  w.ws.close();
  await until(async () => !(await req("/health")).value.connected);
  const result = await req("/jobs/disconnect");
  assert.equal(result.value.results.x.state, "needs_attention");
  await until(async () => {
    const data = JSON.parse(
      await fs.readFile(path.join(dir, "jobs/disconnect.json"), "utf8"),
    );
    return data.results.x.state === "needs_attention";
  });
  const w2 = await worker(t, b);
  assert.equal((await req("/health")).value.pending, 0);
  w2.ws.send(JSON.stringify({ type: "ping" }));
  assert.equal((await w2.next()).type, "pong");
});
test("不带保存证据的成功回报被拒绝，不能制造草稿成功状态", async (t) => {
  const { b, req } = await fixture(t);
  const w = await worker(t, b);
  await req("/jobs", "POST", task("proof"));
  await w.next();
  w.ws.send(
    JSON.stringify({
      type: "result",
      id: "proof",
      platform: "x",
      result: { state: "draft_ready", persisted: false },
    }),
  );
  assert.equal((await w.next()).type, "error");
  assert.notEqual(
    (await req("/jobs/proof")).value.results.x.state,
    "draft_ready",
  );
});
test("素材按1MB分片传输，内容保持一致；源文件改动会被阻止", async (t) => {
  const { req, dir } = await fixture(t);
  const data = Buffer.alloc(1024 ** 2 + 37, 7),
    file = path.join(dir, "video.mp4");
  await fs.writeFile(file, data);
  await req("/jobs", "POST", {
    id: "video",
    kind: "video",
    title: "视频",
    description: "介绍",
    platforms: ["x"],
    assets: [
      {
        id: "asset",
        name: "video.mp4",
        path: "video.mp4",
        filePath: file,
        type: "video/mp4",
        size: data.length,
        role: "video",
      },
    ],
  });
  const chunks = await Promise.all(
    [0, 1].map((i) => req("/jobs/video/assets/asset?chunk=" + i)),
  );
  assert.deepEqual(
    Buffer.concat(chunks.map((c) => Buffer.from(c.value.chunk, "base64"))),
    data,
  );
  assert.equal((await req("/jobs/video/assets/asset?chunk=2")).status, 400);
  await fs.appendFile(file, "changed");
  assert.equal((await req("/jobs/video/assets/asset?chunk=0")).status, 400);
  const listed = await req("/jobs/video");
  assert.equal(listed.value.assets[0].filePath, undefined);
});
test("草稿打开指令经过已认证扩展，接口不会把会话令牌写入返回链接", async (t) => {
  const { b, req } = await fixture(t);
  const w = await worker(t, b);
  await req("/jobs", "POST", task("open"));
  await w.next();
  w.ws.send(
    JSON.stringify({
      type: "result",
      id: "open",
      platform: "x",
      result: { ...saved, draftUrl: saved.draftUrl + "?token=private-token" },
    }),
  );
  await w.next();
  assert.doesNotMatch(
    JSON.stringify((await req("/jobs/open")).value),
    /private-token/,
  );
  assert.equal((await req("/jobs/open/open/x", "POST", {})).status, 200);
  assert.deepEqual(await w.next(), { type: "open", id: "open", platform: "x" });
});

test("AI CLI 默认输出任务摘要，--full 才返回完整正文", async (t) => {
  const { dir, req } = await fixture(t);
  await req("/jobs", "POST", task("compact"));
  const run = promisify(execFile);
  const cli = new URL("../cli.mjs", import.meta.url).pathname;
  const args = { env: { ...process.env, OMNIPOST_HOME: dir } };
  const compact = JSON.parse(
    (await run(process.execPath, [cli, "status", "compact"], args)).stdout,
  );
  assert.equal(compact.id, "compact");
  assert.equal(compact.assetCount, 0);
  assert.equal(compact.markdown, undefined);
  assert.equal(compact.prepared, undefined);
  const full = JSON.parse(
    (await run(process.execPath, [cli, "status", "compact", "--full"], args))
      .stdout,
  );
  assert.match(full.markdown, /完整正文/);
  assert.match(full.prepared.x, /完整正文/);
});

test("手动交接先 ready，之后原页执行状态能回传而不重新派发", async (t) => {
  const { b, req } = await fixture(t);
  const { ws, next } = await worker(t, b);
  await req("/jobs", "POST", { ...task("manual-job"), delivery: "manual" });
  assert.equal((await next()).task.delivery, "manual");
  const result = async (state) => {
    ws.send(
      JSON.stringify({
        type: "result",
        id: "manual-job",
        platform: "x",
        result: { state, message: state },
      }),
    );
    assert.equal((await next()).type, "ack");
  };
  await result("ready");
  assert.equal((await req("/jobs/manual-job")).value.results.x.state, "ready");
  await result("opening");
  await result("needs_attention");
  assert.equal(
    (await req("/jobs/manual-job")).value.results.x.state,
    "needs_attention",
  );
});

test("旧扩展不能领取手动交接任务，但普通任务仍可派发", async (t) => {
  const { b, req } = await fixture(t);
  const { next } = await worker(t, b, []);
  await req("/jobs", "POST", { ...task("new-manual"), delivery: "manual" });
  await req("/jobs", "POST", task("old-auto"));
  assert.equal((await next()).task.id, "old-auto");
  assert.equal((await req("/jobs/new-manual")).value.results.x.state, "queued");
});

test("删除交接记录时保留源文件", async (t) => {
  const { req, dir } = await fixture(t);
  const file = path.join(dir, "video.mp4");
  await fs.writeFile(file, "video-bytes");
  const created = await req("/jobs", "POST", {
    id: "drop",
    kind: "video",
    title: "视频",
    description: "介绍",
    platforms: ["x"],
    assets: [
      {
        id: "asset",
        name: "video.mp4",
        path: "video.mp4",
        filePath: file,
        type: "video/mp4",
        size: Buffer.byteLength("video-bytes"),
        role: "video",
      },
    ],
  });
  assert.equal(created.status, 201);
  assert.equal((await req("/jobs/drop", "DELETE")).status, 200);
  assert.equal((await req("/jobs/drop")).status, 404);
  assert.equal(await fs.readFile(file, "utf8"), "video-bytes");
  await assert.rejects(() => fs.access(path.join(dir, "jobs", "drop.json")));
});

test("已有扩展在线时拒绝第二个连接，断开后新的扩展可以接上", async (t) => {
  const { b, root } = await fixture(t);
  const first = await worker(t, b);
  const intruder = new WebSocket("ws://127.0.0.1:" + b.port + "/worker");
  t.after(() => intruder.terminate());
  await new Promise((resolve, reject) => {
    intruder.once("open", resolve);
    intruder.once("error", reject);
  });
  const closed = new Promise((resolve) => intruder.once("close", resolve));
  intruder.send(
    JSON.stringify({ type: "hello", token, capabilities: ["manual-stage"] }),
  );
  assert.equal(await closed, 1008);
  first.ws.close();
  await until(async () => {
    const health = await fetch(root + "/health");
    return (await health.json()).connected === false;
  });
  await worker(t, b);
  assert.equal((await (await fetch(root + "/health")).json()).connected, true);
});
test("正在交接的任务不能删除", async (t) => {
  const { b, req } = await fixture(t);
  const w = await worker(t, b);
  await req("/jobs", "POST", task("busy"));
  await w.next();
  const denied = await req("/jobs/busy", "DELETE");
  assert.equal(denied.status, 409);
  assert.equal((await req("/jobs/busy")).status, 200);
});

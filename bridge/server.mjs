import http from "node:http";
import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { WebSocketServer, WebSocket } from "ws";
import {
  validateTask,
  initialResults,
  validateResult,
  retryable,
  TERMINAL,
  safeUrl,
  validSha256,
} from "../extension/shared/model.js";
import { DOMParser } from "linkedom";
import { renderArticle } from "../extension/shared/content.js";
import {
  NATIVE_SCHEDULE_CAPABILITY,
  PLATFORMS,
} from "../extension/shared/platforms/index.js";
const CHUNK = 1024 ** 2;
const equal = (a, b) => {
  if (typeof a !== "string") return false;
  const left = Buffer.from(a),
    right = Buffer.from(b);
  return left.length === right.length && crypto.timingSafeEqual(left, right);
};
export async function startBridge({
  port = 4318,
  dataDir = path.resolve(".local"),
  token,
} = {}) {
  await fs.mkdir(dataDir, { recursive: true, mode: 0o700 });
  const configFile = path.join(dataDir, "config.json");
  let config;
  try {
    config = JSON.parse(await fs.readFile(configFile, "utf8"));
  } catch {
    config = { token: token || crypto.randomBytes(32).toString("hex"), port };
  }
  if (token) config.token = token;
  await fs.writeFile(configFile, JSON.stringify(config), { mode: 0o600 });
  await fs.chmod(configFile, 0o600);
  const jobsDir = path.join(dataDir, "jobs");
  await fs.mkdir(jobsDir, { recursive: true });
  const jobs = new Map();
  const fingerprints = new Map();
  async function assetFingerprint(asset) {
    if (validSha256(asset.sha256)) return asset.sha256;
    if (!asset.filePath || !Number.isFinite(asset.mtimeMs)) return null;
    const stat = await fs.stat(asset.filePath).catch(() => null);
    if (
      !stat?.isFile() ||
      stat.size !== asset.size ||
      stat.mtimeMs !== asset.mtimeMs
    )
      return null;
    const sourceStamp = (st) => [
      st.size,
      st.mtimeMs,
      st.ctimeMs,
      st.dev,
      st.ino,
    ];
    const key = JSON.stringify([asset.filePath, ...sourceStamp(stat)]);
    const cached = fingerprints.get(key);
    if (cached) return cached;
    const result = (async () => {
      const hash = crypto.createHash("sha256");
      for await (const chunk of createReadStream(asset.filePath))
        hash.update(chunk);
      const after = await fs.stat(asset.filePath);
      return JSON.stringify([asset.filePath, ...sourceStamp(after)]) === key
        ? hash.digest("hex")
        : null;
    })().catch(() => null);
    fingerprints.set(key, result);
    result.then((sha) => {
      if (!sha) fingerprints.delete(key);
    });
    return result;
  }
  function videoRequestKey(job) {
    return JSON.stringify([
      job.title,
      job.description ?? "",
      job.delivery === "manual" ? "manual" : "auto",
      Boolean(job.aiGenerated),
      job.schedule ?? null,
      [...job.platforms].sort().map((id) => {
        const o = job.overrides?.[id];
        return [
          id,
          o?.title ?? job.title,
          o?.description ?? job.description,
          o?.tags ?? "",
          o?.collection ?? job.schedule?.collection ?? "",
          o?.category ?? "",
        ];
      }),
      job.assets.map(({ role, type, size }) => [role, type, size]),
    ]);
  }
  async function identicalVideoTask(task) {
    const key = videoRequestKey(task);
    for (const existing of jobs.values()) {
      if (existing.kind !== "video" || videoRequestKey(existing) !== key)
        continue;
      const hashes = await Promise.all(existing.assets.map(assetFingerprint));
      if (
        hashes.every((sha, index) => sha && sha === task.assets[index].sha256)
      )
        return existing;
    }
    return null;
  }
  function recover(r) {
    if (TERMINAL.has(r.state) || r.state === "queued") return;
    const uncertain = r.state === "submitting";
    Object.assign(r, {
      state: uncertain ? "schedule_unconfirmed" : "needs_attention",
      message: uncertain
        ? "定时提交结果不明，请先核对平台作品列表"
        : "服务曾中断，请检查平台现有草稿后再重试",
    });
  }
  let workerCapabilities = [];
  let worker = null,
    active = null,
    closing = false,
    seenAt = 0,
    persistence = Promise.resolve();
  const staleMs = 25000;
  let gate = Promise.resolve();
  const lock = (fn) => {
    const run = gate.then(() => fn());
    gate = run.then(
      () => {},
      () => {},
    );
    return run;
  };
  const responded = (target) => {
    if (!target || target.readyState !== WebSocket.OPEN)
      return Promise.resolve(false);
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), 800);
      target.once("pong", () => {
        clearTimeout(timer);
        resolve(true);
      });
      try {
        target.ping();
      } catch {
        clearTimeout(timer);
        resolve(false);
      }
    });
  };
  const heartbeat = setInterval(() => {
    if (!worker || !seenAt || Date.now() - seenAt < staleMs) return;
    const stale = worker;
    seenAt = 0;
    stale.terminate();
  }, 5000);
  heartbeat.unref?.();
  for (const name of await fs.readdir(jobsDir)) {
    if (!name.endsWith(".json")) continue;
    try {
      const j = JSON.parse(await fs.readFile(path.join(jobsDir, name), "utf8"));
      for (const r of Object.values(j.results)) recover(r);
      jobs.set(j.id, j);
    } catch {}
  }
  async function save(j) {
    const snapshot = JSON.stringify(j);
    const file = path.join(jobsDir, j.id + ".json");
    persistence = persistence.then(async () => {
      const temp = file + "." + crypto.randomUUID() + ".tmp";
      await fs.writeFile(temp, snapshot, { mode: 0o600 });
      await fs.rename(temp, file);
    });
    await persistence;
  }
  function view(j) {
    const copy = structuredClone(j);
    for (const a of copy.assets) delete a.filePath;
    for (const r of Object.values(copy.results)) {
      if (r.draftUrl) r.draftUrl = safeUrl(r.draftUrl);
      if (r.editorUrl) r.editorUrl = safeUrl(r.editorUrl);
    }
    return copy;
  }
  function done(j) {
    return Object.values(j.results).every((r) => TERMINAL.has(r.state));
  }
  function supportsSchedule(job) {
    if (!job.schedule) return true;
    return (
      workerCapabilities.includes(NATIVE_SCHEDULE_CAPABILITY) &&
      job.platforms.every((id) => {
        const capability = PLATFORMS[id]?.schedule?.capability;
        return !capability || workerCapabilities.includes(capability);
      })
    );
  }
  async function dispatch() {
    if (!worker || worker.readyState !== WebSocket.OPEN || active || closing)
      return;
    const j = [...jobs.values()].find(
      (j) =>
        supportsSchedule(j) &&
        (j.delivery !== "manual" ||
          workerCapabilities.includes("manual-stage")) &&
        Object.values(j.results).some((r) => r.state === "queued"),
    );
    if (!j) return;
    active = j.id;
    const assigned = worker,
      platforms = j.platforms.filter((p) => j.results[p].state === "queued");
    for (const p of platforms)
      j.results[p] = {
        state: "opening",
        message: "任务已交给浏览器扩展",
        updatedAt: new Date().toISOString(),
      };
    await save(j);
    if (worker === assigned && worker.readyState === WebSocket.OPEN)
      worker.send(
        JSON.stringify({
          type: "task",
          task: { ...view(j), platforms },
          bridgeJob: true,
        }),
      );
  }
  function reply(res, status, value) {
    res.writeHead(status, {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    });
    res.end(JSON.stringify(value));
  }
  function allowExtension(req, res) {
    const origin = req.headers.origin;
    if (!origin || !publicOrigin(origin)) return;
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Access-Control-Allow-Private-Network", "true");
    res.setHeader(
      "Access-Control-Allow-Headers",
      "Authorization, Content-Type",
    );
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
    res.setHeader("Access-Control-Max-Age", "600");
    res.setHeader("Vary", "Origin");
  }
  async function body(req) {
    let text = "";
    for await (const chunk of req) {
      text += chunk;
      if (Buffer.byteLength(text) > 4 * 1024 ** 2)
        throw new Error("请求超过4MB");
    }
    return JSON.parse(text || "{}");
  }
  function publicOrigin(origin) {
    return !origin || /^chrome-extension:\/\/[a-p]{32}$/.test(origin);
  }
  const server = http.createServer(async (req, res) => {
    try {
      const host = req.headers.host || "";
      if (!/^(127\.0\.0\.1|localhost):\d+$/.test(host))
        return reply(res, 403, { error: "Host rejected" });
      const url = new URL(req.url, "http://127.0.0.1");
      if (!publicOrigin(req.headers.origin))
        return reply(res, 403, { error: "Origin rejected" });
      allowExtension(req, res);
      if (req.method === "OPTIONS") {
        res.writeHead(204);
        res.end();
        return;
      }
      if (req.method === "GET" && url.pathname === "/health")
        return reply(res, 200, {
          ok: true,
          connected: Boolean(worker),
          nativeVideoSchedule:
            Boolean(worker) &&
            workerCapabilities.includes(NATIVE_SCHEDULE_CAPABILITY),
          nativeBilibiliSchedule:
            Boolean(worker) &&
            workerCapabilities.includes(PLATFORMS.bilibili.schedule.capability),
          pending: [...jobs.values()].filter((j) => !done(j)).length,
        });
      if (!equal(req.headers.authorization || "", "Bearer " + config.token))
        return reply(res, 401, { error: "Unauthorized" });
      if (req.method === "GET" && url.pathname === "/jobs")
        return reply(res, 200, { jobs: [...jobs.values()].map(view) });
      if (req.method === "GET" && url.pathname === "/video-fingerprints") {
        const entries = [];
        for (const j of jobs.values()) {
          if (j.kind !== "video") continue;
          const asset = j.assets.find((a) => a.role === "video");
          if (!asset) continue;
          const sha256 = await assetFingerprint(asset);
          if (sha256) entries.push([j.id, asset.id, sha256]);
        }
        return reply(res, 200, { fingerprints: entries });
      }
      if (req.method === "POST" && url.pathname === "/jobs") {
        const incoming = await body(req);
        const task = validateTask(incoming);
        if (!/^[\w-]{1,100}$/.test(task.id)) throw new Error("任务 ID 无效");
        if (jobs.has(task.id)) {
          const existing = jobs.get(task.id);
          if (
            (existing.schedule || task.schedule) &&
            JSON.stringify(existing.schedule) !== JSON.stringify(task.schedule)
          )
            return reply(res, 409, { error: "任务 ID 已绑定不同的定时参数" });
          if (
            (existing.kind === "x_reply" || task.kind === "x_reply") &&
            (existing.kind !== task.kind ||
              existing.targetUrl !== task.targetUrl ||
              existing.description !== task.description)
          )
            return reply(res, 409, { error: "任务 ID 已绑定另一份内容" });
          return reply(res, 200, view(existing));
        }
        for (const a of task.assets) {
          if (!a.filePath || !path.isAbsolute(a.filePath))
            throw new Error("AI素材必须提供本地绝对路径");
          const st = await fs.stat(a.filePath);
          if (!st.isFile() || st.size !== a.size)
            throw new Error("素材已变化或不是文件：" + a.name);
          a.mtimeMs = st.mtimeMs;
          // Only the bridge may attach a verified hash to a local source.
          delete a.sha256;
          if (task.kind === "video") {
            a.sha256 = await assetFingerprint(a);
            if (!a.sha256) throw new Error("素材读取时发生变化：" + a.name);
          }
        }
        if (task.kind === "article")
          task.prepared = renderArticle(task.markdown, task.assets, DOMParser);
        await lock(async () => {
          // Recheck after reading the files to make concurrent submissions idempotent.
          const existing = jobs.get(task.id);
          if (existing) {
            if (
              JSON.stringify(existing.schedule) !==
                JSON.stringify(task.schedule) ||
              existing.kind !== task.kind ||
              (task.kind === "x_reply" &&
                (existing.targetUrl !== task.targetUrl ||
                  existing.description !== task.description))
            )
              return reply(res, 409, {
                error: "任务 ID 已绑定另一份内容或定时参数",
              });
            return reply(res, 200, view(existing));
          }
          const duplicate =
            task.kind === "video" && incoming.deduplicate === true
              ? await identicalVideoTask(task)
              : null;
          if (duplicate) return reply(res, 200, view(duplicate));
          const j = { ...task, results: initialResults(task) };
          await save(j);
          jobs.set(j.id, j);
          reply(res, 201, view(j));
          dispatch().catch(() => {});
        });
        return;
      }
      const match =
        /^\/jobs\/([\w-]+)(?:\/(assets|retry|open)(?:\/([\w-]+))?)?$/.exec(
          url.pathname,
        );
      if (!match) return reply(res, 404, { error: "Not found" });
      const [, id, action, key] = match,
        j = jobs.get(id);
      if (!j) return reply(res, 404, { error: "Job not found" });
      if (!action && req.method === "GET") return reply(res, 200, view(j));
      if (!action && req.method === "DELETE") {
        if (active === j.id)
          return reply(res, 409, {
            error: "这条草稿正在交接，完成后再删除",
          });
        jobs.delete(id);
        await fs.unlink(path.join(jobsDir, id + ".json")).catch(() => {});
        return reply(res, 200, { ok: true });
      }
      if (action === "assets" && req.method === "GET") {
        const a = j.assets.find((a) => a.id === key);
        if (!a) return reply(res, 404, { error: "Asset not found" });
        const index = Number(url.searchParams.get("chunk") || 0);
        if (
          !Number.isSafeInteger(index) ||
          index < 0 ||
          index >= Math.max(1, Math.ceil(a.size / CHUNK))
        )
          return reply(res, 400, { error: "Invalid chunk" });
        const st = await fs.stat(a.filePath);
        if (st.size !== a.size || st.mtimeMs !== a.mtimeMs)
          throw new Error("源文件已修改，请重新创建任务");
        const file = await fs.open(a.filePath, "r");
        try {
          const buffer = Buffer.alloc(
            Math.min(CHUNK, Math.max(0, a.size - index * CHUNK)),
          );
          const { bytesRead } = await file.read(
            buffer,
            0,
            buffer.length,
            index * CHUNK,
          );
          return reply(res, 200, {
            chunk: buffer.subarray(0, bytesRead).toString("base64"),
          });
        } finally {
          await file.close();
        }
      }
      if (action === "retry" && req.method === "POST") {
        if (!j.platforms.includes(key)) throw new Error("任务不包含该平台");
        if (!retryable(j.results[key]))
          return reply(res, 409, {
            error: "已成功或正在执行的平台不能重复创建草稿",
          });
        if (active === j.id)
          return reply(res, 409, { error: "当前任务仍在执行，请完成后重试" });
        j.results[key] = {
          state: "queued",
          message: "等待重试",
          updatedAt: new Date().toISOString(),
        };
        await save(j);
        reply(res, 200, view(j));
        dispatch().catch(() => {});
        return;
      }
      if (action === "open" && req.method === "POST") {
        if (!j.platforms.includes(key)) throw new Error("任务不包含该平台");
        if (!worker) return reply(res, 409, { error: "Chrome 扩展未连接" });
        worker.send(JSON.stringify({ type: "open", id, platform: key }));
        return reply(res, 200, { ok: true });
      }
      reply(res, 404, { error: "Not found" });
    } catch (e) {
      reply(res, 400, { error: e.message });
    }
  });
  const sockets = new WebSocketServer({
    noServer: true,
    maxPayload: 1024 ** 2,
  });
  server.on("upgrade", (req, socket, head) => {
    if (
      req.url !== "/worker" ||
      !publicOrigin(req.headers.origin) ||
      !/^(127\.0\.0\.1|localhost):\d+$/.test(req.headers.host || "")
    ) {
      socket.destroy();
      return;
    }
    sockets.handleUpgrade(req, socket, head, (ws) =>
      sockets.emit("connection", ws, req),
    );
  });
  sockets.on("connection", (ws) => {
    let authenticated = false;
    const timer = setTimeout(() => ws.close(1008, "Authenticate first"), 5000);
    let chain = Promise.resolve();
    ws.on("message", (raw) => {
      chain = chain
        .then(async () => {
          let m;
          try {
            m = JSON.parse(raw);
          } catch {
            ws.close(1008, "Invalid message");
            return;
          }
          if (!authenticated) {
            await lock(async () => {
              if (m.type !== "hello" || !equal(m.token, config.token)) {
                ws.close(1008, "Unauthorized or worker already connected");
                return;
              }
              if (worker && worker !== ws) {
                const previous = worker;
                if (await responded(previous)) {
                  ws.close(1008, "Unauthorized or worker already connected");
                  return;
                }
                previous.terminate();
                if (worker === previous) worker = null;
              }
              if (ws.readyState !== WebSocket.OPEN) return;
              authenticated = true;
              clearTimeout(timer);
              seenAt = Date.now();
              worker = ws;
              workerCapabilities = Array.isArray(m.capabilities)
                ? m.capabilities
                : [];
              ws.send(JSON.stringify({ type: "hello", ok: true }));
              await dispatch();
            });
            return;
          }
          seenAt = Date.now();
          if (m.type === "ping") {
            ws.send(JSON.stringify({ type: "pong" }));
            return;
          }
          if (m.type === "result") {
            const j = jobs.get(m.id);
            if (
              j?.delivery === "manual" &&
              j.platforms.includes(m.platform) &&
              m.result?.state === "opening" &&
              j.results[m.platform]?.state === "ready"
            ) {
              if (active && active !== j.id)
                throw new Error("另一个桥接任务正在执行");
              active = j.id;
            }
            if (!j || active !== j.id || !j.platforms.includes(m.platform))
              throw new Error("Unexpected task result");
            if (
              TERMINAL.has(j.results[m.platform].state) &&
              !(
                j.delivery === "manual" &&
                j.results[m.platform].state === "ready" &&
                m.result?.state === "opening"
              )
            )
              return;
            if (
              (m.result?.state === "review_ready" && j.kind !== "x_reply") ||
              (j.kind === "x_reply" && m.result?.state === "draft_ready")
            )
              throw new Error("任务类型与结果不匹配");
            if (
              ["schedule_ready", "scheduled"].includes(m.result?.state) &&
              (!j.schedule ||
                m.result.scheduledAt !== j.schedule.at ||
                (m.result.state === "scheduled" && !j.schedule.submit))
            )
              throw new Error("定时结果与任务授权不匹配");
            if (TERMINAL.has(m.result?.state)) validateResult(m.result);
            else if (
              ![
                "opening",
                "uploading",
                "filling",
                "saving",
                "submitting",
              ].includes(m.result?.state)
            )
              throw new Error("Unexpected state");
            j.results[m.platform] = {
              ...m.result,
              updatedAt: new Date().toISOString(),
            };
            await save(j);
            ws.send(
              JSON.stringify({ type: "ack", id: j.id, platform: m.platform }),
            );
            if (done(j)) {
              active = null;
              await dispatch();
            }
          }
        })
        .catch((e) =>
          ws.send(JSON.stringify({ type: "error", message: e.message })),
        );
    });
    ws.on("close", () => {
      clearTimeout(timer);
      if (worker !== ws) return;
      worker = null;
      const id = active;
      active = null;
      if (id) {
        const j = jobs.get(id);
        for (const r of Object.values(j.results)) recover(r);
        for (const r of Object.values(j.results))
          if (r.state === "queued")
            Object.assign(r, {
              state: "needs_attention",
              message: "连接中断，尚未执行；可单独重试",
            });
        save(j).catch(() => {});
      }
    });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  const actual = server.address().port;
  config.port = actual;
  await fs.writeFile(configFile, JSON.stringify(config), { mode: 0o600 });
  return {
    server,
    port: actual,
    token: config.token,
    configFile,
    jobs,
    async close() {
      closing = true;
      clearInterval(heartbeat);
      for (const ws of sockets.clients) ws.terminate();
      await new Promise((resolve) => server.close(resolve));
      await new Promise((resolve) => sockets.close(resolve));
      await persistence;
    },
  };
}

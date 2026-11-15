#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { DOMParser } from "linkedom";
import { startBridge } from "./bridge/server.mjs";
import { validateTask } from "./extension/shared/model.js";
import { extractTitle, renderArticle } from "./extension/shared/content.js";
import { collectMedia, resolveLocalImage } from "./src/media.mjs";
const base = path.dirname(fileURLToPath(import.meta.url));
const dataDir = process.env.OMNIPOST_HOME || path.join(base, ".local");
const types = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
  ".webm": "video/webm",
};
function options(args) {
  const o = { _: [] };
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith("--")) {
      const k = args[i].slice(2);
      if (k === "ai-generated" || k === "full" || k === "stage") o[k] = true;
      else {
        if (!args[i + 1] || args[i + 1].startsWith("--"))
          throw new Error("参数缺少值：" + k);
        o[k] = args[++i];
      }
    } else o._.push(args[i]);
  }
  return o;
}
export async function importTask(kind, source, opts = {}) {
  const file = path.resolve(source || "");
  const stat = await fs.stat(file);
  if (!stat.isFile()) throw new Error("请选择文件");
  const assets = [];
  let markdown = "",
    title = opts.title || "";
  async function asset(filePath, role, relative) {
    const st = await fs.stat(filePath);
    const type = types[path.extname(filePath).toLowerCase()];
    if (!type) throw new Error("不支持素材格式：" + filePath);
    const a = {
      id: crypto.randomUUID(),
      name: path.basename(filePath),
      path: relative || path.basename(filePath),
      source: relative,
      role,
      type,
      size: st.size,
      filePath,
    };
    assets.push(a);
    return a;
  }
  if (kind === "article") {
    if (!/\.m(arkdown|d)$/i.test(file) || stat.size > 2 * 1024 ** 2)
      throw new Error("文章需要2MB以内的 Markdown 文件");
    markdown = await fs.readFile(file, "utf8");
    title ||= extractTitle(markdown) || path.basename(file, path.extname(file));
    for (const m of collectMedia(markdown, path.dirname(file))) {
      if (!m.local || !m.available)
        throw new Error("请先下载或补齐本地图片：" + m.source);
      if (assets.some((a) => a.source === m.source)) continue;
      await asset(
        resolveLocalImage(m.source, path.dirname(file)),
        "image",
        m.source,
      );
    }
    renderArticle(markdown, assets, DOMParser);
  } else {
    await asset(file, "video");
    if (opts.cover) await asset(path.resolve(opts.cover), "cover");
    for (const role of ["cover-landscape", "cover-portrait"]) {
      if (opts[role]) {
        const a = await asset(path.resolve(opts[role]), role);
        if (!a.type.startsWith("image/")) throw new Error("封面必须是图片");
      }
    }
  }
  const description = opts["description-file"]
    ? await fs.readFile(path.resolve(opts["description-file"]), "utf8")
    : opts.description || "";
  const overrides = opts.overrides
    ? JSON.parse(await fs.readFile(path.resolve(opts.overrides), "utf8"))
    : {};
  return validateTask({
    id: opts.id || crypto.randomUUID(),
    kind,
    title,
    markdown,
    description,
    overrides,
    assets,
    delivery: opts.stage ? "manual" : "auto",
    aiGenerated: Boolean(opts["ai-generated"]),
    platforms: (
      opts.platforms ||
      (kind === "article"
        ? "wechat,xiaohongshu,x"
        : "xiaohongshu,x,channels,douyin")
    ).split(","),
    mode: "draft",
    prepared:
      kind === "article"
        ? renderArticle(markdown, assets, DOMParser)
        : undefined,
  });
}
export function summarizeJob(job) {
  if (!job?.id || !job?.results) return job;
  const { id, kind, title, platforms, mode, createdAt, results, targetUrl } =
    job;
  return {
    id,
    kind,
    title,
    platforms,
    mode,
    createdAt,
    assetCount: job.assets?.length || 0,
    results,
    ...(targetUrl ? { targetUrl } : {}),
  };
}
async function main() {
  const opts = options(process.argv.slice(2));
  const [command, arg, platform] = opts._;
  if (command === "serve") {
    const b = await startBridge({ port: Number(opts.port || 4318), dataDir });
    console.log(
      JSON.stringify({
        ok: true,
        url: "http://127.0.0.1:" + b.port,
        configFile: b.configFile,
        mode: "draft",
      }),
    );
    process.once("SIGINT", async () => {
      await b.close();
      process.exit(0);
    });
    return;
  }
  if (!command || command === "help") {
    console.log(
      "omnipost serve | pair | doctor | draft file.md --platforms wechat,xiaohongshu,x | video file.mp4 --title 标题 | status ID | list | retry ID PLATFORM | open ID PLATFORM\n--stage 仅交接到插件，等待当前页填充。--cover-landscape / --cover-portrait 保存横竖封面。默认只生成草稿。--overrides JSON 可逐平台调整 title/description。--full 输出完整任务。",
    );
    console.log(
      "x-reply X_POST_URL --description-file reply.txt：把回复交给 Chrome 工作台审阅。",
    );
    return;
  }
  const config = JSON.parse(
    await fs.readFile(path.join(dataDir, "config.json"), "utf8"),
  );
  if (command === "pair") {
    console.log(config.token);
    return;
  }
  const root = "http://127.0.0.1:" + config.port;
  async function request(route, method = "GET", body) {
    const r = await fetch(root + route, {
      method,
      headers: {
        Authorization: "Bearer " + config.token,
        "Content-Type": "application/json",
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const value = await r.json();
    if (!r.ok) throw new Error(value.error || "请求失败");
    return value;
  }
  let result;
  if (command === "doctor") result = await request("/health");
  else if (command === "x-reply") {
    if (!opts["description-file"])
      throw new Error("需要 --description-file 回复正文文件");
    result = await request(
      "/jobs",
      "POST",
      validateTask({
        kind: "x_reply",
        mode: "review",
        platforms: ["x"],
        targetUrl: arg,
        description: await fs.readFile(
          path.resolve(opts["description-file"]),
          "utf8",
        ),
      }),
    );
  } else if (command === "draft" || command === "video")
    result = await request(
      "/jobs",
      "POST",
      await importTask(command === "draft" ? "article" : "video", arg, opts),
    );
  else if (command === "status")
    result = await request("/jobs/" + encodeURIComponent(arg));
  else if (command === "list") result = await request("/jobs");
  else if (command === "retry" || command === "open") {
    if (!arg || !platform) throw new Error("需要任务ID和平台");
    result = await request(
      "/jobs/" +
        encodeURIComponent(arg) +
        "/" +
        command +
        "/" +
        encodeURIComponent(platform),
      "POST",
      {},
    );
  } else throw new Error("未知命令：" + command);
  if (!opts.full)
    result = Array.isArray(result)
      ? result.map(summarizeJob)
      : summarizeJob(result);
  console.log(JSON.stringify(result, null, 2));
}
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  main().catch((e) => {
    console.error(JSON.stringify({ ok: false, error: e.message }));
    process.exitCode = 1;
  });

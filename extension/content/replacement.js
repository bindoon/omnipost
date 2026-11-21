import { replacementPlatform } from "../shared/video-replacement.js";

function text(element) {
  return (element.textContent || "").replace(/\s+/g, " ").trim();
}
function visible(element) {
  const rect = element.getBoundingClientRect();
  const style = getComputedStyle(element);
  return rect.width && rect.height && style.visibility !== "hidden";
}
function fileAccepts(input, asset) {
  const extension = /\.[^.]+$/.exec(asset.name)?.[0].toLowerCase();
  return (input.getAttribute("accept") || "")
    .toLowerCase()
    .split(",")
    .map((accept) => accept.trim())
    .some(
      (accept) =>
        accept === extension || accept === asset.type || accept === "video/*",
    );
}
function enabled(input) {
  return (
    !input.disabled &&
    !input.closest('fieldset[disabled],[aria-disabled="true"]')
  );
}
function verifyOriginal(task) {
  if (
    location.href !== task.url ||
    replacementPlatform(location.href) !== task.platform ||
    !(Date.parse(task.at) > Date.now())
  )
    throw new Error("当前页面已切换，或预约时间已到");
  const xhs = task.platform === "xiaohongshu";
  const titleSelector = xhs
    ? 'input[placeholder*="填写标题"],input[placeholder*="请输入标题"],textarea[placeholder="输入标题"]'
    : 'input[placeholder="请输入稿件标题"]';
  const titles = [...document.querySelectorAll(titleSelector)].filter(visible);
  if (titles.length !== 1 || titles[0].value !== task.title)
    throw new Error("原稿标题与交接任务不一致");
  const [day, clock] = task.at.slice(0, 16).split("T");
  let matchesTime;
  if (xhs) {
    const times = [
      ...document.querySelectorAll('input,[role="textbox"]'),
    ].filter(
      (element) =>
        visible(element) &&
        /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(
          (element.value ?? text(element)).trim(),
        ),
    );
    matchesTime =
      times.length === 1 &&
      (times[0].value ?? text(times[0])).trim() === `${day} ${clock}`;
  } else {
    const schedule = document.querySelector(".time-container");
    const zone = document.querySelector(".date-picker-timezone-wrp input");
    const shown = [...(schedule?.querySelectorAll(".date-show") || [])].map(
      text,
    );
    matchesTime =
      /^\(UTC\+08:00\)/.test(zone?.value || "") &&
      schedule?.querySelector(".switch-container.switch-container-active") &&
      shown.length === 2 &&
      shown[0] === day &&
      shown[1] === clock;
  }
  if (!matchesTime) throw new Error("原稿定时时间与交接任务不一致");
}
function xiaohongshuInput(asset) {
  const matches = [
    ...document.querySelectorAll('input.upload-input[type="file"]'),
  ].filter((input) => {
    if (!enabled(input) || !fileAccepts(input, asset)) return false;
    let container = input.parentElement;
    for (
      let depth = 0;
      container && depth < 6;
      depth++, container = container.parentElement
    ) {
      if (container.querySelectorAll('input[type="file"]').length !== 1) break;
      const labels = text(container);
      if (
        visible(container) &&
        labels.includes("视频文件") &&
        labels.includes("重新上传")
      )
        return true;
    }
    return false;
  });
  if (matches.length !== 1)
    throw new Error("无法确认唯一的小红书视频重新上传框");
  return matches[0];
}
function bilibiliButton() {
  const labels = [
    ...document.querySelectorAll(".operate-btns .icon-text-btn > span"),
  ].filter(
    (label) =>
      visible(label) &&
      text(label) === "更换视频" &&
      enabled(label.parentElement),
  );
  if (labels.length !== 1) throw new Error("无法确认唯一的 B 站「更换视频」");
  return labels[0];
}
async function bilibiliInput(button, asset) {
  const fired = new Set();
  let interrupted = false;
  function intercept(event) {
    if (event.isTrusted) {
      interrupted = true;
      return;
    }
    if (interrupted || !event.target?.matches?.('input[type="file"]')) return;
    event.preventDefault();
    fired.add(event.target);
  }
  document.addEventListener("click", intercept, true);
  try {
    // Click the text itself so handlers on both the span and its parent run.
    // Vue can dispatch the actual file picker on its next update.
    button.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
  } finally {
    document.removeEventListener("click", intercept, true);
  }
  const [input] = fired;
  if (interrupted) throw new Error("页面操作打断了 B 站的换源选框捕获");
  if (fired.size !== 1 || !enabled(input))
    throw new Error(
      fired.size
        ? "B 站「更换视频」触发了多个或禁用的文件框"
        : "B 站没有向插件暴露「更换视频」的文件框，请在原稿使用该入口手动选文件",
    );
  // Some B 站 picker versions omit accept and validate files on change.
  // Only the input actually triggered by the exact replacement control may
  // use this fallback. The add-part input is never searched.
  if (input.getAttribute("accept")?.trim() && !fileAccepts(input, asset))
    throw new Error("B 站选框声明的文件类型与替换视频不匹配");
  return input;
}
async function readFile(task) {
  const parts = [];
  const chunkSize = 1024 ** 2;
  for (let index = 0; index < Math.ceil(task.asset.size / chunkSize); index++) {
    const result = await chrome.runtime.sendMessage({
      type: "ASSET",
      id: task.id,
      assetId: task.asset.id,
      index,
    });
    if (!result?.ok) throw new Error(result?.error || "无法读取替换视频");
    const part = Uint8Array.from(atob(result.chunk), (character) =>
      character.charCodeAt(0),
    );
    const expected = Math.min(chunkSize, task.asset.size - index * chunkSize);
    if (part.length !== expected) throw new Error("替换视频的分片读取不完整");
    parts.push(part);
  }
  return new File(parts, task.asset.name, { type: task.asset.type });
}
async function replaceVideo(task) {
  verifyOriginal(task);
  const getControl =
    task.platform === "xiaohongshu"
      ? () => xiaohongshuInput(task.asset)
      : bilibiliButton;
  const control = getControl();
  const file = await readFile(task);
  verifyOriginal(task);
  if (getControl() !== control)
    throw new Error("原稿的换源入口已改变，请重新核对");
  const input =
    task.platform === "bilibili"
      ? await bilibiliInput(control, task.asset)
      : control;
  verifyOriginal(task);
  if (!input.isConnected || !enabled(input))
    throw new Error("视频文件框已失效");
  const transfer = new DataTransfer();
  transfer.items.add(file);
  input.files = transfer.files;
  input.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
  input.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
  return { ok: true };
}

if (!globalThis.__OMNIPOST_VIDEO_REPLACEMENT__) {
  globalThis.__OMNIPOST_VIDEO_REPLACEMENT__ = true;
  chrome.runtime.onMessage.addListener((message, sender, reply) => {
    if (message?.type !== "UPLOAD_REPLACEMENT_VIDEO") return false;
    if (sender.id !== chrome.runtime.id) return false;
    replaceVideo(message.task)
      .then(reply)
      .catch((error) => reply({ ok: false, error: error.message }));
    return true;
  });
}

import { writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { parseArgs } from "node:util";

const bundleId = "com.xingin.discover";
const elementKey = "element-6066-11e4-a52e-4f735466cecf";
const usage = `小红书 iPhone 视频发布页测试

先将视频存入 iPhone 相册，再启动已安装 XCUITest 驱动的本地 Appium：
  appium --address 127.0.0.1

检查连接及当前控件：
  node src/xiaohongshu-iphone.mjs --udid DEVICE --team-id TEAM \\
    --wda-bundle-id BUNDLE --inspect /tmp/xiaohongshu.xml

从小红书首页打开相册，选片、填文案并停在发布页：
  node src/xiaohongshu-iphone.mjs --udid DEVICE --team-id TEAM \\
    --wda-bundle-id BUNDLE --asset-label '0:03' \\
    --title '真机测试' --description 'Omnipost 测试'

--port 可指定本机 Appium 端口，默认 4723。
--picker 从已打开且未选素材的小红书相册开始。
--asset-label 匹配当前相册画面中唯一一个视频的时长或完整控件名称。
--allow-provisioning 允许 Xcode 为 WDA 更新签名配置和注册测试设备。
--prebuilt-wda 可指定已签名的 WebDriverAgentRunner-Runner.app。
--wda-port 可连接已通过 USB 转发到本机的 WDA 端口，省去签名参数。
--inspect 只读取当前页面控件，XML 可能包含手机画面中的个人信息。
脚本停在「发布笔记」页面，未接入公开提交或保存草稿动作。`;

const { values: options } = parseArgs({
  options: {
    help: { type: "boolean" },
    udid: { type: "string" },
    "team-id": { type: "string" },
    "wda-bundle-id": { type: "string" },
    "allow-provisioning": { type: "boolean" },
    "prebuilt-wda": { type: "string" },
    "wda-port": { type: "string" },
    port: { type: "string", default: "4723" },
    inspect: { type: "string" },
    picker: { type: "boolean" },
    "asset-label": { type: "string" },
    title: { type: "string" },
    description: { type: "string" },
  },
});

if (options.help) {
  console.log(usage);
  process.exit(0);
}

const port = Number(options.port);
const wdaPort =
  options["wda-port"] === undefined ? null : Number(options["wda-port"]);
const assetLabel = options["asset-label"];
const required = [
  "udid",
  ...(wdaPort === null ? ["team-id", "wda-bundle-id"] : []),
  ...(options.inspect ? [] : ["asset-label", "title", "description"]),
];
const validPort = (value) =>
  Number.isInteger(value) && value >= 1 && value <= 65535;
if (
  required.some((key) => !options[key]?.trim()) ||
  !validPort(port) ||
  (wdaPort !== null &&
    (!validPort(wdaPort) ||
      options["prebuilt-wda"] ||
      options["allow-provisioning"]))
) {
  console.error(usage);
  process.exit(2);
}
if (
  !options.inspect &&
  (options.title.length > 20 || options.description.length > 1000)
) {
  console.error("小红书视频标题最多 20 字，正文最多 1000 字。");
  process.exit(2);
}

const server = `http://127.0.0.1:${port}`;
let sessionId;
let step = "连接 iPhone";

async function request(method, route, body, timeout = 15_000) {
  const response = await fetch(server + route, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeout),
  });
  const { value } = await response.json();
  if (!response.ok || value?.error) {
    throw new Error(value?.message || `Appium HTTP ${response.status}`);
  }
  return value;
}

function device(method, route, body) {
  return request(method, `/session/${sessionId}${route}`, body);
}

function named(labels, attributes = ["name", "label"]) {
  const values = `{${labels.map((label) => JSON.stringify(label)).join(", ")}}`;
  return `visible == 1 AND (${attributes.map((attr) => `${attr} IN ${values}`).join(" OR ")})`;
}

async function findAll(value, using = "-ios predicate string") {
  const elements = await device("POST", "/elements", {
    using,
    value,
  });
  return elements.map((element) => element[elementKey]);
}

async function waitForElements(value, using) {
  const deadline = Date.now() + 10_000;
  do {
    const elements = await findAll(value, using);
    if (elements.length) return elements;
    await delay(250);
  } while (Date.now() < deadline);
  throw new Error("未找到预期控件，请用 --inspect 检查当前页面。");
}

async function findOne(value, using) {
  const elements = await waitForElements(value, using);
  if (elements.length !== 1) throw new Error("发现多个匹配控件，已暂停。");
  return elements[0];
}

const button = (...labels) =>
  `type == 'XCUIElementTypeButton' AND enabled == 1 AND ${named(labels)}`;

function click(element) {
  return device("POST", `/element/${element}/click`, {});
}

async function clickPreviewNext() {
  await findOne(button("选择音乐"));
  const next = await waitForElements(button("下一步"));
  const frames = await Promise.all(
    next.map((id) => device("GET", `/element/${id}/rect`)),
  );
  const { x, y, width, height } = frames[0];
  if (
    frames.some(
      (rect) =>
        rect.x !== x ||
        rect.y !== y ||
        rect.width !== width ||
        rect.height !== height,
    )
  ) {
    throw new Error("视频预览存在多个不同位置的下一步按钮。");
  }
  await click(next[0]);
}

function videoSelection(label) {
  // XPath quotes are literals, not backslash escapes.
  const literal = label.includes('"')
    ? `concat(${label
        .split('"')
        .map((part) => `"${part}"`)
        .join(`, '"', `)})`
    : `"${label}"`;
  const duration = `@name=${literal} or @label=${literal}`;
  return (
    `//XCUIElementTypeCollectionView//XCUIElementTypeCell[@visible="true"][${duration} or .//XCUIElementTypeStaticText[@visible="true"][${duration}]]` +
    '//XCUIElementTypeButton[@visible="true"][@name="capa photo3 c"]'
  );
}

async function fill(placeholder, value, type) {
  const field = await findOne(
    `type == '${type}' AND ${named(placeholder, ["name", "label", "value"])}`,
  );
  await click(field);
  await device("POST", `/element/${field}/value`, { text: value });
  const current = await device("GET", `/element/${field}/attribute/value`);
  if (current !== value) throw new Error("读取到的文字与输入值不一致。");
}

async function start() {
  await request("GET", "/status");
  const wdaCapabilities =
    wdaPort === null
      ? {
          "appium:xcodeOrgId": options["team-id"],
          "appium:xcodeSigningId": "Apple Development",
          "appium:updatedWDABundleId": options["wda-bundle-id"],
          "appium:allowProvisioningDeviceRegistration": Boolean(
            options["allow-provisioning"],
          ),
          ...(options["prebuilt-wda"] && {
            "appium:usePreinstalledWDA": true,
            "appium:prebuiltWDAPath": options["prebuilt-wda"],
          }),
        }
      : { "appium:webDriverAgentUrl": `http://127.0.0.1:${wdaPort}` };
  const session = await request(
    "POST",
    "/session",
    {
      capabilities: {
        alwaysMatch: {
          platformName: "iOS",
          "appium:automationName": "XCUITest",
          "appium:udid": options.udid,
          "appium:bundleId": bundleId,
          "appium:noReset": true,
          "appium:forceAppLaunch": false,
          "appium:shouldTerminateApp": false,
          ...wdaCapabilities,
          "appium:showXcodeLog": true,
          "appium:wdaLaunchTimeout": 90_000,
        },
      },
    },
    240_000,
  );
  sessionId = session.sessionId;

  const app = await device("POST", "/execute/sync", {
    script: "mobile: activeAppInfo",
    args: [],
  });
  if (app.bundleId !== bundleId) throw new Error("当前前台不是小红书。");

  if (options.inspect) {
    step = "读取小红书控件";
    const source = await device("GET", "/source");
    await writeFile(options.inspect, source, { flag: "wx", mode: 0o600 });
    console.log(`已连接小红书，控件树已写入 ${options.inspect}`);
    return;
  }

  if (!options.picker) {
    step = "打开小红书首页的发布入口";
    const editor = await findAll(named(["发布笔记", "添加标题", "存草稿"]));
    if (editor.length) throw new Error("当前有编辑中的笔记，请先检查页面。");
    await click(await findOne(button("发布标签")));
    step = "打开相册";
    await click(await findOne(named(["从相册选择"])));
  }

  step = "核对相册并选择指定视频";
  await findOne(button("最近项目", "最近项目，展开", "最近项目，下拉按钮"));
  const selected =
    "type == 'XCUIElementTypeButton' AND visible == 1 AND name MATCHES '已选中[0-9]+'";
  if ((await findAll(selected)).length) {
    throw new Error("相册里已有选中的素材。");
  }
  await click(await findOne(videoSelection(assetLabel), "xpath"));

  step = "确认仅选了一项素材";
  await findOne(button("已选中1"));
  if ((await findAll(selected)).length !== 1)
    throw new Error("当前选中的素材数不为 1。");
  await click(await findOne(button("下一步")));
  step = "打开视频发布页";
  await clickPreviewNext();
  await findOne(button("发布笔记"));

  step = "填写并核对标题";
  await fill(["添加标题"], options.title, "XCUIElementTypeTextField");
  step = "填写并核对正文";
  await fill(
    ["添加作品描述", "展开说说"],
    options.description,
    "XCUIElementTypeTextView",
  );
  await findOne(button("发布笔记"));
  console.log("已核对文案并停在小红书视频发布页。");
}

try {
  await start();
} catch (error) {
  console.error(`${step}失败。 ${error.message}`);
  process.exitCode = 1;
} finally {
  if (sessionId) {
    try {
      await device("DELETE", "");
    } catch (error) {
      console.error(`Appium 会话关闭失败。 ${error.message}`);
      process.exitCode = 1;
    }
  }
}

import { execFile, spawn } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs, promisify } from "node:util";

const exec = promisify(execFile);
const node = process.execPath;
const appiumPort = 4732;
const localWdaPort = 18101;
const deviceWdaPort = 8100;
const driver = "appium-xcuitest-driver";
const appiumVersions = { appium: "4.0.0", [driver]: "13.1.3" };
const publisher = fileURLToPath(
  new URL("./xiaohongshu-iphone.mjs", import.meta.url),
);
const xcodeScheme = "WebDriverAgentRunner";

function start(bin, args, cwd, output = "inherit") {
  const log = output === "inherit" ? null : openSync(output, "w", 0o600);
  const child = spawn(bin, args, {
    cwd,
    stdio: log === null ? "inherit" : ["ignore", log, log],
  });
  if (log !== null) closeSync(log);
  const finished = new Promise((resolve) => {
    child.once("error", (error) => resolve({ error }));
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  return { child, finished };
}

async function stop(task) {
  if (!task || task.child.exitCode !== null || task.child.signalCode !== null)
    return;
  task.child.kill("SIGINT");
  await Promise.race([task.finished, delay(3000, undefined, { ref: false })]);
  if (task.child.exitCode === null && task.child.signalCode === null)
    task.child.kill("SIGTERM");
}

async function run(bin, args, cwd) {
  const { code, signal, error } = await start(bin, args, cwd).finished;
  if (code !== 0)
    throw error || new Error(`${bin} 退出（${signal ?? code}）。`);
}

async function usbDevice(udid) {
  const { stdout } = await exec(
    "xcrun",
    ["xcdevice", "list", "--timeout", "4"],
    { timeout: 20_000 },
  );
  const devices = JSON.parse(stdout).filter(
    (device) =>
      device.interface === "usb" &&
      device.platform === "com.apple.platform.iphoneos" &&
      !device.simulator &&
      device.available &&
      (!udid || device.identifier === udid),
  );
  if (devices.length !== 1) {
    throw new Error(
      "请通过 USB 连接、解锁并信任这台 Mac。连接多台 iPhone 时，请在 setup 指定 --udid。",
    );
  }
  return devices[0].identifier;
}

async function setup(args, root, appium) {
  const { values } = parseArgs({
    args,
    options: { "team-id": { type: "string" }, udid: { type: "string" } },
  });
  const team = values["team-id"];
  if (!/^[A-Z0-9]{10}$/.test(team ?? ""))
    throw new Error("请提供 Xcode 的 Apple Developer Team ID。");
  const udid = await usbDevice(values.udid);
  await mkdir(appium, { recursive: true, mode: 0o700 });
  await writeFile(
    path.join(appium, "package.json"),
    JSON.stringify({ private: true, dependencies: appiumVersions }),
    { mode: 0o600 },
  );
  await run(
    "npm",
    [
      "install",
      "--legacy-peer-deps",
      "--prefer-offline",
      "--no-audit",
      "--no-fund",
    ],
    appium,
  );

  const build = await mkdtemp(path.join(root, "wda-"));
  const source = path.join(
    appium,
    "node_modules",
    driver,
    "node_modules",
    "appium-webdriveragent",
  );
  const projectDir = path.join(build, "source");
  await cp(source, projectDir, { recursive: true });
  const project = path.join(projectDir, "WebDriverAgent.xcodeproj");
  const config = path.join(project, "project.pbxproj");
  const original = await readFile(config, "utf8");
  await writeFile(
    config,
    original.replaceAll(
      "PRODUCT_BUNDLE_IDENTIFIER = com.facebook.WebDriverAgentRunner;",
      `PRODUCT_BUNDLE_IDENTIFIER = dev.omnipost.wda.${team.toLowerCase()};`,
    ),
  );
  await run(
    "xcodebuild",
    [
      "-project",
      project,
      "-scheme",
      xcodeScheme,
      "-destination",
      `platform=iOS,id=${udid}`,
      "-derivedDataPath",
      build,
      "-allowProvisioningUpdates",
      "-quiet",
      "build-for-testing",
      `DEVELOPMENT_TEAM=${team}`,
      "CODE_SIGN_STYLE=Automatic",
      "CODE_SIGN_IDENTITY=Apple Development",
      // The runner icon is optional. No need to wait on actool on an older Mac.
      "EXCLUDED_SOURCE_FILE_NAMES=Assets.xcassets",
    ],
    root,
  );
  const products = path.join(build, "Build", "Products");
  const runs = (await readdir(products)).filter((file) =>
    /^WebDriverAgentRunner_iphoneos.*\.xctestrun$/.test(file),
  );
  if (runs.length !== 1) throw new Error("找不到唯一的真机 xctestrun 文件。");
  const xctestrun = path.join(products, runs[0]);
  await bindWda(xctestrun);
  const profile = path.join(
    products,
    "Debug-iphoneos",
    "WebDriverAgentRunner-Runner.app",
    "embedded.mobileprovision",
  );
  const { stdout } = await exec("security", ["cms", "-D", "-i", profile]);
  const expiresAt = stdout.match(
    /<key>ExpirationDate<\/key>\s*<date>([^<]+)<\/date>/,
  )?.[1];
  if (!expiresAt) throw new Error("无法读取 iPhone 驱动签名的到期时间。");
  const settings = {
    team,
    udid,
    expiresAt,
    xctestrun: path.relative(root, xctestrun),
  };
  const pending = path.join(build, "settings.json");
  await writeFile(pending, JSON.stringify(settings), { mode: 0o600 });
  await rename(pending, path.join(root, "settings.json"));
  console.log(
    "iPhone 驱动已准备好。首次在手机上启动时，按 iOS 提示信任开发者证书。",
  );
  return settings;
}

async function bindWda(xctestrun) {
  await exec("plutil", [
    "-replace",
    `${xcodeScheme}.EnvironmentVariables.USE_IP`,
    "-string",
    "127.0.0.1",
    xctestrun,
  ]);
}

async function reachable(port) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/status`, {
      signal: AbortSignal.timeout(750),
    });
    return response.ok && (await response.json()).value?.ready === true;
  } catch {
    return false;
  }
}

async function waitReady(port, task, timeout, label, log) {
  const outcome = task.finished.then(() => true);
  const deadline = Date.now() + timeout;
  do {
    if (await Promise.race([outcome, delay(0, false)])) break;
    if (await reachable(port)) return;
    await delay(400);
  } while (Date.now() < deadline);
  const contents = await readFile(log, "utf8").catch(() => "");
  if (contents.includes("is not trusted")) {
    throw new Error(
      "iPhone 尚未信任 WebDriverAgent。请在「设置 → 通用 → VPN 与设备管理」信任开发者。",
    );
  }
  if (contents.includes("Unlock ") || contents.includes("device is locked")) {
    throw new Error("请解锁 iPhone，并在运行期间保持屏幕亮着。");
  }
  throw new Error(`${label}未就绪，详见 ${log}`);
}

async function executeIphone(args, root, appium) {
  let settings = await readFile(path.join(root, "settings.json"), "utf8")
    .then(JSON.parse)
    .catch((error) => {
      if (error.code === "ENOENT")
        throw new Error("请先运行 node cli.mjs iphone setup --team-id TEAM。");
      throw error;
    });
  if (Date.parse(settings.expiresAt) <= Date.now()) {
    console.log("iPhone 驱动签名已到期，正在通过 Xcode 更新。");
    settings = await setup(
      ["--team-id", settings.team, "--udid", settings.udid],
      root,
      appium,
    );
  }
  const { udid, xctestrun } = settings;
  await usbDevice(udid);
  if (await reachable(appiumPort))
    throw new Error(`本机 Appium 端口 ${appiumPort} 已在使用。`);
  const remote = path.join(
    appium,
    "node_modules",
    driver,
    "node_modules",
    "appium-ios-remotexpc",
    "build",
    "src",
    "index.js",
  );
  const { connectViaUsbmux, DevicePortForwarder } = await import(
    pathToFileURL(remote)
  );
  const forwarder = new DevicePortForwarder(localWdaPort, deviceWdaPort, {
    host: "127.0.0.1",
    primaryConnector: () => connectViaUsbmux(udid, deviceWdaPort),
  });
  const tasks = [];
  const interrupt = () => {
    for (const task of tasks) task.child.kill("SIGINT");
  };
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", interrupt);
  try {
    await forwarder.start();
    if (await reachable(localWdaPort)) {
      throw new Error(
        "iPhone 上已有 WebDriverAgent 会话，请先结束该会话再重试。",
      );
    }
    const xcodeLog = path.join(root, "last-wda.log");
    const wda = start(
      "xcodebuild",
      [
        "-xctestrun",
        path.resolve(root, xctestrun),
        "-destination",
        `platform=iOS,id=${udid}`,
        "-parallel-testing-enabled",
        "NO",
        "-collect-test-diagnostics",
        "never",
        "test-without-building",
      ],
      root,
      xcodeLog,
    );
    tasks.push(wda);
    await waitReady(localWdaPort, wda, 45_000, "iPhone 驱动", xcodeLog);
    const appiumLog = path.join(root, "last-appium.log");
    const server = start(
      node,
      [
        path.join(appium, "node_modules", "appium", "index.js"),
        "--address",
        "127.0.0.1",
        "--port",
        String(appiumPort),
        "--log-level",
        "warn",
        "--log-no-colors",
      ],
      appium,
      appiumLog,
    );
    tasks.push(server);
    await waitReady(appiumPort, server, 25_000, "Appium", appiumLog);
    const publish = start(
      node,
      [
        publisher,
        ...args,
        "--port",
        String(appiumPort),
        "--wda-port",
        String(localWdaPort),
        "--udid",
        udid,
      ],
      process.cwd(),
    );
    tasks.push(publish);
    const result = await publish.finished;
    if (result.error) throw result.error;
    process.exitCode = result.code ?? 1;
  } finally {
    process.removeListener("SIGINT", interrupt);
    process.removeListener("SIGTERM", interrupt);
    for (const task of tasks.reverse()) await stop(task);
    await forwarder.stop();
  }
}

export async function iphoneCommand(args, dataDir) {
  if (!args.length || args[0] === "--help") {
    console.log(
      "node cli.mjs iphone setup --team-id TEAM\nnode cli.mjs iphone --asset-label '0:03' --title '标题' --description '正文'\n把视频导入手机相册。脚本选中当前画面唯一匹配的视频，填好内容并停在发布页。",
    );
    return;
  }
  const root = path.resolve(dataDir, "iphone");
  const appium = path.join(root, "appium");
  await mkdir(root, { recursive: true, mode: 0o700 });
  if (args[0] === "setup") return setup(args.slice(1), root, appium);
  return executeIphone(args, root, appium);
}

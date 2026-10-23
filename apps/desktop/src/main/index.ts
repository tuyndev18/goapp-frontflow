import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { app, BrowserWindow, Menu, session, shell, type WebContents } from "electron";
import { registerIpcHandlers, PushBus } from "./ipc-gateway.js";
import { createServices, type Services } from "./services.js";

const here = fileURLToPath(new URL(".", import.meta.url));
const DEV_URL = process.env["ELECTRON_RENDERER_URL"];

let services: Services | undefined;
const bus = new PushBus();

function isTrustedSender(sender: WebContents, frameUrl: string): boolean {
  if (BrowserWindow.fromWebContents(sender) === null) return false;
  if (DEV_URL) return frameUrl.startsWith(DEV_URL);
  return frameUrl.startsWith("file://");
}

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 640,
    title: "GoApp FrontFlow",
    icon: join(here, "../../resources/icon.png"),
    show: false,
    webPreferences: {
      preload: join(here, "../preload/index.cjs"),
      // Spec §9.1: no Node in the renderer, isolated context, typed preload only.
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      spellcheck: false,
    },
  });
  // No default File/Edit/View menu bar: the app's own sidebar is the navigation.
  // macOS keeps its application menu (it carries the copy/paste shortcuts there).
  if (process.platform !== "darwin") win.removeMenu();
  bus.attach(win.webContents);
  win.once("ready-to-show", () => win.show());

  // Block navigation away from the app and open external links in the OS browser.
  win.webContents.on("will-navigate", (event, url) => {
    if (DEV_URL ? !url.startsWith(DEV_URL) : !url.startsWith("file://")) event.preventDefault();
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//.test(url)) void shell.openExternal(url);
    return { action: "deny" };
  });

  if (DEV_URL) void win.loadURL(DEV_URL);
  else void win.loadFile(join(here, "../renderer/index.html"));
  return win;
}

app.whenReady().then(async () => {
  if (process.platform !== "darwin") Menu.setApplicationMenu(null);
  session.defaultSession.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  const dataDir = process.env["FRONTFLOW_DATA_DIR"] ?? join(app.getPath("userData"), "goapp-frontflow");
  services = await createServices({ dataDir, bus, runnerEntry: join(here, "runner.js") });
  registerIpcHandlers(services.handlers, isTrustedSender);
  createWindow();
  // Spec DoD #9: resume runs that were active before the app restarted.
  void services.recover();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("web-contents-created", (_e, contents) => {
  contents.on("will-attach-webview", (event) => event.preventDefault());
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => {
  void services?.dispose();
});

import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { app, BrowserWindow, Menu, session, shell, type WebContents } from "electron";
import { registerIpcHandlers, PushBus } from "./ipc-gateway.js";
import { createServices, type Services } from "./services.js";
import { FloWindow } from "./flo-window.js";

const here = fileURLToPath(new URL(".", import.meta.url));
const DEV_URL = process.env["ELECTRON_RENDERER_URL"];

let services: Services | undefined;
let mainWindow: BrowserWindow | undefined;
const bus = new PushBus();

function loadPage(win: BrowserWindow, page: string): void {
  if (DEV_URL) void win.loadURL(page === "index.html" ? DEV_URL : `${DEV_URL}/${page}`);
  else void win.loadFile(join(here, "../renderer", page));
}

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

  loadPage(win, "index.html");
  mainWindow = win;
  // Flo floats outside the app window, so it would otherwise keep the app alive after it closes.
  win.on("closed", () => {
    if (mainWindow === win) mainWindow = undefined;
    flo?.destroy();
  });
  return win;
}

let flo: FloWindow | undefined;

function openFromFlo(target: { projectId: string; runId: string; nodeId?: string }): void {
  const win = mainWindow ?? createWindow();
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
  bus.send("flo:open", target);
}

app.whenReady().then(async () => {
  if (process.platform !== "darwin") Menu.setApplicationMenu(null);
  session.defaultSession.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  const dataDir = process.env["FRONTFLOW_DATA_DIR"] ?? join(app.getPath("userData"), "goapp-frontflow");
  flo = new FloWindow({
    dataDir,
    preload: join(here, "../preload/flo.cjs"),
    load: loadPage,
    anchor: () => mainWindow?.getBounds(),
    onOpen: openFromFlo,
  });
  services = await createServices({ dataDir, bus, runnerEntry: join(here, "runner.js"), flo });
  registerIpcHandlers(services.handlers, isTrustedSender);
  createWindow();
  const { showFlo, floSize } = await services.handlers["settings:get"]();
  flo.setSize(floSize);
  flo.setVisible(showFlo);
  // Spec DoD #9: resume runs that were active before the app restarted.
  void services.recover();

  app.on("activate", () => {
    if (mainWindow) return;
    createWindow();
    if (services) void Promise.resolve(services.handlers["settings:get"]()).then((s) => flo?.setVisible(s.showFlo));
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

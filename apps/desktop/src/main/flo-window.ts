import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BrowserWindow, screen, type Rectangle } from "electron";
import { redact } from "@frontflow/event-schema";
import type { FloConfigDto, FloSize, FloStateDto, FloTargetDto } from "../shared/ipc.js";

/** Before the page reports its size: Flo alone (sprite 120×108 plus breathing room). */
const START_SIZE = { width: 132, height: 120 };
const MARGIN = 24;

/**
 * Flo's own window: transparent, frameless and always on top, so the mascot can be dragged anywhere
 * on screen — over the app or outside it. The app window decides what Flo shows (`flo:update`);
 * this window only draws it, moves, and asks the app to open the step.
 *
 * The window is anchored by its bottom-right corner (where Flo sits), which is what is remembered
 * in `{dataDir}/flo-window.json`, so the card growing or shrinking never moves Flo.
 */
export class FloWindow {
  private win: BrowserWindow | undefined;
  private state: FloStateDto | null = null;
  private config: FloConfigDto = { size: "medium" };
  private visible = false;
  private saveTimer: NodeJS.Timeout | undefined;
  private readonly file: string;

  constructor(
    private readonly opts: {
      dataDir: string;
      preload: string;
      load(win: BrowserWindow, page: string): void;
      /** Bounds of the app window, to place Flo inside its bottom-right corner the first time. */
      anchor(): Rectangle | undefined;
      onOpen(target: FloTargetDto): void;
    },
  ) {
    this.file = join(opts.dataDir, "flo-window.json");
  }

  setVisible(visible: boolean): void {
    this.visible = visible;
    if (!visible) {
      this.win?.hide();
      return;
    }
    if (this.win) this.win.showInactive();
    else this.create();
  }

  update(state: FloStateDto): void {
    this.state = redact(state);
    if (this.win && !this.win.isDestroyed()) this.win.webContents.send("flo:state", this.state);
  }

  current(): FloStateDto | null {
    return this.state;
  }

  /** The page redraws at the new size and reports it back through `resize`, so Flo's corner stays put. */
  setSize(size: FloSize): void {
    this.config = { size };
    if (this.win && !this.win.isDestroyed()) this.win.webContents.send("flo:config", this.config);
  }

  currentConfig(): FloConfigDto {
    return this.config;
  }

  open(): void {
    if (this.state?.target) this.opts.onOpen(this.state.target);
  }

  moveTo(x: number, y: number): void {
    if (!this.win) return;
    this.win.setPosition(x, y);
    this.rememberSoon();
  }

  resize(width: number, height: number): void {
    if (!this.win) return;
    const b = this.win.getBounds();
    if (b.width !== width || b.height !== height) {
      // Grows up and left from Flo's corner, but never past the screen's edge (the card would be cut off).
      const area = screen.getDisplayMatching(b).workArea;
      const x = Math.max(area.x, b.x + b.width - width);
      const y = Math.max(area.y, b.y + b.height - height);
      this.win.setBounds({ x, y, width, height });
    }
    // First shown once the page has sized it, so it never flashes a clipped card. Never steals focus.
    if (this.visible && !this.win.isVisible()) this.win.showInactive();
  }

  destroy(): void {
    if (this.saveTimer) this.remember();
    this.win?.destroy();
    this.win = undefined;
  }

  private create(): void {
    const { right, bottom } = this.startCorner();
    const win = new BrowserWindow({
      x: right - START_SIZE.width,
      y: bottom - START_SIZE.height,
      ...START_SIZE,
      title: "Flo",
      frame: false,
      transparent: true,
      hasShadow: false,
      resizable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      show: false,
      webPreferences: {
        preload: this.opts.preload,
        // Same lockdown as the app window (spec §9.1); its preload exposes only the flo: channels.
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webSecurity: true,
        spellcheck: false,
      },
    });
    // Above normal windows, including the app's own, but under system UI.
    win.setAlwaysOnTop(true, "floating");
    win.webContents.on("will-navigate", (event) => event.preventDefault());
    win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    win.on("closed", () => {
      if (this.win === win) this.win = undefined;
    });
    this.win = win;
    this.opts.load(win, "flo.html");
  }

  /** The remembered corner if it is still on a screen, else inside the app window's bottom-right. */
  private startCorner(): { right: number; bottom: number } {
    try {
      if (existsSync(this.file)) {
        const saved = JSON.parse(readFileSync(this.file, "utf8")) as { right?: unknown; bottom?: unknown };
        if (typeof saved.right === "number" && typeof saved.bottom === "number") {
          const area = screen.getDisplayNearestPoint({ x: saved.right, y: saved.bottom }).workArea;
          const inside = saved.right > area.x && saved.right <= area.x + area.width && saved.bottom > area.y && saved.bottom <= area.y + area.height;
          if (inside) return { right: saved.right, bottom: saved.bottom };
        }
      }
    } catch {
      // A broken file only loses Flo's last position.
    }
    const a = this.opts.anchor() ?? screen.getPrimaryDisplay().workArea;
    return { right: a.x + a.width - MARGIN, bottom: a.y + a.height - MARGIN };
  }

  /** Dragging moves the window many times a second; the corner is written once it settles. */
  private rememberSoon(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.remember(), 400);
  }

  private remember(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = undefined;
    if (!this.win || this.win.isDestroyed()) return;
    const b = this.win.getBounds();
    try {
      writeFileSync(this.file, JSON.stringify({ right: b.x + b.width, bottom: b.y + b.height }));
    } catch (err) {
      console.warn("[flo] could not save position:", redact(err instanceof Error ? err.message : String(err)));
    }
  }
}

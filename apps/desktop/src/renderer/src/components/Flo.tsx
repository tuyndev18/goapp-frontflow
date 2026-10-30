import { useEffect, useRef, useState, type CSSProperties, type PointerEvent } from "react";
import type { FloMood } from "@frontflow/ui-components";
import type { FloApi, FloSize, FloStateDto } from "../../../shared/ipc.js";
import { FLO_EYE_TOKEN, FLO_H, FLO_TICK_MS, FLO_W, drawFlo, floStill } from "../lib/floSprite.js";

declare global {
  interface Window {
    /** Only in Flo's window (preload/flo.ts). */
    flo: FloApi;
  }
}

const COMPACT_KEY = "ff-flo-compact";
/** Pointer travel before a press becomes a drag, so a click still clicks. */
const DRAG_THRESHOLD = 4;
/** Screen pixels per art pixel; whole numbers keep the pixel art crisp. */
const SCALE: Record<FloSize, number> = { small: 2, medium: 3, large: 4 };

const MOOD_LABEL: Record<FloMood, string> = {
  idle: "Idle",
  thinking: "Thinking",
  reading: "Reading",
  coding: "Coding",
  testing: "Testing",
  waiting: "Waiting for you",
  retrying: "Retrying",
  paused: "Paused",
  passed: "Done",
  assumed: "Done with assumptions",
  blocked: "Blocked",
  failed: "Failed",
};

/**
 * Flo, animated. Pixel art stays crisp only at whole multiples, so `scale` is an integer.
 * Decorative: whoever shows Flo says in text what the mood means.
 */
export function FloSprite({ mood, scale = 2 }: { mood: FloMood; scale?: number }) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    const dpr = Math.max(1, Math.round(window.devicePixelRatio || 1));
    canvas.width = FLO_W * scale * dpr;
    canvas.height = FLO_H * scale * dpr;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)");
    let t = 0;
    const paint = () => {
      const css = getComputedStyle(canvas);
      drawFlo(ctx, mood, reduce.matches ? floStill(mood) : t, {
        eye: css.getPropertyValue(FLO_EYE_TOKEN[mood]).trim() || "#ffffff",
        shadow: css.getPropertyValue("--flo-shadow").trim() || "transparent",
      });
    };
    paint();
    const timer = setInterval(() => {
      if (reduce.matches) return;
      t++;
      paint();
    }, FLO_TICK_MS);
    // Eye colours are theme tokens: repaint when the theme flips, even with motion off.
    const themeWatch = new MutationObserver(paint);
    themeWatch.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    reduce.addEventListener("change", paint);
    return () => {
      clearInterval(timer);
      themeWatch.disconnect();
      reduce.removeEventListener("change", paint);
    };
  }, [mood, scale]);

  return <canvas ref={ref} className="ff-flo-sprite" style={{ width: FLO_W * scale, height: FLO_H * scale }} aria-hidden="true" />;
}

/**
 * Everything in Flo's floating window: Flo plus a card saying what the run is doing. Drag anywhere
 * on it to move the window (over the app or outside it); click the card to open the step, click
 * Flo to hide or show the card (remembered).
 */
export function FloWidget() {
  const flo = window.flo;
  const [state, setState] = useState<FloStateDto | null>(null);
  const [compact, setCompact] = useState(readCompact);
  const [size, setSize] = useState<FloSize>("medium");
  const root = useRef<HTMLDivElement>(null);
  const drag = useRef<{ dx: number; dy: number; x0: number; y0: number; moving: boolean } | null>(null);
  // Set when a drag ends, so the click the browser fires right after it does nothing.
  const justDragged = useRef(false);

  useEffect(() => {
    void flo.state().then((s) => s && setState(s));
    return flo.onState(setState);
  }, [flo]);

  useEffect(() => {
    void flo.config().then((c) => setSize(c.size));
    return flo.onConfig((c) => setSize(c.size));
  }, [flo]);

  // The window hugs the widget, so its transparent rest never blocks clicks on what is below.
  useEffect(() => {
    const el = root.current;
    if (!el) return;
    const observer = new ResizeObserver(() => {
      const r = el.getBoundingClientRect();
      void flo.resize(Math.ceil(r.width), Math.ceil(r.height));
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [flo]);

  function onPointerDown(e: PointerEvent<HTMLDivElement>) {
    if (e.button !== 0) return;
    justDragged.current = false;
    drag.current = { dx: e.screenX - window.screenX, dy: e.screenY - window.screenY, x0: e.screenX, y0: e.screenY, moving: false };
  }

  function onPointerMove(e: PointerEvent<HTMLDivElement>) {
    const d = drag.current;
    if (!d) return;
    if (!d.moving) {
      if (Math.hypot(e.screenX - d.x0, e.screenY - d.y0) < DRAG_THRESHOLD) return;
      d.moving = true;
      // Captured only once it is a drag: capturing on press would retarget the click away from the buttons.
      e.currentTarget.setPointerCapture(e.pointerId);
    }
    void flo.moveTo(Math.round(e.screenX - d.dx), Math.round(e.screenY - d.dy));
  }

  function onPointerUp() {
    justDragged.current = drag.current?.moving ?? false;
    drag.current = null;
  }

  function unlessDragged(action: () => void) {
    return () => {
      const skip = justDragged.current;
      justDragged.current = false;
      if (!skip) action();
    };
  }

  function toggle() {
    const next = !compact;
    setCompact(next);
    try {
      localStorage.setItem(COMPACT_KEY, next ? "1" : "0");
    } catch {
      // Not remembered; the choice still applies until the window closes.
    }
  }

  const mood = state?.mood ?? "idle";
  const label = MOOD_LABEL[mood];
  const title = state?.title ?? "FrontFlow";
  const scale = SCALE[size];

  return (
    <div
      ref={root}
      className="ff-flo"
      // The bubble's frame and tail use the same art pixel as Flo.
      style={{ "--flo-px": `${scale}px` } as CSSProperties}
      onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={onPointerUp}>
      {compact ? null : (
        // A pixel-art speech bubble whose tail points down at Flo.
        <div className="ff-flo-bubble">
          <button
            type="button"
            className="ff-flo-bubble-body"
            // aria-disabled rather than disabled: a disabled button swallows the press that starts a drag.
            aria-disabled={!state?.target}
            title={state?.target ? "Open this in FrontFlow" : undefined}
            onClick={unlessDragged(() => {
              if (state?.target) void flo.open();
            })}
          >
            <span className="ff-flo-mood">
              <i className={`ff-flo-mood-dot ff-flo-mood-${mood}`} aria-hidden="true" />
              {label}
            </span>
            <strong className="ff-flo-title">{title}</strong>
            {state?.detail ? <span className="ff-flo-detail">{state.detail}</span> : null}
          </button>
          <button type="button" className="ff-flo-close" aria-label="Hide Flo (show it again from the app's sidebar)" title="Hide Flo" onClick={unlessDragged(() => void flo.hide())}>
            x
          </button>
        </div>
      )}
      <button
        type="button"
        className="ff-flo-toggle"
        aria-expanded={!compact}
        aria-label={compact ? `Flo: ${label}, ${title}. Show the card` : "Hide the card"}
        title={compact ? `${label} · ${title}` : "Drag to move · click to hide the card"}
        onClick={unlessDragged(toggle)}
      >
        <FloSprite mood={mood} scale={scale} />
      </button>
    </div>
  );
}

function readCompact(): boolean {
  try {
    return localStorage.getItem(COMPACT_KEY) === "1";
  } catch {
    return false;
  }
}

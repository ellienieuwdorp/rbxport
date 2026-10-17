/**
 * What the app is costing, for the title bar's readout.
 *
 * Readings are chained with `setTimeout` rather than run on an interval: an
 * interval that outlives the page keeps firing, and a reading is only worth
 * taking once the last one has come back.
 *
 * The readout must cost less than the budget it reports. At one reading a
 * second with ten frames timed per reading, it was the idle load: ten forced
 * composites, a process walk in the backend and a re-render every second
 * came to 0.8 % of a core in the app and 2.6 % in the webview against a
 * budget of 0.5 % (measured on a compiled 0.5.1 with the library loaded).
 * So: a reading every five seconds, and the frame rate from a quarter of a
 * second of frames rather than a frame interval every second.
 */
import { useSyncExternalStore } from "react";

import { getBackend } from "@/ipc/client";
import type { Diagnostics } from "@/ipc/types";

/** Between readings. Five seconds is a readout that still moves, at a
 * fortieth of the idle cost a reading a second had. */
const PERIOD_MS = 5000;

/**
 * How long each reading counts frames for. One interval between two frames
 * is not enough: frames do not land exactly a refresh apart, and WebKit
 * rounds their timestamps to the millisecond, so a single interval under a
 * 60 fps cap read anywhere from 60 to 77, and at 120 Hz an 8.3 ms interval
 * reads as 8 or 9 ms, 125 or 111. Over a quarter of a second that millisecond
 * is under half a frame a second either way, so 60 reads 60 and 120 reads
 * 120. Every frame asked for here is a frame the compositor has to
 * draw, so this is the whole cost of the FPS figure: 30 frames every five
 * seconds at 120 Hz.
 */
const WINDOW_MS = 250;

export interface AppCost extends Diagnostics {
  /** Frames a second, measured in the webview, or `null` before the first. */
  fps: number | null;
}

const NOTHING: AppCost = {
  audioLoad: 0,
  audioXruns: 0,
  cpu: 0,
  memoryMb: 0,
  threads: null,
  openFiles: null,
  gpu: null,
  fps: null,
};

/**
 * Counts frames for `WINDOW_MS` and returns the rate they arrived at.
 *
 * The first frame's timestamp is the start, so the rate is over the gaps
 * between frames rather than from the moment of asking — which included the
 * wait for the first frame and read low. Aborting cancels the frame asked
 * for, so a readout that goes away mid-count stops drawing frames with it.
 */
function measureFps(signal: AbortSignal): Promise<number> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error("aborted"));
      return;
    }
    let start: number | null = null;
    let gaps = 0;
    let frame = 0;
    const abort = () => {
      cancelAnimationFrame(frame);
      reject(new Error("aborted"));
    };
    const step = (now: number) => {
      if (start === null) {
        start = now;
      } else {
        gaps += 1;
      }
      const elapsed = now - start;
      if (elapsed < WINDOW_MS) {
        frame = requestAnimationFrame(step);
        return;
      }
      signal.removeEventListener("abort", abort);
      resolve((gaps / elapsed) * 1000);
    };
    signal.addEventListener("abort", abort, { once: true });
    frame = requestAnimationFrame(step);
  });
}

/**
 * One poller for the whole window, shared by whoever shows a figure.
 *
 * A store rather than a hook holding state in the shell: with `cost` a
 * value of `App`, every reading re-rendered the entire shell — the browser,
 * the deck, the tree — to change four short strings, and that render was
 * most of what the webview did all day. Now a reading changes this store,
 * and only the readout and the processor meter, which subscribe to it,
 * render again. The poller runs while anything subscribes and stops when
 * nothing does.
 *
 * Each run of the poller has its own signal, aborted when the last
 * subscriber leaves. A reading still under way then neither publishes nor
 * schedules the next, so a readout unmounted and mounted again before a
 * reading comes back leaves one poller running, not two.
 */
let current: AppCost = NOTHING;
const listeners = new Set<() => void>();
let run: AbortController | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;

function publish(next: AppCost) {
  current = next;
  for (const listener of listeners) listener();
}

async function read(signal: AbortSignal) {
  try {
    const backend = await getBackend();
    const [sample, fps] = await Promise.all([backend.appDiagnostics(), measureFps(signal)]);
    if (!signal.aborted) publish({ ...sample, fps });
  } catch {
    // A build with no backend behind it simply shows nothing.
    if (!signal.aborted) publish(NOTHING);
  }
  if (!signal.aborted) timer = setTimeout(() => void read(signal), PERIOD_MS);
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (run === null) {
    run = new AbortController();
    void read(run.signal);
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && run !== null) {
      run.abort();
      run = null;
      if (timer !== null) clearTimeout(timer);
      timer = null;
    }
  };
}

function snapshot(): AppCost {
  return current;
}

/** What the app is costing now, updated every few seconds while mounted. */
export function useAppCost(): AppCost {
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}

/** `1.2 GB`, `312 MB` — the readout has no room for six digits of bytes. */
export function formatMemory(mb: number): string {
  if (!Number.isFinite(mb) || mb <= 0) return "—";
  return mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${Math.round(mb)} MB`;
}

/** A whole number, or a dash where the platform will not say. */
export function formatCount(value: number | null): string {
  return value === null || !Number.isFinite(value) ? "—" : String(Math.round(value));
}

/**
 * `12%`, or a dash.
 *
 * A tenth is kept below 10%, where rounding to a whole number reports a quiet
 * app as `0%` — a reading indistinguishable from a broken one, which is how
 * an idle 0.15% used to read.
 */
export function formatPercent(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "—";
  if (value > 0 && value < 10) return `${value.toFixed(1)}%`;
  return `${Math.round(value)}%`;
}

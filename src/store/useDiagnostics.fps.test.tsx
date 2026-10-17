// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { formatCount, useAppCost } from "./useDiagnostics";

vi.mock("@/ipc/client", () => ({
  getBackend: () =>
    Promise.resolve({
      appDiagnostics: () =>
        Promise.resolve({ audioLoad: 0, audioXruns: 0, cpu: 0, memoryMb: 0, threads: null, openFiles: null, gpu: null }),
    }),
}));

function Probe() {
  return <span>{formatCount(useAppCost().fps)}</span>;
}

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement("div");
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  vi.unstubAllGlobals();
});

it.each([60, 120])("reads %i fps from a %i Hz display whose frame times are rounded to the millisecond", async (hz) => {
  // WebKit hands `requestAnimationFrame` whole milliseconds, so no single
  // interval between two frames is the refresh period.
  let frame = 0;
  vi.stubGlobal("requestAnimationFrame", (step: FrameRequestCallback) => {
    const now = 1234 + Math.round((frame * 1000) / hz);
    frame += 1;
    queueMicrotask(() => step(now));
    return frame;
  });
  await act(async () => {
    root.render(<Probe />);
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  expect(host.textContent).toBe(String(hz));
});

/** A display whose frames arrive only when the test draws one. */
function stubDisplay(hz: number) {
  const pending = new Map<number, FrameRequestCallback>();
  let id = 0;
  let frame = 0;
  vi.stubGlobal("requestAnimationFrame", (step: FrameRequestCallback) => {
    id += 1;
    pending.set(id, step);
    return id;
  });
  vi.stubGlobal("cancelAnimationFrame", (handle: number) => pending.delete(handle));
  return {
    pending,
    async draw() {
      const steps = [...pending.values()];
      pending.clear();
      const now = 1234 + Math.round((frame * 1000) / hz);
      frame += 1;
      await act(async () => {
        for (const step of steps) step(now);
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
    },
  };
}

async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

it("stops asking for frames when the readout goes away mid-count", async () => {
  const display = stubDisplay(120);
  act(() => root.render(<Probe />));
  await settle();
  await display.draw();
  expect(display.pending.size).toBe(1);

  act(() => root.render(<></>));
  expect(display.pending.size).toBe(0);
});

it("keeps one reading going when the readout is remounted before a reading comes back", async () => {
  const display = stubDisplay(120);
  act(() => root.render(<Probe />));
  await settle();
  await display.draw();
  act(() => root.render(<></>));
  act(() => root.render(<Probe />));
  await settle();

  // Two pollers would each have a frame outstanding.
  expect(display.pending.size).toBe(1);
  while (display.pending.size > 0) {
    expect(display.pending.size).toBe(1);
    await display.draw();
  }
  expect(host.textContent).toBe("120");
});

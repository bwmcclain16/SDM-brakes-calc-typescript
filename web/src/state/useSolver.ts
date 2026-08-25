/** React hook over the solver worker.
 *
 * Gives a page three things it needs and Streamlit never offered: the result,
 * a truthful "still running" flag, and the ability to supersede an in-flight
 * request when inputs change again. Without that last part, dragging a slider
 * queues a minute of stale simulations that arrive out of order and overwrite
 * each other.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { SolverRequest, SolverResponse } from "../worker/solver.worker.ts";

export interface SolverState<T> {
  result: T | null;
  running: boolean;
  error: string | null;
}

export function useSolver<T = Extract<SolverResponse, { ok: true }>>() {
  const worker = useRef<Worker | null>(null);
  const latestId = useRef(0);
  const [state, setState] = useState<SolverState<T>>({
    result: null,
    running: false,
    error: null,
  });

  useEffect(() => {
    const instance = new Worker(new URL("../worker/solver.worker.ts", import.meta.url), {
      type: "module",
    });

    instance.onmessage = (event: MessageEvent<SolverResponse>) => {
      const message = event.data;
      // Ignore anything that is not the newest request: an earlier, slower solve
      // landing last would otherwise clobber a fresher result.
      if (message.id !== latestId.current) return;
      setState(
        message.ok
          ? { result: message as T, running: false, error: null }
          : { result: null, running: false, error: message.message },
      );
    };

    instance.onerror = (event) => {
      setState({ result: null, running: false, error: event.message || "solver failed" });
    };

    worker.current = instance;
    return () => {
      instance.terminate();
      worker.current = null;
    };
  }, []);

  const solve = useCallback((request: Omit<SolverRequest, "id">) => {
    const instance = worker.current;
    if (!instance) return;
    const id = ++latestId.current;
    setState((prev) => ({ ...prev, running: true, error: null }));
    instance.postMessage({ ...request, id } as SolverRequest);
  }, []);

  return { ...state, solve };
}

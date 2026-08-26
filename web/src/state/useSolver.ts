/** React hook over the solver worker.
 *
 * Gives a page three things it needs and Streamlit never offered: the result,
 * a truthful "still running" flag, and the ability to supersede an in-flight
 * request when inputs change again. Without that last part, dragging a slider
 * queues a minute of stale simulations that arrive out of order and overwrite
 * each other.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { SolverOk, SolverRequest, SolverResponse } from "../worker/solver.worker.ts";

/** Omit that DISTRIBUTES over a union.
 *
 * A plain `Omit<A | B, "id">` collapses the union to its common keys, which
 * would silently discard every solver-specific field the request carries. */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

export type SolveInput = DistributiveOmit<SolverRequest, "id">;

export interface SolverState {
  result: SolverOk | null;
  running: boolean;
  error: string | null;
}

export function useSolver() {
  const worker = useRef<Worker | null>(null);
  const latestId = useRef(0);
  const [state, setState] = useState<SolverState>({
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
          ? { result: message, running: false, error: null }
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

  const solve = useCallback((request: SolveInput) => {
    const instance = worker.current;
    if (!instance) return;
    const id = ++latestId.current;
    setState((prev) => ({ ...prev, running: true, error: null }));
    instance.postMessage({ ...request, id } as SolverRequest);
  }, []);

  /** Drop the current result — used when the geometry changes underneath it, so
   *  a stale field is never read as describing the new one. */
  const clear = useCallback(() => {
    latestId.current += 1;
    setState({ result: null, running: false, error: null });
  }, []);

  return { ...state, solve, clear };
}

export interface QueueState {
  results: SolverOk[];
  running: boolean;
  done: number;
  total: number;
  error: string | null;
}

/** Run a LIST of solves one after another, collecting every result.
 *
 * Sequential rather than parallel on purpose: each solve already saturates a
 * core, and five concurrent field solves on a laptop finish no sooner while
 * making the first result arrive five times later. This is what backs the
 * sweep comparison, where the point is the set, not any one run.
 */
export function useSolverQueue() {
  const worker = useRef<Worker | null>(null);
  const queue = useRef<SolveInput[]>([]);
  const collected = useRef<SolverOk[]>([]);
  const runId = useRef(0);
  const nextId = useRef(0);
  const [state, setState] = useState<QueueState>({
    results: [],
    running: false,
    done: 0,
    total: 0,
    error: null,
  });

  useEffect(() => {
    const instance = new Worker(new URL("../worker/solver.worker.ts", import.meta.url), {
      type: "module",
    });

    instance.onmessage = (event: MessageEvent<SolverResponse>) => {
      const message = event.data;
      if (message.id !== nextId.current) return;
      if (!message.ok) {
        queue.current = [];
        setState((prev) => ({ ...prev, running: false, error: message.message }));
        return;
      }
      collected.current = [...collected.current, message];
      const remaining = queue.current;
      if (remaining.length) {
        const [head, ...rest] = remaining;
        queue.current = rest;
        const id = ++nextId.current;
        instance.postMessage({ ...head, id } as SolverRequest);
        setState((prev) => ({ ...prev, results: collected.current, done: prev.done + 1 }));
      } else {
        setState((prev) => ({
          ...prev,
          results: collected.current,
          done: prev.total,
          running: false,
        }));
      }
    };

    instance.onerror = (event) => {
      queue.current = [];
      setState((prev) => ({ ...prev, running: false, error: event.message || "solver failed" }));
    };

    worker.current = instance;
    return () => {
      instance.terminate();
      worker.current = null;
    };
  }, []);

  const runAll = useCallback((requests: SolveInput[]) => {
    const instance = worker.current;
    if (!instance) return;
    runId.current += 1;
    collected.current = [];
    if (!requests.length) {
      queue.current = [];
      setState({ results: [], running: false, done: 0, total: 0, error: null });
      return;
    }
    const [head, ...rest] = requests;
    queue.current = rest;
    const id = ++nextId.current;
    setState({ results: [], running: true, done: 0, total: requests.length, error: null });
    instance.postMessage({ ...head!, id } as SolverRequest);
  }, []);

  return { ...state, runAll };
}

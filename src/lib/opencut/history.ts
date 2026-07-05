export interface OpenCutHistoryState<T> {
  past: T[];
  present: T;
  future: T[];
  limit: number;
}

export function createOpenCutHistory<T>(initial: T, limit = 60): OpenCutHistoryState<T> {
  return { past: [], present: initial, future: [], limit };
}

export function pushOpenCutHistory<T>(history: OpenCutHistoryState<T>, next: T): OpenCutHistoryState<T> {
  if (Object.is(history.present, next)) return history;
  const past = [...history.past, history.present].slice(-Math.max(1, history.limit));
  return { ...history, past, present: next, future: [] };
}

export function undoOpenCutHistory<T>(history: OpenCutHistoryState<T>): OpenCutHistoryState<T> {
  const previous = history.past[history.past.length - 1];
  if (!previous) return history;
  return {
    ...history,
    past: history.past.slice(0, -1),
    present: previous,
    future: [history.present, ...history.future].slice(0, Math.max(1, history.limit)),
  };
}

export function redoOpenCutHistory<T>(history: OpenCutHistoryState<T>): OpenCutHistoryState<T> {
  const next = history.future[0];
  if (!next) return history;
  return {
    ...history,
    past: [...history.past, history.present].slice(-Math.max(1, history.limit)),
    present: next,
    future: history.future.slice(1),
  };
}

export function canUndoOpenCut<T>(history: OpenCutHistoryState<T>) {
  return history.past.length > 0;
}

export function canRedoOpenCut<T>(history: OpenCutHistoryState<T>) {
  return history.future.length > 0;
}

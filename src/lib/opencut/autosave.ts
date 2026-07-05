import type { OpenCutProject } from './types';

const PREFIX = 'opencut.autosave.';

export interface OpenCutAutosaveRecord {
  project: OpenCutProject;
  savedAt: string;
  version: 1;
}

export function openCutAutosaveKey(projectId: string) {
  return `${PREFIX}${projectId}`;
}

export function saveOpenCutProjectSnapshot(project: OpenCutProject, storage: Storage = window.localStorage): OpenCutAutosaveRecord {
  const record: OpenCutAutosaveRecord = { project, savedAt: new Date().toISOString(), version: 1 };
  storage.setItem(openCutAutosaveKey(project.id), JSON.stringify(record));
  storage.setItem(`${PREFIX}last`, project.id);
  return record;
}

export function loadOpenCutProjectSnapshot(projectId: string, storage: Storage = window.localStorage): OpenCutAutosaveRecord | null {
  const raw = storage.getItem(openCutAutosaveKey(projectId));
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as OpenCutAutosaveRecord;
    if (!parsed?.project?.id) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function loadLastOpenCutProjectSnapshot(storage: Storage = window.localStorage): OpenCutAutosaveRecord | null {
  const lastId = storage.getItem(`${PREFIX}last`);
  return lastId ? loadOpenCutProjectSnapshot(lastId, storage) : null;
}

export function clearOpenCutProjectSnapshot(projectId: string, storage: Storage = window.localStorage) {
  storage.removeItem(openCutAutosaveKey(projectId));
  if (storage.getItem(`${PREFIX}last`) === projectId) storage.removeItem(`${PREFIX}last`);
}

export function debounceOpenCutAutosave(project: OpenCutProject, waitMs = 800) {
  let timer: number | undefined;
  return () => {
    if (timer) window.clearTimeout(timer);
    timer = window.setTimeout(() => saveOpenCutProjectSnapshot(project), waitMs);
  };
}

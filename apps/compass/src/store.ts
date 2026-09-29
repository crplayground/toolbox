// アプリ全体の状態と操作（個人用）。
// データの原本は Worker の KV。画面の変更はまずローカル状態（localStorage にキャッシュ）へ反映し、1.5秒まとめてから Worker へ保存する。
// 保存時は「どの版に対する変更か（baseVersion）」を送り、別の端末で先に更新されていたら上書きせずに最新を読み込む。

import { useSyncExternalStore } from "react";
import type { AppData, AppEvent, Bookmark, Project, Task } from "./types";
import { DEFAULT_STYLE } from "./lib/style";
import { todayKey } from "./lib/date";
import * as api from "./lib/api";

export type SaveStatus = "saved" | "saving" | "pending" | "offline" | "unauthorized" | "unconfigured";

export type State = AppData & {
  events: AppEvent[];
  readIds: string[];
  version: number; // 最後にWorkerと一致した版
  dirty: boolean; // Workerへ未保存の変更がある
  saveStatus: SaveStatus;
  savedAt?: string;
};

const STATE_KEY = "compass_state";
// 旧名（CR Board）時代のキャッシュを引き継ぐ
if (!localStorage.getItem(STATE_KEY) && localStorage.getItem("pmb_state_v2")) {
  localStorage.setItem(STATE_KEY, localStorage.getItem("pmb_state_v2")!);
  localStorage.removeItem("pmb_state_v2");
}

function initial(): State {
  return {
    projects: [],
    tasks: [],
    bookmarks: [],
    userName: "宮川 雄気",
    events: [],
    readIds: [],
    version: 0,
    dirty: false,
    saveStatus: api.getToken() ? "saved" : "unconfigured",
  };
}

function load(): State {
  try {
    const raw = localStorage.getItem(STATE_KEY);
    if (raw) return { ...initial(), ...JSON.parse(raw), saveStatus: api.getToken() ? "saved" : "unconfigured" };
  } catch {
    /* 破損時は初期化 */
  }
  return initial();
}

let state: State = load();
const listeners = new Set<() => void>();

export const getState = () => state;

function setState(update: (s: State) => State) {
  state = update(state);
  localStorage.setItem(STATE_KEY, JSON.stringify(state));
  listeners.forEach((l) => l());
}

export function useStore(): State {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => state,
  );
}

export const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);

// ---- トースト（画面下の短い通知） -------------------------------------------

export type Toast = { id: string; text: string; tone: "info" | "error" | "success" };
let toasts: Toast[] = [];
const toastListeners = new Set<() => void>();

export function toast(text: string, tone: Toast["tone"] = "info") {
  const t = { id: uid(), text, tone };
  toasts = [...toasts, t];
  toastListeners.forEach((l) => l());
  window.setTimeout(() => {
    toasts = toasts.filter((x) => x.id !== t.id);
    toastListeners.forEach((l) => l());
  }, 4200);
}

export function useToasts() {
  return useSyncExternalStore(
    (l) => {
      toastListeners.add(l);
      return () => toastListeners.delete(l);
    },
    () => toasts,
  );
}

function logEvent(e: Omit<AppEvent, "id" | "at">) {
  setState((s) => ({ ...s, events: [{ ...e, id: uid(), at: new Date().toISOString() }, ...s.events].slice(0, 30) }));
}

// ---- Workerとの保存・読み込み ---------------------------------------------

const dataOf = (s: State): AppData => ({ projects: s.projects, tasks: s.tasks, bookmarks: s.bookmarks, userName: s.userName, style: s.style });

function adopt(remote: api.Remote) {
  setState((s) => ({
    ...s,
    ...(remote.data || {}),
    version: remote.version,
    dirty: false,
    saveStatus: "saved",
    savedAt: remote.updatedAt || s.savedAt,
  }));
}

let saveTimer: number | undefined;
let retryTimer: number | undefined;
let saving = false;
let changeSeq = 0;

/** データを変更したら呼ぶ。1.5秒まとめて保存する */
function commit(update: (s: State) => State) {
  changeSeq++;
  setState((s) => ({ ...update(s), dirty: true, saveStatus: api.getToken() ? "pending" : "unconfigured" }));
  scheduleSave();
}

function scheduleSave(delay = 1500) {
  if (!api.getToken()) return;
  window.clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => void saveNow(), delay);
}

export async function saveNow() {
  if (saving || !api.getToken() || !state.dirty) return;
  saving = true;
  const seq = changeSeq;
  setState((s) => ({ ...s, saveStatus: "saving" }));
  try {
    const res = await api.saveData(state.version, dataOf(state));
    // 保存中に次の変更が入っていたら dirty のまま次回へ
    const stillDirty = seq !== changeSeq;
    setState((s) => ({ ...s, version: res.version, dirty: stillDirty, saveStatus: stillDirty ? "pending" : "saved", savedAt: res.updatedAt }));
    if (stillDirty) scheduleSave();
  } catch (e) {
    const err = e as api.ApiError;
    if (err.status === 409 && err.body?.current) {
      adopt(err.body.current);
      toast("別の端末で更新されていたため、最新の内容を読み込みました。直前の変更はやり直してください", "error");
    } else if (err.status === 401) {
      setState((s) => ({ ...s, saveStatus: "unauthorized" }));
      toast("合言葉が違います。接続設定を確認してください", "error");
    } else {
      setState((s) => ({ ...s, saveStatus: "offline" }));
      window.clearTimeout(retryTimer);
      retryTimer = window.setTimeout(() => void saveNow(), 15000);
    }
  } finally {
    saving = false;
  }
}

/** Workerから最新を読み込む。未保存の変更がある場合は先に保存を試みる */
export async function refresh(opts: { silent?: boolean } = {}): Promise<boolean> {
  if (!api.getToken()) return false;
  if (state.dirty) {
    await saveNow();
    return !state.dirty;
  }
  try {
    const remote = await api.fetchData();
    if (!remote.data) {
      // Worker側が空（初回）：手元のデータを初期データとして保存する
      if (state.projects.length || state.bookmarks.length) {
        setState((s) => ({ ...s, version: 0, dirty: true }));
        await saveNow();
      } else {
        setState((s) => ({ ...s, version: remote.version, saveStatus: "saved" }));
      }
      return true;
    }
    if (remote.version !== state.version) {
      adopt(remote);
      if (!opts.silent) logEvent({ icon: "sync", tone: "blue", title: "最新の内容を読み込みました", detail: `プロジェクト${remote.data.projects.length}件・タスク${remote.data.tasks.length}件` });
    } else {
      setState((s) => ({ ...s, saveStatus: "saved" }));
    }
    return true;
  } catch (e) {
    const err = e as api.ApiError;
    setState((s) => ({ ...s, saveStatus: err.status === 401 ? "unauthorized" : "offline" }));
    if (!opts.silent) toast(err.message, "error");
    return false;
  }
}

/** 起動時とウィンドウに戻ったときに最新を確認する（別端末での更新を拾う） */
export function startAutoRefresh() {
  void refresh({ silent: true });
  window.addEventListener("focus", () => void refresh({ silent: true }));
  window.addEventListener("online", () => void refresh({ silent: true }));
  window.addEventListener("beforeunload", (e) => {
    if (state.dirty && api.getToken()) {
      void saveNow();
      e.preventDefault();
    }
  });
}

/** 合言葉を確認して保存する。成功で null、失敗でエラー文 */
export async function connect(token: string): Promise<string | null> {
  if (!token) return "合言葉を入力してください";
  try {
    const remote = await api.fetchData(token);
    api.setToken(token);
    if (remote.data && (state.projects.length || state.bookmarks.length) && remote.version !== state.version) {
      const useRemote = window.confirm(
        `サーバーに保存済みのデータがあります（プロジェクト${remote.data.projects.length}件）。\nOK：サーバーのデータを使う（この端末のデータは破棄）\nキャンセル：この端末のデータでサーバーを上書き`,
      );
      if (useRemote) adopt(remote);
      else {
        setState((s) => ({ ...s, version: remote.version, dirty: true }));
        await saveNow();
      }
    } else if (remote.data) adopt(remote);
    else await refresh({ silent: true });
    return null;
  } catch (e) {
    return (e as Error).message;
  }
}

export function disconnect() {
  api.setToken("");
  setState((s) => ({ ...s, saveStatus: "unconfigured" }));
}

// ---- 書き出し・読み込み・バックアップ ------------------------------------

export function exportJson() {
  const blob = new Blob([JSON.stringify({ exportedAt: new Date().toISOString(), data: dataOf(state) }, null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `compass_${todayKey()}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
}

function isAppData(d: any): d is AppData {
  return d && Array.isArray(d.projects) && Array.isArray(d.tasks) && Array.isArray(d.bookmarks);
}

export async function importJson(file: File): Promise<string | null> {
  try {
    const parsed = JSON.parse(await file.text());
    const data = parsed.data ?? parsed;
    if (!isAppData(data)) return "Compassの書き出しファイルではありません";
    commit((s) => ({ ...s, ...data, userName: data.userName || s.userName }));
    return null;
  } catch {
    return "ファイルを読み込めませんでした";
  }
}

export async function restoreBackup(day: string): Promise<string | null> {
  try {
    const backup = await api.fetchBackup(day);
    if (!isAppData(backup.data)) return "バックアップの形式が不正です";
    const data = backup.data;
    commit((s) => ({ ...s, ...data }));
    return null;
  } catch (e) {
    return (e as Error).message;
  }
}

export function setUserName(name: string) {
  commit((s) => ({ ...s, userName: name.trim() || s.userName }));
}

// ---- 操作（画面から呼ぶ） ------------------------------------------------

export type Draft = { project: Project; tasks: Task[] };

export function newDraft(preset: Partial<Project> = {}): Draft {
  const today = todayKey();
  return {
    project: {
      id: uid(),
      title: "",
      status: "未着",
      department: "",
      types: [],
      start: today,
      due: "",
      memo: "",
      url: "",
      order: Math.max(0, ...state.projects.map((p) => p.order)) + 1,
      ...preset,
    },
    tasks: [],
  };
}

export function draftFor(projectId: string): Draft | null {
  const project = state.projects.find((p) => p.id === projectId);
  if (!project) return null;
  return { project, tasks: state.tasks.filter((t) => t.projectId === projectId).sort((a, b) => a.order - b.order) };
}

/** 複製：新しいIDで内容をコピーし、未保存の下書きとして返す */
export function duplicateDraft(projectId: string): Draft | null {
  const src = draftFor(projectId);
  if (!src) return null;
  const base = newDraft();
  const id = base.project.id;
  return {
    project: { ...src.project, id, title: `${src.project.title}（コピー）`, status: "未着", order: base.project.order, start: todayKey() },
    tasks: src.tasks.map((t) => ({ ...t, id: uid(), projectId: id, status: "未着" })),
  };
}

/** 完了にした日時を記録する（実績として学習に使う） */
const stamp = (t: Task): Task => (t.status === "完了" ? { ...t, completedAt: t.completedAt || new Date().toISOString() } : { ...t, completedAt: undefined });

export function saveDraft(draft: Draft) {
  const project = { ...draft.project, title: draft.project.title.trim() || "（無題）" };
  const tasks = draft.tasks.map((t, i) => stamp({ ...t, projectId: project.id, order: i }));
  commit((s) => ({
    ...s,
    projects: s.projects.some((p) => p.id === project.id) ? s.projects.map((p) => (p.id === project.id ? project : p)) : [...s.projects, project],
    tasks: [...s.tasks.filter((t) => t.projectId !== project.id), ...tasks],
  }));
}

export function updateProject(id: string, patch: Partial<Project>) {
  commit((s) => ({ ...s, projects: s.projects.map((p) => (p.id === id ? { ...p, ...patch } : p)) }));
}

export function updateTask(id: string, patch: Partial<Task>) {
  commit((s) => ({ ...s, tasks: s.tasks.map((t) => (t.id === id ? stamp({ ...t, ...patch }) : t)) }));
}

export function deleteProject(id: string) {
  commit((s) => ({ ...s, projects: s.projects.filter((p) => p.id !== id), tasks: s.tasks.filter((t) => t.projectId !== id) }));
}

/** 並べ替え：渡した順に order を振り直す */
export function reorderProjects(ids: string[]) {
  const orderById = new Map(ids.map((id, i) => [id, i + 1]));
  commit((s) => ({ ...s, projects: s.projects.map((p) => (orderById.has(p.id) ? { ...p, order: orderById.get(p.id)! } : p)) }));
}

export function saveBookmark(b: Bookmark) {
  commit((s) => ({
    ...s,
    bookmarks: s.bookmarks.some((x) => x.id === b.id) ? s.bookmarks.map((x) => (x.id === b.id ? b : x)) : [...s.bookmarks, b],
  }));
}

export function deleteBookmark(id: string) {
  commit((s) => ({ ...s, bookmarks: s.bookmarks.filter((x) => x.id !== id) }));
}

export function markRead(ids: string[]) {
  setState((s) => ({ ...s, readIds: Array.from(new Set([...s.readIds, ...ids])).slice(-300) }));
}

export const importFromRequest = (url: string) => api.importRequestPage(url);

// ---- 作業スタイル（WBS提案でAIに渡すルール） ------------------------------------

export const styleOf = (s: State) => s.style?.trim() || DEFAULT_STYLE;

export function setStyle(text: string) {
  // 初期値と同じなら保存しない（初期値の更新に追従させるため）
  commit((s) => ({ ...s, style: text.trim() === DEFAULT_STYLE.trim() ? undefined : text }));
}

export const planFromRequest = (url: string) => api.planRequestPage(url, styleOf(state));

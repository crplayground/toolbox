import type { AppEvent, Filter, Project, Task } from "../types";
import { addDays, diffDays, formatMD, toKey, todayKey, weekStart } from "./date";

export const isClosed = (s: Project["status"]) => s === "完了" || s === "中止";

export const isOverdue = (p: { due: string; status: Project["status"] }) =>
  !!p.due && !isClosed(p.status) && diffDays(p.due, todayKey()) < 0;

export function progressOf(projectId: string, tasks: Task[]) {
  const own = tasks.filter((t) => t.projectId === projectId);
  const done = own.filter((t) => t.status === "完了").length;
  return { done, total: own.length, percent: own.length ? Math.round((done / own.length) * 100) : 0 };
}

/** ステータスごとの色（Figmaのtone名） */
export const statusTone = (p: Project) =>
  isOverdue(p) ? "orange" : p.status === "進行中" ? "blue" : p.status === "完了" ? "green" : p.status === "中止" ? "gray" : "purple";

export const initials = (name: string) => (name ? name.trim().charAt(0) : "?");

export function applyFilter(projects: Project[], filter: Filter) {
  return projects.filter((p) => !filter.statuses.length || filter.statuses.includes(p.status));
}

export const byDue = (a: { due: string }, b: { due: string }) => (a.due || "9999").localeCompare(b.due || "9999");

export function thisWeek() {
  const start = weekStart(todayKey());
  return { start, end: addDays(start, 6) };
}

/** 期限ベースの通知（今日期限・期限超過）と、同期などのイベント履歴をまとめる */
export function buildNotifications(projects: Project[], tasks: Task[], events: AppEvent[]) {
  const today = todayKey();
  const nameOf = new Map(projects.map((p) => [p.id, p.title]));
  const due: (AppEvent & { group: "今日" | "今週" | "以前" })[] = [];
  for (const t of tasks) {
    if (!t.due || t.status === "完了" || t.status === "中止") continue;
    const n = diffDays(t.due, today);
    if (n === 0) due.push({ id: `due-${t.id}-${t.due}`, icon: "flag", tone: "orange", title: `「${t.title}」が本日期限です`, detail: nameOf.get(t.projectId) || "", at: new Date().toISOString(), group: "今日" });
    else if (n < 0) due.push({ id: `over-${t.id}-${t.due}`, icon: "error", tone: "orange", title: `「${t.title}」が期限を${-n}日超過しています`, detail: `${nameOf.get(t.projectId) || ""} / ${formatMD(t.due)}`, at: new Date().toISOString(), group: "今日" });
  }
  const week = thisWeek().start;
  const logged = events.map((e) => {
    const day = toKey(new Date(e.at));
    const group: "今日" | "今週" | "以前" = day === today ? "今日" : day >= week ? "今週" : "以前";
    return { ...e, group };
  });
  return [...due, ...logged];
}

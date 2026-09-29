import { useState } from "react";
import { updateProject, updateTask, useStore } from "../store";
import { applyFilter, statusTone, taskLabel } from "../lib/derive";
import { addDays, fromKey, todayKey, weekStart } from "../lib/date";
import { useActions, ViewHeader } from "../components/layout";

type Item = { kind: "project" | "task"; id: string; projectId: string; title: string; business: string; tone: string; done: boolean };

export default function Schedule() {
  const { projects, tasks } = useStore();
  const { openEdit, openNew, filter } = useActions();
  const [mode, setMode] = useState<"month" | "week">("month");
  const [cursor, setCursor] = useState(todayKey());
  const [dragOver, setDragOver] = useState<string | null>(null);
  const today = todayKey();

  const visible = applyFilter(projects, filter);
  const visibleIds = new Set(visible.map((p) => p.id));
  const byId = new Map(projects.map((p) => [p.id, p]));

  const itemsByDay = new Map<string, Item[]>();
  const push = (day: string, item: Item) => itemsByDay.set(day, [...(itemsByDay.get(day) || []), item]);
  for (const p of visible) {
    if (p.due) push(p.due, { kind: "project", id: p.id, projectId: p.id, title: p.title, business: p.department, tone: statusTone(p), done: p.status === "完了" });
  }
  for (const t of tasks) {
    if (!t.due || !visibleIds.has(t.projectId)) continue;
    const p = byId.get(t.projectId)!;
    push(t.due, { kind: "task", id: t.id, projectId: t.projectId, title: taskLabel(t), business: p.title, tone: "task", done: t.status === "完了" });
  }

  const d = fromKey(cursor);
  const monthStart = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-01`;
  const gridStart = mode === "month" ? weekStart(monthStart) : weekStart(cursor);
  const nextMonth = new Date(d.getFullYear(), d.getMonth() + 1, 1);
  const weeks = mode === "month" ? Math.ceil((((fromKey(monthStart).getDay() + 6) % 7) + new Date(nextMonth.getTime() - 86400000).getDate()) / 7) : 1;
  const days = Array.from({ length: weeks * 7 }, (_, i) => addDays(gridStart, i));

  const shift = (dir: number) => {
    if (mode === "week") setCursor(addDays(cursor, dir * 7));
    else setCursor(`${new Date(d.getFullYear(), d.getMonth() + dir, 1).getFullYear()}-${String(new Date(d.getFullYear(), d.getMonth() + dir, 1).getMonth() + 1).padStart(2, "0")}-01`);
  };

  const drop = (day: string, raw: string) => {
    const [kind, id] = raw.split(":");
    if (kind === "project") updateProject(id, { due: day });
    else if (kind === "task") updateTask(id, { due: day });
  };

  const title = mode === "month" ? `${d.getFullYear()}年 ${d.getMonth() + 1}月` : `${fromKey(gridStart).getMonth() + 1}月${fromKey(gridStart).getDate()}日 の週`;

  return (
    <>
      <ViewHeader title="スケジュール" description="プロジェクトとタスクの期限を月単位で確認できます。ドラッグで期限を変更できます。" schedule />
      <section className="calendar-panel">
        <div className="calendar-toolbar">
          <div className="calendar-toolbar__nav">
            <button className="icon-button" onClick={() => shift(-1)} aria-label="前へ">
              <span className="material-symbols-rounded icon">chevron_left</span>
            </button>
            <h2>{title}</h2>
            <button className="icon-button" onClick={() => shift(1)} aria-label="次へ">
              <span className="material-symbols-rounded icon">chevron_right</span>
            </button>
            <button className="today-button" onClick={() => setCursor(todayKey())}>
              今日
            </button>
          </div>
          <div className="view-switch">
            <button className={mode === "month" ? "is-active" : ""} onClick={() => setMode("month")}>
              月
            </button>
            <button className={mode === "week" ? "is-active" : ""} onClick={() => setMode("week")}>
              週
            </button>
          </div>
        </div>
        <div className="calendar-grid calendar-grid--labels">
          {["月", "火", "水", "木", "金", "土", "日"].map((w) => (
            <span key={w}>{w}</span>
          ))}
        </div>
        <div className={`calendar-grid calendar-grid--days ${mode === "week" ? "calendar-grid--week" : ""}`}>
          {days.map((day) => {
            const muted = mode === "month" && day.slice(0, 7) !== monthStart.slice(0, 7);
            const items = itemsByDay.get(day) || [];
            return (
              <div
                className={`calendar-day ${muted ? "is-muted" : ""} ${day === today ? "is-today" : ""} ${dragOver === day ? "is-drop-target" : ""}`}
                key={day}
                onDragOver={(e) => {
                  e.preventDefault();
                  setDragOver(day);
                }}
                onDragLeave={() => setDragOver((cur) => (cur === day ? null : cur))}
                onDrop={(e) => {
                  setDragOver(null);
                  drop(day, e.dataTransfer.getData("text/plain"));
                }}
                onDoubleClick={(e) => {
                  if (e.target === e.currentTarget) openNew({ due: day });
                }}
              >
                <span className="calendar-day__number">{fromKey(day).getDate()}</span>
                {items.map((item) => (
                  <button
                    className={`calendar-event calendar-event--${item.tone} calendar-event--detail ${item.done ? "is-done" : ""}`}
                    draggable
                    onDragStart={(e) => e.dataTransfer.setData("text/plain", `${item.kind}:${item.id}`)}
                    onClick={() => openEdit(item.projectId)}
                    key={`${item.kind}-${item.id}`}
                  >
                    {item.business && <span>{item.business}</span>}
                    <strong>{item.title}</strong>
                  </button>
                ))}
              </div>
            );
          })}
        </div>
      </section>
    </>
  );
}

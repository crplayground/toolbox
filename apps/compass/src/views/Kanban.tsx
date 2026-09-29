import { useState } from "react";
import type { Status } from "../types";
import { STATUSES } from "../types";
import { deleteProject, getState, reorderProjects, updateProject, useStore } from "../store";
import { applyFilter, isClosed, isOverdue, progressOf } from "../lib/derive";
import { formatMD, relativeDue } from "../lib/date";
import { useActions, ViewHeader } from "../components/layout";
import { Icon, MoreMenu } from "../components/ui";

const TONES: Record<Status, string> = { 未着: "orange", 進行中: "blue", 完了: "green", 中止: "gray" };

export default function Kanban() {
  const { projects, tasks } = useStore();
  const { openEdit, openNew, duplicate, filter } = useActions();
  const [dragId, setDragId] = useState<string | null>(null);
  const [over, setOver] = useState<string | null>(null);
  const visible = applyFilter(projects, { statuses: [] }).sort((a, b) => a.order - b.order);

  /** カードを status 列の beforeId の前（null なら末尾）へ移動 */
  const move = (id: string, status: Status, beforeId: string | null) => {
    const card = getState().projects.find((p) => p.id === id);
    if (!card) return;
    if (card.status !== status) updateProject(id, { status });
    const ordered = [...getState().projects].sort((a, b) => a.order - b.order).filter((p) => p.id !== id);
    const idx = beforeId ? ordered.findIndex((p) => p.id === beforeId) : -1;
    ordered.splice(idx < 0 ? ordered.length : idx, 0, card);
    reorderProjects(ordered.map((p) => p.id));
  };

  return (
    <>
      <ViewHeader title="カンバン" description="カードをドラッグしてプロジェクトの進行状況を更新できます。" />
      <div className="kanban-board">
        {STATUSES.filter((s) => !filter.statuses.length || filter.statuses.includes(s)).map((status) => {
          const cards = visible.filter((p) => p.status === status);
          return (
            <section
              className={`kanban-column ${over === status ? "is-drop-target" : ""}`}
              key={status}
              onDragOver={(e) => {
                e.preventDefault();
                setOver(status);
              }}
              onDragLeave={(e) => {
                if (!e.currentTarget.contains(e.relatedTarget as Node)) setOver(null);
              }}
              onDrop={() => {
                if (dragId) move(dragId, status, null);
                setDragId(null);
                setOver(null);
              }}
            >
              <div className="kanban-column__header">
                <span className={`kanban-dot kanban-dot--${TONES[status]}`} />
                <h2>{status}</h2>
                <span>{cards.length}</span>
                <button className="icon-button" onClick={() => openNew({ status })} aria-label={`${status}にプロジェクトを追加`}>
                  <Icon name="add" />
                </button>
              </div>
              <div className="kanban-column__cards">
                {cards.map((p) => {
                  const pr = progressOf(p.id, tasks);
                  return (
                    <article
                      className={`kanban-card ${dragId === p.id ? "is-dragging" : ""}`}
                      draggable
                      onDragStart={() => setDragId(p.id)}
                      onDragEnd={() => setDragId(null)}
                      onDrop={(e) => {
                        e.stopPropagation();
                        if (dragId && dragId !== p.id) move(dragId, status, p.id);
                        setDragId(null);
                        setOver(null);
                      }}
                      onClick={() => openEdit(p.id)}
                      key={p.id}
                    >
                      <div className="kanban-card__top">
                        <span>{p.department || "部署未設定"}</span>
                        <MoreMenu
                          items={[
                            { label: "編集", icon: "edit", onClick: () => openEdit(p.id) },
                            { label: "複製", icon: "content_copy", onClick: () => duplicate(p.id) },
                            {
                              label: "削除",
                              icon: "delete",
                              danger: true,
                              onClick: () => window.confirm(`「${p.title}」を削除しますか？`) && deleteProject(p.id),
                            },
                          ]}
                        />
                      </div>
                      <h3>{p.title}</h3>
                      <p>{p.types.join("、") || "種別未設定"}</p>
                      <div className="progress-row">
                        <div className="progress">
                          <span style={{ width: `${pr.percent}%` }} />
                        </div>
                        <span>{pr.percent}%</span>
                      </div>
                      <div className="kanban-card__footer">
                        <span>
                          <Icon name="check_circle" />
                          {pr.done} / {pr.total}
                        </span>
                        <time className={isOverdue(p) ? "is-urgent" : ""}>
                          <Icon name="calendar_today" />
                          {isClosed(p.status) ? formatMD(p.due) : relativeDue(p.due)}
                        </time>
                      </div>
                    </article>
                  );
                })}
                <button className="kanban-add" onClick={() => openNew({ status })}>
                  <Icon name="add" />
                  カードを追加
                </button>
              </div>
            </section>
          );
        })}
      </div>
    </>
  );
}

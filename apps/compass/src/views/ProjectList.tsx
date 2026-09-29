import { useState } from "react";
import { deleteProject, reorderProjects, useStore } from "../store";
import { applyFilter, isOverdue, progressOf } from "../lib/derive";
import { formatMD } from "../lib/date";
import { useActions, ViewHeader } from "../components/layout";
import { EmptyState, Icon, MoreMenu } from "../components/ui";

export default function ProjectList() {
  const { projects, tasks } = useStore();
  const { openEdit, openNew, duplicate, filter } = useActions();
  const [query, setQuery] = useState("");
  const [dragId, setDragId] = useState<string | null>(null);
  const [overId, setOverId] = useState<string | null>(null);

  const q = query.trim().toLowerCase();
  const sorted = [...projects].sort((a, b) => a.order - b.order);
  const rows = applyFilter(sorted, filter).filter(
    (p) => !q || [p.title, p.department, p.memo, ...p.types].some((v) => v.toLowerCase().includes(q)),
  );

  const drop = (targetId: string) => {
    if (!dragId || dragId === targetId) return;
    const ids = sorted.map((p) => p.id).filter((id) => id !== dragId);
    ids.splice(ids.indexOf(targetId), 0, dragId);
    reorderProjects(ids);
  };

  return (
    <>
      <ViewHeader title="プロジェクト一覧" description="すべての案件を検索・整理し、詳細を確認できます。" />
      <section className="list-panel">
        <div className="list-toolbar">
          <label className="search-box">
            <Icon name="search" />
            <input type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="プロジェクトを検索" />
          </label>
          <div className="list-toolbar__count">
            <strong>{rows.length}</strong> プロジェクト
          </div>
        </div>
        <div className="project-table">
          <div className="project-table__head">
            <span>プロジェクト名</span>
            <span>ステータス</span>
            <span>対象部署</span>
            <span>期限</span>
            <span>進捗</span>
            <span />
          </div>
          {rows.length === 0 && (
            <EmptyState
              icon="search_off"
              text={projects.length ? "条件に合うプロジェクトはありません" : "プロジェクトはまだありません"}
              action={
                !projects.length && (
                  <button className="text-button" onClick={() => openNew()}>
                    <Icon name="add" />
                    新規プロジェクト
                  </button>
                )
              }
            />
          )}
          {rows.map((p) => {
            const pr = progressOf(p.id, tasks);
            return (
              <article
                className={`project-table__row ${overId === p.id && dragId !== p.id ? "is-drop-target" : ""}`}
                draggable
                onDragStart={() => setDragId(p.id)}
                onDragEnd={() => {
                  setDragId(null);
                  setOverId(null);
                }}
                onDragOver={(e) => {
                  e.preventDefault();
                  setOverId(p.id);
                }}
                onDrop={() => {
                  drop(p.id);
                  setDragId(null);
                  setOverId(null);
                }}
                onClick={() => openEdit(p.id)}
                key={p.id}
              >
                <div className="table-project">
                  <span className="table-project__handle" title="ドラッグして並べ替え">
                    <Icon name="drag_indicator" />
                  </span>
                  <span>
                    <strong>{p.title}</strong>
                    <small>{p.types.join("、") || "種別未設定"}</small>
                  </span>
                </div>
                <span>
                  <i className={`status-pill status-pill--${p.status}`}>{p.status}</i>
                </span>
                <span>{p.department || "—"}</span>
                <time className={isOverdue(p) ? "is-urgent" : ""}>{formatMD(p.due)}</time>
                <div className="table-progress">
                  <div className="progress">
                    <span style={{ width: `${pr.percent}%` }} />
                  </div>
                  <span>{pr.percent}%</span>
                </div>
                <MoreMenu
                  items={[
                    { label: "編集", icon: "edit", onClick: () => openEdit(p.id) },
                    { label: "複製", icon: "content_copy", onClick: () => duplicate(p.id) },
                    { label: "削除", icon: "delete", danger: true, onClick: () => window.confirm(`「${p.title}」を削除しますか？`) && deleteProject(p.id) },
                  ]}
                />
              </article>
            );
          })}
        </div>
      </section>
    </>
  );
}

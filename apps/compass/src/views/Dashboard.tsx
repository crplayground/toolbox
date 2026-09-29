import { useState } from "react";
import type { Bookmark } from "../types";
import { deleteBookmark, getState, refresh, uid, updateTask, useStore } from "../store";
import { byDue, isClosed, isOverdue, progressOf, statusTone, thisWeek } from "../lib/derive";
import { addDays, diffDays, formatLongJa, formatMD, formatSlash, relativeDue, todayKey, weekStart } from "../lib/date";
import { useActions } from "../components/layout";
import { BookmarkModal } from "../components/modals";
import { EmptyState, Icon, MoreMenu } from "../components/ui";

function greeting() {
  const h = new Date().getHours();
  return h < 11 ? "おはようございます" : h < 18 ? "こんにちは" : "おつかれさまです";
}

export default function Dashboard() {
  const { projects, tasks, bookmarks, userName, savedAt, saveStatus } = useStore();
  const { openNew, openEdit, duplicate, navigate } = useActions();
  const [syncing, setSyncing] = useState(false);
  const [editing, setEditing] = useState<{ bookmark: Bookmark; isNew: boolean } | null>(null);
  const today = todayKey();
  const week = thisWeek();
  const monthPrefix = today.slice(0, 7);

  // 別の端末で更新した内容を手動で読み込む（ウィンドウに戻ったときにも自動で確認している）
  const runSync = async () => {
    setSyncing(true);
    await refresh();
    setSyncing(false);
  };
  const busy = syncing || saveStatus === "saving";

  const active = projects.filter((p) => p.status === "進行中");
  const metrics = [
    { label: "プロジェクト", value: projects.length, sub: `タスク ${tasks.length}件` },
    { label: "進行中", value: active.length, sub: `今週期限 ${active.filter((p) => p.due >= week.start && p.due <= week.end).length}件` },
    { label: "完了", value: projects.filter((p) => p.status === "完了").length, sub: `今月 ${projects.filter((p) => p.status === "完了" && p.due.startsWith(monthPrefix)).length}件` },
    { label: "期限超過", value: projects.filter(isOverdue).length, sub: `タスク ${tasks.filter(isOverdue).length}件` },
    { label: "進行停止", value: projects.filter((p) => p.status === "中止").length, sub: "ステータス：中止" },
  ];

  const openProjects = projects.filter((p) => !isClosed(p.status)).sort(byDue);
  const weekTasks = tasks.filter((t) => t.due >= week.start && t.due <= week.end);
  const weekOpen = weekTasks.filter((t) => t.status !== "完了");
  const todayTasks = tasks.filter((t) => t.due && t.due <= today && !isClosed(t.status)).sort(byDue);
  const doneToday = tasks.filter((t) => t.due === today && t.status === "完了");
  const projectName = (id: string) => projects.find((p) => p.id === id)?.title || "";

  // 今週月曜から4週間
  const rangeStart = weekStart(today);
  const rangeEnd = addDays(rangeStart, 27);
  const timeline = projects
    .filter((p) => p.due && p.status !== "中止" && p.due >= rangeStart && (p.start || p.due) <= rangeEnd)
    .sort(byDue)
    .slice(0, 8)
    .map((p) => {
      const s = Math.max(0, diffDays(p.start && p.start < p.due ? p.start : p.due, rangeStart));
      const e = Math.min(27, diffDays(p.due, rangeStart));
      return { p, left: (s / 28) * 100, width: Math.max(((e - s + 1) / 28) * 100, 3) };
    });

  return (
    <>
      <header className="page-header">
        <div>
          <p className="date-label">{formatLongJa(new Date())}</p>
          <h1>
            {greeting()}、{userName.split(" ")[0]}さん
          </h1>
          <p className="page-subtitle">{savedAt ? `最終保存：${new Date(savedAt).toLocaleString("ja-JP", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })}` : "今日もプロジェクトを前に進めましょう。"}</p>
        </div>
        <div className="header-actions">
          {saveStatus !== "unconfigured" && (
            <button className={`sync-button ${busy ? "is-syncing" : ""}`} onClick={runSync} disabled={busy} title="別の端末での更新を読み込む">
              <Icon name="sync" />
              <span>{busy ? "同期中…" : "最新を読み込む"}</span>
            </button>
          )}
          <button className="button button--accent" onClick={() => openNew()}>
            <Icon name="add" />
            <span>新規プロジェクト</span>
          </button>
        </div>
      </header>

      <section className="metric-grid" aria-label="プロジェクトサマリー">
        {metrics.map((m, i) => (
          <article className="metric-card" key={m.label} style={{ animationDelay: `${i * 60}ms` }}>
            <div>
              <span className="metric-card__label">{m.label}</span>
              <strong>{m.value}</strong>
              <small>{m.sub}</small>
            </div>
          </article>
        ))}
      </section>

      <div className="dashboard-grid">
        <section className="panel panel--projects">
          <div className="panel__header">
            <div>
              <h2>進行中のプロジェクト</h2>
              <p>期限が近い順に表示</p>
            </div>
            <button className="text-button" onClick={() => navigate("list")}>
              すべて表示
              <Icon name="arrow_forward" />
            </button>
          </div>
          <div className="project-list">
            {openProjects.length === 0 && <EmptyState icon="folder_open" text="進行中のプロジェクトはありません" action={<button className="text-button" onClick={() => openNew()}><Icon name="add" />新規プロジェクト</button>} />}
            {openProjects.slice(0, 5).map((p) => {
              const pr = progressOf(p.id, tasks);
              return (
                <article className="project-item is-clickable" key={p.id} onClick={() => openEdit(p.id)}>
                  <div className={`project-item__status status--${p.status}`} />
                  <div className="project-item__main">
                    <div className="project-item__title-row">
                      <h3>{p.title}</h3>
                      <span className={`status-pill status-pill--${p.status}`}>{p.status}</span>
                    </div>
                    <div className="project-item__meta">
                      {p.department && <span>{p.department}</span>}
                      {p.types.length > 0 && <span>{p.types.join("、")}</span>}
                    </div>
                    <div className="progress-row">
                      <div className="progress">
                        <span style={{ width: `${pr.percent}%` }} />
                      </div>
                      <span>
                        {pr.done} / {pr.total} タスク
                      </span>
                    </div>
                  </div>
                  <div className="project-item__due">
                    <span>期限</span>
                    <strong className={isOverdue(p) || p.due === today ? "is-urgent" : ""}>{p.due ? relativeDue(p.due) : "未設定"}</strong>
                  </div>
                  <MoreMenu
                    items={[
                      { label: "編集", icon: "edit", onClick: () => openEdit(p.id) },
                      { label: "複製", icon: "content_copy", onClick: () => duplicate(p.id) },
                    ]}
                  />
                </article>
              );
            })}
          </div>
        </section>

        <aside className="panel panel--focus">
          <div className="panel__header">
            <div>
              <h2>今週のフォーカス</h2>
              <p>
                {formatMD(week.start)} — {week.start.slice(5, 7) === week.end.slice(5, 7) ? `${Number(week.end.slice(8))}日` : formatMD(week.end)}
              </p>
            </div>
            <button className="icon-button" onClick={() => navigate("schedule")} aria-label="スケジュールを見る">
              <Icon name="calendar_month" />
            </button>
          </div>
          <div className="focus-stat">
            <div className="focus-stat__ring">
              <strong>{weekTasks.length}</strong>
              <span>タスク</span>
            </div>
            <div>
              <strong>完了予定</strong>
              <p>
                <b>{weekOpen.length}件</b>が今週期限です
              </p>
            </div>
          </div>
          <div className="today-list">
            <p className="section-label">TODAY</p>
            {todayTasks.length === 0 && doneToday.length === 0 && <p className="today-list__empty">今日期限のタスクはありません</p>}
            {[...todayTasks, ...doneToday].slice(0, 6).map((t) => (
              <label key={t.id}>
                <input type="checkbox" checked={t.status === "完了"} onChange={(e) => updateTask(t.id, { status: e.target.checked ? "完了" : "進行中" })} />
                <span className={t.status === "完了" ? "is-done" : ""}>
                  <strong>{t.title}</strong>
                  <small>{projectName(t.projectId)}</small>
                </span>
                <time>{relativeDue(t.due)}</time>
              </label>
            ))}
          </div>
        </aside>
      </div>

      <section className="panel timeline-panel">
        <div className="panel__header">
          <div>
            <h2>プロジェクトスケジュール</h2>
            <p>今後4週間の進行状況</p>
          </div>
          <div className="timeline-legend">
            <span>
              <i className="legend-dot legend-dot--blue" />
              進行中
            </span>
            <span>
              <i className="legend-dot legend-dot--orange" />
              要確認
            </span>
          </div>
        </div>
        <div className="timeline">
          <div className="timeline__header">
            <span />
            <div className="timeline__scale">
              {[0, 7, 14, 21].map((d) => (
                <span key={d} style={{ left: `${(d / 28) * 100}%` }}>
                  {formatSlash(addDays(rangeStart, d))}
                </span>
              ))}
            </div>
          </div>
          {timeline.length === 0 && <p className="timeline__empty">4週間以内に期限を迎えるプロジェクトはありません</p>}
          {timeline.map(({ p, left, width }) => (
            <div className="timeline__row is-clickable" key={p.id} onClick={() => openEdit(p.id)}>
              <strong>{p.title}</strong>
              <div className="timeline__track">
                <span className={`timeline__bar timeline__bar--${statusTone(p)}`} style={{ left: `${left}%`, width: `${width}%` }} title={`${formatMD(p.start)} → ${formatMD(p.due)}`}>
                  <i />
                </span>
              </div>
            </div>
          ))}
        </div>
      </section>

      <section className="bookmarks">
        <div className="section-header">
          <div>
            <h2>ブックマーク</h2>
            <p>よく使うアセットやリンク</p>
          </div>
          <button className="text-button" onClick={() => setEditing({ bookmark: { id: uid(), title: "", url: "", note: "", order: getState().bookmarks.length }, isNew: true })}>
            <Icon name="add" />
            ブックマークを追加
          </button>
        </div>
        <div className="bookmark-grid">
          {bookmarks.length === 0 && <p className="bookmark-grid__empty">ブックマークはまだありません。「ブックマークを追加」から登録できます。</p>}
          {[...bookmarks]
            .sort((a, b) => a.order - b.order)
            .map((b) => (
              <div className="bookmark-card-wrap" key={b.id}>
                <a className="bookmark-card" href={b.url} target="_blank" rel="noreferrer">
                  <span className="bookmark-card__icon">
                    <Icon name="bookmark" />
                  </span>
                  <span>
                    <strong>{b.title}</strong>
                    <small>{b.note || b.url}</small>
                  </span>
                  <Icon name="arrow_outward" />
                </a>
                <button className="icon-button bookmark-card__edit" onClick={() => setEditing({ bookmark: b, isNew: false })} aria-label="ブックマークを編集">
                  <Icon name="edit" />
                </button>
              </div>
            ))}
        </div>
      </section>

      {editing && (
        <BookmarkModal
          bookmark={editing.bookmark}
          onClose={() => setEditing(null)}
          onDelete={
            editing.isNew
              ? undefined
              : () => {
                  if (!window.confirm(`「${editing.bookmark.title}」を削除しますか？`)) return;
                  deleteBookmark(editing.bookmark.id);
                  setEditing(null);
                }
          }
        />
      )}
    </>
  );
}

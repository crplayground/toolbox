import { createContext, useContext, useEffect, useRef, useState } from "react";
import type { Filter, Project } from "../types";
import { STATUSES } from "../types";
import { markRead, useStore } from "../store";
import { buildNotifications } from "../lib/derive";
import { timeAgo } from "../lib/date";
import { Avatar, Icon } from "./ui";

export const navItems = [
  { id: "dashboard", label: "ダッシュボード", icon: "space_dashboard" },
  { id: "schedule", label: "スケジュール", icon: "calendar_month" },
  { id: "kanban", label: "カンバン", icon: "view_kanban" },
  { id: "list", label: "プロジェクト一覧", icon: "view_list" },
] as const;

export type ViewId = (typeof navItems)[number]["id"];

/** 各ビューから呼ぶ画面操作（モーダルの開閉・画面遷移） */
export type Actions = {
  openNew: (preset?: Partial<Project>) => void;
  openEdit: (projectId: string) => void;
  duplicate: (projectId: string) => void;
  navigate: (view: ViewId) => void;
  filter: Filter;
  setFilter: (f: Filter) => void;
};

export const ActionsContext = createContext<Actions | null>(null);
export const useActions = () => useContext(ActionsContext)!;

export function Sidebar({ expanded, onToggle, active, onNavigate }: { expanded: boolean; onToggle: () => void; active: string; onNavigate: (id: ViewId) => void }) {
  return (
    <aside className={`sidebar ${expanded ? "sidebar--expanded" : ""}`}>
      <button className="brand" onClick={onToggle} aria-label={expanded ? "メニューを閉じる" : "メニューを開く"}>
        <div className="brand__mark">
          <span>C</span>
        </div>
        {expanded && <strong className="brand__name">Compass</strong>}
      </button>
      <nav className="nav" aria-label="メインナビゲーション">
        {navItems.map((item) => (
          <button className={`nav__item ${active === item.id ? "nav__item--active" : ""}`} key={item.id} onClick={() => onNavigate(item.id)} title={expanded ? undefined : item.label}>
            <Icon name={item.icon} filled={active === item.id} />
            {expanded && <span>{item.label}</span>}
          </button>
        ))}
      </nav>
    </aside>
  );
}

function FilterButton() {
  const { filter, setFilter } = useActions();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && setOpen(false);
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);
  const count = filter.statuses.length;
  return (
    <div className="filter" ref={ref}>
      <button className={`button button--secondary ${count ? "is-filtered" : ""}`} onClick={() => setOpen(!open)}>
        <Icon name="filter_list" />
        フィルター{count ? `（${count}）` : ""}
      </button>
      {open && (
        <div className="popover filter__panel">
          <p className="section-label">STATUS</p>
          <div className="chips chips--wrap">
            {STATUSES.map((s) => (
              <button
                key={s}
                className={filter.statuses.includes(s) ? "is-selected" : ""}
                onClick={() => setFilter({ ...filter, statuses: filter.statuses.includes(s) ? filter.statuses.filter((x) => x !== s) : [...filter.statuses, s] })}
              >
                {s}
              </button>
            ))}
          </div>
          {count > 0 && (
            <button className="text-button" onClick={() => setFilter({ statuses: [] })}>
              <Icon name="restart_alt" />
              フィルターを解除
            </button>
          )}
        </div>
      )}
    </div>
  );
}

export function ViewHeader({ title, description, schedule = false, filter = true }: { title: string; description: string; schedule?: boolean; filter?: boolean }) {
  const { openNew } = useActions();
  return (
    <header className={`workspace-header ${schedule ? "workspace-header--schedule" : ""}`}>
      <div>
        <p className="eyebrow">PROJECT WORKSPACE</p>
        <h1>{title}</h1>
        <p>{description}</p>
      </div>
      <div className="header-actions">
        {filter && <FilterButton />}
        <button className="button button--accent" onClick={() => openNew()}>
          <Icon name="add" />
          新規プロジェクト
        </button>
      </div>
    </header>
  );
}

export function useNotifications() {
  const { projects, tasks, events, readIds } = useStore();
  const items = buildNotifications(projects, tasks, events);
  const read = new Set(readIds);
  return items.map((i) => ({ ...i, unread: !read.has(i.id) }));
}

export function NotificationPanel({ onClose }: { onClose: () => void }) {
  const items = useNotifications();
  const { openEdit } = useActions();
  const { tasks } = useStore();
  const unreadCount = items.filter((i) => i.unread).length;
  const groups = ["今日", "今週", "以前"] as const;
  return (
    <>
      <div className="notif-backdrop" onMouseDown={onClose} role="presentation" />
      <section className="notif-panel" role="dialog" aria-modal="true" aria-label="通知">
        <div className="notif-panel__header">
          <div>
            <h2>通知</h2>
            {unreadCount > 0 && <span className="notif-panel__count">{unreadCount}</span>}
          </div>
          <button className="icon-button" onClick={onClose} aria-label="閉じる">
            <Icon name="close" />
          </button>
        </div>
        <div className="notif-panel__body">
          {items.length === 0 ? (
            <div className="notif-empty">
              <Icon name="notifications_off" />
              <p>新しい通知はありません</p>
            </div>
          ) : (
            groups.map((group) => {
              const groupItems = items.filter((i) => i.group === group);
              if (!groupItems.length) return null;
              return (
                <div key={group}>
                  <p className="notif-group">{group}</p>
                  {groupItems.map((item) => (
                    <button
                      key={item.id}
                      className={`notif-item ${item.unread ? "is-unread" : ""}`}
                      onClick={() => {
                        markRead([item.id]);
                        const taskId = item.id.match(/^(?:due|over)-(.+)-\d{4}-\d{2}-\d{2}$/)?.[1];
                        const task = tasks.find((t) => t.id === taskId);
                        if (task) {
                          onClose();
                          openEdit(task.projectId);
                        }
                      }}
                    >
                      <span className={`notif-item__icon tone--${item.tone}`}>
                        <Icon name={item.icon} />
                      </span>
                      <span className="notif-item__body">
                        <strong>{item.title}</strong>
                        <p>{item.detail}</p>
                        <time>{item.id.startsWith("due-") || item.id.startsWith("over-") ? "期限" : timeAgo(item.at)}</time>
                      </span>
                      {item.unread && <span className="notif-item__dot" aria-label="未読" />}
                    </button>
                  ))}
                </div>
              );
            })
          )}
        </div>
        <div className="notif-panel__footer">
          <button className="button button--secondary" onClick={() => markRead(items.map((i) => i.id))}>
            <Icon name="done_all" />
            すべて既読にする
          </button>
        </div>
      </section>
    </>
  );
}

const STATUS_LABEL = {
  saved: "保存済み",
  saving: "保存中…",
  pending: "保存待ち",
  offline: "未保存（オフライン）",
  unauthorized: "合言葉を確認",
  unconfigured: "接続設定が必要",
} as const;

export function UserMenu({ onClick }: { onClick: () => void }) {
  const { userName, saveStatus } = useStore();
  const warn = saveStatus === "offline" || saveStatus === "unauthorized" || saveStatus === "unconfigured";
  return (
    <button className="user-menu" onClick={onClick} title="接続設定">
      <Avatar name={userName} />
      <span className="user-menu__copy">
        <strong>{userName}</strong>
        <small className={warn ? "is-urgent" : ""}>{STATUS_LABEL[saveStatus]}</small>
      </span>
      <Icon name="expand_more" />
    </button>
  );
}

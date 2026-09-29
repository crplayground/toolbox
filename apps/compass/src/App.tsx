import { useState } from "react";
import type { Filter, Project } from "./types";
import { useEffect } from "react";
import { draftFor, duplicateDraft, newDraft, startAutoRefresh, useStore, type Draft } from "./store";
import { ActionsContext, navItems, NotificationPanel, Sidebar, useNotifications, UserMenu, type Actions, type ViewId } from "./components/layout";
import { ProjectModal, SettingsModal, type ProjectModalMode } from "./components/modals";
import { Icon, Toasts } from "./components/ui";
import Dashboard from "./views/Dashboard";
import Schedule from "./views/Schedule";
import Kanban from "./views/Kanban";
import ProjectList from "./views/ProjectList";

type ProjectModalState = { draft: Draft; mode: ProjectModalMode; key: string };

export default function App() {
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [active, setActive] = useState<ViewId>(() => (navItems.some((n) => n.id === location.hash.slice(1)) ? (location.hash.slice(1) as ViewId) : "dashboard"));
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [projectModal, setProjectModal] = useState<ProjectModalState | null>(null);
  const [notifOpen, setNotifOpen] = useState(false);
  const [filter, setFilter] = useState<Filter>({ statuses: [] });
  const hasUnread = useNotifications().some((n) => n.unread);
  const { saveStatus } = useStore();

  useEffect(() => {
    startAutoRefresh();
    // 初回（合言葉が未設定）は接続設定を開く
    if (saveStatus === "unconfigured") setSettingsOpen(true);
  }, []);

  const navigate = (view: ViewId) => {
    setActive(view);
    history.replaceState(null, "", `#${view}`);
  };

  const actions: Actions = {
    openNew: (preset?: Partial<Project>) => setProjectModal({ draft: newDraft(preset), mode: "new", key: String(Date.now()) }),
    openEdit: (id) => {
      const draft = draftFor(id);
      if (draft) setProjectModal({ draft, mode: "edit", key: id });
    },
    duplicate: (id) => {
      const draft = duplicateDraft(id);
      if (draft) setProjectModal({ draft, mode: "new", key: draft.project.id });
    },
    navigate,
    filter,
    setFilter,
  };

  return (
    <ActionsContext.Provider value={actions}>
      <div className="app-shell">
        <Sidebar expanded={sidebarOpen} onToggle={() => setSidebarOpen(!sidebarOpen)} active={active} onNavigate={navigate} />
        <main className={`main ${sidebarOpen ? "main--shifted" : ""}`}>
          <div className="topbar">
            <div className="topbar__context">
              <Icon name="home" />
              <span>/</span>
              <strong>{navItems.find((item) => item.id === active)?.label}</strong>
            </div>
            <div className="topbar__tools">
              <button className={`icon-button notification-button ${notifOpen ? "is-open" : ""} ${hasUnread ? "has-unread" : ""}`} aria-label="通知" aria-expanded={notifOpen} onClick={() => setNotifOpen((o) => !o)}>
                <Icon name="notifications" filled={notifOpen} />
                <span />
              </button>
              <UserMenu onClick={() => setSettingsOpen(true)} />
            </div>
          </div>
          <div className="content">
            {active === "dashboard" && <Dashboard />}
            {active === "schedule" && <Schedule />}
            {active === "kanban" && <Kanban />}
            {active === "list" && <ProjectList />}
          </div>
        </main>
        {notifOpen && <NotificationPanel onClose={() => setNotifOpen(false)} />}
        {settingsOpen && <SettingsModal onClose={() => setSettingsOpen(false)} />}
        {projectModal && (
          <ProjectModal
            key={projectModal.key}
            draft={projectModal.draft}
            mode={projectModal.mode}
            onClose={() => setProjectModal(null)}
            onDuplicate={actions.duplicate}
          />
        )}
        <Toasts />
      </div>
    </ActionsContext.Provider>
  );
}

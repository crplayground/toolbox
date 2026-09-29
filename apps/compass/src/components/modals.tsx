import { useEffect, useRef, useState, type ReactNode } from "react";
import type { Bookmark, Status, Task } from "../types";
import { DEPARTMENTS, PRODUCT_TYPES, STATUSES } from "../types";
import {
  connect,
  deleteProject,
  disconnect,
  exportJson,
  importFromRequest,
  importJson,
  restoreBackup,
  saveBookmark,
  saveDraft,
  setUserName,
  toast,
  uid,
  useStore,
  type Draft,
} from "../store";
import { getToken, listBackups, WORKER_URL } from "../lib/api";
import { formatMD } from "../lib/date";
import { Dropdown, Icon } from "./ui";

function Modal({ eyebrow, title, wide, onClose, children }: { eyebrow: string; title: string; wide?: boolean; onClose: () => void; children: ReactNode }) {
  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={onClose}>
      <section className={`modal ${wide ? "modal--wide" : ""}`} role="dialog" aria-modal="true" aria-label={title} onMouseDown={(e) => e.stopPropagation()}>
        <div className="modal__header">
          <div>
            <p className="eyebrow">{eyebrow}</p>
            <h2>{title}</h2>
          </div>
          <button className="icon-button" onClick={onClose} aria-label="閉じる">
            <Icon name="close" />
          </button>
        </div>
        {children}
      </section>
    </div>
  );
}

// ---- 接続設定（合言葉・表示名・バックアップ） ---------------------------------

export function SettingsModal({ onClose }: { onClose: () => void }) {
  const { userName, savedAt } = useStore();
  const [token, setTokenInput] = useState(getToken());
  const [name, setName] = useState(userName);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  const [days, setDays] = useState<string[] | null>(null);
  const [day, setDay] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);
  const connected = !!getToken();

  useEffect(() => {
    if (!connected) return;
    listBackups()
      .then((r) => setDays(r.days))
      .catch(() => setDays([]));
  }, [connected]);

  const save = async () => {
    setSaving(true);
    setError("");
    setSaved(false);
    if (name.trim() && name.trim() !== userName) setUserName(name);
    const err = token.trim() !== getToken() ? await connect(token.trim()) : null;
    setSaving(false);
    if (err) setError(err);
    else setSaved(true);
  };

  const restore = async () => {
    if (!day || !window.confirm(`${day} 時点のバックアップで現在のデータを置き換えます。よろしいですか？`)) return;
    const err = await restoreBackup(day);
    if (err) setError(err);
    else toast(`${day} のバックアップを復元しました`, "success");
  };

  return (
    <Modal eyebrow="SETTINGS" title="接続設定" onClose={onClose}>
      <p className="modal__lead">データはCloudflare Workerに保存されます。同じ合言葉を入れた端末どうしで、同じデータを使えます。</p>
      <label className="field">
        <span>合言葉</span>
        <div className="input-with-icon">
          <Icon name="key" />
          <input type="password" autoComplete="off" value={token} onChange={(e) => setTokenInput(e.target.value)} placeholder="Workerに登録した APP_TOKEN" />
        </div>
      </label>
      <label className="field">
        <span>表示名</span>
        <input type="text" value={name} onChange={(e) => setName(e.target.value)} placeholder="例：宮川 雄気" />
      </label>
      <div className="connection-note">
        <Icon name="lock" />
        <span>合言葉はこのブラウザ内にのみ保存されます（接続先：{WORKER_URL.replace("https://", "")}）</span>
      </div>
      {error && (
        <div className="error-message">
          <Icon name="error" filled />
          <span>{error}</span>
        </div>
      )}
      {saved && (
        <div className="saved-message">
          <Icon name="check_circle" filled />
          <span>設定を保存しました</span>
        </div>
      )}

      <div className="modal-divider">
        <span>バックアップ</span>
      </div>
      <div className="settings-row">
        <div>
          <strong>ファイルに書き出す／読み込む</strong>
          <small>JSONファイルで手元に保存できます{savedAt ? `（最終保存：${new Date(savedAt).toLocaleString("ja-JP", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })}）` : ""}</small>
        </div>
        <button className="button button--secondary" onClick={exportJson}>
          <Icon name="download" />
          書き出す
        </button>
        <button className="button button--secondary" onClick={() => fileRef.current?.click()}>
          <Icon name="upload" />
          読み込む
        </button>
        <input
          ref={fileRef}
          type="file"
          accept="application/json"
          hidden
          onChange={async (e) => {
            const f = e.target.files?.[0];
            e.target.value = "";
            if (!f || !window.confirm("ファイルの内容で現在のデータを置き換えます。よろしいですか？")) return;
            const err = await importJson(f);
            if (err) setError(err);
            else toast("ファイルから読み込みました", "success");
          }}
        />
      </div>
      {connected && (
        <div className="settings-row">
          <div>
            <strong>自動バックアップから復元</strong>
            <small>1日1回、Workerに自動で保存（30日間）</small>
          </div>
          <select className="settings-select" value={day} onChange={(e) => setDay(e.target.value)} disabled={!days?.length}>
            <option value="">{days === null ? "読み込み中…" : days.length ? "日付を選択" : "まだありません"}</option>
            {days?.map((d) => (
              <option key={d} value={d}>
                {d}
              </option>
            ))}
          </select>
          <button className="button button--secondary" onClick={restore} disabled={!day}>
            <Icon name="history" />
            復元
          </button>
        </div>
      )}

      <div className="modal__actions">
        {connected && (
          <div className="modal__actions-left">
            <button
              className="button button--danger"
              onClick={() => {
                if (window.confirm("この端末の接続を解除します（Worker上のデータは消えません）。よろしいですか？")) {
                  disconnect();
                  setTokenInput("");
                }
              }}
            >
              <Icon name="link_off" />
              接続を解除
            </button>
          </div>
        )}
        <button className="button button--secondary" onClick={onClose}>
          キャンセル
        </button>
        <button className="button button--primary" onClick={save} disabled={saving}>
          <Icon name="save" />
          {saving ? "接続を確認中…" : "保存する"}
        </button>
      </div>
    </Modal>
  );
}

// ---- プロジェクト（新規・編集・複製） ------------------------------------

export type ProjectModalMode = "new" | "edit";

export function ProjectModal({ draft: initial, mode, onClose, onDuplicate }: { draft: Draft; mode: ProjectModalMode; onClose: () => void; onDuplicate?: (id: string) => void }) {
  const [source, setSource] = useState<"manual" | "notion">("manual");
  const [draft, setDraft] = useState<Draft>(initial);
  const [importUrl, setImportUrl] = useState("");
  const [importing, setImporting] = useState(false);
  const [importError, setImportError] = useState("");
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const p = draft.project;
  const setProject = (patch: Partial<Draft["project"]>) => setDraft((d) => ({ ...d, project: { ...d.project, ...patch } }));
  const setTask = (i: number, patch: Partial<Task>) => setDraft((d) => ({ ...d, tasks: d.tasks.map((t, j) => (j === i ? { ...t, ...patch } : t)) }));
  const addTask = (title = "", due = "") =>
    setDraft((d) => ({
      ...d,
      tasks: [...d.tasks, { id: uid(), projectId: d.project.id, title, status: "未着" as Status, due, order: d.tasks.length }],
    }));
  const moveTask = (from: number, to: number) =>
    setDraft((d) => {
      const tasks = [...d.tasks];
      const [t] = tasks.splice(from, 1);
      tasks.splice(to, 0, t);
      return { ...d, tasks };
    });

  const runImport = async () => {
    setImporting(true);
    setImportError("");
    try {
      const r = await importFromRequest(importUrl);
      setDraft((d) => ({
        project: {
          ...d.project,
          title: r.title || d.project.title,
          department: r.department || d.project.department,
          types: r.types.length ? r.types : d.project.types,
          memo: [r.memo, d.project.memo].filter(Boolean).join("\n"),
          url: r.url,
          due: r.tasks.map((t) => t.due).filter(Boolean).sort().slice(-1)[0] || d.project.due,
        },
        tasks: [
          ...d.tasks,
          ...r.tasks.map((t, i) => ({ id: uid(), projectId: d.project.id, title: t.title, status: "未着" as Status, due: t.due, order: d.tasks.length + i })),
        ],
      }));
      setSource("manual");
      toast(`依頼ページを読み込みました${r.tasks.length ? `（タスク${r.tasks.length}件）` : ""}。内容を確認して登録してください`, "success");
    } catch (e) {
      setImportError((e as Error).message);
    } finally {
      setImporting(false);
    }
  };

  const submit = () => {
    if (!p.title.trim()) {
      toast("案件タイトルを入力してください", "error");
      return;
    }
    saveDraft(draft);
    onClose();
  };

  const remove = () => {
    if (!window.confirm(`「${p.title}」と紐づくタスクを削除します。よろしいですか？`)) return;
    deleteProject(p.id);
    onClose();
  };

  return (
    <Modal eyebrow={mode === "new" ? "NEW PROJECT" : "EDIT PROJECT"} title={mode === "new" ? "新規プロジェクト" : "プロジェクトを編集"} wide onClose={onClose}>
      {mode === "new" && (
        <div className="segmented">
          <button className={source === "manual" ? "is-active" : ""} onClick={() => setSource("manual")}>
            <Icon name="edit_note" />
            手動で登録
          </button>
          <button className={source === "notion" ? "is-active" : ""} onClick={() => setSource("notion")}>
            <Icon name="link" />
            Notionページから
          </button>
        </div>
      )}
      {source === "notion" ? (
        <div className="notion-import">
          <div className="notion-import__icon">
            <Icon name="description" />
          </div>
          <h3>依頼ページから情報を読み込む</h3>
          <p>社内依頼フォームから作成されたNotionページのURLを貼り付けてください。案件名・対象部署・制作物の種別・スケジュールを読み込みます。</p>
          <label className="field field--full">
            <span>Notionページ URL</span>
            <div className="input-with-icon">
              <Icon name="link" />
              <input type="url" value={importUrl} onChange={(e) => setImportUrl(e.target.value)} placeholder="https://www.notion.so/..." />
            </div>
          </label>
          {importError && (
            <div className="error-message field--full">
              <Icon name="error" filled />
              <span>{importError}</span>
            </div>
          )}
          <button className="button button--primary" onClick={runImport} disabled={importing || !importUrl.trim()}>
            <Icon name="download" />
            {importing ? "読み込み中…" : "内容を読み込む"}
          </button>
        </div>
      ) : (
        <div className="project-form">
          <label className="field field--full">
            <span>案件タイトル</span>
            <input type="text" value={p.title} onChange={(e) => setProject({ title: e.target.value })} placeholder="プロジェクト名を入力" autoFocus={mode === "new"} />
          </label>
          <div className="field field--full">
            <span>ステータス</span>
            <div className="chips">
              {STATUSES.map((s) => (
                <button key={s} type="button" onClick={() => setProject({ status: s })} className={p.status === s ? "is-selected" : ""}>
                  {s}
                </button>
              ))}
            </div>
          </div>
          <div className="form-grid">
            <div className="field">
              <span>対象部署</span>
              <Dropdown options={DEPARTMENTS} value={p.department} onChange={(v) => setProject({ department: v })} />
            </div>
            <label className="field">
              <span>期限</span>
              <input type="date" value={p.due} onChange={(e) => setProject({ due: e.target.value })} />
            </label>
          </div>
          <div className="field field--full">
            <span>制作物の種別</span>
            <Dropdown multiple options={PRODUCT_TYPES} value={p.types} onChange={(v) => setProject({ types: v })} />
          </div>
          <div className="task-builder">
            <div className="task-builder__header">
              <div>
                <strong>タスク</strong>
                <small>プロジェクトに必要な作業を追加</small>
              </div>
              <button type="button" className="text-button" onClick={() => addTask()}>
                <Icon name="add" />
                タスクを追加
              </button>
            </div>
            {draft.tasks.map((t, i) => (
              <div
                className={`task-row ${dragIndex === i ? "is-dragging" : ""}`}
                key={t.id}
                onDragOver={(e) => e.preventDefault()}
                onDrop={() => {
                  if (dragIndex !== null) moveTask(dragIndex, i);
                  setDragIndex(null);
                }}
              >
                <span className="drag-handle" draggable onDragStart={() => setDragIndex(i)} onDragEnd={() => setDragIndex(null)} title="ドラッグして並べ替え">
                  <Icon name="drag_indicator" />
                </span>
                <input
                  type="checkbox"
                  className="task-row__check"
                  checked={t.status === "完了"}
                  onChange={(e) => setTask(i, { status: e.target.checked ? "完了" : "未着" })}
                  aria-label="完了"
                />
                <input type="text" value={t.title} onChange={(e) => setTask(i, { title: e.target.value })} placeholder="タスク名（例：初稿デザイン）" />
                <label className="date-control" title={t.due ? formatMD(t.due) : "期限"}>
                  <Icon name="calendar_today" />
                  <input type="date" value={t.due} onChange={(e) => setTask(i, { due: e.target.value })} />
                </label>
                <button type="button" className="icon-button" onClick={() => setDraft((d) => ({ ...d, tasks: d.tasks.filter((_, j) => j !== i) }))} aria-label="タスクを削除">
                  <Icon name="delete" />
                </button>
              </div>
            ))}
            {!draft.tasks.length && <p className="task-builder__empty">タスクはまだありません</p>}
          </div>
          <label className="field field--full">
            <span>メモ</span>
            <textarea rows={3} value={p.memo} onChange={(e) => setProject({ memo: e.target.value })} placeholder="共有事項や参考情報を入力" />
          </label>
          {p.url && (
            <a className="source-link field--full" href={p.url} target="_blank" rel="noreferrer">
              <Icon name="description" />
              依頼ページを開く
            </a>
          )}
        </div>
      )}
      {source === "manual" && (
        <div className="modal__actions">
          {mode === "edit" && (
            <div className="modal__actions-left">
              <button className="button button--danger" onClick={remove}>
                <Icon name="delete" />
                削除
              </button>
              {onDuplicate && (
                <button className="button button--secondary" onClick={() => onDuplicate(p.id)}>
                  <Icon name="content_copy" />
                  複製
                </button>
              )}
            </div>
          )}
          <button className="button button--secondary" onClick={onClose}>
            キャンセル
          </button>
          <button className="button button--primary" onClick={submit}>
            <Icon name={mode === "new" ? "add" : "save"} />
            {mode === "new" ? "プロジェクトを登録" : "保存する"}
          </button>
        </div>
      )}
    </Modal>
  );
}

// ---- ブックマーク -------------------------------------------------------

export function BookmarkModal({ bookmark, onClose, onDelete }: { bookmark: Bookmark; onClose: () => void; onDelete?: () => void }) {
  const [b, setB] = useState(bookmark);
  const submit = () => {
    if (!b.title.trim() || !b.url.trim()) {
      toast("見出しとURLを入力してください", "error");
      return;
    }
    const url = /^https?:\/\//.test(b.url.trim()) ? b.url.trim() : `https://${b.url.trim()}`;
    saveBookmark({ ...b, title: b.title.trim(), url });
    onClose();
  };
  return (
    <Modal eyebrow="BOOKMARK" title={onDelete ? "ブックマークを編集" : "ブックマークを追加"} onClose={onClose}>
      <label className="field">
        <span>見出し</span>
        <input type="text" value={b.title} onChange={(e) => setB({ ...b, title: e.target.value })} placeholder="例：ブランドアセット" autoFocus />
      </label>
      <label className="field">
        <span>URL</span>
        <div className="input-with-icon">
          <Icon name="link" />
          <input type="url" value={b.url} onChange={(e) => setB({ ...b, url: e.target.value })} placeholder="https://drive.google.com/..." />
        </div>
      </label>
      <label className="field">
        <span>メモ</span>
        <input type="text" value={b.note} onChange={(e) => setB({ ...b, note: e.target.value })} placeholder="例：ロゴ・カラー・ガイドライン" />
      </label>
      <div className="modal__actions">
        {onDelete && (
          <div className="modal__actions-left">
            <button className="button button--danger" onClick={onDelete}>
              <Icon name="delete" />
              削除
            </button>
          </div>
        )}
        <button className="button button--secondary" onClick={onClose}>
          キャンセル
        </button>
        <button className="button button--primary" onClick={submit}>
          <Icon name="save" />
          保存する
        </button>
      </div>
    </Modal>
  );
}

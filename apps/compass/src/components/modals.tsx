import { useEffect, useRef, useState, type ReactNode } from "react";
import type { Bookmark, Status, Task, TaskActor } from "../types";
import { DEPARTMENTS, PRODUCT_TYPES, STATUSES } from "../types";
import {
  connect,
  deleteProject,
  disconnect,
  exportJson,
  importFromRequest,
  importJson,
  planFromRequest,
  restoreBackup,
  saveBookmark,
  saveDraft,
  setStyle,
  setUserName,
  styleOf,
  toast,
  uid,
  useStore,
  type Draft,
} from "../store";
import { getToken, listBackups, WORKER_URL, type PlannedRequest } from "../lib/api";
import { DEFAULT_STYLE } from "../lib/style";
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
  const store = useStore();
  const { userName, savedAt } = store;
  const [style, setStyleInput] = useState(styleOf(store));
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
        <span>作業スタイル</span>
      </div>
      <p className="modal__lead">依頼ページからWBS（タスクと期限）を提案するときに、AIに渡すルールです。提案を直すたびに、ここも育ててください。</p>
      <textarea className="style-editor" rows={10} value={style} onChange={(e) => setStyleInput(e.target.value)} spellCheck={false} />
      <div className="settings-row settings-row--end">
        <button className="text-button" onClick={() => setStyleInput(DEFAULT_STYLE)}>
          初期値に戻す
        </button>
        <button
          className="button button--secondary"
          onClick={() => {
            setStyle(style);
            toast("作業スタイルを保存しました", "success");
          }}
          disabled={style.trim() === styleOf(store).trim()}
        >
          <Icon name="save" />
          作業スタイルを保存
        </button>
      </div>

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
  const [planned, setPlanned] = useState<PlannedRequest | null>(null);
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const p = draft.project;
  const setProject = (patch: Partial<Draft["project"]>) => setDraft((d) => ({ ...d, project: { ...d.project, ...patch } }));
  const setTask = (i: number, patch: Partial<Task>) => setDraft((d) => ({ ...d, tasks: d.tasks.map((t, j) => (j === i ? { ...t, ...patch } : t)) }));
  const addTask = (title = "", due = "") =>
    setDraft((d) => ({
      ...d,
      tasks: [...d.tasks, { id: uid(), projectId: d.project.id, title, status: "未着" as Status, due, order: d.tasks.length, source: "manual" }],
    }));
  const moveTask = (from: number, to: number) =>
    setDraft((d) => {
      const tasks = [...d.tasks];
      const [t] = tasks.splice(from, 1);
      tasks.splice(to, 0, t);
      return { ...d, tasks };
    });

  // AIでWBSを提案させる（通常はこちら）
  const runPlan = async () => {
    setImporting(true);
    setImportError("");
    setPlanned(null);
    try {
      setPlanned(await planFromRequest(importUrl));
    } catch (e) {
      setImportError((e as Error).message);
    } finally {
      setImporting(false);
    }
  };

  const togglePlanTask = (key: string) =>
    setPlanned((r) => r && { ...r, plan: { ...r.plan, tasks: r.plan.tasks.map((t) => (t.key === key ? { ...t, include: !t.include } : t)) } });

  // 提案をフォームに入れる。登録はフォームで確認してから
  const applyPlan = () => {
    if (!planned) return;
    const { plan } = planned;
    const picked = plan.tasks.filter((t) => t.include);
    const title = plan.title || planned.title;
    const memo = [
      planned.memo,
      title !== planned.title && planned.title && `依頼時の案件名：${planned.title}`,
      plan.questions.length && `確認事項：\n${plan.questions.map((q) => `・${q}`).join("\n")}`,
    ].filter(Boolean);
    setDraft((d) => ({
      project: {
        ...d.project,
        title,
        department: planned.department || d.project.department,
        types: planned.types.length ? planned.types : d.project.types,
        memo: [...memo, d.project.memo].filter(Boolean).join("\n"),
        url: planned.url,
        due: plan.due || d.project.due,
        proposal: {
          at: new Date().toISOString(),
          title: plan.title,
          size: plan.size,
          tasks: plan.tasks.map((t) => ({ title: t.title, group: t.group, actor: t.actor, source: t.source, due: t.due })),
        },
      },
      tasks: [
        ...d.tasks,
        ...picked.map((t, i) => ({
          id: uid(),
          projectId: d.project.id,
          title: t.title,
          status: "未着" as Status,
          due: t.due,
          order: d.tasks.length + i,
          group: t.group || undefined,
          actor: t.actor,
          source: t.source,
        })),
      ],
    }));
    setSource("manual");
    setPlanned(null);
    toast(`提案を反映しました（タスク${picked.length}件）。内容を確認して登録してください`, "success");
  };

  // AIを使わない読み込み（予備）
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
          ...r.tasks.map((t, i) => ({ id: uid(), projectId: d.project.id, title: t.title, status: "未着" as Status, due: t.due, order: d.tasks.length + i, source: "page" as const })),
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
        planned ? (
          <PlanReview planned={planned} onToggle={togglePlanTask} onRetry={runPlan} onApply={applyPlan} retrying={importing} />
        ) : (
          <div className="notion-import">
            <div className="notion-import__icon">
              <Icon name="description" />
            </div>
            <h3>依頼ページからWBSを提案する</h3>
            <p>社内依頼フォームから作成されたNotionページのURLを貼り付けてください。ページ全体を読み、案件名の清書とタスク・期限の提案を作ります。提案は確認してから登録します。</p>
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
            <button className="button button--primary" onClick={runPlan} disabled={importing || !importUrl.trim()}>
              <Icon name="auto_awesome" />
              {importing ? "読み込み中…（20〜40秒ほど）" : "読み込んで提案を作る"}
            </button>
            {importError && (
              <button className="text-button plan-fallback" onClick={runImport} disabled={importing}>
                AIを使わずに読み込む（スケジュール欄の箇条書きのみ）
              </button>
            )}
          </div>
        )
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
                <TaskTags task={t} onActor={(actor) => setTask(i, { actor })} />
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


// ---- WBS提案の確認画面 ----------------------------------------------------

const ACTOR_LABEL: Record<TaskActor, string> = { self: "", client: "受け取り", vendor: "外部" };
const SIZE_LABEL = { light: "軽い", standard: "標準", heavy: "重い" } as const;

const ACTOR_ORDER: TaskActor[] = ["self", "client", "vendor"];

/** フォームのタスク行のタグ。依頼ページから読み込んだタスクは、主体のタグを押して切り替えられる（AIの判定の修正用） */
function TaskTags({ task, onActor }: { task: Pick<Task, "group" | "actor" | "source">; onActor?: (a: TaskActor) => void }) {
  const imported = task.source === "page" || task.source === "ai";
  const actor = task.actor || "self";
  if (!task.group && !imported && !task.actor) return null;
  return (
    <span className="task-tags">
      {task.group && <span className="task-tag">{task.group}</span>}
      {imported && onActor ? (
        <button
          type="button"
          className={`task-tag task-tag--${actor} task-tag--button`}
          title="押して切り替え（自分 → 受け取り → 外部）"
          onClick={() => onActor(ACTOR_ORDER[(ACTOR_ORDER.indexOf(actor) + 1) % ACTOR_ORDER.length])}
        >
          {ACTOR_LABEL[actor] || "自分"}
        </button>
      ) : (
        ACTOR_LABEL[actor] && <span className={`task-tag task-tag--${actor}`}>{ACTOR_LABEL[actor]}</span>
      )}
      {task.source === "ai" && <span className="task-tag task-tag--ai">AI</span>}
    </span>
  );
}

function PlanReview({ planned, onToggle, onRetry, onApply, retrying }: { planned: PlannedRequest; onToggle: (key: string) => void; onRetry: () => void; onApply: () => void; retrying: boolean }) {
  const { plan } = planned;
  const groups = Array.from(new Set(plan.tasks.map((t) => t.group)));
  const count = plan.tasks.filter((t) => t.include).length;
  const range = (a: { date: string; dateEnd: string }) => (a.dateEnd ? `${formatMD(a.date)}〜${formatMD(a.dateEnd)}` : formatMD(a.date));
  return (
    <div className="plan-review">
      <div className="plan-review__head">
        <div>
          <p className="section-label">案件名</p>
          <h3>{plan.title || planned.title}</h3>
          {plan.title && plan.title !== planned.title && <small>依頼時：{planned.title}</small>}
        </div>
        <span className={`plan-size plan-size--${plan.size}`} title={plan.sizeReason}>
          規模：{SIZE_LABEL[plan.size]}
        </span>
      </div>
      {plan.sizeReason && <p className="plan-review__note">{plan.sizeReason}</p>}

      <p className="section-label">確定日（ページ記載）</p>
      {plan.anchors.length ? (
        <ul className="plan-anchors">
          {plan.anchors.map((a) => (
            <li key={a.key}>
              <Icon name="lock" />
              <time>{range(a)}</time>
              <strong>
                {a.group && `${a.group}｜`}
                {a.label}
              </strong>
              {a.inferred && <span className="task-tag task-tag--warn">推定</span>}
              <small>「{a.evidence}」</small>
            </li>
          ))}
        </ul>
      ) : (
        <p className="plan-review__note">ページから確定日を読み取れませんでした。</p>
      )}

      <p className="section-label">タスク案（{count}/{plan.tasks.length}件を登録）</p>
      <div className="plan-tasks">
        {groups.map((g) => (
          <div key={g || "_"} className="plan-group">
            {g && <p className="plan-group__name">{g}</p>}
            {plan.tasks
              .filter((t) => t.group === g)
              .map((t) => (
                <label key={t.key} className={`plan-task ${t.include ? "" : "is-off"}`}>
                  <input type="checkbox" checked={t.include} onChange={() => onToggle(t.key)} />
                  <time>{t.due ? formatMD(t.due) : "未設定"}</time>
                  <span className="plan-task__body">
                    <strong>{t.title}</strong>
                    {t.reason && <small>{t.reason}</small>}
                    {t.warning && <small className="plan-task__warn">⚠ {t.warning}</small>}
                  </span>
                  <span className="task-tags">
                    {ACTOR_LABEL[t.actor] && <span className={`task-tag task-tag--${t.actor}`}>{ACTOR_LABEL[t.actor]}</span>}
                    <span className={`task-tag ${t.source === "ai" ? "task-tag--ai" : "task-tag--page"}`}>{t.source === "ai" ? "AI提案" : "ページ記載"}</span>
                  </span>
                </label>
              ))}
          </div>
        ))}
        {!plan.tasks.length && <p className="plan-review__note">タスク案はありません。</p>}
      </div>

      {plan.questions.length > 0 && (
        <div className="plan-questions">
          <p className="section-label">確認が必要なこと</p>
          <ul>
            {plan.questions.map((q) => (
              <li key={q}>{q}</li>
            ))}
          </ul>
        </div>
      )}

      <div className="modal__actions">
        <button className="button button--secondary" onClick={onRetry} disabled={retrying}>
          <Icon name="refresh" />
          {retrying ? "作り直し中…" : "提案を作り直す"}
        </button>
        <button className="button button--primary" onClick={onApply} disabled={retrying}>
          <Icon name="arrow_forward" />
          この内容でフォームに入れる
        </button>
      </div>
    </div>
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

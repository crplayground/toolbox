import { useEffect, useRef, useState, type ReactNode } from "react";
import { useToasts } from "../store";
import { initials } from "../lib/derive";

export function Icon({ name, filled = false }: { name: string; filled?: boolean }) {
  return (
    <span className={`material-symbols-rounded icon ${filled ? "icon--filled" : ""}`} aria-hidden="true">
      {name}
    </span>
  );
}

export function Avatar({ name, size }: { name: string; size?: "small" | "tiny" }) {
  return (
    <span className={`avatar ${size ? `avatar--${size}` : ""}`} title={name}>
      {initials(name)}
    </span>
  );
}

/** 外側クリックで閉じるポップオーバーの開閉 */
function usePopover() {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);
  return { open, setOpen, ref };
}

type DropdownProps = {
  options: string[];
  placeholder?: string;
  creatable?: boolean;
  renderLead?: (value: string) => ReactNode;
} & ({ multiple: true; value: string[]; onChange: (v: string[]) => void } | { multiple?: false; value: string; onChange: (v: string) => void });

/** Figmaの select-box の見た目のまま使える選択UI（単一／複数・新規追加） */
export function Dropdown(props: DropdownProps) {
  const { open, setOpen, ref } = usePopover();
  const [query, setQuery] = useState("");
  const selected = props.multiple ? props.value : props.value ? [props.value] : [];
  const all = Array.from(new Set([...props.options, ...selected])).filter(Boolean);
  const shown = all.filter((o) => o.includes(query.trim()));
  const canCreate = props.creatable && query.trim() && !all.includes(query.trim());

  const pick = (v: string) => {
    if (props.multiple) {
      props.onChange(props.value.includes(v) ? props.value.filter((x) => x !== v) : [...props.value, v]);
    } else {
      props.onChange(props.value === v ? "" : v);
      setOpen(false);
    }
    setQuery("");
  };

  return (
    <div className="dropdown" ref={ref}>
      <button type="button" className="select-box" onClick={() => setOpen(!open)}>
        {selected.length === 1 && props.renderLead?.(selected[0])}
        <span className={selected.length ? "select-box__value" : ""}>{selected.length ? selected.join("、") : props.placeholder || "選択してください"}</span>
        <Icon name="expand_more" />
      </button>
      {open && (
        <div className="popover dropdown__menu">
          {(props.creatable || all.length > 8) && (
            <input
              className="dropdown__search"
              autoFocus
              value={query}
              placeholder={props.creatable ? "検索・新規追加" : "検索"}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && canCreate) {
                  e.preventDefault();
                  pick(query.trim());
                }
              }}
            />
          )}
          <div className="dropdown__options">
            {shown.map((o) => (
              <button type="button" key={o} className={selected.includes(o) ? "is-selected" : ""} onClick={() => pick(o)}>
                {props.renderLead?.(o)}
                <span>{o}</span>
                {selected.includes(o) && <Icon name="check" />}
              </button>
            ))}
            {canCreate && (
              <button type="button" onClick={() => pick(query.trim())}>
                <Icon name="add" />
                <span>「{query.trim()}」を追加</span>
              </button>
            )}
            {!shown.length && !canCreate && <p className="dropdown__empty">候補がありません</p>}
          </div>
        </div>
      )}
    </div>
  );
}

export type MenuItem = { label: string; icon: string; onClick: () => void; danger?: boolean };

/** 「…」ボタンのメニュー */
export function MoreMenu({ items }: { items: MenuItem[] }) {
  const { open, setOpen, ref } = usePopover();
  return (
    <div className="more-menu" ref={ref} onClick={(e) => e.stopPropagation()} onMouseDown={(e) => e.stopPropagation()}>
      <button type="button" className="icon-button" aria-label="メニュー" onClick={() => setOpen(!open)}>
        <Icon name="more_horiz" />
      </button>
      {open && (
        <div className="popover more-menu__list">
          {items.map((item) => (
            <button
              type="button"
              key={item.label}
              className={item.danger ? "is-danger" : ""}
              onClick={() => {
                setOpen(false);
                item.onClick();
              }}
            >
              <Icon name={item.icon} />
              {item.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export function Toasts() {
  const toasts = useToasts();
  return (
    <div className="toasts" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={`toast toast--${t.tone}`}>
          <Icon name={t.tone === "error" ? "error" : t.tone === "success" ? "check_circle" : "info"} filled />
          <span>{t.text}</span>
        </div>
      ))}
    </div>
  );
}

export function EmptyState({ icon, text, action }: { icon: string; text: string; action?: ReactNode }) {
  return (
    <div className="empty-state">
      <Icon name={icon} />
      <p>{text}</p>
      {action}
    </div>
  );
}

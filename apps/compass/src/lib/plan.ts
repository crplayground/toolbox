// AI（Worker /plan）の出力を、画面に出せる提案に変換する。
// 日付の計算はここで行う：AIには「どの確定日の何営業日前か」だけを出させ、日付そのものは書かせない。

import type { TaskActor } from "../types";
import { addBusinessDays, todayKey } from "./date";

export type RawPlan = {
  title: string;
  size: "light" | "standard" | "heavy";
  sizeReason: string;
  anchors: { key: string; label: string; kind: "use" | "delivery" | "other"; group: string; date: string; dateEnd: string; inferred: boolean; evidence: string }[];
  tasks: { title: string; group: string; actor: TaskActor; from: "page" | "ai"; date: string; anchorKey: string; offsetDays: number; reason: string }[];
  questions: string[];
};

export type PlanTask = {
  key: string;
  title: string;
  group: string;
  actor: TaskActor;
  source: "page" | "ai";
  due: string;
  reason: string;
  warning: string; // 「期限が過ぎています」など。なければ空
  include: boolean; // 登録に含めるか（画面で切り替える）
};

export type Plan = {
  title: string;
  size: RawPlan["size"];
  sizeReason: string;
  anchors: RawPlan["anchors"];
  tasks: PlanTask[];
  questions: string[];
  due: string; // 案件の期限（最終納品日）
};

const isDate = (v: unknown): v is string => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(v));
const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");
const ACTORS: TaskActor[] = ["self", "client", "vendor"];

/** AIの出力を検証し、日付を計算する。AIの出力は信用せず、ここで最終責任を持つ */
export function buildPlan(raw: RawPlan): Plan {
  const today = todayKey();
  const anchors = (Array.isArray(raw?.anchors) ? raw.anchors : [])
    .filter((a) => isDate(a?.date))
    .map((a) => ({ ...a, kind: a.kind === "use" || a.kind === "delivery" ? a.kind : ("other" as const), label: str(a.label), group: str(a.group), dateEnd: isDate(a.dateEnd) ? a.dateEnd : "", evidence: str(a.evidence), inferred: !!a.inferred }));
  const byKey = new Map(anchors.map((a) => [a.key, a]));

  const tasks: PlanTask[] = (Array.isArray(raw?.tasks) ? raw.tasks : [])
    .filter((t) => str(t?.title))
    .map((t, i) => {
      const source: PlanTask["source"] = t.from === "page" ? "page" : "ai";
      let due = "";
      let warning = "";
      if (source === "page" && isDate(t.date)) due = t.date;
      else {
        const anchor = byKey.get(t.anchorKey);
        const offset = Number.isInteger(t.offsetDays) ? t.offsetDays : NaN;
        if (anchor && !Number.isNaN(offset)) due = addBusinessDays(anchor.date, -offset);
        else warning = "基準日が読み取れないため、期限は未設定です";
      }
      if (due && due < today) warning = "期限が今日より前です";
      return {
        key: `t${i}`,
        title: str(t.title),
        group: str(t.group),
        actor: ACTORS.includes(t.actor) ? t.actor : "self",
        source,
        due,
        reason: source === "ai" ? str(t.reason) : "",
        warning,
        include: true,
      };
    })
    // 制作物ごとにまとめ、その中で日付順（期限なしは最後）
    .sort((a, b) => a.group.localeCompare(b.group, "ja") || (a.due || "9999").localeCompare(b.due || "9999"));

  const due = projectDue(anchors, tasks);

  return {
    title: str(raw?.title),
    size: raw?.size === "light" || raw?.size === "heavy" ? raw.size : "standard",
    sizeReason: str(raw?.sizeReason),
    anchors,
    tasks,
    questions: (Array.isArray(raw?.questions) ? raw.questions : []).map(str).filter(Boolean).slice(0, 5),
    due,
  };
}

/**
 * 案件の期限＝最終納品日（2026-09-29 ユウキ決定。使用開始日ではなく、自分の責任が終わる日）。
 * AIの主体（actor）の判定は揺れるため、期限の決定には使わない。
 * 1. 納品の確定日があれば、その最終日
 * 2. なければ、使用開始の確定日より前にあるタスクの最終日（使用開始の前営業日に納め終える想定）
 * 3. どちらもなければ、全タスク・確定日の最終日
 */
function projectDue(anchors: Plan["anchors"], tasks: PlanTask[]): string {
  const last = (dates: string[]) => dates.filter(Boolean).sort().slice(-1)[0] || "";
  const delivery = last(anchors.filter((a) => a.kind === "delivery").map((a) => a.date));
  if (delivery) return delivery;
  const firstUse = anchors.filter((a) => a.kind === "use").map((a) => a.date).sort()[0];
  if (firstUse) {
    const before = last(tasks.map((t) => t.due).filter((d) => d && d < firstUse));
    if (before) return before;
  }
  return last([...tasks.map((t) => t.due), ...anchors.map((a) => a.date)]);
}

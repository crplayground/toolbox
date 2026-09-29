// Worker（workers/compass）との通信。
// データは Worker の KV に JSON 1件で保存する。合言葉（APP_TOKEN）はこのブラウザの localStorage に保存する。

import type { AppData } from "../types";
import { DEPARTMENTS, PRODUCT_TYPES } from "../types";
import { parseLooseDate, todayKey } from "./date";
import { buildPlan, type Plan, type RawPlan } from "./plan";

export const WORKER_URL = "https://compass.yukimiyakawa.workers.dev";
const TOKEN_KEY = "compass_app_token";
// 旧名（CR Board）時代の合言葉を引き継ぐ
if (!localStorage.getItem(TOKEN_KEY) && localStorage.getItem("pmb_app_token")) {
  localStorage.setItem(TOKEN_KEY, localStorage.getItem("pmb_app_token")!);
  localStorage.removeItem("pmb_app_token");
}

export const getToken = () => localStorage.getItem(TOKEN_KEY) || "";
export const setToken = (t: string) => (t ? localStorage.setItem(TOKEN_KEY, t) : localStorage.removeItem(TOKEN_KEY));

export class ApiError extends Error {
  status: number;
  body: any;
  constructor(message: string, status: number, body?: any) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

async function call<T = any>(path: string, init: RequestInit = {}, token = getToken()): Promise<T> {
  let res: Response;
  try {
    res = await fetch(WORKER_URL + path, {
      ...init,
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...(init.headers || {}) },
    });
  } catch {
    throw new ApiError("サーバーに接続できませんでした（オフライン、またはWorker未公開）", 0);
  }
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(json.error || json.message || `エラー（${res.status}）`, res.status, json);
  return json as T;
}

export type Remote = { version: number; updatedAt: string | null; data: AppData | null };

export const fetchData = (token?: string) => call<Remote>("/data", {}, token);

export const saveData = (baseVersion: number, data: AppData) =>
  call<{ version: number; updatedAt: string }>("/data", { method: "PUT", body: JSON.stringify({ baseVersion, data }) });

export const listBackups = () => call<{ days: string[] }>("/backups");
export const fetchBackup = (day: string) => call<Remote>(`/backups/${day}`);

// ---- 社内依頼フォームのページ読み込み（Worker経由・読み取りのみ） ------------------
// 依頼DB（CREATIVE PROCESS が起票するDB）のプロパティ名は workers/creative-process/src/worker.js の buildNotionProperties() が正。
// 依頼フォームの選択肢は「ANV｜アニバに関する制作物」のように説明つきのため、「｜」より前を値として使う。

/**
 * NotionのURL・ハイフン付きID・生IDのいずれからも32桁のIDを取り出す。
 * IDはURLの末尾にあるため、英数字（0-9a-f）の連なりの「最後の32文字」を取る。
 * 先頭から取ると「Bridal-for-Good-3e56…」の Good の d までIDに含めてしまう（2026-09-29 修正）
 */
export function extractNotionId(input: string): string {
  const raw = input.trim();
  // データベースの中でページを開いたURL（…?v=…&p=<ID>）は p= の値がページID
  const peek = raw.match(/[?&]p=([0-9a-f-]{32,36})/i);
  const path = (peek ? peek[1] : raw.split(/[?#]/)[0]).replace(/-/g, "");
  const runs = path.match(/[0-9a-f]{32,}/gi);
  return runs ? runs[runs.length - 1].slice(-32).toLowerCase() : "";
}

const plain = (rich: any[] | undefined) => (rich || []).map((r) => r.plain_text || "").join("");
const head = (v: string) => v.split(/[｜|]/)[0].trim();

function read(page: any, name: string): any {
  const p = page.properties?.[name];
  if (!p) return undefined;
  if (p.type === "title" || p.type === "rich_text") return plain(p[p.type]);
  if (p.type === "select") return p.select?.name || "";
  if (p.type === "multi_select") return (p.multi_select || []).map((o: any) => o.name);
  return undefined;
}

export type ImportedRequest = {
  title: string;
  department: string;
  types: string[];
  memo: string;
  url: string;
  tasks: { title: string; due: string }[];
};

/** 依頼ページのプロパティ（案件名・部署・種別・依頼者など）を読む */
function readRequestProps(page: any, pageUrl: string): Omit<ImportedRequest, "tasks"> {
  const titleProp = Object.keys(page.properties).find((k) => page.properties[k].type === "title") || "";
  const category = read(page, "依頼種別") || "";
  const requester = read(page, "依頼者") || "";
  const requesterDept = read(page, "所属部署") || "";

  // 選択肢に無い値は「その他」に寄せ、元の値はメモに残す
  const rawDept = head(read(page, "対象事業・部署") || "");
  const department = !rawDept ? "" : DEPARTMENTS.includes(rawDept) ? rawDept : "その他";
  const rawTypes: string[] = (read(page, "制作物の種別") || []).map(head);
  const types = Array.from(new Set(rawTypes.map((t) => (PRODUCT_TYPES.includes(t) ? t : "その他"))));
  const unknown = [rawDept && department === "その他" && rawDept !== "その他" ? rawDept : "", ...rawTypes.filter((t) => !PRODUCT_TYPES.includes(t))].filter(Boolean);

  const memoLines = [
    category && `依頼種別：${category}`,
    (requester || requesterDept) && `依頼者：${[requesterDept, requester].filter(Boolean).join(" ")}`,
    unknown.length && `依頼時の表記：${unknown.join("、")}`,
  ].filter(Boolean);

  return { title: read(page, titleProp) || "", department, types, memo: memoLines.join("\n"), url: page.url || pageUrl };
}

const notFound = (e: unknown) => {
  if ((e as ApiError).status === 404) throw new ApiError("ページが見つかりません。依頼DBにインテグレーション「Compass（読み取り）」が接続されているか確認してください", 404);
  throw e;
};

/** AIなしの読み込み（予備）。本文の「スケジュール」見出し直下の箇条書きだけをタスク候補にする */
export async function importRequestPage(pageUrl: string): Promise<ImportedRequest> {
  const id = extractNotionId(pageUrl);
  if (!id) throw new ApiError("NotionページのURLを読み取れませんでした", 400);
  const page: any = await call(`/notion/pages/${id}`).catch(notFound);

  // 本文の「スケジュール」見出し配下の箇条書きをタスク候補にする（例：「2026-10-01　初稿提出」）
  const tasks: ImportedRequest["tasks"] = [];
  try {
    const blocks: any = await call(`/notion/blocks/${id}/children?page_size=100`);
    let inSchedule = false;
    for (const b of blocks.results || []) {
      if (b.type?.startsWith("heading_")) {
        inSchedule = plain(b[b.type].rich_text).includes("スケジュール");
        continue;
      }
      if (inSchedule && (b.type === "bulleted_list_item" || b.type === "numbered_list_item" || b.type === "to_do")) {
        const line = plain(b[b.type].rich_text).trim();
        if (!line) continue;
        const due = parseLooseDate(line);
        // 先頭の日付だけを外す（「2026-10-01　3案提出」の「3」まで消さないように）
        const title = line.replace(/^\s*(\d{4}\s*[-/.年]\s*\d{1,2}\s*[-/.月]\s*\d{1,2}日?|\d{1,2}\s*[/月]\s*\d{1,2}日?)\s*(\([^)]*\)|（[^）]*）)?\s*[:：\-–]?\s*/, "").trim() || line;
        tasks.push({ title, due });
      }
    }
  } catch {
    // 本文が読めなくてもプロパティだけで登録できるようにする
  }
  return { ...readRequestProps(page, pageUrl), tasks };
}

export type PlannedRequest = Omit<ImportedRequest, "tasks"> & { plan: Plan; text: string };

/** 依頼ページを全文読み、AIにWBSの提案を作らせる（Worker /plan）。日付の計算は lib/plan.ts */
export async function planRequestPage(pageUrl: string, style: string): Promise<PlannedRequest> {
  const id = extractNotionId(pageUrl);
  if (!id) throw new ApiError("NotionページのURLを読み取れませんでした", 400);
  const res = await call<{ page: any; text: string; plan: RawPlan }>("/plan", {
    method: "POST",
    body: JSON.stringify({ pageId: id, style, today: todayKey() }),
  }).catch(notFound);
  return { ...readRequestProps(res.page, pageUrl), plan: buildPlan(res.plan), text: res.text };
}

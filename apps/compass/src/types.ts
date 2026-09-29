export type Status = "未着" | "進行中" | "完了" | "中止";
export const STATUSES: Status[] = ["未着", "進行中", "完了", "中止"];

export type Project = {
  id: string;
  title: string;
  status: Status;
  department: string;
  types: string[];
  start: string; // YYYY-MM-DD
  due: string; // YYYY-MM-DD
  memo: string;
  url: string; // 依頼ページURL
  order: number;
};

export type Task = {
  id: string;
  projectId: string;
  title: string;
  status: Status;
  due: string;
  order: number;
};

export type Bookmark = {
  id: string;
  title: string;
  url: string;
  note: string;
  order: number;
};

/** Workerに保存するデータ本体 */
export type AppData = { projects: Project[]; tasks: Task[]; bookmarks: Bookmark[]; userName: string };

export type AppEvent = {
  id: string;
  icon: string;
  tone: "blue" | "orange" | "green" | "purple";
  title: string;
  detail: string;
  at: string; // ISO datetime
};

export type Filter = { statuses: Status[] };

// 対象部署・制作物の種別は固定リスト（2026-09-28 決定）。社内依頼フォーム（CREATIVE PROCESS）の選択肢と同じ。
export const DEPARTMENTS = [
  "ANV",
  "CAREER",
  "CCA",
  "CGM-PSC",
  "CGM-レストラン",
  "CGM-館内",
  "CGM-婚礼",
  "CRAZY",
  "CR室",
  "CW",
  "CWA",
  "HR",
  "IWAI-館内",
  "IWAI-婚礼",
  "MT-the-Terrace",
  "MT-館内",
  "MT-婚礼",
  "その他",
];

export const PRODUCT_TYPES = [
  "イベント・キャンペーン",
  "スライド・ePDF",
  "バナー・告知画像",
  "LP・WEBサイト",
  "チラシ・ポスター・パネル",
  "リーフレット・パンフレット",
  "看板・サイン",
  "ペーパーアイテム",
  "招待状・紙袋・ノベルティ",
  "その他",
];

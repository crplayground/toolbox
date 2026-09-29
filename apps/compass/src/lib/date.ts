const pad = (n: number) => String(n).padStart(2, "0");

export const toKey = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

export function fromKey(key: string): Date {
  const [y, m, d] = key.split("-").map(Number);
  return new Date(y, m - 1, d);
}

export const todayKey = () => toKey(new Date());

export function addDays(key: string, days: number): string {
  const d = fromKey(key);
  d.setDate(d.getDate() + days);
  return toKey(d);
}

export function diffDays(a: string, b: string): number {
  return Math.round((fromKey(a).getTime() - fromKey(b).getTime()) / 86400000);
}

/** その週の月曜日 */
export function weekStart(key: string): string {
  const d = fromKey(key);
  const offset = (d.getDay() + 6) % 7;
  return addDays(key, -offset);
}

export function formatMD(key: string): string {
  if (!key) return "未設定";
  const d = fromKey(key);
  return `${d.getMonth() + 1}月${d.getDate()}日`;
}

export const formatSlash = (key: string) => {
  const d = fromKey(key);
  return `${d.getMonth() + 1}/${d.getDate()}`;
};

const WEEKDAYS = ["日", "月", "火", "水", "木", "金", "土"];

export function formatLongJa(d: Date): string {
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日 ${WEEKDAYS[d.getDay()]}曜日`;
}

/** 「今日」「明日」「3日超過」など、期限までの相対表現 */
export function relativeDue(key: string): string {
  if (!key) return "期限なし";
  const n = diffDays(key, todayKey());
  if (n === 0) return "今日";
  if (n === 1) return "明日";
  if (n < 0) return `${-n}日超過`;
  return formatMD(key);
}

/** 「2026-10-01」「2026/10/1」「10月1日」「10/1」などを YYYY-MM-DD に。読めなければ空文字 */
export function parseLooseDate(text: string): string {
  const full = text.match(/(\d{4})\s*[-/.年]\s*(\d{1,2})\s*[-/.月]\s*(\d{1,2})/);
  if (full) return `${full[1]}-${pad(+full[2])}-${pad(+full[3])}`;
  const short = text.match(/(\d{1,2})\s*[/月]\s*(\d{1,2})/);
  if (short) {
    const now = new Date();
    let y = now.getFullYear();
    const m = +short[1];
    // 過去3か月より前の月なら翌年として扱う
    if (m < now.getMonth() + 1 - 3) y += 1;
    return `${y}-${pad(m)}-${pad(+short[2])}`;
  }
  return "";
}

export const timeAgo = (iso: string) => {
  const min = Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
  if (min < 1) return "たった今";
  if (min < 60) return `${min}分前`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h}時間前`;
  const d = Math.floor(h / 24);
  return d === 1 ? "昨日" : `${d}日前`;
};

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

// ---- 営業日（土日・祝日・年末年始を除く） --------------------------------------
// 祝日は内閣府の公表どおり（振替休日・国民の休日を含む）。2028年以降は追記が必要。
const HOLIDAYS = new Set([
  "2026-01-01", "2026-01-12", "2026-02-11", "2026-02-23", "2026-03-20", "2026-04-29", "2026-05-03", "2026-05-04", "2026-05-05", "2026-05-06",
  "2026-07-20", "2026-08-11", "2026-09-21", "2026-09-22", "2026-09-23", "2026-10-12", "2026-11-03", "2026-11-23",
  "2027-01-01", "2027-01-11", "2027-02-11", "2027-02-23", "2027-03-21", "2027-03-22", "2027-04-29", "2027-05-03", "2027-05-04", "2027-05-05",
  "2027-07-19", "2027-08-11", "2027-09-20", "2027-09-23", "2027-10-11", "2027-11-03", "2027-11-23",
]);

export function isBusinessDay(key: string): boolean {
  const day = fromKey(key).getDay();
  if (day === 0 || day === 6 || HOLIDAYS.has(key)) return false;
  const md = key.slice(5);
  return !(md >= "12-29" || md <= "01-03"); // 年末年始
}

/** 営業日で n 日ずらす（正＝後ろへ、負＝前へ）。0 のときはそのまま */
export function addBusinessDays(key: string, n: number): string {
  let d = key;
  const step = n < 0 ? -1 : 1;
  for (let left = Math.abs(n); left > 0; ) {
    d = addDays(d, step);
    if (isBusinessDay(d)) left--;
  }
  return d;
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

// GET /learning … 作業スタイルの学習レポート（学習ループ④の材料）
//
// 「AIの提案（proposal.tasks）」と「登録ボタンを押した時点の内容（proposal.registered）」の差分をコードで集計し、
// （登録後の日程変更は依頼者都合のことが多いため、作業スタイルの学習には混ぜない。実績＝期限と完了日のずれ、としてだけ扱う）
// 同じ傾向が何度も繰り返されたものだけを「パターン」として返す。
// 提案するかどうか（decision）はここで決める。レポートを書く側（Claudeの定期タスク）は、この判定を覆さない。
// → 記録が薄い日に、AIが想像で修正案を作ることを防ぐため（2026-09-29 ユウキ指定）
//
// クエリ
//   ?commit=1 … 今回提案したパターンを「提案済み」として記録する（定期タスクが1日1回だけ付ける）
//
// 返り値の report は、定期タスクがそのまま表示する日本語のレポート（書式をコードで固定し、実行ごとの揺れを無くす。2026-09-30）
//
// 認証：APP_TOKEN または LEARN_TOKEN（このエンドポイント専用・読み取りのみ）

const DATA_KEY = "data";
const REPORTED_KEY = "learn:reported"; // { [patternId]: { at, count } }

// ---- 判定のしきい値（運用しながら調整する） ----
const MIN_SAMPLES = 3; // 同じ傾向が何件そろったらパターンとみなすか
const SAME_DIRECTION = 0.8; // 日付のずれの向きがどれだけ揃っているか
const MIN_ADOPTION = 0.3; // 提案の採用率がこれ未満の案件は、作り直したとみなして集計から外す
const REPROPOSE_GROWTH = 2; // 提案済みのパターンは、件数がこれだけ増えたら再提案する

export async function handleLearning(url, env, json) {
  const stored = await env.DATA.get(DATA_KEY, "json");
  const data = stored?.data || { projects: [], tasks: [] };
  const today = jstToday();

  const records = collect(data);
  const { patterns, watch } = findPatterns(records);

  const reported = (await env.DATA.get(REPORTED_KEY, "json")) || {};
  for (const p of patterns) {
    const prev = reported[p.id];
    p.status = !prev ? "new" : p.count >= prev.count + REPROPOSE_GROWTH ? "grown" : "reported";
    p.lastReportedAt = prev?.at || "";
  }
  const fresh = patterns.filter((p) => p.status !== "reported");
  const decision = fresh.length ? "propose" : "no_change";

  if (url.searchParams.get("commit") === "1" && fresh.length) {
    for (const p of fresh) reported[p.id] = { at: today, count: p.count };
    await env.DATA.put(REPORTED_KEY, JSON.stringify(reported));
  }

  const used = records.projects.filter((p) => !p.excluded);
  const totals = {
    projectsWithProposal: records.projects.length,
    projectsUsed: used.length,
    projectsExcluded: records.projects.length - used.length,
    proposedTasks: used.reduce((n, p) => n + p.proposed, 0),
    keptTasks: used.reduce((n, p) => n + p.kept, 0),
    completedTasks: records.completions.length,
  };
  const todayProjects = records.projects.filter((p) => p.proposedAt && toJstDate(p.proposedAt) === today);
  const todayCompleted = records.completions.filter((c) => c.completedOn === today).length;
  const report = buildReport({ today, decision, fresh, watch, totals, todayProjects, todayCompleted, records });

  return json({
    report,
    generatedAt: new Date().toISOString(),
    today,
    decision,
    thresholds: { MIN_SAMPLES, SAME_DIRECTION, MIN_ADOPTION, REPROPOSE_GROWTH },
    style: { customized: !!data.style, text: data.style || "" },
    totals,
    todayActivity: { registered: todayProjects.map((p) => p.title), completed: todayCompleted },
    patterns: fresh,
    watch,
    duplicates: records.duplicates,
    alreadyReported: patterns.filter((p) => p.status === "reported").map((p) => ({ id: p.id, count: p.count, lastReportedAt: p.lastReportedAt })),
    projects: records.projects,
  });
}

// ---- 集計 ------------------------------------------------------------------

const norm = (s) => String(s || "").replace(/[\s　・、。「」（）()【】\-–—:：]/g, "").toLowerCase();

function collect(data) {
  const byProject = new Map();
  for (const t of data.tasks || []) byProject.set(t.projectId, [...(byProject.get(t.projectId) || []), t]);

  const projects = [];
  const events = []; // { kind, type, step, value, project }
  const completions = [];

  // 同じ依頼ページから作った案件が複数あるとき（登録し直し）は、提案が新しい方だけを学習に使う
  const latestByUrl = new Map();
  for (const p of data.projects || []) {
    if (!p.proposal || !p.url) continue;
    const prev = latestByUrl.get(p.url);
    if (!prev || (p.proposal.at || "") > (prev.proposal.at || "")) latestByUrl.set(p.url, p);
  }
  const duplicates = [];

  for (const p of data.projects || []) {
    const tasks = byProject.get(p.id) || [];
    const type = (p.types && p.types[0]) || "その他";

    // 実績：完了日と期限のずれ（提案の有無に関係なく集める）
    for (const t of tasks) {
      if (!t.completedAt || !t.due) continue;
      const completedOn = toJstDate(t.completedAt);
      completions.push({ completedOn });
      events.push({ kind: "late", type, step: norm(t.title), label: t.title, value: bizDiff(t.due, completedOn), project: p.title });
    }

    if (!p.proposal || p.status === "中止") continue;
    if (p.url && latestByUrl.get(p.url) !== p) {
      duplicates.push(p.title);
      continue;
    }
    const proposed = p.proposal.tasks || [];
    // 比較の相手は「登録時の控え」。控えの無い古い案件だけ、現在のタスクで代用する
    const final = p.proposal.registered
      ? p.proposal.registered.tasks.map((t, i) => ({ ...t, id: `r${i}` }))
      : tasks;
    const used = new Set();
    const rows = { kept: 0, removed: [], added: [], shifted: [], renamed: [], actorFixed: [] };

    proposed.forEach((pt, i) => {
      // 提案番号（pk）で対応づける。無ければ制作物＋タスク名で探す
      const match =
        final.find((t) => t.pk === i && !used.has(t.id)) ||
        final.find((t) => !used.has(t.id) && (t.pk === undefined || t.pk === null) && (t.group || "") === (pt.group || "") && norm(t.title) === norm(pt.title));
      if (!match) {
        rows.removed.push(pt.title);
        return;
      }
      used.add(match.id);
      rows.kept++;
      if (norm(match.title) !== norm(pt.title)) rows.renamed.push({ from: pt.title, to: match.title });
      if (match.actor && pt.actor && match.actor !== pt.actor) rows.actorFixed.push({ title: pt.title, from: pt.actor, to: match.actor });
      if (match.due && pt.due && match.due !== pt.due) rows.shifted.push({ title: pt.title, days: bizDiff(pt.due, match.due), source: pt.source });
    });
    for (const t of final) if (!used.has(t.id) && (t.source === "manual" || t.source === undefined)) rows.added.push(t.title);

    const adoption = proposed.length ? rows.kept / proposed.length : 0;
    const excluded = adoption < MIN_ADOPTION;
    projects.push({
      title: p.title,
      type,
      size: p.proposal.size,
      proposedAt: p.proposal.at || "",
      comparedWith: p.proposal.registered ? "registered" : "current",
      proposed: proposed.length,
      kept: rows.kept,
      adoption: Math.round(adoption * 100) / 100,
      excluded,
      ...rows,
    });
    if (excluded) continue;

    for (const title of rows.removed) {
      const pt = proposed.find((x) => x.title === title);
      if (pt?.source === "ai") events.push({ kind: "removed", type, step: norm(title), label: title, value: 1, project: p.title });
    }
    for (const title of rows.added) events.push({ kind: "added", type, step: norm(title), label: title, value: 1, project: p.title });
    for (const s of rows.shifted) if (s.source === "ai") events.push({ kind: "shift", type, step: norm(s.title), label: s.title, value: s.days, project: p.title });
    for (const a of rows.actorFixed) events.push({ kind: "actor", type: "（全種別）", step: norm(a.title), label: a.title, value: `${a.from}→${a.to}`, project: p.title });
  }
  return { projects, events, completions, duplicates };
}

function findPatterns({ events }) {
  const groups = new Map();
  for (const e of events) {
    const id = `${e.kind}|${e.type}|${e.step}`;
    groups.set(id, [...(groups.get(id) || []), e]);
  }
  const patterns = [];
  const watch = []; // 判定には届かないが近いもの（学習の進み具合として見せる。提案はしない）
  const KIND_LABEL = { shift: "日付の調整", late: "実績のずれ", removed: "削除", added: "手で追加", actor: "主体の修正" };
  for (const [id, list] of groups) {
    const { kind, type, label } = list[0];
    const evidence = list.map((e) => ({ project: e.project, value: e.value }));
    const base = { id, kind, type, step: label, count: list.length, evidence };
    const need = kind === "actor" ? 2 : MIN_SAMPLES;
    if (list.length < need) {
      if (list.length === need - 1 || (need - list.length === 1)) watch.push({ ...base, need, note: `${KIND_LABEL[kind]}：${list.length}/${need}件` });
      continue;
    }

    if (kind === "shift" || kind === "late") {
      const values = list.map((e) => e.value).sort((a, b) => a - b);
      const median = values[Math.floor(values.length / 2)];
      const sameSign = values.filter((v) => Math.sign(v) === Math.sign(median)).length / values.length;
      if (median === 0 || sameSign < SAME_DIRECTION) {
        watch.push({ ...base, need: MIN_SAMPLES, note: `${KIND_LABEL[kind]}：${list.length}件あるが向きがそろっていない` });
        continue;
      }
      patterns.push({
        ...base,
        medianDays: median,
        summary:
          kind === "shift"
            ? `${type}の「${label}」：AIの提案より${Math.abs(median)}営業日${median < 0 ? "早く" : "遅く"}設定している（${list.length}件中${Math.round(sameSign * list.length)}件が同じ向き）`
            : `${type}の「${label}」：期限より${Math.abs(median)}営業日${median > 0 ? "遅れて" : "早く"}完了している（${list.length}件）`,
      });
    } else if (kind === "removed") {
      patterns.push({ ...base, summary: `${type}の「${label}」：AIが提案したが${list.length}件で削除された` });
    } else if (kind === "added") {
      patterns.push({ ...base, summary: `${type}の「${label}」：AIが提案せず、手で${list.length}件追加された` });
    } else if (kind === "actor") {
      if (list.length < 2) continue;
      patterns.push({ ...base, summary: `「${label}」の主体を${list.length}件で修正（${list[0].value}）` });
    }
  }
  return { patterns: patterns.sort((a, b) => b.count - a.count), watch: watch.sort((a, b) => b.count - a.count) };
}

// ---- レポート（日本語・書式固定） ------------------------------------------------

function buildReport({ today, decision, fresh, watch, totals, todayProjects, todayCompleted, records }) {
  const L = [];
  const [, m, d] = today.split("-").map(Number);
  L.push(`## Compass 学習レポート（${m}/${d}）`);
  L.push("");
  L.push(decision === "propose" ? `**作業スタイルの修正提案：あり（${fresh.length}件）**` : "**作業スタイルの修正提案：なし**（条件を満たす傾向がまだないため、学習を続けます）");
  L.push("");

  L.push("### 今日の記録");
  if (!todayProjects.length && !todayCompleted) L.push("- 登録・完了ともにありませんでした");
  for (const p of todayProjects) {
    const diffs = [
      p.removed.length && `削除${p.removed.length}`,
      p.added.length && `追加${p.added.length}`,
      p.shifted.length && `日付調整${p.shifted.length}`,
      p.renamed.length && `名前変更${p.renamed.length}`,
      p.actorFixed.length && `主体修正${p.actorFixed.length}`,
    ].filter(Boolean);
    L.push(`- ${p.title}（${p.type}）：提案${p.proposed}件中${p.kept}件を採用${diffs.length ? `／${diffs.join("・")}` : "／修正なし"}${p.excluded ? "　※採用率が低いため集計から除外" : ""}`);
  }
  if (todayCompleted) L.push(`- 完了したタスク：${todayCompleted}件`);
  L.push("");

  if (fresh.length) {
    L.push("### 見つかった傾向（提案の対象）");
    fresh.forEach((p, i) => L.push(`${i + 1}. ${p.summary}　根拠：${p.evidence.map((e) => e.project).join("、")}`));
    L.push("");
  }

  L.push("### 学習の進み具合");
  L.push(`- 集計に使った案件：${totals.projectsUsed}件（提案${totals.proposedTasks}件中${totals.keptTasks}件を採用・採用率${totals.proposedTasks ? Math.round((totals.keptTasks / totals.proposedTasks) * 100) : 0}%）／完了タスク：${totals.completedTasks}件`);
  if (watch.length) {
    L.push("- あと少しで判定される傾向：");
    for (const w of watch.slice(0, 5)) L.push(`  - ${w.type}の「${w.step}」— ${w.note}`);
  } else {
    L.push("- あと少しで判定される傾向：まだありません");
  }
  L.push("");

  const notes = [];
  if (records.duplicates.length) notes.push(`同じ依頼ページから作った案件が複数あります（古い方を集計から除外）：${records.duplicates.join("、")}。不要なら削除してください`);
  const noSnapshot = records.projects.filter((p) => p.comparedWith === "current").length;
  if (noSnapshot) notes.push(`登録時の控えが無い案件が${noSnapshot}件あり、現在の内容で比べています（アプリを開くと自動で控えが付きます）`);
  if (totals.projectsExcluded) notes.push(`採用率が低い案件${totals.projectsExcluded}件は、作り直したとみなして集計から外しています`);
  if (notes.length) {
    L.push("### 注意");
    for (const n of notes) L.push(`- ${n}`);
  }
  return L.join("\n").trim();
}

// ---- 日付（日本時間・営業日） --------------------------------------------------
// 祝日リストはアプリ側（apps/compass/src/lib/date.ts）と同じ。更新するときは両方直す

const HOLIDAYS = new Set([
  "2026-01-01", "2026-01-12", "2026-02-11", "2026-02-23", "2026-03-20", "2026-04-29", "2026-05-03", "2026-05-04", "2026-05-05", "2026-05-06",
  "2026-07-20", "2026-08-11", "2026-09-21", "2026-09-22", "2026-09-23", "2026-10-12", "2026-11-03", "2026-11-23",
  "2027-01-01", "2027-01-11", "2027-02-11", "2027-02-23", "2027-03-21", "2027-03-22", "2027-04-29", "2027-05-03", "2027-05-04", "2027-05-05",
  "2027-07-19", "2027-08-11", "2027-09-20", "2027-09-23", "2027-10-11", "2027-11-03", "2027-11-23",
]);

const toJstDate = (iso) => new Date(new Date(iso).getTime() + 9 * 3600e3).toISOString().slice(0, 10);
const jstToday = () => toJstDate(new Date().toISOString());

function isBusinessDay(key) {
  const day = new Date(key + "T00:00:00Z").getUTCDay();
  if (day === 0 || day === 6 || HOLIDAYS.has(key)) return false;
  const md = key.slice(5);
  return !(md >= "12-29" || md <= "01-03");
}

/** from から to まで何営業日か（to が後なら正） */
function bizDiff(from, to) {
  if (from === to) return 0;
  const sign = to > from ? 1 : -1;
  let d = new Date(from + "T00:00:00Z");
  let n = 0;
  for (let i = 0; i < 400; i++) {
    d = new Date(d.getTime() + sign * 86400e3);
    const key = d.toISOString().slice(0, 10);
    if (isBusinessDay(key)) n += sign;
    if (key === to) return n;
  }
  return n;
}

export const _test = { collect, findPatterns, bizDiff };

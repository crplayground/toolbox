// POST /plan … 依頼ページを全文読み、Gemini にWBS（作業分解）の提案を作らせる。
//
// body { pageId, style, today }
//   pageId … 32桁のNotionページID
//   style  … 作業スタイル（アプリの設定画面で編集するテキスト。8,000字まで）
//   today  … YYYY-MM-DD（ブラウザ側の今日）
// 返り値 { page, text, plan }
//   page … Notion API のページ（プロパティの読み取りはアプリ側で行う）
//   text … AIに渡したページ本文（確認用）
//   plan … Gemini の出力（下の PLAN_SCHEMA）
//
// 日付の計算（営業日の逆算）はアプリ側（apps/compass/src/lib/plan.ts）で行う。
// AIには「どの確定日の何営業日前か」だけを出させ、日付そのものは書かせない（取り違え防止）。
//
// 必要な Secret：NOTION_TOKEN（読み取り専用インテグレーション）・GEMINI_API_KEY
// 任意の Var：GEMINI_MODEL

const GEMINI_API_BASE = "https://generativelanguage.googleapis.com/v1beta/models/";
const GEMINI_DEFAULT_MODEL = "gemini-2.5-flash";
const GEMINI_TIMEOUT_MS = 55_000;
const MAX_BLOCKS = 400;
const MAX_TEXT = 20_000;

export async function handlePlan(request, env, json) {
  if (!env.NOTION_TOKEN) return json({ error: "依頼ページの読み込みは未設定です（NOTION_TOKEN）" }, 501);
  if (!env.GEMINI_API_KEY) return json({ error: "AIの提案は未設定です（GEMINI_API_KEY）" }, 501);

  const body = await request.json().catch(() => null);
  const pageId = String(body?.pageId || "").replace(/-/g, "").toLowerCase();
  if (!/^[0-9a-f]{32}$/.test(pageId)) return json({ error: "NotionページのIDが不正です" }, 400);
  const style = String(body?.style || "").slice(0, 8000);
  const today = /^\d{4}-\d{2}-\d{2}$/.test(body?.today || "") ? body.today : new Date().toISOString().slice(0, 10);

  const notion = (path) =>
    fetch(`https://api.notion.com/v1/${path}`, {
      headers: { Authorization: `Bearer ${env.NOTION_TOKEN}`, "Notion-Version": env.NOTION_VERSION || "2022-06-28" },
    });

  const pageRes = await notion(`pages/${pageId}`);
  if (pageRes.status === 404) return json({ error: "ページが見つかりません。依頼DBにインテグレーション「Compass（読み取り）」が接続されているか確認してください" }, 404);
  if (!pageRes.ok) return json({ error: `Notionの読み込みに失敗しました（${pageRes.status}）` }, 502);
  const page = await pageRes.json();

  const lines = [];
  await readBlocks(notion, pageId, 0, lines, { count: 0 });
  const text = [propertiesText(page), "", "# 本文", ...lines].join("\n").slice(0, MAX_TEXT);

  let plan;
  try {
    plan = await callGemini(buildPrompt({ text, style, today, createdAt: (page.created_time || "").slice(0, 10) }), env);
  } catch (e) {
    console.error("[plan] Gemini:", e.message);
    return json({ error: "AIの提案を作れませんでした。少し待ってからもう一度お試しください", text }, 502);
  }
  return json({ page, text, plan });
}

// ---- Notion → テキスト ----------------------------------------------------

const plain = (rich) => (rich || []).map((r) => r.plain_text || "").join("");

function propertiesText(page) {
  const out = ["# プロパティ"];
  for (const [name, p] of Object.entries(page.properties || {})) {
    let v = "";
    if (p.type === "title" || p.type === "rich_text") v = plain(p[p.type]);
    else if (p.type === "select") v = p.select?.name || "";
    else if (p.type === "multi_select") v = (p.multi_select || []).map((o) => o.name).join("、");
    else if (p.type === "date") v = p.date ? [p.date.start, p.date.end].filter(Boolean).join(" 〜 ") : "";
    else if (p.type === "people") v = (p.people || []).map((u) => u.name || "").join("、");
    else if (p.type === "created_time") v = (p.created_time || "").slice(0, 10);
    else if (p.type === "number") v = p.number ?? "";
    else continue; // url・ファイル等はAIに渡さない
    if (v !== "") out.push(`${name}：${v}`);
  }
  return out.join("\n");
}

async function readBlocks(notion, id, depth, lines, budget) {
  let cursor;
  do {
    const res = await notion(`blocks/${id}/children?page_size=100${cursor ? `&start_cursor=${cursor}` : ""}`);
    if (!res.ok) return;
    const data = await res.json();
    for (const b of data.results || []) {
      if (++budget.count > MAX_BLOCKS) return;
      const line = blockLine(b);
      if (line !== null) lines.push("  ".repeat(depth) + line);
      // 表・トグル・入れ子の箇条書きの中身も読む（3段まで）
      if (b.has_children && depth < 3 && b.type !== "child_page" && b.type !== "child_database") {
        await readBlocks(notion, b.id, depth + 1, lines, budget);
      }
    }
    cursor = data.has_more ? data.next_cursor : undefined;
  } while (cursor);
}

function blockLine(b) {
  const v = b[b.type] || {};
  switch (b.type) {
    case "heading_1":
      return `# ${plain(v.rich_text)}`;
    case "heading_2":
      return `## ${plain(v.rich_text)}`;
    case "heading_3":
      return `### ${plain(v.rich_text)}`;
    case "paragraph":
    case "quote":
    case "callout":
    case "toggle":
      return plain(v.rich_text);
    case "bulleted_list_item":
      return `- ${plain(v.rich_text)}`;
    case "numbered_list_item":
      return `1. ${plain(v.rich_text)}`;
    case "to_do":
      return `- [${v.checked ? "x" : " "}] ${plain(v.rich_text)}`;
    case "table_row":
      return `| ${(v.cells || []).map(plain).join(" | ")} |`;
    case "image":
      return `［画像${v.caption?.length ? `：${plain(v.caption)}` : ""}（中身は読めない）］`;
    case "bookmark":
    case "embed":
    case "link_preview":
      return `［リンク：${v.url || ""}］`;
    case "child_page":
      return `［子ページ：${v.title || ""}］`;
    default:
      return null;
  }
}

// ---- Gemini ---------------------------------------------------------------

const PLAN_SCHEMA = {
  type: "OBJECT",
  properties: {
    title: { type: "STRING", description: "清書した案件名。意味は変えず、対象と制作物が分かる形。元の案件名で十分ならそのまま" },
    size: { type: "STRING", enum: ["light", "standard", "heavy"], description: "案件の規模" },
    sizeReason: { type: "STRING", description: "規模の判断理由（1文）" },
    anchors: {
      type: "ARRAY",
      description: "確定日：ページに書かれている、動かせない日付（使用開始日・本番・納品・入稿など）",
      items: {
        type: "OBJECT",
        properties: {
          key: { type: "STRING", description: "a1, a2 … の識別子" },
          label: { type: "STRING", description: "何の日か（例：使用開始、納品、入稿）" },
          kind: { type: "STRING", enum: ["use", "delivery", "other"], description: "use＝使用開始・本番・公開／delivery＝納品（依頼者の手元に届く・納め終わる日）／other＝入稿・校了・素材の締切など" },
          group: { type: "STRING", description: "制作物名。案件全体なら空文字" },
          date: { type: "STRING", description: "YYYY-MM-DD" },
          dateEnd: { type: "STRING", description: "幅がある場合の最終日 YYYY-MM-DD。なければ空文字" },
          inferred: { type: "BOOLEAN", description: "何の日か書かれておらず推定した場合 true" },
          evidence: { type: "STRING", description: "根拠になったページの記述をそのまま短く引用" },
        },
        required: ["key", "label", "kind", "group", "date", "dateEnd", "inferred", "evidence"],
      },
    },
    tasks: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: {
          title: { type: "STRING", description: "タスク名。動詞で終える短い名前（例：デザイン案を提出）" },
          group: { type: "STRING", description: "制作物名。案件全体なら空文字" },
          actor: { type: "STRING", enum: ["self", "client", "vendor"], description: "self＝デザイナー本人の作業（納品・入稿・校了・提出を含む）／client＝依頼者の作業・依頼者からの受け取り・使用開始や本番／vendor＝印刷会社など外部の作業（印刷・出荷）" },
          from: { type: "STRING", enum: ["page", "ai"], description: "page＝ページに日付つきで書かれている工程／ai＝作業スタイルから提案する工程" },
          date: { type: "STRING", description: "from=page のときだけ YYYY-MM-DD。from=ai は空文字" },
          anchorKey: { type: "STRING", description: "from=ai のとき、逆算の基準にする確定日の key" },
          offsetDays: { type: "INTEGER", description: "from=ai のとき、基準日の何営業日前か（前＝正の数、同日＝0、後＝負の数）" },
          reason: { type: "STRING", description: "from=ai のとき、提案の根拠を1文（例：チラシの標準。入稿の5営業日前）" },
        },
        required: ["title", "group", "actor", "from", "date", "anchorKey", "offsetDays", "reason"],
      },
    },
    questions: { type: "ARRAY", items: { type: "STRING" }, description: "担当者に確認が必要なこと（最大5件）" },
  },
  required: ["title", "size", "sizeReason", "anchors", "tasks", "questions"],
};

function buildPrompt({ text, style, today, createdAt }) {
  const system = `あなたは、事業会社のインハウスデザイナー（アートディレクター）の進行管理アシスタントです。
社内の制作依頼ページを読み、デザイナー本人が担当する案件のWBS（作業分解とスケジュール）の叩き台を作ります。
提案は必ずデザイナー本人が確認・修正してから登録します。迷ったら少なめに出し、確認事項に回してください。

## 読み取りのルール
- ページの書き方は依頼者によってばらつきます。見出しの名前や形式に頼らず、ページ全体から日付と出来事を拾ってください。
- 「使用開始日」「本番」「納品」「入稿」など、ページに書かれた動かせない日付を anchors（確定日）にします。
- 年が書かれていない日付は、起票日（${createdAt || "不明"}）以降で最も近い日付として解釈します。
- 何の日か書かれていない日付は「納品日」と推定し、inferred=true にして、questions で確認を促します。
- 「9/30〜10/4の間」のような幅は、date に早い方、dateEnd に遅い方を入れます。
- 画像やリンク先の資料にスケジュールがあると書かれている場合、その中身は読めません。推測で日付を作らず、questions に書いてください。
- 案件名は、日付・【至急】などの装飾を外し、対象と制作物が分かる形に清書します。意味を変えないこと。元の名前で十分ならそのまま使います。

## WBSのルール
- 複数の制作物がある場合は、group に制作物名を入れて、制作物ごとにタスクを作ります。1つだけなら group は空文字です。
- ページに日付つきで書かれている工程は、from=page として日付をそのまま使います（ページの記載を優先）。
- anchors に入れた日も、タスクとして1回だけ出します（from=page、date=その日）。
- actor の判定：納品・入稿・校了・提出・デザインアップはデザイナー本人の責任なので self です（「納品完了」「オール納品済み」も self）。client は、依頼者の作業・依頼者からの受け取り・使用開始や本番だけです。印刷・出荷など外部業者の作業は vendor です。
- ページに書かれていない工程は、作業スタイルに従って from=ai で補います。date は空文字にし、anchorKey と offsetDays（営業日）で表します。日付は自分で計算しないでください。
- 依頼者から素材・原稿・骨子を受け取る工程は actor=client、印刷・施工など外部の工程は actor=vendor にします。
- 規模が light（改訂・転用で差し替えが中心など）なら、タスクは全体で2〜4個に抑えます。細かく分けすぎないこと。
- 今日は ${today} です。今日より前になる工程は作らなくてかまいません。

## 作業スタイル（デザイナー本人のルール。一般論より優先する）
${style || "（未設定）"}`;
  return { system, user: `以下が依頼ページの内容です。\n\n${text}` };
}

async function callGemini({ system, user }, env) {
  const model = (env.GEMINI_MODEL || GEMINI_DEFAULT_MODEL).trim();
  const res = await fetch(GEMINI_API_BASE + encodeURIComponent(model) + ":generateContent", {
    method: "POST",
    signal: AbortSignal.timeout(GEMINI_TIMEOUT_MS),
    headers: { "Content-Type": "application/json", "x-goog-api-key": env.GEMINI_API_KEY },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: system }] },
      contents: [{ role: "user", parts: [{ text: user }] }],
      generationConfig: { temperature: 0.2, responseMimeType: "application/json", responseSchema: PLAN_SCHEMA },
    }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`HTTP_${res.status} ${(body.error && body.error.status) || ""}`);
  const parts = body.candidates?.[0]?.content?.parts || [];
  const text = parts.map((p) => p.text || "").join("").trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "");
  if (!text) throw new Error("EMPTY");
  return JSON.parse(text);
}

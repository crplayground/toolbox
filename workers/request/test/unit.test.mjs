// ============================================================
// REQUEST Worker ユニットテスト（フェーズ3: Notion一本化）
// 実行方法: workers/request/ で `node test/unit.test.mjs`
// ・純粋関数のロジック検証＋「廃止機構が残っていないか」のソース検査
// ・ネットワーク・KV・Notion実呼び出しは行わない（実結合はT7の通しテストで確認）
// ============================================================
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import {
  sectionsFor,
  asImageList,
  asScheduleList,
  asProductTypeList,
  normEmail,
  guestKey,
  redirectTargetFor,
  buildGuideHtml,
  buildNotionProperties,
  buildNotionSectionBlocks,
  buildNotionBlocks,
  buildSlackText,
  SEC_YOKEN,
  SEC_SEISAKU,
  SEC_SOUDAN,
  SEC_KAITEI,
} from "../src/worker.js";

let pass = 0, fail = 0;
function t(name, cond) {
  if (cond) { pass++; console.log("  ✅ " + name); }
  else { fail++; console.log("  ❌ " + name); }
}
function section(title) { console.log("\n" + title); }

// ---- 1. sectionsFor（種別→セクション） ----
section("1. sectionsFor");
t("新規＝与件整理＋制作内容", JSON.stringify(sectionsFor("新規")) === JSON.stringify(SEC_YOKEN.concat(SEC_SEISAKU)));
t("改訂＝改訂専用", sectionsFor("改訂") === SEC_KAITEI);
t("相談＝相談のみ", sectionsFor("相談") === SEC_SOUDAN);
t("不明な種別は新規と同じ構成", sectionsFor("").length === SEC_YOKEN.length + SEC_SEISAKU.length);

// ---- 2. asImageList（画像の厳密検証・XSS対策の継続確認） ----
section("2. asImageList");
const JPEG = "data:image/jpeg;base64,/9j/4AAQSkZJRg==";
const PNG = "data:image/png;base64,iVBORw0KGgo=";
t("正しいjpegを通す", asImageList([JPEG]).length === 1);
t("正しいpngを通す", asImageList([PNG]).length === 1);
t("svg+xmlは拒否（スクリプト実行可能）", asImageList(["data:image/svg+xml;base64,PHN2Zz4="]).length === 0);
t("data:以外の文字列は拒否", asImageList(["https://example.com/a.jpg"]).length === 0);
t('引用符注入は拒否', asImageList(['data:image/png,"><script>alert(1)</script>']).length === 0);
t("base64本体に不正文字があれば拒否", asImageList(["data:image/jpeg;base64,abc<def"]).length === 0);
t("11枚→10枚に制限", asImageList(Array(11).fill(JPEG)).length === 10);
t("配列以外は空", asImageList("x").length === 0);

// ---- 3. asScheduleList / asProductTypeList ----
section("3. スケジュール感・制作物種別の整形");
t("空行を除去", asScheduleList([{date:"",text:""},{date:"2026-08-01",text:"入稿"}]).length === 1);
t("最大20件に制限", asScheduleList(Array(25).fill({date:"2026-08-01",text:"x"})).length === 20);
t("date/textをtrim", asScheduleList([{date:" 2026-08-01 ",text:" 入稿 "}])[0].text === "入稿");
t("productTypes: 配列を受ける", asProductTypeList(["スライド"," KV・トンマナ "]).join(",") === "スライド,KV・トンマナ");
t("productTypes: カンマ文字列を受ける", asProductTypeList("スライド, バナー・SNS画像").length === 2);
t("productTypes: 空は空配列", asProductTypeList(undefined).length === 0);

// ---- 4. 既知依頼者リスト（フェーズ3新設） ----
section("4. guestKey / normEmail（初依頼者判定の鍵）");
t("小文字化・trimで正規化", normEmail("  Taro@CRAZY.co.jp ") === "taro@crazy.co.jp");
t("guestキーの形式", guestKey("Taro@crazy.co.jp") === "guest:taro@crazy.co.jp");
t("空メールは空キー（通知抑止側に倒す）", guestKey("") === "");
t("null安全", guestKey(null) === "");

// ---- 5. /v/ リダイレクト（移行措置） ----
section("5. redirectTargetFor（旧共有URL→Notion誘導）");
t("notionUrlありは そのURLを返す", redirectTargetFor({ notionUrl: "https://www.notion.so/abc" }) === "https://www.notion.so/abc");
t("前後空白はtrim", redirectTargetFor({ notionUrl: " https://www.notion.so/abc " }) === "https://www.notion.so/abc");
t("http(非https)は拒否", redirectTargetFor({ notionUrl: "http://evil.example" }) === "");
t("javascript:等は拒否", redirectTargetFor({ notionUrl: "javascript:alert(1)" }) === "");
t("recordなしは空", redirectTargetFor(null) === "");
t("notionUrl欠落は空", redirectTargetFor({ data: {} }) === "");
const guide = buildGuideHtml();
t("案内ページ：Notion移行の説明を含む", guide.indexOf("Notionに移行しました") !== -1);
t("案内ページ：受付chへ誘導する", guide.indexOf("#83_creative_クリ室依頼受付") !== -1);

// ---- 6. Notionプロパティ ----
section("6. buildNotionProperties");
const propsFull = buildNotionProperties({
  title: "夏フェア バナー", category: "新規", brand: "IWAI-婚礼",
  productTypes: ["バナー・SNS画像"], requesterDept: "MKT・広報",
  requesterName: "太郎", requesterEmail: "taro@crazy.co.jp",
  deadline: "2026-08-10", dataStorage: "https://drive.google.com/x",
});
t("案件名（title）", propsFull["案件名"].title[0].text.content === "夏フェア バナー");
t("依頼カテゴリ（select）", propsFull["依頼カテゴリ"].select.name === "新規");
t("制作物の種別（multi_select）", propsFull["制作物の種別"].multi_select[0].name === "バナー・SNS画像");
t("依頼者メール（email）", propsFull["依頼者メール"].email === "taro@crazy.co.jp");
t("希望納期（date）", propsFull["希望納期"].date.start === "2026-08-10");
const propsMin = buildNotionProperties({ title: "相談だけ", category: "相談" });
t("任意プロパティは無ければ送らない", !("希望納期" in propsMin) && !("対象ブランド・部署" in propsMin));
t("タイトル無しは（無題）", buildNotionProperties({ category: "相談" })["案件名"].title[0].text.content === "（無題）");

// ---- 7. Notion本文ブロック（共有URL calloutの廃止＋画像埋め込み） ----
section("7. buildNotionBlocks / buildNotionSectionBlocks");
const dataNew = {
  category: "新規", title: "x", purpose: "集客", manuscript: "原稿テキスト",
  schedule: [{ date: "2026-08-01", text: "入稿" }],
};
const secBlocks = buildNotionSectionBlocks(dataNew);
t("見出し＋本文のペアが生成される", secBlocks.some(b => b.type === "heading_2") && secBlocks.some(b => b.type === "paragraph"));
t("スケジュール感がbulleted_list_itemで入る", secBlocks.some(b => b.type === "bulleted_list_item"));
const blocksNoImg = buildNotionBlocks(dataNew, { ids: [], failed: 0 });
t("共有ページcalloutが無い（廃止確認）", JSON.stringify(blocksNoImg).indexOf("共有ページ") === -1);
t("画像なしなら画像見出しも無い", JSON.stringify(blocksNoImg).indexOf("参考画像") === -1);
const blocksImg = buildNotionBlocks(dataNew, { ids: ["fu-1", "fu-2"], failed: 1 });
t("file_uploadの画像ブロックが入る", blocksImg.filter(b => b.type === "image" && b.image.type === "file_upload").length === 2);
t("画像IDが引き継がれる", blocksImg.some(b => b.type === "image" && b.image.file_upload.id === "fu-1"));
t("失敗枚数が本文に記録される", JSON.stringify(blocksImg).indexOf("失敗：1枚") !== -1);
t("画像は本文の末尾（セクションの後）", blocksImg[blocksImg.length - 2].type === "image" || blocksImg[blocksImg.length - 1].type === "paragraph");

// ---- 8. Slack投稿文（初依頼者付記・フェーズ3新設） ----
section("8. buildSlackText");
const slackData = {
  category: "新規", title: "夏フェア", requesterDept: "MKT・広報",
  requesterName: "太郎", requesterEmail: "Taro@crazy.co.jp", images: [JPEG],
};
const txtKnown = buildSlackText(slackData, "https://www.notion.so/abc", false);
t("Notionリンクを含む", txtKnown.indexOf("https://www.notion.so/abc") !== -1);
t("共有ページの行が無い（廃止確認）", txtKnown.indexOf("共有ページ") === -1);
t("既知依頼者には🆕を付けない", txtKnown.indexOf("🆕") === -1);
t("画像はNotion掲載と案内", txtKnown.indexOf("Notionページに掲載") !== -1);
const txtFirst = buildSlackText(slackData, "https://www.notion.so/abc", true);
t("初依頼者は🆕付記", txtFirst.indexOf("🆕") !== -1);
t("招待先メールを明記（正規化済み）", txtFirst.indexOf("taro@crazy.co.jp") !== -1);
t("招待手順（共有→今はスキップ）を含む", txtFirst.indexOf("今はスキップ") !== -1);

// ---- 9. ソース検査：フェーズ2機構の撤去確認（T2） ----
section("9. ソース検査（廃止機構が残っていないこと）");
const __dir = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(__dir, "../src/worker.js"), "utf8");
["buildShareHtml", "buildNotionUpdateBlocks", "updateNotionPageProps", "appendNotionBlocks",
 "saveFormRecord", "canEdit", "editorEmailSet", "bearerToken", "buildEditUrl", "diffLabels",
 "CREATIVE_EDITOR_EMAILS", "FORM_URL"].forEach((name) => {
  t("撤去済み: " + name, src.indexOf(name) === -1);
});
t('KVへの html:<id> 読み書きが無い', src.indexOf('"html:"') === -1);
t('form:<id> は読み出し専用（putしない）', src.indexOf('put("form:') === -1 && src.indexOf('"form:"') !== -1);
t("guest:<email> 照合が実装されている", src.indexOf('"guest:"') !== -1);
t("File Upload APIを使用", src.indexOf("/v1/file_uploads") !== -1);
t("editId送信には410で案内", src.indexOf("EDIT_REMOVED") !== -1);

// ---- 結果 ----
console.log("\n============================");
console.log("合格 " + pass + " 件 ／ 不合格 " + fail + " 件");
if (fail > 0) process.exit(1);
console.log("全テスト合格 🎉");

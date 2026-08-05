// ============================================================
// CREATIVE PROCESS Worker ユニットテスト（フェーズ3: Notion一本化）
// 実行方法: workers/creative-process/ で `node test/unit.test.mjs`
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
  buildSlackBlocks,
  CATEGORY_EMOJI,
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
t("改訂・流用＝改訂専用", sectionsFor("改訂・流用") === SEC_KAITEI);
t("相談＝相談のみ", sectionsFor("相談") === SEC_SOUDAN);
t("不明な種別は新規と同じ構成", sectionsFor("").length === SEC_YOKEN.length + SEC_SEISAKU.length);
// 2026-07-26 テキストFIX：依頼概要(overview)を撤去し、広報確認を制作物の概要の前へ移した
t("与件整理から overview を撤去", !SEC_YOKEN.some(([k]) => k === "overview"));
t("与件整理の先頭は依頼背景・課題感", SEC_YOKEN[0][0] === "purpose" && SEC_YOKEN[0][1] === "依頼背景・課題感");
t("与件整理から issue（現状の課題）を撤去", !SEC_YOKEN.some(([k]) => k === "issue"));
t("制作内容の先頭は広報チームの企画確認状況", SEC_SEISAKU[0][0] === "prStatus" && SEC_SEISAKU[0][1] === "広報チームの企画確認状況");
t("制作内容から reference（参考・インスピレーション）を撤去", !SEC_SEISAKU.some(([k]) => k === "reference"));
t("旧カテゴリ名「改訂」では改訂セクションにならない", sectionsFor("改訂") !== SEC_KAITEI);
// 2026-08-01 見出しの改称（フォームの設問名に合わせる）
t("prototype の見出しは「プロトタイプ」", SEC_SEISAKU.some(([k, l]) => k === "prototype" && l === "プロトタイプ"));
t("intent の見出しは「プロジェクトに対する想い」", SEC_SEISAKU.some(([k, l]) => k === "intent" && l === "プロジェクトに対する想い"));
t("旧見出しは残っていない", JSON.stringify(SEC_YOKEN.concat(SEC_SEISAKU)).indexOf("抱えている課題感") === -1
  && JSON.stringify(SEC_SEISAKU).indexOf("構成ラフ") === -1
  && JSON.stringify(SEC_SEISAKU).indexOf("意気込み") === -1);

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
  title: "夏フェア バナー", category: "新規", brand: "IWAI-婚礼｜婚礼に関する制作物",
  productTypes: ["バナー・告知画像"], requesterDept: "MKT・広報",
  requesterName: "太郎", requesterEmail: "taro@crazy.co.jp",
  dataStorage: "https://drive.google.com/x",
});
t("案件名（title）", propsFull["案件名"].title[0].text.content === "夏フェア バナー");
t("依頼種別（select）", propsFull["依頼種別"].select.name === "新規");
t("制作物の種別（multi_select）", propsFull["制作物の種別"].multi_select[0].name === "バナー・告知画像");
// 2026-07-26 Notion DB改称に追従（プロパティ名がずれるとNotion登録が丸ごと失敗するため固定する）
t("対象事業・部署（旧「対象ブランド・部署」）", propsFull["対象事業・部署"].select.name === "IWAI-婚礼｜婚礼に関する制作物");
t("所属部署（旧「依頼者部署」）", propsFull["所属部署"].select.name === "MKT・広報");
t("依頼者（rich_text）に氏名が入る", propsFull["依頼者"].rich_text[0].text.content === "太郎");
t("データ格納先（url）", propsFull["データ格納先"].url === "https://drive.google.com/x");
t("旧プロパティ名は送らない", !("依頼カテゴリ" in propsFull) && !("対象ブランド・部署" in propsFull) && !("依頼者部署" in propsFull) && !("依頼者名" in propsFull));
// 2026-08-01 Notion DB整理：存在しないプロパティを送るとNotion APIが400を返し登録が丸ごと失敗する
t("DBに無い「担当者名」を送らない", !("担当者名" in propsFull));
t("DBに無い「依頼者メール」を送らない（メールは本文に書く）", !("依頼者メール" in propsFull));
t("廃止した「希望納期」を送らない", !("希望納期" in propsFull));
t("person型の「担当者」はWorkerから触らない", !("担当者" in propsFull));
const propsMin = buildNotionProperties({ title: "相談だけ", category: "相談" });
t("任意プロパティは無ければ送らない", !("依頼者" in propsMin) && !("対象事業・部署" in propsMin) && !("データ格納先" in propsMin));
t("タイトル無しは（無題）", buildNotionProperties({ category: "相談" })["案件名"].title[0].text.content === "（無題）");
t("送るプロパティはDBに実在する9つの範囲に収まる", Object.keys(propsFull).every(k =>
  ["案件名","依頼種別","依頼者","所属部署","対象事業・部署","制作物の種別","データ格納先"].indexOf(k) !== -1));

// ---- 7. Notion本文ブロック（共有URL calloutの廃止＋画像埋め込み） ----
section("7. buildNotionBlocks / buildNotionSectionBlocks");
const dataNew = {
  category: "新規", title: "x", purpose: "集客", manuscript: "原稿テキスト",
  schedule: [{ date: "2026-08-01", text: "入稿" }],
};
const secBlocks = buildNotionSectionBlocks(dataNew);
t("見出し＋本文のペアが生成される", secBlocks.some(b => b.type === "heading_2") && secBlocks.some(b => b.type === "paragraph"));
t("スケジュールがbulleted_list_itemで入る", secBlocks.some(b => b.type === "bulleted_list_item"));
t("スケジュールの見出しは「スケジュール」", JSON.stringify(secBlocks).indexOf("スケジュール感") === -1
  && secBlocks.some(b => b.type === "heading_2" && b.heading_2.rich_text[0].text.content === "スケジュール"));

// 2026-08-01 依頼者のメールアドレスはプロパティに入れず、本文の先頭に書く
const secWho = buildNotionSectionBlocks({
  category: "相談", consultDetail: "ざっくり相談", requesterName: "太郎", requesterEmail: "taro@crazy.co.jp",
});
t("本文の先頭が依頼者情報", secWho[0].type === "paragraph"
  && secWho[0].paragraph.rich_text[0].text.content === "依頼者：太郎（taro@crazy.co.jp）");
t("依頼者情報が無ければ段落も作らない",
  buildNotionSectionBlocks({ category: "相談", consultDetail: "x" })[0].type === "heading_2");

// 改訂・流用でもスケジュールを本文に出す（フォームに設問を追加したため）
const secKaitei = buildNotionSectionBlocks({
  category: "改訂・流用", reviseManuscript: "文言差し替え",
  schedule: [{ date: "2026-08-05", text: "校了" }],
});
t("改訂・流用にもスケジュールが入る", secKaitei.some(b => b.type === "bulleted_list_item"));
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
t("カテゴリ絵文字を含む（新規=🎨）", txtKnown.indexOf(CATEGORY_EMOJI["新規"]) === 0);

// ---- 8b. Slack Block Kit整形（フェーズ4先行分・2026-07-25新設） ----
section("8b. buildSlackBlocks（Block Kit整形）");
const blocksKnown = buildSlackBlocks(slackData, "https://www.notion.so/abc", false);
t("先頭はheaderブロック", blocksKnown[0].type === "header");
t("headerに依頼タイトルを含む", blocksKnown[0].text.text.indexOf("夏フェア") !== -1);
t("headerにカテゴリ絵文字（新規=🎨）", blocksKnown[0].text.text.indexOf("🎨") === 0);
t("headerはplain_text（Block Kit仕様）", blocksKnown[0].text.type === "plain_text");
const fieldSec = blocksKnown.find(b => b.type === "section" && Array.isArray(b.fields));
t("概要フィールドのsectionがある", !!fieldSec);
t("依頼カテゴリのフィールドを含む", fieldSec.fields.some(f => f.text.indexOf("依頼種別") !== -1));
t("依頼者名＋部署を1フィールドに統合", fieldSec.fields.some(f => f.text.indexOf("太郎（MKT・広報）") !== -1));
t("添付画像のフィールドを含む", fieldSec.fields.some(f => f.text.indexOf("添付画像") !== -1));
t("空の項目はフィールドに出さない（納期なし）", !fieldSec.fields.some(f => f.text.indexOf("希望納期") !== -1));
t("フィールドは最大10件以内", fieldSec.fields.length <= 10);
const btnBlock = blocksKnown.find(b => b.type === "actions");
t("Notionリンクボタンがある", !!btnBlock && btnBlock.elements[0].type === "button");
t("ボタンのURLがnotionUrl", btnBlock.elements[0].url === "https://www.notion.so/abc");
t("既知依頼者に🆕ブロックが無い", JSON.stringify(blocksKnown).indexOf("🆕") === -1);
const blocksFirst = buildSlackBlocks(slackData, "https://www.notion.so/abc", true);
t("初依頼者は🆕sectionが付く", JSON.stringify(blocksFirst).indexOf("🆕") !== -1);
t("🆕sectionに正規化メールを含む", JSON.stringify(blocksFirst).indexOf("taro@crazy.co.jp") !== -1);
t("🆕の前にdividerが入る", blocksFirst.some(b => b.type === "divider"));
const blocksNoUrl = buildSlackBlocks(slackData, "", false);
t("notionUrl無しならボタンを出さない", !blocksNoUrl.some(b => b.type === "actions"));
const blocksLongTitle = buildSlackBlocks({ ...slackData, title: "あ".repeat(200) }, "https://www.notion.so/abc", false);
t("headerは150字以内に切り詰め", blocksLongTitle[0].text.text.length <= 150);
const blocksMin = buildSlackBlocks({ category: "相談", title: "相談だけ" }, "https://www.notion.so/abc", false);
t("相談カテゴリの絵文字は💬", blocksMin[0].text.text.indexOf("💬") === 0);
t("最小データでもfieldsが1件以上（Block Kit仕様）", blocksMin.find(b => b.fields).fields.length >= 1);

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
// 2026-08-01 Googleログイン：認可コードフロー
t("/auth/exchange エンドポイントがある", src.indexOf('"/auth/exchange"') !== -1);
t("トークン交換の宛先が Google の token エンドポイント", src.indexOf("https://oauth2.googleapis.com/token") !== -1);
t("ポップアップ方式のため redirect_uri は postmessage", src.indexOf('redirect_uri: "postmessage"') !== -1);
t("シークレットは env から読む（ソースに直書きしない）", src.indexOf("env.GOOGLE_CLIENT_SECRET") !== -1);
t("交換したIDトークンも署名検証している", /exchangeCodeForIdToken[\s\S]{0,400}verifyGoogleIdToken/.test(src));
t("Google のエラー本文をそのまま返さない", src.indexOf("out.error_description") === -1);
t("File Upload APIを使用", src.indexOf("/v1/file_uploads") !== -1);
t("editId送信には410で案内", src.indexOf("EDIT_REMOVED") !== -1);
t("Slack投稿にblocksを送信（Block Kit・フェーズ4先行分）", src.indexOf("blocks: buildSlackBlocks") !== -1);
t("Slack投稿にfallback textも送信（通知用）", src.indexOf("text: buildSlackText") !== -1);

// ---- 結果 ----
console.log("\n============================");
console.log("合格 " + pass + " 件 ／ 不合格 " + fail + " 件");
if (fail > 0) process.exit(1);
console.log("全テスト合格 🎉");

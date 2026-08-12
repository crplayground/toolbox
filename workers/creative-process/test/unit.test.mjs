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
  redirectTargetFor,
  buildGuideHtml,
  buildNotionProperties,
  buildNotionSectionBlocks,
  buildNotionBlocks,
  buildImageBlocks,
  brandShortName,
  sanitizeFolderName,
  extractDriveFolderId,
  DRIVE_BRAND_FOLDERS,
  DRIVE_SOUDAN_FOLDER_ID,
  DRIVE_SUBFOLDERS,
  SEC_YOKEN,
  SEC_SEISAKU,
  SEC_SOUDAN,
  SEC_KAITEI,
  SEC_TENYO,
  SEC_KAITEI_LEGACY,
  DRIVE_TYPE_SHELVES,
  DRIVE_FOLDER_TO_BRAND,
  DFOLDER_KV_PREFIX,
  DRIVE_KANRI_FOLDER_ID,
  brandFromShortName,
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
t("改訂＝改訂専用（親フォルダURL＋制作内容）", sectionsFor("改訂") === SEC_KAITEI);
t("転用＝転用専用（転用元＋制作内容）", sectionsFor("転用") === SEC_TENYO);
t("旧「改訂・流用」は互換セクション（旧フォームの過渡期用）", sectionsFor("改訂・流用") === SEC_KAITEI_LEGACY);
t("相談＝相談のみ", sectionsFor("相談") === SEC_SOUDAN);
t("不明な種別は新規と同じ構成", sectionsFor("").length === SEC_YOKEN.length + SEC_SEISAKU.length);
// 2026-07-26 テキストFIX：依頼概要(overview)を撤去し、広報確認を制作物の概要の前へ移した
t("与件整理から overview を撤去", !SEC_YOKEN.some(([k]) => k === "overview"));
t("与件整理の先頭は依頼背景・課題感", SEC_YOKEN[0][0] === "purpose" && SEC_YOKEN[0][1] === "依頼背景・課題感");
t("与件整理から issue（現状の課題）を撤去", !SEC_YOKEN.some(([k]) => k === "issue"));
t("制作内容の先頭は広報チームの企画確認状況", SEC_SEISAKU[0][0] === "prStatus" && SEC_SEISAKU[0][1] === "広報チームの企画確認状況");
t("制作内容から reference（参考・インスピレーション）を撤去", !SEC_SEISAKU.some(([k]) => k === "reference"));
t("改訂の見出しはFigma第4次改修の設問名", SEC_KAITEI[0][1] === "改訂するデータの親フォルダのURL");
t("転用の見出しはFigma第3次改修の設問名", SEC_TENYO[0][1] === "転用元のデータ");
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
t("案内ページ：問い合わせ先（クリエイティブ室）を案内する", guide.indexOf("クリエイティブ室") !== -1);

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

// ---- 9. ソース検査：フェーズ2機構の撤去確認（T2） ----
section("9. ソース検査（廃止機構が残っていないこと）");
const __dir = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(__dir, "../src/worker.js"), "utf8");
["buildShareHtml", "buildNotionUpdateBlocks", "updateNotionPageProps", "appendNotionBlocks",
 "saveFormRecord", "canEdit", "editorEmailSet", "bearerToken", "buildEditUrl", "diffLabels",
 "CREATIVE_EDITOR_EMAILS", "FORM_URL",
 // 2026-08-11 Slack自動投稿の白紙化（コードごと撤去）
 "buildSlackText", "buildSlackBlocks", "postToSlack", "SLACK_WEBHOOK_URL",
 "isKnownGuest", "markGuestKnown", "guestKey", "normEmail", "CATEGORY_EMOJI", "firstRequest"].forEach((name) => {
  t("撤去済み: " + name, src.indexOf(name) === -1);
});
t('KVへの html:<id> 読み書きが無い', src.indexOf('"html:"') === -1);
t('form:<id> は読み出し専用（putしない）', src.indexOf('put("form:') === -1 && src.indexOf('"form:"') !== -1);
t('guest:<email> の読み書きが無い（Slack白紙化で撤去）', src.indexOf('"guest:"') === -1);
// 2026-08-01 Googleログイン：認可コードフロー
t("/auth/exchange エンドポイントがある", src.indexOf('"/auth/exchange"') !== -1);
t("トークン交換の宛先が Google の token エンドポイント", src.indexOf("https://oauth2.googleapis.com/token") !== -1);
// 2026-08-12 ボタンログイン不具合修正: redirect_uri は「呼び出し元オリジン」（Google公式仕様）。
// 旧 "postmessage" はGoogleが拒否するようになったため、残っていないことも検査する。
t("トークン交換の redirect_uri は呼び出し元オリジン（変数 redirectUri）", src.indexOf("redirect_uri: redirectUri") !== -1);
t("交換に検証済みリクエストの Origin ヘッダを渡している", /exchangeCodeForIdToken\(code, env, request\.headers\.get\("Origin"\)\)/.test(src));
t('旧 redirect_uri: "postmessage" が残っていない', src.indexOf('redirect_uri: "postmessage"') === -1);
t("シークレットは env から読む（ソースに直書きしない）", src.indexOf("env.GOOGLE_CLIENT_SECRET") !== -1);
t("交換したIDトークンも署名検証している", /exchangeCodeForIdToken[\s\S]{0,400}verifyGoogleIdToken/.test(src));
t("Google のエラー本文をそのまま返さない", src.indexOf("out.error_description") === -1);
t("File Upload APIを使用", src.indexOf("/v1/file_uploads") !== -1);
t("editId送信には410で案内", src.indexOf("EDIT_REMOVED") !== -1);

// ---- 10. V1-5.9 起票番号の廃止（撤去確認） ----
section("10. V1-5.9 起票番号の廃止（採番機構の撤去確認）");
for (const name of [
  "formatSeq", "parseSeq", "nextSeqNumber", "NUMBERED_FOLDER_RE", "DRIVE_SEQ_PROP",
]) {
  t("撤去済み: " + name, !new RegExp("(function |const )" + name + "\\b").test(src));
}
t("採番のNotionクエリが無い（起票番号の降順取得）", !/direction: "descending"[\s\S]{0,60}page_size: 1/.test(src));
t("プロパティ「起票番号」への書き込みコードが無い", !/"起票番号"\]? ?[:=] ?\{ rich_text/.test(src));
t("応答に seqLabel を含まない", !/^\s*seqLabel,\s*$/m.test(src));
t("KVの目印キーは dfolder:", DFOLDER_KV_PREFIX === "dfolder:");

section("11. V1-5 略称の切り出し（brandShortName）");
t("IWAI-婚礼｜… → IWAI-婚礼", brandShortName("IWAI-婚礼｜婚礼に関する制作物") === "IWAI-婚礼");
t("MT-the-Terrace｜… → MT-the-Terrace", brandShortName("MT-the-Terrace｜the Terraceに関する制作物") === "MT-the-Terrace");
t("その他｜… → その他", brandShortName("その他｜AI推進・BD・食企画・経営企画等に関する制作物") === "その他");
t("｜が無ければ全体を返す", brandShortName("CR室") === "CR室");
t("空文字は空のまま", brandShortName("") === "" && brandShortName(undefined) === "");
t("18件すべてが｜を持ち略称を切り出せる",
  Object.keys(DRIVE_BRAND_FOLDERS).every((k) => brandShortName(k).length > 0 && brandShortName(k) !== k));

section("12. V1-5 フォルダ名のサニタイズ（sanitizeFolderName）");
t("スラッシュをハイフンに寄せる", sanitizeFolderName("6月/フェア") === "6月-フェア");
t("バックスラッシュも同様", sanitizeFolderName("A\\B") === "A-B");
t("前後の空白を落とす", sanitizeFolderName("  春の展示会  ") === "春の展示会");
t("連続する空白は1つに畳む", sanitizeFolderName("春の  展示会") === "春の 展示会");
t("制御文字を除去", sanitizeFolderName("春の\u0000展示\u001f会") === "春の展示会");
t("60字で切り詰める", sanitizeFolderName("あ".repeat(100)).length === 60);
t("空・未定義は「無題」", sanitizeFolderName("") === "無題" && sanitizeFolderName(undefined) === "無題");
t("空白だけでも「無題」", sanitizeFolderName("   ") === "無題");

section("13. V1-5 Drive URLからのフォルダID抽出（extractDriveFolderId）");
t("フォルダURL", extractDriveFolderId("https://drive.google.com/drive/folders/1T3J-bOCpWrCKDlOwb3-wFIImg6mgNuFz") === "1T3J-bOCpWrCKDlOwb3-wFIImg6mgNuFz");
t("共有パラメータ付き", extractDriveFolderId("https://drive.google.com/drive/folders/1abcDEFghij-1234?usp=drive_link") === "1abcDEFghij-1234");
t("アカウント番号付きURL", extractDriveFolderId("https://drive.google.com/drive/u/0/folders/1abcDEFghij-1234") === "1abcDEFghij-1234");
t("ファイルURL", extractDriveFolderId("https://drive.google.com/file/d/1abcDEFghij-1234/view") === "1abcDEFghij-1234");
t("open?id= 形式", extractDriveFolderId("https://drive.google.com/open?id=1abcDEFghij-1234") === "1abcDEFghij-1234");
t("文章に混ざっていても拾う", extractDriveFolderId("元データはこちら https://drive.google.com/drive/folders/1abcDEFghij-1234 です") === "1abcDEFghij-1234");
t("Drive以外のURLは空", extractDriveFolderId("https://example.com/drive/folders/1abcDEFghij-1234") === "");
t("URLでない文字列は空", extractDriveFolderId("元データは共有ドライブのどこかです") === "");
t("空入力は空", extractDriveFolderId("") === "" && extractDriveFolderId(undefined) === "");

section("14. V1-5 フォルダID対応表");
const brandKeys = Object.keys(DRIVE_BRAND_FOLDERS);
t("Notionの18選択肢＋旧CRAZY名の互換キー＝19件", brandKeys.length === 19);
t("すべてDriveのファイルID形式", brandKeys.every((k) => /^[A-Za-z0-9_-]{20,}$/.test(DRIVE_BRAND_FOLDERS[k])));
t("旧CRAZY名は現行と同じフォルダを指す（リネーム漏れの保険）",
  DRIVE_BRAND_FOLDERS["CRAZY｜全社周年・自社WEBサイト等に関する制作物"] ===
  DRIVE_BRAND_FOLDERS["CRAZY｜全社周年・全社会議・自社HP等に関する制作物"]);
t("相談フォルダIDはブランドと重複しない", !Object.values(DRIVE_BRAND_FOLDERS).includes(DRIVE_SOUDAN_FOLDER_ID));
t("フォルダIDに重複がない（互換キーの1件を除く）", new Set(Object.values(DRIVE_BRAND_FOLDERS)).size === 18);
t("サブフォルダは3点セット", JSON.stringify(DRIVE_SUBFOLDERS) === JSON.stringify(["01_支給素材", "02_作業データ", "03_納品データ"]));
t("サブフォルダ名は番号順に並ぶ", [...DRIVE_SUBFOLDERS].sort().join(",") === DRIVE_SUBFOLDERS.join(","));

section("14b. V1-5.6 種別フォルダ（棚）対応表");
const shelfKeys = Object.keys(DRIVE_TYPE_SHELVES);
t("棚は10種別すべてを持つ", shelfKeys.length === 10);
t("棚名は「数字_種別名」で始まる", shelfKeys.every((k) => DRIVE_TYPE_SHELVES[k].replace(/^\d+_/, "").startsWith(k)));
t("棚名の番号は01〜10で一意", new Set(shelfKeys.map((k) => DRIVE_TYPE_SHELVES[k].slice(0, 2))).size === 10);
t("先頭はイベント・キャンペーン", DRIVE_TYPE_SHELVES["イベント・キャンペーン"] === "01_イベント・キャンペーン");
t("その他の棚は（基本的に使用しない）付き", DRIVE_TYPE_SHELVES["その他"] === "10_その他（基本的に使用しない）");
t("旧名KV・アイキャッチは棚に無い", !("KV・アイキャッチ" in DRIVE_TYPE_SHELVES));
t("逆引き表がCRAZYのIDを正式名に解決する（互換キーに負けない）",
  DRIVE_FOLDER_TO_BRAND[DRIVE_BRAND_FOLDERS["CRAZY｜全社周年・全社会議・自社HP等に関する制作物"]] ===
  "CRAZY｜全社周年・全社会議・自社HP等に関する制作物");
t("逆引き表は18フォルダぶん", Object.keys(DRIVE_FOLDER_TO_BRAND).length === 18);

section("14b-2. V1-5.9 ツール製フォルダのKV記録（入れ子打ち止めの新方式）");
t("作成時にKVへ記録する（dfolder:<id>）", /createProjectFolderTree[\s\S]{0,900}?DFOLDER_KV_PREFIX/.test(src));
t("改訂フォルダは kaitei として親付きで記録", /\{ t: "kaitei", up: parentId \}/.test(src));
t("案件フォルダは project として記録", /\{ t: "project" \}/.test(src));
t("3点セットは sub として親付きで記録", /\{ t: "sub", up: folder\.id \}/.test(src));
t("KVへの記録失敗は握りつぶす（フォルダ作成を止めない）", /markFolder[\s\S]{0,200}?catch \{\}/.test(src));
t("引き上げ判定はKVを読む（getDfolderMark）", src.indexOf("getDfolderMark") !== -1);
t("KVに無いフォルダ（過去データ等）は引き上げない", /if \(!mark \|\| mark\.t === "project" \|\| !mark\.up\) break;/.test(src));

section("14c. V1-5.7 改訂の親フォルダ制限・略称の逆引き");
t("02_案件管理のルートIDを定数で持つ", /^[A-Za-z0-9_-]{20,}$/.test(DRIVE_KANRI_FOLDER_ID));
t("ルートIDは事業フォルダ・相談と重複しない",
  !Object.values(DRIVE_BRAND_FOLDERS).includes(DRIVE_KANRI_FOLDER_ID) && DRIVE_KANRI_FOLDER_ID !== DRIVE_SOUDAN_FOLDER_ID);
t("略称→正式名の逆引き（IWAI-婚礼）", brandFromShortName("IWAI-婚礼") === "IWAI-婚礼｜婚礼に関する制作物");
t("略称→正式名の逆引き（MT-the-Terrace）", brandFromShortName("MT-the-Terrace") === "MT-the-Terrace｜the Terraceに関する制作物");
t("未知の略称は空", brandFromShortName("存在しない部署") === "" && brandFromShortName("") === "");
t("18略称すべてが往復できる", Object.keys(DRIVE_BRAND_FOLDERS)
  .filter((b) => b !== "CRAZY｜全社周年・自社WEBサイト等に関する制作物")
  .every((b) => brandFromShortName(brandShortName(b)) === b));

section("15. V1-5.9 起票番号はNotionに書かない");
const propsSeq = buildNotionProperties({ title: "テスト", category: "新規", brand: "IWAI-婚礼｜婚礼に関する制作物", seqLabel: "no00007" });
t("旧seqLabelが紛れ込んでも起票番号プロパティを送らない", !("起票番号" in propsSeq));
const propsNoSeq = buildNotionProperties({ title: "テスト", category: "新規" });
t("通常データでも起票番号プロパティを送らない", !("起票番号" in propsNoSeq));
t("データ格納先は依頼者入力があるときだけ載せる", !("データ格納先" in propsNoSeq));

// ---- 16. ソース検査：V1-5 Drive連携 ----
section("16. ソース検査（V1-5 Drive連携）");
t("共有ドライブ対応（supportsAllDrives）", src.indexOf("supportsAllDrives=true") !== -1);
t("サービスアカウントのJWT Bearerフローを使う", src.indexOf("urn:ietf:params:oauth:grant-type:jwt-bearer") !== -1);
t("Driveのスコープを要求", src.indexOf("https://www.googleapis.com/auth/drive") !== -1);
t("秘密鍵はenvから読む（ソースに直書きしない）", src.indexOf("env.GOOGLE_SA_PRIVATE_KEY") !== -1);
t("秘密鍵の実体がソースに無い", src.indexOf("BEGIN PRIVATE KEY-----\\n") === -1 && src.indexOf("MIIE") === -1);
t("Drive失敗時も送信を止めない（createDriveFolderForRequestがthrowしない）",
  /async function createDriveFolderForRequest[\s\S]*?\n\}/.test(src) &&
  /createDriveFolderForRequest[\s\S]{0,5000}?catch \(e\) \{[\s\S]{0,120}?out\.reason/.test(src));
t("フォルダURLはNotionの「データ格納先」へ書き戻す", src.indexOf("patchNotionStorageUrl") !== -1);
t("相談はフラット配置（略称を先頭に付ける・番号なし）", /"\[" \+ brandShortName\(brand\) \+ "\]_" \+ safeTitle/.test(src));
t("新規・転用・改訂のフォルダ名はタイトルのみ", /createProjectFolderTree\(safeTitle, parentId, token, env/.test(src));
t("改訂の親解決は位置非依存（resolveKaiteiParent）", src.indexOf("resolveKaiteiParent") !== -1 && src.indexOf("resolveRevisionParent") === -1);
t("改訂の入れ子はKVの記録で引き上げる（2階層で止める）", /resolveKaiteiParent[\s\S]{0,1800}?getDfolderMark/.test(src));
t("改訂元は sourceUrls（フォームの設問名）を読む", src.indexOf("data.sourceUrls") !== -1);
t("改訂は親から事業を推定してNotionへ書き戻す", src.indexOf("inferBrandFromFolder") !== -1);
t("新規・転用は種別フォルダ（棚）に振り分ける", src.indexOf("resolveTypeShelf") !== -1);
t("転用の元URLは置き場所に使わない（改訂と旧種別のみ親解決）", !/category === "転用"[\s\S]{0,300}?resolveKaiteiParent/.test(src));
t("改訂でフォルダを作れなかったら本文に注記を残す", src.indexOf("appendNotionNote") !== -1);
t("棚は名前検索で解決し、無ければ正式名で作る", /resolveTypeShelf[\s\S]{0,900}?createDriveFolder\(canonical/.test(src));
t("改訂は送信前に親フォルダを検証する（V1-5.7事前チェック）", src.indexOf('code: "KAITEI_PARENT"') !== -1);
t("02_案件管理の外は400で弾く", /02_案件管理」の中にありません[\s\S]{0,200}?400/.test(src));
t("エラー文言で「転用」への切り替えを案内する", src.indexOf("依頼種別を「転用」にして") !== -1);
t("事前チェックはNotionページ作成より前に行う", src.indexOf('code: "KAITEI_PARENT"') < src.indexOf("await createNotionPage(data"));
t("相談フォルダ配下は略称から事業を引く", /inferBrandFromFolder[\s\S]{0,1200}?brandFromShortName/.test(src));
t("診断エンドポイント /drive/health がある", src.indexOf('"/drive/health"') !== -1);
t("診断は秘密鍵の中身を返さない（長さと有無のみ）", !/診断[\s\S]{0,3000}?pem\s*\}/.test(src) && src.indexOf("詳細: pem") === -1);
t("診断はテストフォルダを後片付けする", /_接続テスト[\s\S]{0,1200}?trashed: true/.test(src));
t("共有ドライブで権限不足になるDELETEを使わない", src.indexOf('method: "DELETE"') === -1);

// ---- 17. V1-5.8 起票高速化（応答後処理） ----
section("17. V1-5.8 buildImageBlocks（画像ブロックの切り出し）");
t("画像なし・失敗なしは空", buildImageBlocks({ ids: [], failed: 0 }).length === 0);
t("未定義でも空（null安全）", buildImageBlocks(undefined).length === 0);
const imgBlocks = buildImageBlocks({ ids: ["fu-1", "fu-2"], failed: 1 });
t("先頭は「参考画像」見出し", imgBlocks[0].type === "heading_2"
  && imgBlocks[0].heading_2.rich_text[0].text.content === "参考画像");
t("画像ブロックはfile_upload型で枚数ぶん", imgBlocks.filter(b => b.type === "image" && b.image.type === "file_upload").length === 2);
t("画像IDが順に引き継がれる", imgBlocks[1].image.file_upload.id === "fu-1" && imgBlocks[2].image.file_upload.id === "fu-2");
t("失敗注記が末尾に付く", imgBlocks[imgBlocks.length - 1].type === "paragraph"
  && JSON.stringify(imgBlocks).indexOf("失敗：1枚") !== -1);
t("失敗のみ（全滅）でも注記は出る", buildImageBlocks({ ids: [], failed: 3 }).length === 2);
t("buildNotionBlocks＝セクション＋画像の合成（作成時と追記時で構成が一致）",
  JSON.stringify(buildNotionBlocks(dataNew, { ids: ["fu-1"], failed: 0 })) ===
  JSON.stringify(buildNotionSectionBlocks(dataNew).concat(buildImageBlocks({ ids: ["fu-1"], failed: 0 }))));

section("18. ソース検査（V1-5.8 応答後処理＝waitUntil化・並列化）");
t("fetchがctxを受け取る", /async fetch\(request, env, ctx\)/.test(src));
t("応答後処理はctx.waitUntilに渡す", src.indexOf("ctx.waitUntil(finishSubmitInBackground") !== -1);
t("画像アップロードは並列（Promise.all・入力順を保持）", /async function uploadImagesToNotion[\s\S]{0,600}?Promise\.all\(/.test(src));
t("画像は応答後に本文へ追記する（appendImageBlocksToNotion）", src.indexOf("appendImageBlocksToNotion") !== -1);
t("追記はNotionの blocks/children API を使う", /appendImageBlocksToNotion[\s\S]{0,600}?\/v1\/blocks\//.test(src));
t("ページは画像なしで先に作る", src.indexOf("await createNotionPage(data, { ids: [], failed: 0 }, env)") !== -1);
t("改訂の事前チェックは同期のまま（waitUntilより前＝400で弾ける）",
  src.indexOf('code: "KAITEI_PARENT"') < src.indexOf("ctx.waitUntil("));
t("同期パスに採番処理が無い（V1-5.9で廃止）", src.indexOf("nextSeqNumber(") === -1);
t("冪等キーの保存は応答前（waitUntilより前）", src.indexOf('put("idem:') !== -1
  && src.indexOf('put("idem:') < src.indexOf("ctx.waitUntil("));
t("Driveフォルダ作成はバックグラウンド内", /finishSubmitInBackground[\s\S]*?createDriveFolderForRequest/.test(src));
t("後続処理は互いに独立して続行（Promise.allSettled）", src.indexOf("Promise.allSettled") !== -1);
t("画像の丸ごと失敗も本文に⚠️注記を残す", src.indexOf("参考画像の掲載に失敗") !== -1);
t("応答にdeferredの目印を持つ（後続処理は結果に含まれない）", src.indexOf("deferred: true") !== -1);
t("改訂のフォルダ作成失敗の注記も引き続き残す（バックグラウンド内）",
  /finishSubmitInBackground[\s\S]*?改訂元の親フォルダにアクセスできなかった/.test(src));

// ---- 結果 ----
console.log("\n============================");
console.log("合格 " + pass + " 件 ／ 不合格 " + fail + " 件");
if (fail > 0) process.exit(1);
console.log("全テスト合格 🎉");

# CREATIVE PROCESS — DESIGN.md（UIデザイン仕様書）

> **このファイルの役割**
> **UIデザインの正はFigma『CREATIVE PROCESS』**（`https://www.figma.com/design/paEvn9ugpEQoYRPBWF3fc6/CREATIVE-PROCESS`／セクション `27:3284`）。
> このファイルは **Figmaにない部分を補完するときの基準**であり、Figmaと食い違ったら**必ずFigmaが勝つ**。
> 見た目を変えるときはFigmaを先に直し、そこから反映する。コードだけを先に変えることはしない。

**扱う範囲**：色・タイポグラフィ・余白・角丸・影・コンポーネント・レイアウト・モーションといった**見た目のこと**。
**扱わない範囲**：設問構成・画面フロー・Worker／Notionのデータ設計は [`../SPEC.md`](../SPEC.md)、インフラ・セキュリティ・運用は Google Drive の `creative-process/開発/BRIEF.md`。

- 最終更新: 2026-08-11（Figma第3次改修のUI反映）
- 対象コード: `creative-process/index.html`
- 関連ファイル: [`tokens.json`](./tokens.json)（トークン定義）／[`components.json`](./components.json)（コンポーネント定義）

---

## 1. 前提ルール

1. **UIデザインの正はFigma。** 変更はFigma → コードの順。
2. **CUS（CRAZY UI SYSTEM）は取り込まない**（2026-07-27 決定・恒久）。明示的な許可がない限り、提案・検討候補としても挙げない。
3. **他ツール（print-check / revision-request / project-board）とのトーン統一はしない。** 「他ツールと見た目が揃わない」ことを変更の理由にしない。
4. **CSS変数名はFigmaのバリアブル名をそのまま写す。** 詳細は §3。
5. **アイコンの正はFigmaの書き出し** ＝ Google Drive `04_ツールボックス/creative-process/icon/`。Figmaで描き直したらこのフォルダを更新し、コードに写す。
6. **フォームは単一HTMLで完結させる。** 画像・アイコン・フォント以外の外部リソースを増やさない。

---

## 2. Figmaの構成

### ページ `design`（`0:1`）— 画面
セクション `CREATIVE PROCESS`（`27:3284`）配下に10フレーム（第3次改修・2026-08-11反映）。**これがすべて最新の正**。

| ノード | 名前 | 何を描いているか |
|---|---|---|
| `11:1715` | form | 初期表示。STEP1・2のみ、STEP3は非表示、送信ボタンは無効、依頼者は未ログイン ※STEP2だけ旧3カードのまま。正は各form-\*の4カード |
| `1:482` | form-new | 依頼種別＝新規。依頼者はログイン済み |
| `11:1981` | form-modify | 依頼種別＝改訂（タイトル→スケジュール→親フォルダURL→制作内容→添付） |
| `86:992` | form-reuse | 依頼種別＝転用（制作物の種別は8択） |
| `11:2264` | form-consult | 依頼種別＝相談（タイトルは「相談タイトル」） |
| `64:720` | error-message | 送信できないときのエラー表示 |
| `86:1919` | submit | 送信完了画面（絵文字ヒーロー＋Slack共有手順＋全幅ボタン2つ） |
| `86:1966` | submit-animation | 送信成功時のアニメーション（コンポーネント `86:2083`＝start / emoji-action / finish） |
| `52:2121` | popup 1 | 納期目安表モーダル（9項目・KV行なし） |
| `66:1077` | popup 2 | サイズ目安表モーダル（8項目・KV行なし） |

### ページ ` component`（`38:174`）— デザインシステム
| セクション | 中身 |
|---|---|
| btn | checkbox / close-circle / **radio-btn** / linktext / primary / secondary / tertiary / tertiary-leftcon / **tertiary-blue-leftcon** |
| card | check（廃止・radio に置換）/ **radio** / anchorlink |
| input | text / textarea / select / calendar / add / login |
| icono | add / calendar / check / close / extend / trg-down / **link** / loading |
| chip, logo | badge/required / logo-Notion / logo-url / logo-google-g |
| emoji | Laughing ほか16種（現行デザインで使うのは Laughing 😆 のみ） |
| submit-animation | start / emoji-action / finish（送信アニメーションのキーフレーム） |

各コンポーネントに default・hover・focus・select・disable・loading の状態が定義されている。**hover や focus を自分で考えず、必ずここを見る。**

---

## 3. トークンと CSS変数の命名

値の一覧は [`tokens.json`](./tokens.json) が正。ここでは方針だけ書く。

### 命名規則
Figmaのバリアブル名の `/` を `-` に置き換え、**名前空間を省略せずそのまま**CSS変数名にする。

| Figma | CSS変数 |
|---|---|
| `color/text/accent` | `--color-text-accent` |
| `color/btn/tertiary/border` | `--color-btn-tertiary-border` |
| `spacing/semantic/padding-page-x` | `--spacing-padding-page-x` |
| `radius/button-s` | `--radius-button-s` |

短縮しないのは、**Figmaの値が変わったときにどのCSS変数を直せばよいかを名前だけで機械的に特定できる**ようにするため。

### グラデーションと影
Figmaではグラデーションをバリアブルに登録できないため、`gradation/*` と `shadow/*` は**ローカルスタイル**（色スタイル／エフェクトスタイル）で管理している。
Figmaの読み取りAPIではバリアブルとして値が取れないので、**Figmaのスタイル編集パネルを直接見て転記する**。転記済みの値は `tokens.json` にある。

### アクセントカラーの使いどころ
`color/text/accent`（#0872b6）はページタイトル・リード文・STEP見出し・テキストリンク・アイコン・選択状態の4か所で共通。`color/bg/select` と `color/icon/blue` も同じ値だが、**役割が違うので変数は分けたまま使う**（片方だけ変えたくなったときに困らないように）。

---

## 4. 画面の骨格

```
body（背景 color/bg/default）
└ wrap（max-width 1280 / padding: padding-page-y padding-page-x）
  └ column（縦積み・gap: gap-head-offset）
    ├ header-area（gap: gap-head-group）
    │   h1 CREATIVE PROCESS（English/head-1・accent）
    │   p  リード文（Japanese/head-3・accent）
    └ section（gap: gap-section）
      ├ input-section（gap: gap-box）
      │   └ box ×n（白・radius-section・padding-box・gap-content）
      │       ├ section-header（STEP n ＋ 見出し）
      │       └ input ×n（gap-subhead-offset）
      │           ├ subhead-group（gap-subhead-group：ラベル＋必須バッジ／キャプション）
      │           └ コントロール
      ├ submit-section
      │   ├ btn/primary（親幅いっぱい・高さ64）
      │   ├ error-message（エラー時のみ）
      │   └ 案内文（Japanese/body・中央寄せ）
      └ footer（テキストリンク・中央寄せ）
```

設問1つ分の幅は **896px**（960 − padding-box × 2）。

---

## 5. コンポーネントの実装ルール

定義は [`components.json`](./components.json) が正。設計上おさえる点だけ挙げる。

### 5-1. 状態の対応
| Figmaの状態名 | CSSでの実装 |
|---|---|
| default | 既定 |
| hover | `:hover`。タッチデバイスで貼り付かないよう `@media (hover: hover)` で囲う |
| focus | `:focus-visible`（`:focus` ではない。マウスクリックでリングを出さないため） |
| select | `aria-pressed="true"` / `input:checked` |
| disable | `:disabled` |
| loading | `aria-busy="true"` ＋ `disabled` |

### 5-2. 選択状態の見せ方が2種類ある
- **依頼種別カード**（`card/anchorlink`）＝ **青ベタ塗り＋白文字**。4択から1つを選ぶので、選んだものを強く見せる。
- **制作物の種別**（`card/radio`）＝ **淡青の地＋1pxグレー枠＋ラジオON（青い内円）**。同系の選択肢から1つを選ぶが、依頼種別ほど強く見せない。

この違いは意図的なもの。**どちらかに揃えない。**

> 2026-08-11のUI改訂で `card/check`（チェックボックス）→ `card/radio`（ラジオボタン）に置き換えた。
> V1-5.6で単一選択になったため、コントロールの見た目も「1つを選ぶ」ものに揃えた（Figma第3次改修）。
> ラジオは **24px円＋1px枠**。選択時は枠が `color/btn/radio/default` になり、**16pxの内円**（枠から3px内側）が入る。

`card/radio` はラジオボタンと文字を **縦中央でそろえる**（`align-items: center`／間隔16px）。
補助テキストの有無で寄りが変わってしまうため、上そろえにしない。

### 5-2-1. フォーカスリング

Figmaの各コンポーネントの focus バリアントを**1ピクセルずつ実測**して転記した。推測で決めていない。
実装は `index.html` の「フォーカスリング」ブロック1か所に集約する（各コンポーネント側には書かない）。

#### A. 入力系 ─ 要素の見た目はそのまま、外側に淡青のリングが重なる

**2層構造**であることが要点。リングだけの1本線にしない。

```
[ 淡青 2px ][ グレー 1px ][ 地色 … ]
   ↑外側        ↑要素の境界線は残る
```

| 項目 | 値 | 出典 |
|---|---|---|
| リングの色 | `--color-input-focus` = **#d9e9f6** | `color/input/focus` |
| 広がり | **2px**（要素の直外・隙間なし） | 実測（例：`input/text` focus `38:610`） |
| ぼかし | **なし**（blur 0） | 実測。Figmaのリングは単色の線でエフェクトは付いていない |
| 要素の境界線 | **default/select 状態のまま残す** | 実測 |

```css
box-shadow: 0 0 0 2px var(--color-input-focus);
```

> ⚠️ 入力欄（`.ctl`）は **default では枠なし**だが、Figmaの focus バリアントでは **1px のグレー枠（`--color-input-border`）が加わる**。
> リングとは別に `:focus` で枠を足す。この枠を淡青で置き換えてはいけない。

**対象**：入力欄すべて（text / textarea / select / date）・`input/add`・`input/login`・依頼種別カード・制作物の種別カード（内部のラジオボタンにフォーカスが入ったらカードにリングを出す）

#### B. ボタン系 ─ 少し離して細い青の線が回る

```
[ 青 1px ][ 隙間 2px ][ 要素 … ]
```

| 項目 | 値 | 出典 |
|---|---|---|
| 線の色 | `--color-btn-primary-focus` / `-tertiary-focus` / `-secondary-focus` = **#0872b6** | 各コンポーネントの focusring レイヤー |
| 太さ | **1px** | 実測 |
| 要素からの距離 | **2px** | 実測（`btn/primary`・`btn/tertiary`・`btn/close-circle`・`btn/linktext` すべて同じ） |

```css
outline: 1px solid var(--color-btn-primary-focus);
outline-offset: 2px;
```

**対象**：送信ボタン・「別のアカウント」・テキストリンク・モーダルの閉じるボタン・画像サムネイルの削除ボタン

#### C. Figmaに focus バリアントがない要素

スケジュール行の×（丸なしの `icon/close`）・完了画面の2ボタン・本文中のリンクなど。

```css
outline: 2px solid var(--color-text-accent);   /* #0872b6 */
outline-offset: 2px;
```

これを `:focus-visible` の**既定**として先に置き、A・B で上書きする。

#### 守ること

- **ブラウザ既定のフォーカスリングは全面的に置き換える。** 既定のままの要素を残さない。
- **`outline: none` で消さない。** キーボード操作の人が現在地を見失う。A で `outline` を使わない場合も、`outline: 2px solid transparent` を残して強制配色モード（Windowsのハイコントラスト）での消失を防ぐ。
- **`:focus` ではなく `:focus-visible`** を使う（マウスクリックではリングを出さない）。
- 選択中・hover中の要素は `box-shadow` を別用途で使っていることがある。`box-shadow: none` でリングを打ち消さないよう、hover の影は `:not()` で選択中を除外して当てる。

### 5-3. 依頼者欄はログイン状態で2つの形をとる
| 状態 | 見た目 |
|---|---|
| 未ログイン | `input/login`。背景透明・1pxグレー枠・角丸8・高さ56。左にGoogleの4色Gマーク（24px）＋ gap 8 ＋「Googleでログインする」（Japanese/label-L・`color/text/sub`）、左寄せ |
| ログイン済み | `login-row-signed-in`。背景 `color/input/default`・角丸8・高さ76。左にログイン中のアカウント情報、右端に `btn/tertiary`「別のアカウント」（132×44） |

ログイン済み行にFigmaが置いているテキスト「Googleログイン情報を表示する」は**ダミー**。実装では検証済みトークンから取れた**氏名（Japanese/label-L・`color/text/default`）とメールアドレス（Japanese/caption・`color/text/sub`）を2行**で表示する。

### 5-4. 送信ボタン
- 幅は親いっぱい・高さ64・角丸16。
- 既定は `gradation/sunbeam-default`、hoverは `gradation/sunbeam-h-hover`。
- **必須項目が埋まるまでは disable**（`color/btn/primary/disable` のベタ塗り）。
- 送信中は loading 状態にし、ラベルの左でスピナーを回す。二重送信を防ぐため `disabled` も併用する。

### 5-4-1. 追加アクション行（`input/add`）
「＋日程を追加する」「＋画像を添付する」に使う。

- **塗りはなく、1pxの枠線だけ**。hover のときだけ淡青の地色になる。
- ラベルは**本文と同じウェイト400・`color/text/sub`**（ボタンだが太字にしない）。中央寄せ。
- 先頭の **「＋」は独立したアイコンではなく文字の一部**。`icon/add` は描画しない。
- ログインボタン（`input/login`）だけは**太字**で左寄せ。同じ枠線でも扱いが違う。

### 5-4-2. アイコンの表示サイズ
アイコンは素材としてはすべて24×24だが、**置き場所ごとに表示サイズが決まっている**。24pxで揃えない。

| 置き場所 | アイコン | 表示サイズ |
|---|---|---|
| プルダウンの右端 | `icon/trg-down` | **16px** |
| 日付欄の右端 | `icon/calendar` | **20px** |
| モーダルの閉じるボタン | `icon/close` | **16px**（24pxの円の中） |
| textareaの右下つまみ | `icon/extend` | **12px**（右下から4px。第3次改修で16px→12pxに縮小） |
| ログインボタン | `logo/google-g` | 24px |
| 完了画面「NotionのURLをコピー」 | `icon/link` | **24px**（第3次改修で新設。色は currentColor＝tertiary-blue の青） |
| 完了画面「Notionで編集」 | `logo/Notion` | 24px |

> `icon/check`（チェックボックス用20px）は card/check の廃止にともない未使用になった。マスク定義はコードに残っている。

### 5-4-3. 入力欄の高さと文字の縦位置

高さ64pxの内訳は **16（padding）＋ 32（line-height）＋ 16（padding）** で、Figmaの箱の計算そのまま。
ここに**枠線を `border` で足してはいけない**。上下で2px分の高さを食い、行ボックス32px＞コンテンツ領域30pxになって、
`select` の文字が `input` より1px下にずれる（ブラウザが `input` と `select` ではみ出し分の扱いを変えるため）。

そのため：

| 項目 | 実装 | 理由 |
|---|---|---|
| 既定の枠 | **なし**（`border: none`） | Figmaの default に枠はない |
| focus時の1pxグレー枠 | **`box-shadow: inset 0 0 0 1px`** | `border` と違い高さを食わないので、フォーカスしても文字が動かない |
| フォーカスリング | `box-shadow: 0 0 0 2px`（inset側と同時指定） | §5-2-1 |
| 上下padding | **上15px / 下17px**（合計は32pxのまま） | 光学調整。下記 |

**上下paddingの光学調整（上15 / 下17）**
Noto Sans JP はアセンダ側が厚く、16/16 で素直に置くと文字の外接矩形の中心が枠の中心より **1px下** に出る。
上を1px減らして下を1px増やすと、`input`・`select` とも**ずれ0px**（実測）になる。合計32pxは変えないので高さ64pxは維持される。

> 測り方：`input` と `select` を同じ幅で縦に並べて描画し、文字のある画素行の上端・下端から中心を求め、枠の中心と比べる。
> 調整前 = `input` +1.0px / `select` +2.0px（2つの間で1pxずれる）、調整後 = **両方とも 0.0px**。

日付欄のプレースホルダ（`.date-ph`）は絶対配置で中央に置いているため、上の調整に合わせて `margin-top: -1px` で行を揃える。

### 5-5. エラーメッセージ
- 送信ボタンの**直下**、案内文の**上**に差し込む。幅は送信ボタンと同じ。
- 背景 `color/warning/bg`／文字 `color/warning/text`／`Japanese/label-L`／角丸8／padding 24・32。
- `role="alert"` を付ける。複数のエラーは1つの枠の中に改行で並べる。
- エラーがないときは要素ごと消す（高さを持たせない）。

---

## 6. モーション

Figmaに定義がないため、以下はコード側で決めた値。`tokens.json` の `motion` に記載。

| 用途 | 値 | 決めた理由 |
|---|---|---|
| 送信アニメーション（`submit-animation`） | グラデーション立ち上がり **0.45s**（clip-pathを下から開く）→ 絵文字ポップ **0.5s**（0.35s遅延・バウンス係数 cubic-bezier(.34,1.4,.64,1)）→ タイトル・サブタイトルのスライドアップ **各0.45s**（0.5s / 0.65s遅延）→ **2.2s後にフェードアウト0.4s** で完了画面が現れる | Figmaはstart / emoji-action / finishの3コマだけで時間が決まっていない。覆い切った直後（0.5s）に背面を完了画面へ差し替え、読める時間（約1.7秒）だけ全画面表示を保ってから引く。`prefers-reduced-motion` ではアニメーションを流さず即座に完了画面へ |
| 送信中スピナーの回転 | **1秒で1回転・linear・無限ループ** | Figmaは0/25/50/75の4コマだけで速度が決まっていない。速すぎると焦りを煽り、遅すぎると止まって見える。1秒/回転はOSの標準的なスピナーと同程度で、4コマ表現とも整合する（1コマ0.25秒）。コマ送りではなくCSSの連続回転で実装する |
| 背景色・枠線・影の変化 | 150ms・ease-out | クリック感を損なわない範囲でいちばん短い値 |
| STEP3へのスクロール | `scroll-behavior: smooth` | どこへ飛んだか分かるようにする |

**`prefers-reduced-motion: reduce` のときは、遷移を0msに、スクロールを `auto` にする。スピナーだけは回転を止めず、代わりに1回転4秒まで遅くする**（処理中であることが伝わらなくなるため完全には止めない）。

---

## 7. レスポンシブ

**Figmaはデスクトップ1280px幅の1本のみ。以下はコード側で決めた設計。** Figmaにモバイル版が起こされたら、そちらを正にしてこの節を破棄する。

ブレークポイントは **768px の1段だけ**。

### 768px以下での縮退
| 項目 | 1280px時 | 768px以下 |
|---|---|---|
| `--spacing-padding-page-x` | 160px | 16px |
| `--spacing-padding-page-y` | 64px | 32px |
| `--spacing-gap-head-offset` | 80px | 40px |
| `--spacing-gap-section` | 64px | 40px |
| `--spacing-padding-box` | 32px | 20px |
| `--typo-size-head-1` | 40px | 32px |
| `--typo-size-head-3` | 24px | 18px |
| 依頼種別カード | 3列 | **1列**（縦積み・gap 16px） |
| 制作物の種別 | 2列 | **1列** |
| スケジュール行 | 日付＋内容＋× の横並び | **日付と内容を縦積み**にし、削除ボタンは行の右上に置く |
| 完了画面の2ボタン | 全幅で縦積み（第3次改修でデスクトップも縦積みに変更） | 同じ（変化なし） |
| モーダル | 幅784px固定 | 幅は画面 − 32px、高さは最大 90vh でスクロール |

縮退は**CSS変数を上書きする方式**で行う。個別のセレクタに直接 px を書かない（Figma側の値が変わったときに追従できなくなるため）。

タップ領域は最小44×44pxを確保する。

---

## 8. アイコン運用

- `creative-process/icon/` のアイコンはすべて**純ベクター**で、合計約4.7KB。ラスタ埋め込みはない。**SVGOなどの軽量化は不要**。
- `syymbol_notion.svg` 以外はIllustrator書き出しで **`fill` 属性を持たない**（＝黒固定）。
  → **インラインSVG化して `fill="currentColor"` を付ける。** 色はCSS変数で制御する。
- 多色のロゴ（`syymbol_notion.svg`／`syymbol_google.png`）は `currentColor` 化しない。そのまま埋め込む。
- `syymbol_google.png` は原寸2820×2820px・約138KB。表示は24pxなので、**96×96pxへ縮小してからdata URI化する**（原寸はGoogle Driveにマスターとして残す）。
- `icon/extend` は **textareaの右下のリサイズハンドル**として使う。`resize: vertical` と併用し、つまみの見た目だけアイコンで置き換える。
- `logo/url` は書き出さない。完了画面のコピーボタンは `icon/link`（`86:2304`）を使う（第3次改修で絵文字🔗から変更）。
  `icon/link` はFigmaのMCPエクスポートから取得したパスをマスク化してコードに埋め込み済み。他アイコンと同じくG-Driveの `icon/` にもマスターを置くこと（未書き出しならFigmaからSVGエクスポートする）。
- `icon/add` は**コードでは描画しない**。「＋日程を追加する」などの先頭の「＋」はFigma上も文字だから（§5-4-1）。
- 表示サイズは置き場所ごとに違う（§5-4-2）。素材が24pxだからといって24pxで置かない。
- **絵文字はNoto Animated Emoji（Google Fonts CDN）が正**（2026-08-11確定）。Figmaのemojiセクション16種と同じ素材を
  `fonts.gstatic.com` から直接読み込む（既にフォントで依存しているCDNなので新しい依存先は増えない）。
  送信ごとに16種からランダムに1種を選び、完了画面64px・送信アニメーション104pxに同じものを表示。
  WebP（100〜300KB程度）→GIF→Unicode絵文字の順でフォールバック。リポジトリにファイルは置かない。
- **ファビコンは🌟**（SVGデータURIのテキスト絵文字）。✅は別ツールで使うためこのツールでは使わない。

---

## 9. 日付欄の見た目

- **未入力のあいだは今日の日付をプレースホルダとして表示し、実値は空にしておく。** 誤って今日が希望納品日として登録されるのを防ぐため。
- 既定値として今日を入れたい場合は `initDateField` 内のコメント行を1行有効化すれば切り替わる。
- **入力後の表示形式（yyyy/mm/dd）はブラウザのロケール依存で、CSSからは変えられない。**
- ネイティブのカレンダーアイコンは隠し、`icon/calendar` を右端に置く。欄のどこをクリックしてもピッカーが開くようにする。

---

## 10. Figmaに定義がなく、コード側で決めた仕様

| 対象 | 決めた内容 |
|---|---|
| 添付画像のサムネイル一覧 | `input/add` の直下に、96×96pxのサムネイルを gap 8px で折り返し配置。`object-fit: cover`／角丸8／背景 `color/bg/default`。各サムネイルの右上に `btn/close-circle` を重ね、クリックでその1枚だけを選択から外す。ファイル名は表示せず `title` 属性で補う。1枚も選ばれていないときは領域ごと非表示 |
| モーダルの操作 | ×ボタン／背面クリック／Escキーで閉じる。開いている間はフォーカスをモーダル内に閉じ込め、閉じたら開いたボタンへフォーカスを戻す。背面のスクロールは止める |
| モーダルの影の当て方 | `shadow/modal` は**白いパネルにだけ**掛ける。外側のラッパーに `filter: drop-shadow` を掛けると、パネルの外に置いた閉じるボタンにも影がついてしまう |
| フォントのフォールバック | 和文 `'Hiragino Kaku Gothic ProN', -apple-system, BlinkMacSystemFont, sans-serif`／欧文 `-apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif` |
| スクロールバー | 幅8px・つまみ `#c9c9c9`（hoverで `#b0b0b0`）・角丸4px。トラックは透明 |
| 選択範囲のハイライト | 背景 `color/bg/select`／文字 `color/text/white` |
| ボタン以外のdisable表現 | 送信ボタン以外にdisable状態を持たせない（必要な操作は常に押せる状態にしておく） |

---

## 11. 未解決事項

| # | 内容 | 状態 |
|---|---|---|
| 1 | ~~モーダル内のコピーだけ旧バリアブルを参照~~ → 差し替え済み（2026-08-01） | 解決 |
| 2 | ~~Googleログインボタンが `input/add` と同名~~ → `input/login` に改名済み（2026-08-01） | 解決 |
| 3 | ~~依頼者欄のラベルが画面ごとに不統一~~ → 統一済み（2026-08-01） | 解決 |
| 4 | `btn/secondary`・`btn/tertiary/leftcon` はどの画面にも置かれていない（デザインシステム上の定義だけがある） | 使う場面ができたら components.json の定義に従って実装する |

---

## 12. 変更履歴

| 日付 | 内容 |
|---|---|
| 2026-08-11 | 追補：①STEP1ログイン欄キャプション・依頼種別4カードのサブテキストをFigmaの最新文言へ追従 ②`btn/linktext` の下線を2px→**1px**（Figma underbar h-px 実測） ③送信中スピナーを24px→**16px**・地色を `gradation/sunbeam-h-hover` に（Figma btn/primary loading 64:783 実測） ④`icon/link` をG-Drive `icon/link.svg`（Illustrator書き出し）のパスに同期 ⑤絵文字をNoto Animated Emoji（CDN直リンク・16種ランダム・😆フォールバック付き）に変更 ⑥ファビコン🌟を追加 |
| 2026-08-11 | Figma第3次改修のUI反映。①制作物の種別を `card/check`→`card/radio`（＋`btn/radio-btn`）に置換 ②STEP2依頼種別カードを4枚構成の寸法（gap16・角丸8・padding 16/24）に変更 ③完了画面を全面刷新（絵文字ヒーロー・箇条書きの共有手順・`btn/tertiary-blue/leftcon`「NotionのURLをコピー」＋`btn/tertiary/leftcon`「Notionで編集」の全幅縦積み） ④送信アニメーション新設（`submit-animation`） ⑤`icon/link` 新設・`icon/extend` を12pxに縮小 ⑥`btn/tertiary` のラベルを label-M 12px に修正 ⑦納期・サイズ目安表からKV・アイキャッチ行を削除し文言をFigmaへ追従 |
| 2026-08-01 | 新規作成。Figmaのコンポーネントページ新設にあわせ、トークン・コンポーネント・状態定義を全面的に整理 |
| 2026-08-01 | フォーカスリングの2系統・アイコンの表示サイズ・`input/add` の扱い・`card/check` の選択表現とそろえ方・モーダルの影の当て方を追記 |

"""
notify.py — Notion タスクボード → Slack 毎朝通知スクリプト
GitHub Actions から呼び出されます。直接実行しないでください。
"""

import os
import sys
import requests
from datetime import datetime, timedelta, timezone

# ── 環境変数（GitHub Secrets から受け取る） ──────────────────────────
NOTION_TOKEN = os.environ["NOTION_TOKEN"]
NOTION_DB_ID = os.environ["NOTION_DB_ID"]
SLACK_WEBHOOK = os.environ["SLACK_WEBHOOK"]

# ── 日付の準備 ────────────────────────────────────────────────────────
JST = timezone(timedelta(hours=9))
today = datetime.now(JST).date()
week_end = today + timedelta(days=7)

WEEKDAY_JA = ["月", "火", "水", "木", "金", "土", "日"]
PRIO_EMOJI  = {"高": "🔴", "中": "🟡", "低": "🟢"}


# ── Notion からタスクを取得 ───────────────────────────────────────────
def query_notion():
    url = f"https://api.notion.com/v1/databases/{NOTION_DB_ID}/query"
    headers = {
        "Authorization": f"Bearer {NOTION_TOKEN}",
        "Notion-Version": "2022-06-28",
        "Content-Type": "application/json",
    }
    # 納期が7日以内 かつ 完了していない タスクを取得
    body = {
        "filter": {
            "and": [
                {"property": "納期", "date": {"on_or_before": week_end.isoformat()}},
                {"property": "納期", "date": {"is_not_empty": True}},
                {"property": "ステータス", "select": {"does_not_equal": "完了"}},
            ]
        },
        "sorts": [{"property": "納期", "direction": "ascending"}],
        "page_size": 100,
    }
    res = requests.post(url, headers=headers, json=body)
    res.raise_for_status()
    return res.json()["results"]


# ── ページデータをタスク辞書に変換 ───────────────────────────────────
def parse_task(page):
    pr = page["properties"]

    title_list = pr.get("タスク名", {}).get("title", [])
    title = title_list[0].get("plain_text", "（無題）") if title_list else "（無題）"

    due_raw   = (pr.get("納期",    {}).get("date")   or {})
    prio_raw  = (pr.get("優先度",  {}).get("select") or {})
    status_raw= (pr.get("ステータス",{}).get("select") or {})
    dept_raw  = (pr.get("担当部署",{}).get("select") or {})
    assignees = pr.get("担当者", {}).get("multi_select", [])

    due_str  = due_raw.get("start", "")
    due_date = datetime.strptime(due_str, "%Y-%m-%d").date() if due_str else None

    return {
        "title":     title,
        "due":       due_date,
        "priority":  prio_raw.get("name", ""),
        "status":    status_raw.get("name", ""),
        "assignees": [a["name"] for a in assignees],
        "dept":      dept_raw.get("name", ""),
    }


# ── タスク1件を Slack mrkdwn テキストに整形 ──────────────────────────
def format_task(task):
    prio_e = PRIO_EMOJI.get(task["priority"], "⚪")
    dept   = f"[{task['dept']}] " if task["dept"] else ""
    d      = task["due"]

    if d is None:
        due_label = ""
    elif d < today:
        due_label = f"⚠️ {(today - d).days}日超過"
    elif d == today:
        due_label = "📅 *今日*"
    else:
        diff = (d - today).days
        due_label = f"📅 {d.strftime('%m/%d')}({WEEKDAY_JA[d.weekday()]}) 残{diff}日"

    assignees_str = " ・ ".join(task["assignees"]) if task["assignees"] else ""
    meta = " ｜ ".join(filter(None, [due_label, assignees_str]))

    line = f"{prio_e} {dept}{task['title']}"
    if meta:
        line += f"\n　　{meta}"
    return line


# ── Slack に送信 ─────────────────────────────────────────────────────
def send_to_slack(tasks):
    overdue   = [t for t in tasks if t["due"] and t["due"] < today]
    today_due = [t for t in tasks if t["due"] and t["due"] == today]
    week_due  = [t for t in tasks if t["due"] and today < t["due"] <= week_end]

    date_label = f"{today.strftime('%m月%d日')}({WEEKDAY_JA[today.weekday()]})"
    total = len(overdue) + len(today_due) + len(week_due)

    blocks = [
        {
            "type": "header",
            "text": {"type": "plain_text", "text": f"📋 タスク通知 ｜ {date_label}", "emoji": True},
        },
        {"type": "divider"},
    ]

    # 期限超過
    if overdue:
        lines = "\n".join(format_task(t) for t in overdue)
        blocks.append({
            "type": "section",
            "text": {"type": "mrkdwn", "text": f"*⚠️ 期限超過 ({len(overdue)}件)*\n{lines}"},
        })
        blocks.append({"type": "divider"})

    # 本日期限
    if today_due:
        lines = "\n".join(format_task(t) for t in today_due)
        blocks.append({
            "type": "section",
            "text": {"type": "mrkdwn", "text": f"*⚡ 本日期限 ({len(today_due)}件)*\n{lines}"},
        })
    else:
        blocks.append({
            "type": "section",
            "text": {"type": "mrkdwn", "text": "*⚡ 本日期限*\nなし ✅"},
        })
    blocks.append({"type": "divider"})

    # 今後7日間
    if week_due:
        lines = "\n".join(format_task(t) for t in week_due)
        blocks.append({
            "type": "section",
            "text": {"type": "mrkdwn", "text": f"*📆 今後7日間 ({len(week_due)}件)*\n{lines}"},
        })
    else:
        blocks.append({
            "type": "section",
            "text": {"type": "mrkdwn", "text": "*📆 今後7日間*\nなし"},
        })

    blocks.append({
        "type": "context",
        "elements": [
            {"type": "mrkdwn", "text": f"完了済みを除く合計 {total}件 ｜ Notion タスクボード自動通知"}
        ],
    })

    res = requests.post(SLACK_WEBHOOK, json={"blocks": blocks})
    res.raise_for_status()
    print(f"✅ 送信完了：期限超過{len(overdue)}件 / 本日{len(today_due)}件 / 今週{len(week_due)}件")


# ── メイン ───────────────────────────────────────────────────────────
if __name__ == "__main__":
    try:
        pages = query_notion()
        tasks = [parse_task(p) for p in pages]
        send_to_slack(tasks)
    except Exception as e:
        print(f"❌ エラー: {e}", file=sys.stderr)
        sys.exit(1)

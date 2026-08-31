# 一億作戰 · 財經簡報系統

自動抓台股/幣價/新聞 → Claude 判讀「今天該不該動」→ 前端遊戲頁顯示。

## 檔案
- `worker.js` — Cloudflare Worker（Cron 抓資料 + 判讀 + API）
- `wrangler.toml` — 設定（cron、KV、模型）
- `dashboard.html` — 前端遊戲頁（fetch Worker，抓不到用保底快照）

---

## 部署（約 10 分鐘）

### 1. 建立 KV
```bash
wrangler kv namespace create BRIEFING
```
把回傳的 `id` 貼進 `wrangler.toml` 的 `id = "..."`。

### 2. 設定 Secrets
```bash
wrangler secret put ANTHROPIC_API_KEY   # 貼你的 Anthropic 金鑰（有才會做 AI 判讀）
wrangler secret put REFRESH_TOKEN        # 自己設一組字串，保護手動刷新（可選）
```
> 不設 ANTHROPIC_API_KEY 也能跑 —— 會用「規則式判讀」（緩衝未建好 → 一律建議防守），一樣誠實可用。

### 3. 部署
```bash
wrangler deploy
```
部署後會拿到網址，例如 `https://finance-briefing.你的子網域.workers.dev`。

### 4. 測一下
```bash
# 手動觸發一次抓取（若有設 token 就帶上）
curl -X POST "https://finance-briefing.你的子網域.workers.dev/api/refresh?token=你的REFRESH_TOKEN"

# 讀最新簡報
curl "https://finance-briefing.你的子網域.workers.dev/api/briefing"
```

### 5. 接前端
打開 `dashboard.html`，最上面改兩行：
```js
const API_BASE = 'https://finance-briefing.你的子網域.workers.dev';
const REFRESH_TOKEN = '你剛剛設的token';  // 沒設就留空 ''
```
丟到 Vercel（或任何靜態空間）就上線。頁面裡的「刷新」按鈕會呼叫 `/api/refresh`。

---

## Cron 時間（`wrangler.toml`，UTC）
- `0 6 * * *` → 台北 14:00，台股收盤後
- `0 0 * * *` → 台北 08:00，美股隔夜後
需要更頻繁就自己加。

## 資料源
- 幣價：CoinGecko（免金鑰）
- 台股加權：TWSE OpenAPI（收盤後才有當日數；欄位若對不到，看 `fetchTaiex()` 的彈性比對，必要時微調）
- 新聞：Google News RSS（穩定、可改查詢字串 `NEWS_QUERIES`）

## 判讀鐵律（寫死在 worker.js 的 prompt）
1. 預備金優先，緩衝未達 2 個月前預設「不進場」
2. 絕不建議借錢買股/幣等波動資產
3. 事業才是最大引擎
4. 不是持照理財顧問，不給個股買賣點

## 之後可加
- 台股個股/ETF 報價（0050、台積電）
- 每日把 verdict 推到 LINE Notify / Threads
- 依「當前資產」動態調整任務難度（前端已存 assets，可傳給 Worker）

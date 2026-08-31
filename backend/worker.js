/**
 * 一億作戰 · 財經簡報 Worker
 * - Cron 每天定時抓：加密貨幣(CoinGecko) + 台股加權(TWSE OpenAPI) + 新聞(Google News RSS)
 * - 丟給 Claude API 判讀成「今天該不該動」的 verdict（鐵律已寫死在 prompt）
 * - 存進 KV，前端遊戲頁 fetch /api/briefing
 *
 * 綁定需求（wrangler.toml）：
 *   KV：BRIEFING
 *   Secret（可選，但建議）：ANTHROPIC_API_KEY  → 有才會做 AI 判讀，沒有就用規則式判讀
 *   Secret（可選）：REFRESH_TOKEN  → 保護手動刷新端點
 *   Var（可選）：MODEL  → 預設 claude-haiku-4-5-20251001
 */

const NEWS_QUERIES = [
  '台股 OR 台積電 OR 加權指數',
  'Fed OR 美股 OR 通膨 財經',
];

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(buildAndStore(env));
  },

  async fetch(request, env) {
    const url = new URL(request.url);
    const cors = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    };
    if (request.method === 'OPTIONS') return new Response(null, { headers: cors });

    try {
      if (url.pathname === '/api/briefing') {
        const cached = await env.BRIEFING.get('briefing:latest');
        if (cached) {
          return new Response(cached, { headers: { ...cors, 'Content-Type': 'application/json; charset=utf-8' } });
        }
        const fresh = await buildAndStore(env); // 第一次沒快取就即時建
        return json(fresh, cors);
      }

      if (url.pathname === '/api/refresh' && request.method === 'POST') {
        const token = url.searchParams.get('token');
        if (env.REFRESH_TOKEN && token !== env.REFRESH_TOKEN) {
          return json({ error: 'unauthorized' }, cors, 401);
        }
        const fresh = await buildAndStore(env);
        return json(fresh, cors);
      }

      if (url.pathname === '/') {
        return new Response('finance-briefing worker OK · ' + taipeiNow(), { headers: cors });
      }
      return json({ error: 'not found' }, cors, 404);
    } catch (err) {
      return json({ error: String(err && err.message || err) }, cors, 500);
    }
  },
};

/* ---------- 主流程 ---------- */

async function buildAndStore(env) {
  const [crypto, taiex, news] = await Promise.all([
    fetchCrypto(),
    fetchTaiex(),
    fetchNews(),
  ]);

  const market = { crypto, taiex };
  const verdict = await judge(env, market, news);

  const briefing = {
    date: taipeiDate(),
    generated_at: taipeiNow(),
    market,
    news: news.slice(0, 6),
    verdict,
    source_note: '幣價 CoinGecko · 台股 TWSE OpenAPI · 新聞 Google News RSS',
  };

  const body = JSON.stringify(briefing);
  await env.BRIEFING.put('briefing:latest', body);
  await env.BRIEFING.put('briefing:' + briefing.date, body, { expirationTtl: 60 * 60 * 24 * 90 });
  return briefing;
}

/* ---------- 資料源 ---------- */

// 加密貨幣：CoinGecko 免費、免金鑰
async function fetchCrypto() {
  try {
    const r = await fetch(
      'https://api.coingecko.com/api/v3/simple/price?ids=bitcoin,ethereum&vs_currencies=usd&include_24hr_change=true',
      { headers: { accept: 'application/json' } }
    );
    if (!r.ok) return null;
    const d = await r.json();
    return {
      btc: d.bitcoin ? { usd: d.bitcoin.usd, chg: round2(d.bitcoin.usd_24h_change) } : null,
      eth: d.ethereum ? { usd: d.ethereum.usd, chg: round2(d.ethereum.usd_24h_change) } : null,
    };
  } catch (_) {
    return null;
  }
}

// 台股加權：TWSE OpenAPI（收盤後才有當日數）
async function fetchTaiex() {
  try {
    const r = await fetch('https://openapi.twse.com.tw/v1/exchangeReport/MI_INDEX', {
      headers: { accept: 'application/json' },
    });
    if (!r.ok) return null;
    const arr = await r.json();
    if (!Array.isArray(arr)) return null;
    // 找「發行量加權股價指數」那一列，欄位名稱可能因 API 版本略有差異，做彈性比對
    const row = arr.find((x) => {
      const name = x['指數'] || x['指數名稱'] || x.name || '';
      return String(name).includes('發行量加權股價指數');
    });
    if (!row) return null;
    const close = pickNum(row, ['收盤指數', '收盤', 'closing_index', 'close']);
    const chgPct = pickNum(row, ['漲跌百分比', '漲跌幅', 'change_pct']);
    const chgPt = pickNum(row, ['漲跌點數', '漲跌', 'change']);
    const dir = (row['漲跌(+/-)'] || row['漲跌'] || '').toString();
    const sign = dir.includes('-') ? -1 : 1;
    return {
      close,
      chg_pct: chgPct != null ? sign * Math.abs(chgPct) : null,
      chg_pt: chgPt != null ? sign * Math.abs(chgPt) : null,
    };
  } catch (_) {
    return null;
  }
}

// 新聞：Google News RSS（穩定、可查詢、伺服器端抓沒有 CORS 問題）
async function fetchNews() {
  const out = [];
  for (const q of NEWS_QUERIES) {
    try {
      const u =
        'https://news.google.com/rss/search?q=' +
        encodeURIComponent(q) +
        '&hl=zh-TW&gl=TW&ceid=TW:zh-Hant';
      const r = await fetch(u, { headers: { 'user-agent': 'Mozilla/5.0' } });
      if (!r.ok) continue;
      const xml = await r.text();
      const items = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].slice(0, 4);
      for (const m of items) {
        const block = m[1];
        const title = decodeXml(pick(block, /<title>([\s\S]*?)<\/title>/));
        const link = decodeXml(pick(block, /<link>([\s\S]*?)<\/link>/));
        if (title) out.push({ title, link });
      }
    } catch (_) {
      /* 略過失敗的來源 */
    }
  }
  // 去重
  const seen = new Set();
  return out.filter((n) => (seen.has(n.title) ? false : (seen.add(n.title), true)));
}

/* ---------- 判讀（Claude API，鐵律寫死） ---------- */

async function judge(env, market, news) {
  // 沒設金鑰 → 規則式保底判讀（依然誠實、可用）
  if (!env.ANTHROPIC_API_KEY) return ruleVerdict(market);

  const model = env.MODEL || 'claude-haiku-4-5-20251001';
  const sys =
    '你是一位謹慎的財經簡報助手，服務對象是一位台灣創業者：經營三條事業線、固定月領約 4 萬、目前緊急預備金接近 0 正在重建、有車貸、長期目標一億。' +
    '鐵律（不可違反）：①預備金優先，緩衝未達 2 個月前，預設動作就是「不進場、繼續建防守」。②絕不建議借錢買股票或加密貨幣等波動資產。③事業才是最大引擎，不是盤或幣。④你不是持照理財顧問，不給個股買賣點。' +
    '根據當日市場數據與新聞，輸出「純 JSON」（不要任何說明文字、不要 markdown），格式：' +
    '{"light":"red|amber|green","headline_zh":"一句話當日重點","action_zh":"對這位用戶今天的具體動作","reasoning_zh":"2-3句理由","focus_zh":"今天該把力氣放哪(通常是紀律或事業)"}。' +
    'light 判定：緩衝未建好時，涉及進場/加碼一律 red 或 amber，green 僅用於「純執行紀律、與市場無關」的日子。';

  const userMsg =
    '市場數據：' + JSON.stringify(market) + '\n新聞標題：' + JSON.stringify(news.slice(0, 6).map((n) => n.title));

  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model,
        max_tokens: 600,
        system: sys,
        messages: [{ role: 'user', content: userMsg }],
      }),
    });
    if (!r.ok) return ruleVerdict(market);
    const d = await r.json();
    const text = (d.content || [])
      .filter((b) => b.type === 'text')
      .map((b) => b.text)
      .join('')
      .trim();
    const clean = text.replace(/```json|```/g, '').trim();
    const parsed = JSON.parse(clean);
    // 安全網：不論模型回什麼，若 light 是 green 但緩衝邏輯上不該進場，仍由前端顯示紀律導向；此處僅信任結構
    return {
      light: ['red', 'amber', 'green'].includes(parsed.light) ? parsed.light : 'amber',
      headline_zh: parsed.headline_zh || '今日重點',
      action_zh: parsed.action_zh || '繼續建防守，不進場。',
      reasoning_zh: parsed.reasoning_zh || '',
      focus_zh: parsed.focus_zh || '紀律與事業',
      by: 'claude',
    };
  } catch (_) {
    return ruleVerdict(market);
  }
}

// 規則式保底：沒有 LLM 也能給誠實判讀
function ruleVerdict(market) {
  const btcChg = market && market.crypto && market.crypto.btc ? market.crypto.btc.chg : null;
  const taiexChg = market && market.taiex ? market.taiex.chg_pct : null;
  const bits = [];
  if (taiexChg != null) bits.push('台股' + (taiexChg >= 0 ? '漲' : '跌') + Math.abs(taiexChg) + '%');
  if (btcChg != null) bits.push('BTC 24h ' + (btcChg >= 0 ? '+' : '') + btcChg + '%');
  return {
    light: 'red',
    headline_zh: bits.join('、') || '市場資料更新',
    action_zh: '緩衝尚未建好 → 今天不進場任何資產，先執行「先存再花」。',
    reasoning_zh: '無論市場漲跌，你目前最缺的是安全網。市場波動不改變今天的正確動作：把每月結餘接住。',
    focus_zh: '紀律與事業（你的最大引擎）',
    by: 'rule',
  };
}

/* ---------- 小工具 ---------- */

function pick(s, re) {
  const m = s.match(re);
  return m ? m[1].trim() : '';
}
function pickNum(obj, keys) {
  for (const k of keys) {
    if (obj[k] != null && obj[k] !== '') {
      const n = parseFloat(String(obj[k]).replace(/[,\s%]/g, ''));
      if (!isNaN(n)) return n;
    }
  }
  return null;
}
function round2(n) {
  return n == null ? null : Math.round(n * 100) / 100;
}
function decodeXml(s) {
  return String(s)
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .trim();
}
function json(obj, cors, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { ...cors, 'Content-Type': 'application/json; charset=utf-8' },
  });
}
function taipeiNow() {
  return new Date().toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' });
}
function taipeiDate() {
  const d = new Date().toLocaleString('en-CA', { timeZone: 'Asia/Taipei' });
  return d.slice(0, 10); // YYYY-MM-DD
}

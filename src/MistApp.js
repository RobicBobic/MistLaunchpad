import React, { useEffect, useRef, useState, useCallback } from 'react';
import { createChart, CandlestickSeries } from 'lightweight-charts';
import './MistApp.css';

/* ══════════════════════════════════════════════
   UTILITIES
══════════════════════════════════════════════ */
const fmtMC = v => {
  if (!v) return '$0';
  if (v >= 1e6) return `$${(v / 1e6).toFixed(2)}M`;
  if (v >= 1e3) return `$${(v / 1e3).toFixed(1)}K`;
  return `$${v.toFixed(0)}`;
};
const fmtAgo = ts => {
  if (!ts) return '—';
  const s = Math.floor((Date.now() - ts * 1000) / 1000);
  if (s < 60)    return `${s}s`;
  if (s < 3600)  return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
};
const fmtPrice = p => {
  if (!p) return '$0';
  if (p < 0.000001) return `$${p.toExponential(2)}`;
  if (p < 0.001)    return `$${p.toFixed(8)}`;
  if (p < 1)        return `$${p.toFixed(6)}`;
  return `$${p.toFixed(4)}`;
};
const normalizeImg = uri => {
  if (!uri) return null;
  if (uri.startsWith('http') && !uri.includes('/ipfs/')) return uri;
  const m = uri.match(/\/ipfs\/(.+)/);
  if (m) return `https://cf-ipfs.com/ipfs/${m[1]}`;
  if (uri.startsWith('ipfs://')) return `https://cf-ipfs.com/ipfs/${uri.slice(7)}`;
  return uri;
};
const PUMP_BASE = 'https://frontend-api.pump.fun';

const pumpFetch = async (path) => {
  const direct = `${PUMP_BASE}${path}`;
  const urls = [
    // 1. CRA / Netlify proxy (same-origin, no CORS issue)
    `/api/pump${path}`,
    // 2. corsproxy.io
    `https://corsproxy.io/?${encodeURIComponent(direct)}`,
    // 3. allorigins
    `https://api.allorigins.win/raw?url=${encodeURIComponent(direct)}`,
    // 4. thingproxy
    `https://thingproxy.freeboard.io/fetch/${direct}`,
    // 5. Direct (works if browser allows / server-side)
    direct,
  ];

  for (const url of urls) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 6000);
      const r = await fetch(url, {
        signal: controller.signal,
        headers: { Accept: 'application/json' },
      });
      clearTimeout(timeout);
      if (!r.ok) continue;
      const d = await r.json();
      if (d && (Array.isArray(d) ? d.length > 0 : true)) return d;
    } catch (_) { /* try next */ }
  }
  return null;
};
const tradesToOHLC = (trades, interval = 60) => {
  const map = new Map();
  [...trades].sort((a, b) => a.timestamp - b.timestamp).forEach(t => {
    if (!t.sol_amount || !t.token_amount) return;
    const price = (t.sol_amount / 1e9) / t.token_amount;
    const bucket = Math.floor(t.timestamp / interval) * interval;
    if (!map.has(bucket)) map.set(bucket, { time: bucket, open: price, high: price, low: price, close: price });
    else {
      const b = map.get(bucket);
      b.high = Math.max(b.high, price);
      b.low  = Math.min(b.low, price);
      b.close = price;
    }
  });
  return [...map.values()].sort((a, b) => a.time - b.time);
};

/* ══════════════════════════════════════════════
   COIN AVATAR
══════════════════════════════════════════════ */
const GATEWAYS = [
  cid => `https://cf-ipfs.com/ipfs/${cid}`,
  cid => `https://cloudflare-ipfs.com/ipfs/${cid}`,
  cid => `https://ipfs.io/ipfs/${cid}`,
];
function CoinAvatar({ name, imageUri, size = 40, radius = 10 }) {
  const [status, setStatus] = useState('loading');
  const [gi, setGi]         = useState(0);
  const cid = imageUri?.match(/\/ipfs\/(.+)/)?.[1] || null;
  const src = cid ? GATEWAYS[Math.min(gi, GATEWAYS.length - 1)](cid) : imageUri;

  useEffect(() => { if (imageUri) { setStatus('loading'); setGi(0); } else setStatus('err'); }, [imageUri]);

  const base = { width: size, height: size, borderRadius: radius, flexShrink: 0, overflow: 'hidden', position: 'relative' };
  if (!imageUri || status === 'err') {
    return (
      <div style={{ ...base, background: '#1a1a1a', border: '1px solid #222', display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 900, fontSize: size * 0.42, color: '#fff' }}>
        {name?.[0]?.toUpperCase() || '?'}
      </div>
    );
  }
  return (
    <div style={{ ...base, border: '1px solid rgba(255,255,255,0.08)' }}>
      {status === 'loading' && <div style={{ position: 'absolute', inset: 0, background: '#111', animation: 'shimmer 1.2s infinite' }} />}
      <img key={src} src={src} alt={name}
        style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block', opacity: status === 'ok' ? 1 : 0, transition: 'opacity .2s' }}
        onLoad={() => setStatus('ok')}
        onError={() => cid && gi < GATEWAYS.length - 1 ? setGi(g => g + 1) : setStatus('err')}
      />
    </div>
  );
}

/* ══════════════════════════════════════════════
   LIVE TRADING CHART — pump.fun style
   Always shows data: generates simulated candles
   immediately, blends real data when API responds
══════════════════════════════════════════════ */

// Seeded RNG so same coin always gets same history
function seededRand(seed) {
  let s = seed;
  return () => {
    s = (s * 1664525 + 1013904223) & 0xffffffff;
    return (s >>> 0) / 0xffffffff;
  };
}

// Build 60 historical 1-min candles from basePrice
function buildHistory(basePrice, coinId, count = 60) {
  const rng = seededRand(coinId.split('').reduce((a, c) => a + c.charCodeAt(0), 0));
  const candles = [];
  let price = basePrice * (0.3 + rng() * 0.5); // start lower for uptrend feel
  const now = Math.floor(Date.now() / 1000);
  for (let i = count; i >= 0; i--) {
    const t = now - i * 60;
    const open = price;
    const vol  = rng();
    const move = (rng() - 0.45) * open * 0.04;
    const close= Math.max(open + move, open * 0.001);
    const wick = Math.abs(close - open) * (0.4 + rng() * 1.2);
    const high = Math.max(open, close) + wick * rng();
    const low  = Math.min(open, close) - wick * rng();
    candles.push({ time: t, open, high, low, close });
    price = close;
  }
  return candles;
}

function TradingChart({ mint, basePrice, coinId }) {
  const containerRef = useRef();
  const seriesRef    = useRef();
  const chartRef     = useRef();
  const liveRef      = useRef(null);   // current forming candle
  const priceRef     = useRef(basePrice);

  const [price, setPrice] = useState(basePrice);
  const [pct,   setPct]   = useState(0);
  const startRef = useRef(basePrice);

  useEffect(() => {
    if (!containerRef.current) return;
    const el = containerRef.current;

    // ── Create chart ──
    const chart = createChart(el, {
      width:  el.clientWidth,
      height: 260,
      layout: {
        background: { type: 'solid', color: '#030303' },
        textColor:  '#555',
        fontSize:   10,
      },
      grid: {
        vertLines: { color: '#0e0e0e' },
        horzLines: { color: '#0e0e0e' },
      },
      crosshair: { mode: 1 },
      rightPriceScale: {
        borderColor: '#181818',
        textColor:   '#444',
        minimumWidth: 70,
      },
      timeScale: {
        borderColor:    '#181818',
        timeVisible:    true,
        secondsVisible: false,
        fixLeftEdge:    true,
      },
      handleScroll:   true,
      handleScale:    true,
    });
    chartRef.current = chart;

    const series = chart.addSeries(CandlestickSeries, {
      upColor:     '#22c55e',
      downColor:   '#ef4444',
      borderVisible: false,
      wickUpColor:   '#22c55e',
      wickDownColor: '#ef4444',
    });
    seriesRef.current = series;

    // ── Step 1: show simulated history immediately ──
    const history = buildHistory(basePrice, coinId || mint || 'default', 80);
    series.setData(history);
    startRef.current = history[0].open;
    chart.timeScale().fitContent();

    // Seed the live candle from last historical price
    const lastHist = history[history.length - 1];
    liveRef.current = {
      time:  Math.floor(Date.now() / 1000),
      open:  lastHist.close,
      high:  lastHist.close,
      low:   lastHist.close,
      close: lastHist.close,
    };
    priceRef.current = lastHist.close;

    // ── Step 2: animate the live forming candle every 400ms ──
    const tickIv = setInterval(() => {
      const prev  = liveRef.current;
      const drift = (Math.random() - 0.47) * prev.close * 0.008;
      const newClose = Math.max(prev.close + drift, prev.close * 0.001);
      const updated  = {
        time:  prev.time,
        open:  prev.open,
        high:  Math.max(prev.high,  newClose),
        low:   Math.min(prev.low,   newClose),
        close: newClose,
      };
      liveRef.current = updated;
      priceRef.current = newClose;
      try { series.update(updated); } catch (_) {}

      setPrice(newClose);
      setPct(((newClose - startRef.current) / startRef.current) * 100);
    }, 400);

    // ── Step 3: commit candle every 60s (new bucket) ──
    const candleIv = setInterval(() => {
      const prev = liveRef.current;
      liveRef.current = {
        time:  Math.floor(Date.now() / 1000),
        open:  prev.close,
        high:  prev.close,
        low:   prev.close,
        close: prev.close,
      };
    }, 60000);

    // ── Step 4: try real API in background, merge if success ──
    const seen = new Set();
    const fetchReal = async (initial) => {
      try {
        const data = await pumpFetch(`/trades/all?mint=${mint}&offset=0&limit=${initial ? 500 : 30}&minimumSize=0`);
        if (!Array.isArray(data) || !data.length) return;

        // Build real OHLC
        const realOHLC = tradesToOHLC(data, 60);
        if (!realOHLC.length) return;

        if (initial) {
          // Replace simulated with real data
          series.setData(realOHLC);
          startRef.current = realOHLC[0].open;
          chart.timeScale().fitContent();
          // Re-seed live candle from real last price
          const lastReal = realOHLC[realOHLC.length - 1];
          liveRef.current = {
            time:  Math.floor(Date.now() / 1000),
            open:  lastReal.close,
            high:  lastReal.close,
            low:   lastReal.close,
            close: lastReal.close,
          };
        } else {
          const fresh = data.filter(t => !seen.has(t.signature));
          if (fresh.length) tradesToOHLC(fresh, 60).forEach(c => { try { series.update(c); } catch (_) {} });
        }
        data.forEach(t => seen.add(t.signature));

        const last = data[0];
        if (last) {
          const p = (last.sol_amount / 1e9) / last.token_amount;
          if (!isNaN(p) && p > 0) {
            priceRef.current = p;
            setPrice(p);
            setPct(((p - startRef.current) / startRef.current) * 100);
          }
        }
      } catch (_) {}
    };

    // Try real data after a short delay
    const realTimeout = setTimeout(() => fetchReal(true), 800);
    const realIv = setInterval(() => fetchReal(false), 5000);

    // Resize handler
    const onResize = () => { try { chart.applyOptions({ width: el.clientWidth }); } catch (_) {} };
    window.addEventListener('resize', onResize);

    return () => {
      clearInterval(tickIv);
      clearInterval(candleIv);
      clearInterval(realIv);
      clearTimeout(realTimeout);
      window.removeEventListener('resize', onResize);
      try { chart.remove(); } catch (_) {}
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mint]);

  const up = pct >= 0;
  return (
    <div className="tc-wrap">
      <div className="tc-header">
        <span className="tc-price" style={{ color: up ? '#22c55e' : '#ef4444' }}>
          {fmtPrice(price)}
        </span>
        <span className="tc-pct" style={{ color: up ? '#22c55e' : '#ef4444' }}>
          {up ? '+' : ''}{pct.toFixed(2)}%
        </span>
        <span className="live-pill">● LIVE</span>
      </div>
      <div ref={containerRef} />
    </div>
  );
}

/* ══════════════════════════════════════════════
   LIVE TX FEED
══════════════════════════════════════════════ */
function TxFeed({ mint, ticker }) {
  const [txs, setTxs]     = useState([]);
  const [loading, setLoad] = useState(true);
  const seen = useRef(new Set());

  useEffect(() => {
    if (!mint) return;
    const load = async () => {
      const data = await pumpFetch(`/trades/all?mint=${mint}&offset=0&limit=30&minimumSize=0`);
      if (!Array.isArray(data)) return;
      const fresh = data.filter(t => !seen.current.has(t.signature)).map(t => {
        seen.current.add(t.signature);
        return {
          id: t.signature, type: t.is_buy ? 'buy' : 'sell',
          sol: (t.sol_amount / 1e9).toFixed(3),
          tokens: Math.floor(t.token_amount).toLocaleString(),
          wallet: (t.user || '???').slice(0, 6),
          ts: new Date(t.timestamp * 1000).toLocaleTimeString('en', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' }),
        };
      });
      if (fresh.length) setTxs(p => [...fresh, ...p].slice(0, 40));
      setLoad(false);
    };
    load();
    const iv = setInterval(load, 3500);
    return () => clearInterval(iv);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mint]);

  return (
    <div className="txfeed">
      <div className="txfeed-head">
        <span>Live Transactions</span>
        <span className="live-pill">● LIVE</span>
      </div>
      <div className="txfeed-list">
        {loading && <div className="txfeed-empty">Fetching trades…</div>}
        {!loading && txs.length === 0 && <div className="txfeed-empty">No trades yet</div>}
        {txs.map(tx => (
          <div key={tx.id} className={`txfeed-row txfeed-row--${tx.type}`}>
            <span className={`txfeed-type txfeed-type--${tx.type}`}>{tx.type.toUpperCase()}</span>
            <span className="txfeed-sol">{tx.sol} SOL</span>
            <span className="txfeed-tokens">{tx.tokens} {ticker}</span>
            <span className="txfeed-wallet">{tx.wallet}…</span>
            <span className="txfeed-time">{tx.ts}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ══════════════════════════════════════════════
   TRADE MODAL
══════════════════════════════════════════════ */
function TradeModal({ coin, onClose }) {
  const [side, setSide]     = useState('buy');
  const [amount, setAmount] = useState('0.1');
  const [done, setDone]     = useState('');
  const [vol5m, setVol5m]   = useState(coin.vol5m || 0);

  useEffect(() => {
    const iv = setInterval(() => setVol5m(v => parseFloat((v + Math.random() * 0.3).toFixed(2))), 2000);
    return () => clearInterval(iv);
  }, []);

  useEffect(() => {
    const fn = e => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', fn);
    return () => window.removeEventListener('keydown', fn);
  }, [onClose]);

  const est = (parseFloat(amount || 0) / (coin.basePrice || 0.0001)).toFixed(0);

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="trade-modal" onClick={e => e.stopPropagation()}>
        {/* Header */}
        <div className="trade-modal-head">
          <CoinAvatar name={coin.name} imageUri={coin.imageUri} size={44} radius={12} />
          <div className="trade-modal-info">
            <span className="trade-modal-name">{coin.name}</span>
            <span className="trade-modal-ticker">{coin.ticker}</span>
          </div>
          <div className="trade-modal-stats">
            <div className="tms"><span className="tms-val">{fmtMC(coin.mcVal)}</span><span className="tms-lbl">MKT CAP</span></div>
            <div className="tms"><span className="tms-val" style={{ color: '#22c55e' }}>{vol5m.toFixed(1)} SOL</span><span className="tms-lbl">VOL 5M</span></div>
          </div>
          <button className="modal-x" onClick={onClose}>✕</button>
        </div>

        {/* Chart */}
        <TradingChart mint={coin.mint} basePrice={coin.basePrice || 0.0001} coinId={coin.id} />

        {/* Tx Feed */}
        <TxFeed mint={coin.mint} ticker={coin.ticker} />

        {/* Trade Panel */}
        <div className="trade-panel">
          <div className="trade-sides">
            <button className={`trade-side${side === 'buy' ? ' trade-side--buy' : ''}`} onClick={() => { setSide('buy'); setDone(''); }}>Buy</button>
            <button className={`trade-side${side === 'sell' ? ' trade-side--sell' : ''}`} onClick={() => { setSide('sell'); setDone(''); }}>Sell</button>
          </div>
          <div className="trade-input-row">
            <input className="trade-input" type="number" value={amount}
              onChange={e => { setAmount(e.target.value); setDone(''); }}
              placeholder="SOL amount" />
            <button className="trade-exec"
              style={{ background: done ? '#22c55e' : side === 'buy' ? '#fff' : '#ef4444', color: done || side === 'buy' ? '#000' : '#fff' }}
              onClick={() => { setDone(side); setTimeout(() => setDone(''), 2500); }}>
              {done ? (done === 'buy' ? '✓ Bought!' : '✓ Sold!') : side === 'buy' ? 'Buy' : 'Sell'}
            </button>
          </div>
          <div className="trade-quick">
            {['0.1', '0.5', '1', '5'].map(v => (
              <button key={v} className="trade-quick-btn" onClick={() => setAmount(v)}>{v} SOL</button>
            ))}
          </div>
          <div className="trade-est">
            ≈ {isNaN(Number(est)) ? 0 : Number(est).toLocaleString()} {coin.ticker} · Price: {fmtPrice(coin.basePrice)}
          </div>
        </div>
      </div>
    </div>
  );
}

/* ══════════════════════════════════════════════
   COIN CARD
══════════════════════════════════════════════ */
function CoinCard({ coin, onClick }) {
  const isUp = coin.timeDir !== 'down';
  return (
    <div className="coin-card" onClick={() => onClick(coin)}>
      <div className="coin-card-img" style={{ background: coin.gradient }}>
        <CoinAvatar name={coin.name} imageUri={coin.imageUri} size={56} radius={14} />
        {coin.isNew && <span className="coin-badge coin-badge--new">NEW</span>}
        {coin.isHot && <span className="coin-badge coin-badge--hot">🔥 HOT</span>}
      </div>
      <div className="coin-card-body">
        <div className="coin-card-row1">
          <span className="coin-card-name">{coin.name}</span>
          <span className="coin-card-ticker">{coin.ticker}</span>
        </div>
        <div className="coin-card-mc">{fmtMC(coin.mcVal)}</div>
        <div className="coin-card-meta">
          <span className="coin-card-creator">{coin.creator}</span>
          <span className={`coin-card-time ${isUp ? 'up' : 'down'}`}>
            {isUp ? '▲' : '▼'} {coin.timeAgo}
          </span>
        </div>
        {coin.desc && <p className="coin-card-desc">{coin.desc}</p>}
      </div>
    </div>
  );
}

/* ══════════════════════════════════════════════
   HOT TABLE ROW
══════════════════════════════════════════════ */
function HotRow({ coin, rank, maxVol, onClick }) {
  return (
    <div className="hot-row" onClick={() => onClick(coin)}>
      <span className="hot-rank">#{rank}</span>
      <span className="hot-coin">
        <CoinAvatar name={coin.name} imageUri={coin.imageUri} size={32} radius={8} />
        <span className="hot-coin-info">
          <span className="hot-coin-name">{coin.name}</span>
          <span className="hot-coin-ticker">{coin.ticker}</span>
        </span>
      </span>
      <span className="hot-vol-cell">
        <span className="hot-vol-bar-wrap"><span className="hot-vol-bar" style={{ width: `${Math.min((coin.vol5m / maxVol) * 100, 100)}%` }} /></span>
        <span className="hot-vol-num">{(coin.vol5m || 0).toFixed(1)} SOL</span>
      </span>
      <span className="hot-mc">{fmtMC(coin.mcVal)}</span>
      <span className="hot-age">{coin.timeAgo}</span>
      <span className="hot-pct" style={{ color: coin.pct >= 0 ? '#22c55e' : '#ef4444' }}>
        {coin.pct >= 0 ? '+' : ''}{(coin.pct || 0).toFixed(1)}%
      </span>
    </div>
  );
}

/* ══════════════════════════════════════════════
   3D SPINNING COIN
══════════════════════════════════════════════ */
function SpinningCoin() {
  const coinRef = useRef();
  const frameRef = useRef();
  const rotRef = useRef(0);
  const speedRef = useRef(0.4);
  const [price, setPrice] = useState('$0.0421');

  // auto-spin + mouse drag tilt
  useEffect(() => {
    let lastX = null;
    let isDragging = false;

    const tick = () => {
      if (!isDragging) rotRef.current += speedRef.current;
      if (coinRef.current) {
        coinRef.current.style.transform = `rotateY(${rotRef.current}deg) rotateX(-8deg)`;
      }
      frameRef.current = requestAnimationFrame(tick);
    };
    frameRef.current = requestAnimationFrame(tick);

    const onDown = e => { isDragging = true; lastX = e.clientX ?? e.touches?.[0]?.clientX; };
    const onMove = e => {
      if (!isDragging) return;
      const x = e.clientX ?? e.touches?.[0]?.clientX;
      if (lastX !== null) rotRef.current += (x - lastX) * 0.8;
      lastX = x;
    };
    const onUp = () => { isDragging = false; };

    const el = coinRef.current?.parentElement;
    el?.addEventListener('mousedown', onDown);
    el?.addEventListener('touchstart', onDown);
    window.addEventListener('mousemove', onMove);
    window.addEventListener('touchmove', onMove);
    window.addEventListener('mouseup', onUp);
    window.addEventListener('touchend', onUp);

    // Simulate live price updates
    const iv = setInterval(() => {
      const p = (0.03 + Math.random() * 0.04).toFixed(4);
      setPrice(`$${p}`);
    }, 3000);

    return () => {
      cancelAnimationFrame(frameRef.current);
      clearInterval(iv);
      el?.removeEventListener('mousedown', onDown);
      el?.removeEventListener('touchstart', onDown);
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('touchmove', onMove);
      window.removeEventListener('mouseup', onUp);
      window.removeEventListener('touchend', onUp);
    };
  }, []);

  return (
    <div className="coin3d-scene">
      <div className="coin3d-wrap">
        <div className="coin3d" ref={coinRef}>

          {/* FRONT FACE */}
          <div className="coin3d-face coin3d-front">
            <div className="coin3d-ring coin3d-ring--outer" />
            <div className="coin3d-ring coin3d-ring--inner" />
            <div className="coin3d-center">
              <div className="coin3d-logo-mark">M</div>
              <div className="coin3d-name">MIST</div>
              <div className="coin3d-price">{price}</div>
              <div className="coin3d-live">
                <span className="coin3d-live-dot" />
                LIVE
              </div>
            </div>
            {/* shine sweep */}
            <div className="coin3d-shine" />
          </div>

          {/* BACK FACE */}
          <div className="coin3d-face coin3d-back">
            <div className="coin3d-ring coin3d-ring--outer" />
            <div className="coin3d-ring coin3d-ring--inner" />
            <div className="coin3d-center coin3d-center--back">
              <div className="coin3d-back-label">LAUNCHPAD</div>
              <div className="coin3d-back-sol">Solana</div>
              <div className="coin3d-back-stat">
                <span>0%</span>
                <span className="coin3d-back-stat-lbl">fees</span>
              </div>
              <div className="coin3d-back-stat">
                <span>1B</span>
                <span className="coin3d-back-stat-lbl">supply</span>
              </div>
            </div>
            <div className="coin3d-shine coin3d-shine--back" />
          </div>

          {/* subtle rim light instead of edge slices */}
          <div className="coin3d-rim" />
        </div>
      </div>

      {/* Glow under the coin */}
      <div className="coin3d-shadow" />
    </div>
  );
}

/* ══════════════════════════════════════════════
   HERO STRIP
══════════════════════════════════════════════ */
function HeroStrip({ onLaunch }) {
  return (
    <div className="hero-strip">
      <div className="hero-strip-left">
        <div className="hero-strip-pill">
          <span className="hero-strip-dot" />
          0% Fees · Live on Solana
        </div>
        <h2 className="hero-strip-h">
          The fairest launchpad<br />
          <span className="hero-strip-italic">on Solana.</span>
        </h2>
        <p className="hero-strip-sub">
          Real charts. Real trades. Real coins.
          Be first — every time.
        </p>
        <div className="hero-strip-actions">
          <a
            className="hero-strip-btn-twitter"
            href="https://twitter.com"
            target="_blank"
            rel="noreferrer"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
              <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-4.714-6.231-5.401 6.231H2.746l7.73-8.835L1.254 2.25H8.08l4.258 5.626 5.906-5.626zm-1.161 17.52h1.833L7.084 4.126H5.117z"/>
            </svg>
            Follow on X
          </a>
          <div className="hero-strip-stats">
            <div className="hero-strip-stat">
              <span className="hero-strip-stat-val">0%</span>
              <span className="hero-strip-stat-lbl">Fees</span>
            </div>
            <div className="hero-strip-divider" />
            <div className="hero-strip-stat">
              <span className="hero-strip-stat-val">&lt;2s</span>
              <span className="hero-strip-stat-lbl">Launch</span>
            </div>
            <div className="hero-strip-divider" />
            <div className="hero-strip-stat">
              <span className="hero-strip-stat-val">$69K</span>
              <span className="hero-strip-stat-lbl">To DEX</span>
            </div>
          </div>
        </div>
      </div>
      <div className="hero-strip-right">
        <div className="ca-bar">
          <span className="ca-label">CA:</span>
          <span className="ca-address ca-address--tba">To be announced</span>
        </div>
        <SpinningCoin />
      </div>
    </div>
  );
}

/* ══════════════════════════════════════════════
   PHANTOM WALLET BUTTON
══════════════════════════════════════════════ */
function WalletButton() {
  const [wallet,     setWallet]     = useState(null);
  const [connecting, setConnecting] = useState(false);
  const [err,        setErr]        = useState('');

  const short = addr => addr ? `${addr.slice(0,4)}...${addr.slice(-4)}` : '';

  const connect = async () => {
    setErr('');
    if (!window.solana?.isPhantom) {
      window.open('https://phantom.app/', '_blank');
      return;
    }
    try {
      setConnecting(true);
      const resp = await window.solana.connect();
      setWallet(resp.publicKey.toString());
    } catch (e) {
      setErr(e.message || 'Cancelled');
    } finally {
      setConnecting(false);
    }
  };

  const disconnect = async () => {
    try { await window.solana?.disconnect(); } catch (_) {}
    setWallet(null);
  };

  if (wallet) {
    return (
      <div className="wallet-connected">
        <div className="wallet-dot" />
        <span className="wallet-addr">{short(wallet)}</span>
        <button className="wallet-disconnect" onClick={disconnect} title="Disconnect">
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
            <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
          </svg>
        </button>
      </div>
    );
  }

  return (
    <div style={{ display:'flex', flexDirection:'column', alignItems:'flex-end', gap:4 }}>
      <button className="wallet-btn" onClick={connect} disabled={connecting}>
        {connecting ? (
          <><div className="wallet-spinner" />Connecting…</>
        ) : (
          <>
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M20 7H4a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2z"/>
              <path d="M16 21V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16"/>
            </svg>
            Connect Wallet
          </>
        )}
      </button>
      {err && <span style={{ fontSize:10, color:'#ef4444', textAlign:'right' }}>{err}</span>}
    </div>
  );
}

const TICKER_STATIC = [
  { sym: 'SOL', price: '$182.40', chg: '+3.21%', up: true },
  { sym: 'BONK', price: '$0.0000281', chg: '+8.14%', up: true },
  { sym: 'WIF', price: '$2.87', chg: '-1.03%', up: false },
  { sym: 'POPCAT', price: '$1.14', chg: '+12.7%', up: true },
  { sym: 'JUP', price: '$1.03', chg: '+2.44%', up: true },
  { sym: 'MYRO', price: '$0.184', chg: '-3.11%', up: false },
  { sym: 'BOME', price: '$0.0092', chg: '+5.88%', up: true },
  { sym: 'SAMO', price: '$0.0211', chg: '-0.72%', up: false },
];
function Ticker() {
  const items = [...TICKER_STATIC, ...TICKER_STATIC];
  return (
    <div className="ticker-bar">
      <div className="ticker-track">
        {items.map((t, i) => (
          <span key={i} className="ticker-item">
            <span className="ticker-dot" />
            <span className="ticker-sym">{t.sym}</span>
            <span className="ticker-price">{t.price}</span>
            <span className={`ticker-chg ${t.up ? 'up' : 'down'}`}>{t.chg}</span>
          </span>
        ))}
      </div>
    </div>
  );
}

/* ══════════════════════════════════════════════
   NAV
══════════════════════════════════════════════ */
function Nav({ onLaunch, activeTab, setActiveTab }) {
  const [scrolled, setScrolled] = useState(false);
  useEffect(() => {
    const fn = () => setScrolled(window.scrollY > 10);
    window.addEventListener('scroll', fn);
    return () => window.removeEventListener('scroll', fn);
  }, []);
  return (
    <nav className={`nav${scrolled ? ' nav--scrolled' : ''}`}>
      <div className="nav-inner">
        <div className="nav-logo">
          <div className="nav-logo-mark">
            <img src="/logo.png" alt="Mist" style={{ width: '100%', height: '100%', objectFit: 'contain', borderRadius: 8 }} />
          </div>
          <span>Mist</span>
        </div>
        <div className="nav-tabs">
          {['new', 'hot', 'trending', 'all'].map(t => (
            <button key={t} className={`nav-tab${activeTab === t ? ' active' : ''}`} onClick={() => setActiveTab(t)}>
              {t === 'new' ? 'New Pairs' : t === 'hot' ? 'Hot' : t === 'trending' ? 'Trending' : 'All Coins'}
            </button>
          ))}
        </div>
        <div className="nav-actions">
          <a
            className="nav-twitter"
            href="https://twitter.com"
            target="_blank"
            rel="noreferrer"
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor">
              <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-4.714-6.231-5.401 6.231H2.746l7.73-8.835L1.254 2.25H8.08l4.258 5.626 5.906-5.626zm-1.161 17.52h1.833L7.084 4.126H5.117z"/>
            </svg>
            Twitter
          </a>
          <WalletButton />
        </div>
      </div>
    </nav>
  );
}

/* ══════════════════════════════════════════════
   LAUNCH MODAL
══════════════════════════════════════════════ */
function LaunchModal({ onClose }) {
  const [step, setStep]   = useState(1);
  const [name, setName]   = useState('');
  const [ticker, setTicker] = useState('');
  const [desc, setDesc]   = useState('');

  useEffect(() => {
    const fn = e => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', fn);
    return () => window.removeEventListener('keydown', fn);
  }, [onClose]);

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="launch-modal" onClick={e => e.stopPropagation()}>
        <div className="lm-steps">
          {[1, 2, 3].map(s => (
            <div key={s} className={`lm-step${step >= s ? ' active' : ''}`}>
              <div className="lm-step-dot">{s}</div>
              <span>{s === 1 ? 'Details' : s === 2 ? 'Image' : 'Launch'}</span>
            </div>
          ))}
        </div>

        {step === 1 && <>
          <h2 className="lm-title">Name your coin</h2>
          <p className="lm-sub">Make it unforgettable.</p>
          <div className="lm-field"><label>Coin Name</label><input placeholder="e.g. Moon Frog" value={name} onChange={e => setName(e.target.value)} /></div>
          <div className="lm-field"><label>Ticker</label><input placeholder="MFROG" maxLength={8} value={ticker} onChange={e => setTicker(e.target.value.toUpperCase())} /></div>
          <div className="lm-field"><label>Description</label><textarea rows={3} placeholder="What's this coin about?" value={desc} onChange={e => setDesc(e.target.value)} /></div>
        </>}

        {step === 2 && <>
          <h2 className="lm-title">Upload image</h2>
          <p className="lm-sub">A great image is everything.</p>
          <div className="lm-upload">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><polyline points="16 16 12 12 8 16" /><line x1="12" y1="12" x2="12" y2="21" /><path d="M20.39 18.39A5 5 0 0 0 18 9h-1.26A8 8 0 1 0 3 16.3" /></svg>
            <span>Click or drag to upload</span>
            <span className="lm-upload-hint">PNG · GIF · JPG · Max 1MB</span>
          </div>
        </>}

        {step === 3 && <>
          <h2 className="lm-title">Ready to launch</h2>
          <p className="lm-sub">Your coin hits Solana in seconds.</p>
          <div className="lm-confirm-row"><span>Coin</span><strong>{name || '—'} ({ticker || '—'})</strong></div>
          <div className="lm-confirm-row"><span>Supply</span><strong>1,000,000,000</strong></div>
          <div className="lm-confirm-row"><span>Creation fee</span><strong>0.02 SOL</strong></div>
          <div className="lm-confirm-row"><span>Platform fee</span><strong style={{ color: '#22c55e' }}>0% ✓</strong></div>
        </>}

        <div className="lm-actions">
          {step > 1 && <button className="lm-back" onClick={() => setStep(s => s - 1)}>Back</button>}
          <button className="lm-next" onClick={step === 3 ? onClose : () => setStep(s => s + 1)}>
            {step === 3 ? 'Launch Coin' : 'Continue →'}
          </button>
        </div>
        <button className="modal-x" onClick={onClose}>✕</button>
      </div>
    </div>
  );
}

/* ══════════════════════════════════════════════
   GRADIENTS
══════════════════════════════════════════════ */
const GRADS = [
  'linear-gradient(135deg,#0f1a0f,#0a100a)',
  'linear-gradient(135deg,#0f0f1a,#0a0a10)',
  'linear-gradient(135deg,#1a0f0f,#100a0a)',
  'linear-gradient(135deg,#0f1520,#080e18)',
  'linear-gradient(135deg,#1a1500,#100e00)',
  'linear-gradient(135deg,#15001a,#0e0010)',
];

/* ══════════════════════════════════════════════
   FALLBACK DEMO COINS (shown when API unavailable)
══════════════════════════════════════════════ */
const DEMO_COINS = [
  { id:'d1', mint:'d1', name:'Moon Pepe',    ticker:'MPEPE',  mcVal:2400000, mc:'$2.4M',  creator:'7xKp2', timeAgo:'2m',  timeDir:'up',   desc:'The original pepe from the moon.',          imageUri:null, gradient:GRADS[0], basePrice:0.0000024, vol5m:142, pct:48.2,  isNew:false, isHot:true  },
  { id:'d2', mint:'d2', name:'NotInEmp',     ticker:'NIE',    mcVal:34500000,mc:'$34.5M', creator:'tr00p', timeAgo:'12h', timeDir:'up',   desc:'You will be unemployed. Be happy.',          imageUri:null, gradient:GRADS[1], basePrice:0.0345,    vol5m:188, pct:21.9,  isNew:false, isHot:true  },
  { id:'d3', mint:'d3', name:'Pumpcade',     ticker:'PCADE',  mcVal:41600000,mc:'$41.6M', creator:'jmpfn', timeAgo:'1d',  timeDir:'up',   desc:'Closes $5M round backed by Jump Capital.',  imageUri:null, gradient:GRADS[2], basePrice:0.0416,    vol5m:242, pct:35.7,  isNew:false, isHot:true  },
  { id:'d4', mint:'d4', name:'Unc Mode',     ticker:'UNC',    mcVal:12300000,mc:'$12.3M', creator:'fibs',  timeAgo:'4d',  timeDir:'down', desc:'unc mode activated. stay in the trenches.', imageUri:null, gradient:GRADS[3], basePrice:0.0123,    vol5m:31,  pct:-0.2,  isNew:false, isHot:false },
  { id:'d5', mint:'d5', name:'Peace Frog',   ticker:'PEACE',  mcVal:1630000, mc:'$1.63M', creator:'DFeZ3', timeAgo:'2h',  timeDir:'up',   desc:'Peace love and good vibes only.',            imageUri:null, gradient:GRADS[4], basePrice:0.00412,   vol5m:18,  pct:28.4,  isNew:true,  isHot:false },
  { id:'d6', mint:'d6', name:'Galaxy Brain', ticker:'GBRAIN', mcVal:920000,  mc:'$920K',  creator:'xv9zk', timeAgo:'6h',  timeDir:'up',   desc:'Thinking beyond the curve.',                imageUri:null, gradient:GRADS[5], basePrice:0.00092,   vol5m:9,   pct:7.2,   isNew:true,  isHot:false },
  { id:'d7', mint:'d7', name:'Tung Coin',    ticker:'TUNG',   mcVal:3620000, mc:'$3.62M', creator:'noodl', timeAgo:'3d',  timeDir:'down', desc:'Has returned to rot our feeds once again.', imageUri:null, gradient:GRADS[0], basePrice:0.00362,   vol5m:14,  pct:-3.8,  isNew:false, isHot:false },
  { id:'d8', mint:'d8', name:'Dog Shield',   ticker:'DSHLD',  mcVal:2790000, mc:'$2.79M', creator:'krypt', timeAgo:'2d',  timeDir:'down', desc:'My sword and shield against the world.',    imageUri:null, gradient:GRADS[1], basePrice:0.00279,   vol5m:11,  pct:-3.4,  isNew:false, isHot:false },
  { id:'d9', mint:'d9', name:'Long Live',    ticker:'LLM',    mcVal:14700,   mc:'$14.7K', creator:'bwamJ', timeAgo:'2m',  timeDir:'up',   desc:'Memes are the universal language.',         imageUri:null, gradient:GRADS[2], basePrice:0.0000147, vol5m:6,   pct:15.1,  isNew:true,  isHot:false },
  { id:'d10',mint:'d10',name:'UP ONLY',      ticker:'UPONLY', mcVal:184000,  mc:'$184K',  creator:'mmm',   timeAgo:'1y',  timeDir:'down', desc:'WE GO UP.',                                 imageUri:null, gradient:GRADS[3], basePrice:0.00021,   vol5m:2,   pct:-1.0,  isNew:false, isHot:false },
  { id:'d11',mint:'d11',name:'Mega Asset',   ticker:'M',      mcVal:4110,    mc:'$4.11K', creator:'DuQD5', timeAgo:'9m',  timeDir:'up',   desc:'Global standard for meme assets.',          imageUri:null, gradient:GRADS[4], basePrice:0.0000041, vol5m:1,   pct:3.3,   isNew:true,  isHot:false },
  { id:'d12',mint:'d12',name:'Boob Coin',    ticker:'BOOB',   mcVal:2430000, mc:'$2.43M', creator:'anon9', timeAgo:'5h',  timeDir:'up',   desc:'Is crypto the breast thing to happen?',     imageUri:null, gradient:GRADS[5], basePrice:0.00243,   vol5m:8,   pct:9.7,   isNew:false, isHot:false },
];



const transformCoin = (c, i) => ({
  id:        c.mint,
  mint:      c.mint,
  name:      c.name || 'Unknown',
  ticker:    c.symbol || '???',
  mc:        fmtMC(c.usd_market_cap),
  mcVal:     c.usd_market_cap || 0,
  creator:   (c.creator || '').slice(0, 6),
  timeAgo:   fmtAgo(c.created_timestamp),
  timeDir:   'up',
  desc:      (c.description || '').slice(0, 80),
  imageUri:  normalizeImg(c.image_uri),
  gradient:  GRADS[i % GRADS.length],
  basePrice: c.usd_market_cap && c.total_supply ? c.usd_market_cap / c.total_supply : 0.0001,
  vol5m:     parseFloat((Math.random() * 120 + 0.5).toFixed(1)),
  pct:       parseFloat((Math.random() * 60 - 10).toFixed(1)),
  isNew:     false,
  isHot:     false,
});

/* ══════════════════════════════════════════════
   MAIN APP
══════════════════════════════════════════════ */
export default function MistApp() {
  const [activeTab,  setActiveTab]  = useState('hot');
  const [coins,      setCoins]      = useState([]);
  const [loading,    setLoading]    = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [search,     setSearch]     = useState('');
  const [tradeModal, setTradeModal] = useState(null);
  const [launchModal,setLaunchModal]= useState(false);

  const fetchCoins = useCallback(async (tab, silent = false) => {
    // silent = background refresh — never wipe the grid
    if (!silent) setLoading(true);
    else setRefreshing(true);

    const sortMap = { hot: 'last_trade_timestamp', new: 'created_timestamp', trending: 'usd_market_cap', all: 'last_trade_timestamp' };
    const sort = sortMap[tab] || 'last_trade_timestamp';

    try {
      const data = await pumpFetch(`/coins?offset=0&limit=48&sort=${sort}&order=DESC&includeNsfw=false`);
      if (Array.isArray(data) && data.length) {
        const transformed = data.map((c, i) => ({
          ...transformCoin(c, i),
          isNew: tab === 'new',
          isHot: tab === 'hot' && i < 5,
        }));
        setCoins(transformed);
        setLoading(false);
        setRefreshing(false);
        return;
      }
    } catch (_) {}

    // API failed — use demo coins so UI is never empty
    const demo = DEMO_COINS.map(c => ({
      ...c,
      isNew: tab === 'new' ? c.isNew : false,
      isHot: tab === 'hot' ? c.isHot : false,
    }));
    if (tab === 'trending') demo.sort((a, b) => b.mcVal - a.mcVal);
    if (tab === 'new')      demo.sort((a, b) => (b.isNew ? 1 : 0) - (a.isNew ? 1 : 0));
    setCoins(prev => prev.length > 0 ? prev : demo); // keep existing if we have data
    setLoading(false);
    setRefreshing(false);
  }, []);

  useEffect(() => { fetchCoins(activeTab, false); }, [activeTab, fetchCoins]);
  useEffect(() => {
    const iv = setInterval(() => fetchCoins(activeTab, true), 20000); // silent bg refresh
    return () => clearInterval(iv);
  }, [activeTab, fetchCoins]);

  const filtered = coins.filter(c =>
    !search || c.name.toLowerCase().includes(search.toLowerCase()) || c.ticker.toLowerCase().includes(search.toLowerCase())
  );
  const maxVol = Math.max(...filtered.map(c => c.vol5m || 0), 1);

  return (
    <div className="mist-root">
      {/* Stars */}
      <div className="stars" aria-hidden="true">
        {Array.from({ length: 350 }, (_, i) => (
          <span key={i} className="star" style={{
            left:              `${Math.random() * 100}%`,
            top:               `${Math.random() * 100}%`,
            width:             Math.random() * 2.5 + 0.2,
            height:            Math.random() * 2.5 + 0.2,
            opacity:           Math.random() * 0.6 + 0.05,
            animationDuration: `${Math.random() * 10 + 2}s`,
            animationDelay:    `${Math.random() * 8}s`,
          }} />
        ))}
      </div>

      <Ticker />
      <Nav onLaunch={() => setLaunchModal(true)} activeTab={activeTab} setActiveTab={setActiveTab} />

      <main className="main-content">

        {/* ── HERO STRIP ── */}
        <HeroStrip onLaunch={() => setLaunchModal(true)} />

        {/* ── PAGE HEADER ── */}
        <div className="page-header">
          <div className="page-header-left">
            <h1 className="page-title">
              {activeTab === 'new'      && 'New Pairs'}
              {activeTab === 'hot'      && 'Hot Coins'}
              {activeTab === 'trending' && 'Trending'}
              {activeTab === 'all'      && 'All Coins'}
            </h1>
            <p className="page-subtitle">
              {activeTab === 'new'      && 'Just launched on Solana — be first in.'}
              {activeTab === 'hot'      && 'Highest volume in the last few minutes.'}
              {activeTab === 'trending' && 'Biggest market caps right now.'}
              {activeTab === 'all'      && 'All active coins sorted by last trade.'}
            </p>
          </div>
          <div className="page-header-right">
            <div className="search-box">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" /></svg>
              <input placeholder="Search coins…" value={search} onChange={e => setSearch(e.target.value)} />
            </div>
            <button className="refresh-btn" onClick={() => fetchCoins(activeTab, true)}>
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
                style={{ animation: refreshing ? 'spin 0.7s linear infinite' : 'none' }}>
                <polyline points="23 4 23 10 17 10" /><polyline points="1 20 1 14 7 14" />
                <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
              </svg>
              {refreshing ? 'Refreshing…' : 'Refresh'}
            </button>
            <button className="launch-btn" onClick={() => setLaunchModal(true)}>+ Launch Coin</button>
          </div>
        </div>

        {/* ── HOT TABLE (hot tab only) ── */}
        {activeTab === 'hot' && !loading && filtered.length > 0 && (
          <div className="hot-section">
            <div className="section-label">
              <span className="live-pill">● LIVE</span>
              Top by 5-minute volume
            </div>
            <div className="hot-table">
              <div className="hot-head">
                <span>#</span><span>Coin</span><span>Vol 5m</span><span>Mkt Cap</span><span>Age</span><span>Change</span>
              </div>
              {filtered.slice(0, 10).map((c, i) => (
                <HotRow key={c.id} coin={c} rank={i + 1} maxVol={maxVol} onClick={setTradeModal} />
              ))}
            </div>
          </div>
        )}

        {/* ── NEW PAIRS FEED (new tab) ── */}
        {activeTab === 'new' && !loading && filtered.length > 0 && (
          <div className="new-feed-section">
            <div className="section-label">
              <span className="live-pill">● LIVE</span>
              Freshly launched — sorted by creation time
            </div>
            <div className="new-feed">
              {filtered.slice(0, 20).map(coin => (
                <div key={coin.id} className="new-feed-row" onClick={() => setTradeModal(coin)}>
                  <CoinAvatar name={coin.name} imageUri={coin.imageUri} size={38} radius={10} />
                  <div className="new-feed-info">
                    <span className="new-feed-name">{coin.name}</span>
                    <span className="new-feed-ticker">{coin.ticker}</span>
                  </div>
                  <div className="new-feed-mc">{fmtMC(coin.mcVal)}</div>
                  <div className="new-feed-age">{coin.timeAgo} ago</div>
                  <div className="new-feed-creator">by {coin.creator}…</div>
                  <div className="new-feed-desc">{coin.desc}</div>
                  <button className="new-feed-trade">Trade →</button>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* ── COIN GRID ── */}
        {(activeTab === 'trending' || activeTab === 'all' || activeTab === 'hot' || activeTab === 'new') && (
          <div className="coins-section">
            {(activeTab === 'hot' || activeTab === 'new') && (
              <div className="section-label" style={{ marginTop: 32 }}>All coins</div>
            )}
            {loading && coins.length === 0 ? (
              <div className="coins-loading">
                {Array.from({ length: 12 }, (_, i) => <div key={i} className="coin-skeleton" />)}
              </div>
            ) : filtered.length === 0 ? (
              <div className="coins-empty">No coins found. Try a different search.</div>
            ) : (
              <div className="coins-grid">
                {filtered.map(coin => (
                  <CoinCard key={coin.id} coin={coin} onClick={setTradeModal} />
                ))}
              </div>
            )}
          </div>
        )}
      </main>

      {/* MODALS */}
      {tradeModal  && <TradeModal coin={tradeModal} onClose={() => setTradeModal(null)} />}
      {launchModal && <LaunchModal onClose={() => setLaunchModal(false)} />}
    </div>
  );
}
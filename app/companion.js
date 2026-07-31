/*
 * Copyright © Not Financial Advice, LLC. All rights reserved.
 *
 * This source-available TradingView integration is licensed under the PolyForm
 * Noncommercial License 1.0.0. You may use, copy, modify, and share it only
 * for noncommercial purposes and only in accordance with that license.
 * Commercial use is not permitted without a separate written commercial
 * license from Not Financial Advice, LLC.
 *
 * License: https://polyformproject.org/licenses/noncommercial/1.0.0
 */

// gexbot TradingView v1.0 — shared companion for Linux and Windows.
//
// The companion owns credentials and API traffic. The TradingView renderer receives
// only chart configuration/data through a CDP isolated world; API keys are never
// injected into the page or placed in the overlay DOM.
// Zero npm dependencies — Node 22+ built-in fetch + WebSocket.
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { decodeGex, decodeGreek, parseWebPubSubMessage } = require("./expiry-protobuf");

const DEBUG_PORT = Number(process.env.IOF_PORT || 9222);
const TARGET_FILTER = process.env.IOF_TARGET || "";
const RELOAD_ON_ATTACH = !!process.env.IOF_RELOAD;
const REQUEST_TIMEOUT_MS = boundedNumber(process.env.IOF_REQUEST_TIMEOUT_MS, 10_000, 1_000, 60_000);
const DEBUG_FAILURE_LIMIT = Math.round(boundedNumber(process.env.IOF_DEBUG_FAILURE_LIMIT, 3, 1, 10));
const PID_FILE = process.env.IOF_PID_FILE || "";
const USER_AGENT = "Tradingview";
const ROOT_DIR = path.resolve(__dirname, "..");
const ISOLATED_WORLD = "gexbot-tradingview-v1.0";
const PLATFORM_CONFIG_HOME = process.platform === "win32"
    ? (process.env.LOCALAPPDATA || process.env.APPDATA || path.join(os.homedir(), "AppData", "Local"))
    : (process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"));
const CONFIG_DIR = process.env.IOF_CONFIG_DIR || path.join(PLATFORM_CONFIG_HOME, "gexbot-tradingview-v1.0");
const CONFIG_PATH = process.env.IOF_CONFIG_PATH || path.join(CONFIG_DIR, "config.json");
const API_KEY_PATH = process.env.IOF_API_KEY_PATH || path.join(ROOT_DIR, "api-key.txt");
const LEGACY_CONFIG_PATHS = [
    path.join(PLATFORM_CONFIG_HOME, "gexbot-tradingview-v2", "config.json"),
    path.join(ROOT_DIR, "config.json"),
    path.join(ROOT_DIR, "gb-tradingview-linux", "config.json"),
    path.join(ROOT_DIR, "gb-tradingview-windows", "config.json"),
];
const LEGACY_API_KEY_PATHS = [
    path.join(ROOT_DIR, "gb-tradingview-linux", "api-key.txt"),
    path.join(ROOT_DIR, "gb-tradingview-windows", "api-key.txt"),
];

const EXT_DIR = [__dirname, path.join(__dirname, "..")].find((dir) => {
    try { return fs.existsSync(path.join(dir, "content.js")); } catch { return false; }
}) || __dirname;

const clients = new Set();
const attached = new Set();
const tabFetch = new Map();
const convCache = new Map();
const majorHistoryCache = new Map();
const expiryListCache = new Map();
const expirySockets = { signature: "", generation: 0, descriptors: new Map(), sockets: new Map(), timer: null, abortController: null };
const quantTickerSet = new Set();
const quantBaseSnapshots = new Map();
const CONV_TTL_MS = 15 * 60 * 1000;
const EXPIRY_LIST_TTL_MS = 12 * 60 * 60 * 1000;
const TICKER_LIST_TTL_MS = 24 * 60 * 60 * 1000;
const MARKET_TIME_ZONE = "America/New_York";
const MARKET_OPEN_MINUTE = 9 * 60 + 30;
const MARKET_CLOSE_MINUTE = 16 * 60;
const MARKET_PARTS_FORMATTER = new Intl.DateTimeFormat("en-US", {
    timeZone: MARKET_TIME_ZONE,
    year: "numeric", month: "2-digit", day: "2-digit",
    weekday: "short", hour: "2-digit", minute: "2-digit", second: "2-digit",
    hourCycle: "h23",
});
const EXPIRY_PROFILE_TYPES = new Set(["classic_vol", "classic_oi", "state_gex", "delta", "gamma", "vanna", "charm"]);
const STANDARD_PROFILE_AGGREGATIONS = new Map([
    ["vol", new Set(["zero", "one", "full"])],
    ["oi", new Set(["zero", "one", "full"])],
    ["s_gex", new Set(["zero", "one", "full"])],
    ["s_gamma", new Set(["zero", "one"])],
]);
let configs = {};
let globalApiKey = "";
let tickerListCache = null;
let tickerListRequest = null;
let quantTickerDiscoveryPromise = null;
let quantTickerDiscoveryComplete = false;
let discoveryTimer = null;
let debugFailureCount = 0;
let shuttingDown = false;

function boundedNumber(value, fallback, min, max) {
    const number = Number(value);
    return Number.isFinite(number) ? Math.max(min, Math.min(max, number)) : fallback;
}

function writeOwnPidFile() {
    if (!PID_FILE) return;
    try {
        fs.writeFileSync(PID_FILE, `${process.pid}\n`, { encoding: "utf8", mode: 0o600 });
        fs.chmodSync(PID_FILE, 0o600);
    } catch (error) {
        console.warn(`[iof] could not write PID file ${PID_FILE}: ${error.message}`);
    }
}

function removeOwnPidFile() {
    if (!PID_FILE) return;
    try {
        if (fs.readFileSync(PID_FILE, "utf8").trim() === String(process.pid)) fs.unlinkSync(PID_FILE);
    } catch { }
}

function shutdown(reason, exitCode = 0) {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[iof] shutting down: ${reason}`);
    if (discoveryTimer) clearInterval(discoveryTimer);
    discoveryTimer = null;
    for (const tab of [...tabFetch.keys()]) stopTabFetch(tab, false);
    closeExpirySockets();
    removeOwnPidFile();
    process.exitCode = exitCode;
    setImmediate(() => process.exit(exitCode));
}

process.once("SIGINT", () => shutdown("received SIGINT"));
process.once("SIGTERM", () => shutdown("received SIGTERM"));
process.once("exit", removeOwnPidFile);

function ensureConfigDirectory() {
    fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true, mode: 0o700 });
    try { fs.chmodSync(path.dirname(CONFIG_PATH), 0o700); } catch { }
}

function sanitizeTabConfig(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    let copy;
    try { copy = JSON.parse(JSON.stringify(value)); } catch { return {}; }
    delete copy.apiKey;
    delete copy.apiKeyConfigured;
    return copy;
}

function validApiKey(value) {
    return value.length >= 16 && value.length <= 512 && /^[A-Za-z0-9_-]+$/.test(value);
}

function ensureApiKeyDirectory() {
    const directory = path.dirname(API_KEY_PATH);
    if (!fs.existsSync(directory)) fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
}

function readApiKeyFile() {
    ensureApiKeyDirectory();
    try {
        const stat = fs.lstatSync(API_KEY_PATH);
        if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("must be a regular file, not a symlink");
        fs.chmodSync(API_KEY_PATH, 0o600);
        return fs.readFileSync(API_KEY_PATH, "utf8").trim();
    } catch (error) {
        if (error.code !== "ENOENT") throw new Error(`Cannot read ${API_KEY_PATH}: ${error.message}`);
        fs.writeFileSync(API_KEY_PATH, "", { encoding: "utf8", mode: 0o600 });
        fs.chmodSync(API_KEY_PATH, 0o600);
        return "";
    }
}

function writeApiKeyFile(value) {
    ensureApiKeyDirectory();
    const tempPath = `${API_KEY_PATH}.tmp-${process.pid}`;
    fs.writeFileSync(tempPath, value ? `${value}\n` : "", { encoding: "utf8", mode: 0o600 });
    fs.chmodSync(tempPath, 0o600);
    fs.renameSync(tempPath, API_KEY_PATH);
    fs.chmodSync(API_KEY_PATH, 0o600);
}

function loadConfigs() {
    ensureConfigDirectory();
    let raw = null;
    let legacy = null;
    let legacyPath = null;
    try {
        raw = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
        fs.chmodSync(CONFIG_PATH, 0o600);
    } catch { }
    for (const candidate of LEGACY_CONFIG_PATHS) {
        if (path.resolve(candidate) === path.resolve(CONFIG_PATH)) continue;
        try {
            legacy = JSON.parse(fs.readFileSync(candidate, "utf8"));
            legacyPath = candidate;
            break;
        } catch { }
    }

    // One-time migration from versions that stored the key in config.json.
    // The key moves to the ignored local text file; chart settings stay in the
    // platform config directory (XDG_CONFIG_HOME or LOCALAPPDATA).
    const fileApiKey = readApiKeyFile();
    let legacyFileApiKey = "";
    let legacyApiKeyPath = null;
    if (!fileApiKey) {
        for (const candidate of LEGACY_API_KEY_PATHS) {
            try {
                const stat = fs.lstatSync(candidate);
                if (!stat.isFile() || stat.isSymbolicLink()) continue;
                const value = fs.readFileSync(candidate, "utf8").trim();
                if (!value) continue;
                legacyFileApiKey = value;
                legacyApiKeyPath = candidate;
                break;
            } catch { }
        }
    }
    const migratedApiKey = legacyFileApiKey || (typeof raw?.apiKey === "string" && raw.apiKey.trim()
        ? raw.apiKey.trim()
        : (typeof legacy?.apiKey === "string" ? legacy.apiKey.trim() : ""));
    globalApiKey = fileApiKey || migratedApiKey;
    if (globalApiKey && !validApiKey(globalApiKey)) throw new Error(`Invalid API key in ${API_KEY_PATH}`);
    if (!fileApiKey && globalApiKey) writeApiKeyFile(globalApiKey);
    if (legacyApiKeyPath && globalApiKey) {
        try { fs.unlinkSync(legacyApiKeyPath); }
        catch (error) { console.warn(`[iof] migrated legacy API key but could not remove ${legacyApiKeyPath}: ${error.message}`); }
    }

    if (legacy) {
        raw ||= {};
        if ((!raw.tabs || !Object.keys(raw.tabs).length) && legacy.tabs && typeof legacy.tabs === "object") raw.tabs = legacy.tabs;
    }

    configs = {};
    if (raw?.tabs && typeof raw.tabs === "object" && !Array.isArray(raw.tabs)) {
        for (const [tab, config] of Object.entries(raw.tabs)) configs[tab] = sanitizeTabConfig(config);
    }

    if (legacy || raw?.apiKey) writeConfigs();
    if (legacy && legacyPath) {
        try {
            fs.writeFileSync(legacyPath, "{\n  \"migrated\": true\n}\n", { mode: 0o600 });
            fs.unlinkSync(legacyPath);
            console.log(`[iof] migrated legacy settings to ${CONFIG_PATH} and ${API_KEY_PATH}`);
        } catch (error) {
            console.warn(`[iof] legacy config was migrated but could not be removed: ${error.message}`);
        }
    }
}

function writeConfigs() {
    ensureConfigDirectory();
    const tabs = {};
    for (const [tab, config] of Object.entries(configs)) tabs[tab] = sanitizeTabConfig(config);
    const payload = JSON.stringify({ tabs }, null, 2) + "\n";
    const tempPath = `${CONFIG_PATH}.tmp-${process.pid}`;
    fs.writeFileSync(tempPath, payload, { encoding: "utf8", mode: 0o600 });
    fs.chmodSync(tempPath, 0o600);
    fs.renameSync(tempPath, CONFIG_PATH);
    fs.chmodSync(CONFIG_PATH, 0o600);
}

// ---- Renderer shim ----------------------------------------------------------
// This runs in a named CDP isolated world. TradingView page scripts cannot read
// these globals, callbacks, configs, or streamed API payloads.
const SHIM = `(function(){
  if (window.__iofShim) return; window.__iofShim = true;
  function tabId(){ try{
    var m=location.pathname.match(/\\/chart\\/([^\\/]+)/);
    if(m&&m[1]) return 'layout_'+m[1].replace(/[^A-Za-z0-9_-]/g,'').slice(0,96);
    var id=sessionStorage.getItem('iofTabId');
    if(!id){id='tab_'+Math.random().toString(36).slice(2)+Date.now().toString(36);sessionStorage.setItem('iofTabId',id);}
    return id;
  }catch(e){return 'tab_default';}}
  window.__iofTabId=tabId;
  window.chrome=window.chrome||{};
  var rt=window.chrome.runtime=window.chrome.runtime||{};rt.id="tvdesktop";
  rt.connect=function(){
    var listeners=[];
    window.__iofPort={deliver:function(message){listeners.slice().forEach(function(fn){try{fn(message);}catch(e){}});}};
    return {name:"gexbot",onMessage:{addListener:function(fn){listeners.push(fn);}},onDisconnect:{addListener:function(){}},
      postMessage:function(message){try{__iofSetConfig(JSON.stringify({tab:tabId(),msg:message}));}catch(e){}}};
  };
  window.chrome.storage={local:{
    get:function(key,callback){window.__iofCfgCb=callback;try{__iofReqConfig(tabId());}catch(e){callback({});}},
    set:function(obj){if(obj&&obj.iofConfigV1){try{__iofSave(JSON.stringify({tab:tabId(),config:obj.iofConfigV1}));}catch(e){}}}
  }};
})();`;

function buildContentBundle() {
    const content = fs.readFileSync(path.join(EXT_DIR, "content.js"), "utf8");
    const css = fs.readFileSync(path.join(EXT_DIR, "panel.css"), "utf8");
    const cssInject = `(function(){var s=document.getElementById('iof-style');if(!s){s=document.createElement('style');s.id='iof-style';document.documentElement.appendChild(s);}s.textContent=${JSON.stringify(css)};})();`;
    return `${SHIM}\n${cssInject}\n${content}`;
}

function buildInjectedBundle() {
    return fs.readFileSync(path.join(EXT_DIR, "injected.js"), "utf8");
}

// ---- gexbot API -------------------------------------------------------------
const BASE = "https://api.gex.bot/v2";
const TRADINGVIEW_INTEGRATION = "tradingview";
const TRADINGVIEW_PLUGIN_HEADER = "gexbot-tradingview-v1.0";
const NORMAL_TICKERS_URL = "https://api.gexbot.com/tickers";
const QUANT_TICKERS_URL = "https://api.gex.bot/tickers/quant";

async function fetchJson(url, apiKey, signal, label, options = {}) {
    const headers = {
        Accept: "application/json",
        "User-Agent": USER_AGENT,
    };
    if (options.auth !== false) headers.Authorization = `Bearer ${String(apiKey).trim()}`;
    if (options.plugin) headers["X-gexbot-plugin"] = String(options.plugin);
    if (options.body !== undefined) headers["Content-Type"] = "application/json";
    const response = await fetch(url, {
        signal,
        method: options.method || "GET",
        headers,
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });
    if (!response.ok) {
        const body = (await response.text().catch(() => "")).slice(0, 160);
        throw new Error(`${label} HTTP ${response.status}${body ? `: ${body}` : ""}`);
    }
    return response.json();
}

function getJson(route, apiKey, signal) {
    return fetchJson(`${BASE}/${route}`, apiKey, signal, route);
}

function normalizedTickerList(value) {
    if (!Array.isArray(value)) return [];
    return [...new Set(value
        .filter((ticker) => typeof ticker === "string")
        .map((ticker) => ticker.trim().toUpperCase())
        .filter((ticker) => /^[A-Z_]{1,12}$/.test(ticker)))]
        .sort((a, b) => a.localeCompare(b));
}

function normalizedTickerResponse(value, includeFutures) {
    const response = value && typeof value === "object" && !Array.isArray(value) ? value : {};
    const result = {
        stocks: normalizedTickerList(response.stocks),
        indexes: normalizedTickerList(response.indexes),
    };
    if (includeFutures) result.futures = normalizedTickerList(response.futures);
    return result;
}

function updateQuantTickerSet(normalResponse, quantResponse) {
    if (!quantResponse) return;
    // Match legacy-backend's runtime registry: a symbol already present in the
    // normal universe stays REST-capable; only supplemental Quant symbols are
    // marked PubSub-only.
    const normal = new Set([...(normalResponse?.stocks || []), ...(normalResponse?.indexes || [])]);
    const next = new Set([...(quantResponse.stocks || []), ...(quantResponse.indexes || [])].filter((ticker) => !normal.has(ticker)));
    const changed = next.size !== quantTickerSet.size || [...next].some((ticker) => !quantTickerSet.has(ticker));
    if (!changed) return;
    quantTickerSet.clear();
    for (const ticker of next) quantTickerSet.add(ticker);
    quantBaseSnapshots.clear();
    for (const [tab, entry] of tabFetch) restartTabFetch(tab, entry);
    scheduleExpirySync();
}

function isQuantTicker(symbol) {
    return quantTickerSet.has(String(symbol || "").toUpperCase());
}

async function loadTickerLists(refresh = false) {
    if (refresh) tickerListCache = null;
    if (tickerListCache && Date.now() - tickerListCache.at < TICKER_LIST_TTL_MS) return tickerListCache.payload;
    if (tickerListRequest) return tickerListRequest;

    tickerListRequest = (async () => {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(new Error("ticker list request timed out")), REQUEST_TIMEOUT_MS);
        try {
            const quantRequest = globalApiKey
                ? fetchJson(QUANT_TICKERS_URL, globalApiKey, controller.signal, "Quant ticker list")
                : Promise.reject(new Error("API key not configured"));
            const [normal, quant] = await Promise.allSettled([
                fetchJson(NORMAL_TICKERS_URL, "", controller.signal, "ticker list", { auth: false }),
                quantRequest,
            ]);
            const payload = {
                normal: normal.status === "fulfilled" ? normalizedTickerResponse(normal.value, true) : null,
                quant: quant.status === "fulfilled" ? normalizedTickerResponse(quant.value, false) : null,
                errors: {
                    normal: normal.status === "rejected" ? String(normal.reason?.message || normal.reason).slice(0, 240) : "",
                    quant: quant.status === "rejected" ? String(quant.reason?.message || quant.reason).slice(0, 240) : "",
                },
            };
            updateQuantTickerSet(payload.normal, payload.quant);
            tickerListCache = { at: Date.now(), payload };
            return payload;
        } finally {
            clearTimeout(timeout);
        }
    })();

    try { return await tickerListRequest; }
    finally { tickerListRequest = null; }
}

function ensureQuantTickerDiscovery() {
    if (quantTickerDiscoveryComplete) return Promise.resolve();
    if (quantTickerDiscoveryPromise) return quantTickerDiscoveryPromise;
    quantTickerDiscoveryPromise = loadTickerLists().catch((error) => {
        console.warn(`[iof] Quant ticker discovery failed: ${error.message}`);
    }).finally(() => {
        quantTickerDiscoveryComplete = true;
        quantTickerDiscoveryPromise = null;
        for (const [tab, entry] of tabFetch) restartTabFetch(tab, entry);
        scheduleExpirySync();
    });
    return quantTickerDiscoveryPromise;
}

async function sendTickerLists(tab, refresh = false) {
    try {
        const payload = await loadTickerLists(refresh);
        pushToTab(tab, { type: "ticker-lists", ...payload });
    } catch (error) {
        const message = String(error?.message || error).slice(0, 240);
        pushToTab(tab, { type: "ticker-lists", normal: null, quant: null, errors: { normal: message, quant: message } });
    }
}

const classicCategory = (aggregation) => aggregation === "zero" ? "gex_zero" : aggregation === "one" ? "gex_one" : "gex_full";

function gexSource(response) {
    return {
        ts: Number(response.timestamp) || 0,
        levels: {
            majorPosVol: response.major_pos_vol,
            majorNegVol: response.major_neg_vol,
            zeroGamma: response.zero_gamma,
            majorPosOi: response.major_pos_oi,
            majorNegOi: response.major_neg_oi,
        },
        strikes: Array.isArray(response.strikes) ? response.strikes : [],
    };
}

function gammaSource(response) {
    return {
        ts: Number(response.timestamp) || 0,
        levels: {
            gammaMajorPos: response.major_positive,
            gammaMajorNeg: response.major_negative,
            gammaLong: response.major_long_gamma,
            gammaShort: response.major_short_gamma,
        },
        strikes: Array.isArray(response.mini_contracts) ? response.mini_contracts : [],
    };
}

function standardProfileRequest(symbol, profile) {
    const category = classicCategory(profile.agg);
    if (profile.id === "vol" || profile.id === "oi") {
        return { route: `${symbol}/classic/${category}`, kind: "gex" };
    }
    if (profile.id === "s_gex") {
        return { route: `${symbol}/state/${category}`, kind: "gex" };
    }
    return { route: `${symbol}/state/gamma_${profile.agg}`, kind: "greek" };
}

async function fetchData(config, apiKey, signal) {
    if (!config.profiles.length) return { ts: 0, sources: {} };
    const symbol = encodeURIComponent(config.symbol);
    const byRoute = new Map();
    for (const profile of config.profiles) {
        const request = standardProfileRequest(symbol, profile);
        let entry = byRoute.get(request.route);
        if (!entry) {
            entry = { ...request, profileIds: [] };
            byRoute.set(request.route, entry);
        }
        entry.profileIds.push(profile.id);
    }

    // All selected profiles form one snapshot. If any selected request fails,
    // cancel its siblings instead of mixing fresh and stale sources.
    const controller = new AbortController();
    const combinedSignal = AbortSignal.any([signal, controller.signal]);
    const entries = [...byRoute.values()];
    const requests = entries.map((entry) => getJson(entry.route, apiKey, combinedSignal));
    let responses;
    try {
        responses = await Promise.all(requests);
    } catch (error) {
        controller.abort(error);
        await Promise.allSettled(requests);
        throw error;
    }

    const sources = {};
    let timestamp = 0;
    for (let index = 0; index < entries.length; index++) {
        const entry = entries[index];
        const response = responses[index];
        const source = entry.kind === "gex" ? gexSource(response) : gammaSource(response);
        for (const id of entry.profileIds) sources[id] = source;
        timestamp = Math.max(timestamp, Number(response.timestamp) || 0);
    }
    return { ts: timestamp, sources };
}

function conversionModel(ticker, future) {
    const source = String(ticker || "").toUpperCase();
    const target = String(future || "").toUpperCase();
    return ((source === "NDX" && target === "NQ") || (source === "SPX" && target === "ES")) ? "additive" : "affine";
}

async function fetchConversion(ticker, future, apiKey, signal) {
    if (!future) return null;
    const cacheKey = `${ticker}|${future}`;
    const cached = convCache.get(cacheKey);
    if (cached?.conversion && Date.now() - cached.at < CONV_TTL_MS) return cached.conversion;
    if (cached?.promise) return cached.promise;

    const promise = (async () => {
        const model = conversionModel(ticker, future);
        const url = `${BASE}/futures/conversion?ticker=${encodeURIComponent(String(ticker).toLowerCase())}&future=${encodeURIComponent(future)}&model=${model}`;
        const response = await fetchJson(url, apiKey, signal, "futures conversion");
        const multiplier = Number(response.multiplier);
        const additive = Number(response.additive);
        if (!Number.isFinite(multiplier) || !Number.isFinite(additive)) throw new Error("futures conversion returned invalid coefficients");
        return { multiplier, additive, contract: response.future_contract || future, model };
    })();
    convCache.set(cacheKey, { promise });
    try {
        const conversion = await promise;
        convCache.set(cacheKey, { at: Date.now(), conversion });
        return conversion;
    } catch (error) {
        if (convCache.get(cacheKey)?.promise === promise) convCache.delete(cacheKey);
        throw error;
    }
}

async function sendConversion(tab, message) {
    const chart = Number(message?.chart);
    const version = Number(message?.version);
    const symbol = String(message?.symbol || "").trim().toUpperCase();
    const future = String(message?.future || "").trim().toUpperCase();
    const entry = tabFetch.get(tab);
    const config = Number.isInteger(chart) ? entry?.charts?.[chart] : null;
    if (!entry || entry.version !== version || !config || config.symbol !== symbol || config.futuresTarget !== future) return;
    if (!globalApiKey) {
        pushToTab(tab, { type: "conversion", chart, version, ok: false, symbol, future, error: "API key not configured" });
        return;
    }
    try {
        const conversion = await fetchConversion(symbol, future, globalApiKey, AbortSignal.timeout(REQUEST_TIMEOUT_MS));
        if (tabFetch.get(tab) !== entry || entry.version !== version || entry.charts[chart]?.symbol !== symbol || entry.charts[chart]?.futuresTarget !== future) return;
        pushToTab(tab, { type: "conversion", chart, version, ok: true, symbol, future, conv: conversion });
    } catch (error) {
        if (tabFetch.get(tab) !== entry || entry.version !== version) return;
        pushToTab(tab, { type: "conversion", chart, version, ok: false, symbol, future, error: String(error?.message || error) });
    }
}

function majorHistorySessionRange(now = new Date()) {
    const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    let sessionDay = today;
    const todayOpen = today.getTime() + 13.5 * 60 * 60 * 1000;
    if (today.getUTCDay() === 0 || today.getUTCDay() === 6 || now.getTime() < todayOpen) {
        do { sessionDay = new Date(sessionDay.getTime() - 24 * 60 * 60 * 1000); }
        while (sessionDay.getUTCDay() === 0 || sessionDay.getUTCDay() === 6);
    }
    const start = Math.floor((sessionDay.getTime() + 13.5 * 60 * 60 * 1000) / 1000);
    const close = Math.floor((sessionDay.getTime() + 20 * 60 * 60 * 1000) / 1000);
    const isToday = sessionDay.getTime() === today.getTime();
    return { start, end: isToday ? Math.max(start, Math.min(Math.floor(now.getTime() / 1000), close)) : close };
}

function historicalMajorValue(item, keys) {
    for (const key of keys) {
        const value = Number(item?.[key]);
        if (Number.isFinite(value) && value !== 0) return value;
    }
    return null;
}

async function fetchMajorHistory(symbol, mask, apiKey) {
    const range = majorHistorySessionRange();
    const cacheKey = `${symbol}|${range.start}|${mask}`;
    const cached = majorHistoryCache.get(cacheKey);
    if (cached?.result && Date.now() - cached.at < 5_000) return cached.result;
    if (cached?.promise) return cached.promise;

    const promise = (async () => {
        const url = `${BASE}/${TRADINGVIEW_INTEGRATION}/hist/${encodeURIComponent(symbol)}/classic/gex_full/majors/${mask}`;
        const response = await fetchJson(url, apiKey, AbortSignal.timeout(REQUEST_TIMEOUT_MS), `${symbol} historical majors`, {
            method: "POST",
            body: range,
            plugin: TRADINGVIEW_PLUGIN_HEADER,
        });
        if (!Array.isArray(response)) throw new Error("historical majors returned an invalid response");
        const series = { majorPosVol: [], majorNegVol: [], zeroGamma: [] };
        for (const item of response.slice(0, 100000)) {
            let timestamp = Number(item?.timestamp);
            if (timestamp > 100000000000) timestamp /= 1000;
            if (!Number.isFinite(timestamp)) continue;
            timestamp = Math.floor(timestamp);
            if (mask & 1) {
                const value = historicalMajorValue(item, ["major_call_gamma", "major_positive", "major_pos_vol"]);
                if (value != null) series.majorPosVol.push([timestamp, value]);
            }
            if (mask & 2) {
                const value = historicalMajorValue(item, ["major_put_gamma", "major_negative", "major_neg_vol"]);
                if (value != null) series.majorNegVol.push([timestamp, value]);
            }
            if (mask & 4) {
                const value = historicalMajorValue(item, ["zero_gamma"]);
                if (value != null) series.zeroGamma.push([timestamp, value]);
            }
        }
        return { sessionStart: range.start, sessionEnd: range.end, series };
    })();
    majorHistoryCache.set(cacheKey, { promise });
    try {
        const result = await promise;
        majorHistoryCache.set(cacheKey, { at: Date.now(), result });
        return result;
    } catch (error) {
        if (majorHistoryCache.get(cacheKey)?.promise === promise) majorHistoryCache.delete(cacheKey);
        throw error;
    }
}

async function sendMajorHistory(tab, message) {
    const chart = Number(message?.chart);
    const symbol = String(message?.symbol || "").trim().toUpperCase();
    const mask = Number(message?.mask);
    const entry = tabFetch.get(tab);
    const config = Number.isInteger(chart) ? entry?.charts?.[chart] : null;
    if (!entry || !config?.standardEnabled || config.symbol !== symbol || !Number.isInteger(mask) || mask < 1 || mask > 7) return;
    if (!globalApiKey) {
        pushToTab(tab, { type: "major-history", chart, symbol, mask, ok: false, error: "API key not configured" });
        return;
    }
    try {
        const result = await fetchMajorHistory(symbol, mask, globalApiKey);
        if (tabFetch.get(tab) !== entry || !entry.charts[chart]?.standardEnabled || entry.charts[chart]?.symbol !== symbol) return;
        pushToTab(tab, { type: "major-history", chart, symbol, mask, ok: true, ...result });
    } catch (error) {
        if (tabFetch.get(tab) !== entry || entry.charts[chart]?.symbol !== symbol) return;
        pushToTab(tab, { type: "major-history", chart, symbol, mask, ok: false, error: String(error?.message || error) });
    }
}

// ---- Quant-only Base + explicit-expiration realtime PubSub ------------------
function validExpirationDate(value) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const parsed = Date.parse(`${value}T00:00:00Z`);
    return Number.isFinite(parsed) && new Date(parsed).toISOString().slice(0, 10) === value;
}

function normalizeExpirationSubscriptions(raw) {
    if (!Array.isArray(raw)) return [];
    const result = [];
    for (const item of raw.slice(0, 30)) {
        if (!item || typeof item !== "object") continue;
        const date = String(item.date || "");
        if (!validExpirationDate(date)) continue;
        const profiles = [...new Set((Array.isArray(item.profiles) ? item.profiles : [])
            .map(String).filter((profile) => EXPIRY_PROFILE_TYPES.has(profile)))];
        if (profiles.length) result.push({ date, profiles });
    }
    return result;
}

function expiryGroupDescriptor(symbol, date, profile) {
    const compact = date.replaceAll("-", "");
    if (profile === "classic_vol" || profile === "classic_oi") {
        return { hub: "classic", group: `${symbol}_classic_gex_${compact}`, kind: "gex", source: "classic" };
    }
    if (profile === "state_gex") {
        return { hub: "state_gex", group: `${symbol}_state_gex_${compact}`, kind: "gex", source: "stateGex" };
    }
    return { hub: "state_greeks", group: `${symbol}_state_${profile}_${compact}`, kind: "greek", source: profile };
}

function addRealtimeDescriptor(descriptors, definition, consumer) {
    let descriptor = descriptors.get(definition.group);
    if (!descriptor) {
        descriptor = { ...definition, consumers: [] };
        descriptors.set(definition.group, descriptor);
    }
    if (!descriptor.consumers.some((existing) => existing.key === consumer.key)) descriptor.consumers.push(consumer);
}

function quantBaseGroupDescriptors(config) {
    const byGroup = new Map();
    for (const profile of config.profiles) {
        const category = classicCategory(profile.agg);
        let definition;
        if (profile.id === "vol" || profile.id === "oi") {
            definition = { hub: "classic", group: `${config.symbol}_classic_${category}`, kind: "gex" };
        } else if (profile.id === "s_gex") {
            definition = { hub: "state_gex", group: `${config.symbol}_state_${category}`, kind: "gex" };
        } else {
            definition = { hub: `state_greeks_${profile.agg}`, group: `${config.symbol}_state_gamma_${profile.agg}`, kind: "greek" };
        }
        let existing = byGroup.get(definition.group);
        if (!existing) {
            existing = { ...definition, profileIds: [] };
            byGroup.set(definition.group, existing);
        }
        existing.profileIds.push(profile.id);
    }
    return [...byGroup.values()];
}

function collectExpiryDescriptors() {
    const descriptors = new Map();
    const activeSnapshotKeys = new Set();
    for (const [tab, entry] of tabFetch) {
        for (const [chartText, config] of Object.entries(entry.charts)) {
            const chart = Number(chartText);
            if (isQuantTicker(config.symbol) && config.profiles.length) {
                const definitions = quantBaseGroupDescriptors(config);
                const expectedSources = config.profiles.map((profile) => profile.id);
                const snapshotKey = `${tab}|${chart}|${entry.version}|${config.symbol}|${JSON.stringify(config.profiles)}`;
                activeSnapshotKeys.add(snapshotKey);
                for (const definition of definitions) {
                    addRealtimeDescriptor(descriptors, definition, {
                        key: `${snapshotKey}|base`,
                        scope: "base",
                        snapshotKey,
                        tab,
                        chart,
                        entry,
                        version: entry.version,
                        config,
                        sourceIds: definition.profileIds,
                        expectedSources,
                    });
                }
            }

            for (const expiration of config.expirations || []) {
                for (const profile of expiration.profiles) {
                    const definition = expiryGroupDescriptor(config.symbol, expiration.date, profile);
                    addRealtimeDescriptor(descriptors, definition, {
                        key: `${tab}|${chart}|${expiration.date}`,
                        scope: "expiry",
                        tab,
                        chart,
                        date: expiration.date,
                        entry,
                        version: entry.version,
                    });
                }
            }
        }
    }
    for (const key of quantBaseSnapshots.keys()) if (!activeSnapshotKeys.has(key)) quantBaseSnapshots.delete(key);
    return descriptors;
}

function activeRealtimeConsumer(consumer) {
    return tabFetch.get(consumer.tab) === consumer.entry && consumer.entry.version === consumer.version;
}

function notifyExpiryStatus(text, ok) {
    const seen = new Set();
    for (const descriptor of expirySockets.descriptors.values()) {
        for (const consumer of descriptor.consumers) {
            if (consumer.scope !== "expiry") continue;
            const key = `${consumer.tab}|${consumer.chart}`;
            if (seen.has(key) || !activeRealtimeConsumer(consumer)) continue;
            seen.add(key);
            pushToTab(consumer.tab, { type: "expiry-status", chart: consumer.chart, version: consumer.version, ok, text });
        }
    }
}

function notifyQuantBaseStatus(text, ok, clearData = false) {
    const seen = new Set();
    for (const descriptor of expirySockets.descriptors.values()) {
        for (const consumer of descriptor.consumers) {
            if (consumer.scope !== "base") continue;
            const key = `${consumer.tab}|${consumer.chart}`;
            if (seen.has(key) || !activeRealtimeConsumer(consumer)) continue;
            seen.add(key);
            pushToTab(consumer.tab, {
                type: "quant-base-status",
                chart: consumer.chart,
                version: consumer.version,
                ok,
                clearData,
                text,
            });
        }
    }
}

function closeExpiryConnections() {
    for (const socket of expirySockets.sockets.values()) {
        try { socket.close(1000, "subscriptions changed"); } catch { }
    }
    expirySockets.sockets.clear();
}

function closeExpirySockets() {
    if (expirySockets.timer) clearTimeout(expirySockets.timer);
    expirySockets.timer = null;
    if (expirySockets.abortController) expirySockets.abortController.abort(new Error("expiration subscriptions closed"));
    expirySockets.abortController = null;
    expirySockets.generation++;
    closeExpiryConnections();
    expirySockets.signature = "";
    expirySockets.descriptors = new Map();
    quantBaseSnapshots.clear();
}

function scheduleExpirySync(force = false, delayMs = 250) {
    if (shuttingDown) return;
    if (expirySockets.timer) clearTimeout(expirySockets.timer);
    expirySockets.timer = setTimeout(() => {
        expirySockets.timer = null;
        rebuildExpirySockets(force).catch((error) => {
            if (/subscriptions changed|subscriptions closed/i.test(String(error?.message || error))) return;
            console.warn(`[iof] realtime socket setup failed: ${error.message}`);
            const status = /^Too many profiles/.test(error.message) ? error.message : "Connection error";
            notifyExpiryStatus(status, false);
            notifyQuantBaseStatus(status, false, true);
            if (!/HTTP 4\d\d|limit is 150/i.test(String(error?.message || error))) scheduleExpirySync(true, 10_000);
        });
    }, delayMs);
}

async function rebuildExpirySockets(force = false) {
    const descriptors = collectExpiryDescriptors();
    expirySockets.descriptors = descriptors;
    const groups = [...descriptors.keys()].sort();
    const signature = JSON.stringify(groups);
    if (!force && signature === expirySockets.signature) return;
    if (groups.length > 150) throw new Error("Too many profiles selected (150 maximum)");
    if (expirySockets.abortController) expirySockets.abortController.abort(new Error("subscriptions changed"));
    if (!groups.length) {
        expirySockets.abortController = null;
        expirySockets.generation++;
        closeExpiryConnections();
        expirySockets.signature = signature;
        quantBaseSnapshots.clear();
        return;
    }
    const requiredHubs = [...new Set([...descriptors.values()].map((descriptor) => descriptor.hub))];
    const canPatch = expirySockets.sockets.size > 0 && requiredHubs.every((hub) => expirySockets.sockets.has(hub));

    // Once the required hub connections exist, PATCH is a complete group
    // replacement and avoids tearing down sockets whenever a checkbox changes.
    if (!force && canPatch) {
        const controller = new AbortController();
        expirySockets.abortController = controller;
        const timeout = setTimeout(() => controller.abort(new Error("realtime group update timed out")), REQUEST_TIMEOUT_MS);
        try {
            await fetchJson(`${BASE}/negotiate`, globalApiKey, controller.signal, "expiration group update", {
                method: "PATCH",
                body: { groups: [...descriptors.values()].map((descriptor) => ({ hub: descriptor.hub, group: descriptor.group })) },
            });
            if (!controller.signal.aborted) {
                expirySockets.signature = signature;
                notifyExpiryStatus("Connected", true);
                notifyQuantBaseStatus("Waiting for data…", true);
            }
        } finally {
            clearTimeout(timeout);
        }
        return;
    }

    expirySockets.generation++;
    const generation = expirySockets.generation;
    closeExpiryConnections();
    expirySockets.signature = signature;
    if (!groups.length || !globalApiKey) return;

    const controller = new AbortController();
    expirySockets.abortController = controller;
    const timeout = setTimeout(() => controller.abort(new Error("realtime negotiation timed out")), REQUEST_TIMEOUT_MS);
    let negotiation;
    try {
        negotiation = await fetchJson(`${BASE}/negotiate`, globalApiKey, controller.signal, "expiration negotiation", {
            method: "POST",
            body: { groups },
        });
    } finally {
        clearTimeout(timeout);
    }
    if (generation !== expirySockets.generation || controller.signal.aborted) return;

    const urls = negotiation.websocket_urls;
    if (!urls || typeof urls !== "object") throw new Error("negotiation did not return websocket_urls");
    for (const hub of requiredHubs) if (!urls[hub]) throw new Error(`negotiation did not return the ${hub} hub URL`);
    for (const hub of requiredHubs) {
        const socket = new WebSocket(urls[hub], "json.reliable.webpubsub.azure.v1");
        expirySockets.sockets.set(hub, socket);
        socket.addEventListener("open", () => {
            if (generation !== expirySockets.generation) return;
            notifyExpiryStatus("Connected", true);
            notifyQuantBaseStatus("Waiting for data…", true);
        });
        socket.addEventListener("message", (event) => handleExpirySocketMessage(socket, event.data, generation));
        socket.addEventListener("error", () => {
            if (generation !== expirySockets.generation) return;
            notifyExpiryStatus("Connection error", false);
            notifyQuantBaseStatus("Connection error", false, true);
        });
        socket.addEventListener("close", () => {
            if (generation !== expirySockets.generation || shuttingDown) return;
            notifyExpiryStatus("Reconnecting…", false);
            notifyQuantBaseStatus("Reconnecting…", false, true);
            scheduleExpirySync(true, 2_000);
        });
    }
}

function handleQuantBaseSource(consumer, sourceName, source, timestamp) {
    if (!activeRealtimeConsumer(consumer)) return;
    let snapshot = quantBaseSnapshots.get(consumer.snapshotKey);
    if (!snapshot) {
        snapshot = { sources: {}, timestamps: {}, reportedFuturesError: false };
        quantBaseSnapshots.set(consumer.snapshotKey, snapshot);
    }
    snapshot.sources[sourceName] = source;
    snapshot.timestamps[sourceName] = Number(timestamp) || 0;

    if (consumer.config.futuresTarget) {
        if (!snapshot.reportedFuturesError) {
            snapshot.reportedFuturesError = true;
            pushToTab(consumer.tab, {
                type: "data",
                chart: consumer.chart,
                version: consumer.version,
                ok: false,
                error: `Futures conversion is unavailable for ${consumer.config.symbol}`,
            });
        }
        return;
    }
    if (!consumer.expectedSources.every((expected) => snapshot.sources[expected])) return;

    pushToTab(consumer.tab, {
        type: "data",
        chart: consumer.chart,
        version: consumer.version,
        ok: true,
        data: {
            ts: Math.max(...consumer.expectedSources.map((expected) => snapshot.timestamps[expected] || 0)),
            sources: Object.fromEntries(consumer.expectedSources.map((expected) => [expected, snapshot.sources[expected]])),
        },
        conv: null,
        transport: "pubsub",
    });
}

function handleExpirySocketMessage(socket, rawData, generation) {
    if (generation !== expirySockets.generation) return;
    try {
        const parsed = parseWebPubSubMessage(rawData);
        const groupData = parsed.groupData;
        if (!groupData) return;
        if (groupData.sequenceId !== null && socket.readyState === WebSocket.OPEN) {
            socket.send(JSON.stringify({ type: "sequenceAck", sequenceId: groupData.sequenceId }));
        }

        const descriptor = expirySockets.descriptors.get(groupData.group) ||
            [...expirySockets.descriptors.values()].find((candidate) => groupData.group.endsWith(`_${candidate.group}`));
        if (!descriptor) return;
        const decoded = descriptor.kind === "gex" ? decodeGex(groupData.any.value) : decodeGreek(groupData.any.value);
        const source = descriptor.kind === "gex" ? gexSource(decoded) : gammaSource(decoded);
        source.strikes.sort((a, b) => a[0] - b[0]);
        for (const consumer of descriptor.consumers) {
            if (!activeRealtimeConsumer(consumer)) continue;
            if (consumer.scope === "base") {
                for (const sourceId of consumer.sourceIds) handleQuantBaseSource(consumer, sourceId, source, decoded.timestamp);
                continue;
            }
            pushToTab(consumer.tab, {
                type: "expiry-data",
                chart: consumer.chart,
                version: consumer.version,
                date: consumer.date,
                source: descriptor.source,
                ts: decoded.timestamp || 0,
                data: source,
            });
        }
    } catch (error) {
        console.warn(`[iof] failed to decode realtime profile: ${error.message}`);
        notifyExpiryStatus("Data error", false);
        notifyQuantBaseStatus("Data error", false, true);
    }
}

async function getExpirationList(symbol) {
    const cached = expiryListCache.get(symbol);
    if (cached?.values && Date.now() - cached.at < EXPIRY_LIST_TTL_MS) return cached.values;
    if (cached?.promise) return cached.promise;

    const promise = (async () => {
        const response = await fetchJson(
            `${BASE}/options/${encodeURIComponent(symbol)}/expiries`,
            globalApiKey,
            AbortSignal.timeout(REQUEST_TIMEOUT_MS),
            `${symbol} expirations`,
        );
        const values = [...new Set((Array.isArray(response.expiries) ? response.expiries : [])
            .map(String).filter(validExpirationDate))].sort();
        expiryListCache.set(symbol, { at: Date.now(), values });
        return values;
    })();
    expiryListCache.set(symbol, { promise });
    try { return await promise; }
    catch (error) { expiryListCache.delete(symbol); throw error; }
}

async function sendExpirationList(tab, chart, config, entry) {
    if (!globalApiKey) return;
    try {
        const expirations = await getExpirationList(config.symbol);
        if (tabFetch.get(tab) !== entry || !entry.charts[chart]?.quantEnabled || entry.charts[chart]?.symbol !== config.symbol) return;
        pushToTab(tab, { type: "expiry-list", chart: Number(chart), version: entry.version, ok: true, symbol: config.symbol, expirations });
    } catch (error) {
        if (tabFetch.get(tab) !== entry || !entry.charts[chart]?.quantEnabled) return;
        pushToTab(tab, { type: "expiry-list", chart: Number(chart), version: entry.version, ok: false, symbol: config.symbol, error: String(error?.message || error) });
    }
}

// ---- Validated, non-overlapping per-tab polling -----------------------------
function normalizeStandardProfiles(raw, legacyMode, legacyAgg) {
    if (!Array.isArray(raw)) {
        const agg = ["zero", "one", "full"].includes(legacyAgg) ? legacyAgg : "zero";
        return legacyMode === "state"
            ? [{ id: "oi", agg }, { id: "s_gex", agg }, { id: "s_gamma", agg: "zero" }]
            : [{ id: "vol", agg }, { id: "oi", agg }];
    }
    const result = [];
    const seen = new Set();
    for (const item of raw.slice(0, STANDARD_PROFILE_AGGREGATIONS.size)) {
        if (!item || typeof item !== "object") continue;
        const id = String(item.id || "");
        const allowed = STANDARD_PROFILE_AGGREGATIONS.get(id);
        if (!allowed || seen.has(id)) continue;
        const agg = allowed.has(item.agg) ? item.agg : "zero";
        seen.add(id);
        result.push({ id, agg });
    }
    return result;
}

function normalizeCharts(rawCharts) {
    const result = {};
    if (!rawCharts || typeof rawCharts !== "object" || Array.isArray(rawCharts)) return result;

    for (const [rawIndex, raw] of Object.entries(rawCharts).slice(0, 8)) {
        if (!/^\d{1,2}$/.test(rawIndex) || !raw || typeof raw !== "object") continue;
        const index = Number(rawIndex);
        if (index < 0 || index > 15) continue;
        const symbol = String(raw.symbol || "").trim().toUpperCase();
        const futuresTarget = String(raw.futuresTarget || "").trim().toUpperCase();
        if (!/^[A-Z_]{1,6}$/.test(symbol)) continue;
        if (futuresTarget && !["NQ", "ES", "RTY", "YM", "GC", "CL"].includes(futuresTarget)) continue;
        const standardEnabled = raw.standardEnabled !== false;
        const quantEnabled = raw.quantEnabled !== false;
        const profiles = standardEnabled ? normalizeStandardProfiles(raw.profiles, raw.mode, raw.agg) : [];
        const expirations = quantEnabled ? normalizeExpirationSubscriptions(raw.expirations) : [];
        result[index] = { symbol, futuresTarget, standardEnabled, quantEnabled, profiles, expirations };
    }
    return result;
}

function restChartEntries(entry) {
    return Object.entries(entry.charts).filter(([, config]) =>
        config.standardEnabled && !isQuantTicker(config.symbol) && config.profiles.length);
}

function restartTabFetch(tab, entry) {
    if (entry.timer) clearTimeout(entry.timer);
    entry.timer = null;
    entry.generation++;
    if (entry.controller) entry.controller.abort(new Error("Configuration changed"));
    if (!entry.running && globalApiKey && quantTickerDiscoveryComplete && restChartEntries(entry).length) scheduleTabFetch(tab, entry, 0);
}

function setTabFetch(tab, message) {
    let entry = tabFetch.get(tab);
    if (!entry) {
        entry = { charts: {}, intervalSec: 2, version: 0, signature: "", pollingSignature: "", generation: 0, timer: null, controller: null, running: false };
        tabFetch.set(tab, entry);
    }

    const charts = normalizeCharts(message?.charts);
    const intervalSec = boundedNumber(message?.intervalSec, 2, 1, 60);
    const version = Number.isSafeInteger(message?.version) && message.version >= 0 ? message.version : 0;
    const signature = JSON.stringify({ charts, intervalSec, version });
    if (signature === entry.signature) return;
    const pollingCharts = Object.fromEntries(Object.entries(charts).map(([index, config]) => [index, {
        symbol: config.symbol,
        futuresTarget: config.futuresTarget,
        standardEnabled: config.standardEnabled,
        profiles: config.profiles,
    }]));
    const pollingSignature = JSON.stringify({ charts: pollingCharts, intervalSec });
    const pollingChanged = pollingSignature !== entry.pollingSignature;

    entry.charts = charts;
    entry.intervalSec = intervalSec;
    entry.version = version;
    entry.signature = signature;
    entry.pollingSignature = pollingSignature;
    if (globalApiKey) void ensureQuantTickerDiscovery();
    if (pollingChanged) restartTabFetch(tab, entry);
    for (const [chart, config] of Object.entries(entry.charts)) {
        if (config.quantEnabled) void sendExpirationList(tab, chart, config, entry);
    }
    scheduleExpirySync();
}

function marketTimeParts(date = new Date()) {
    const parts = {};
    for (const part of MARKET_PARTS_FORMATTER.formatToParts(date)) {
        if (part.type !== "literal") parts[part.type] = part.value;
    }
    return {
        year: Number(parts.year),
        month: Number(parts.month),
        day: Number(parts.day),
        weekday: parts.weekday,
        hour: Number(parts.hour),
        minute: Number(parts.minute),
        second: Number(parts.second),
    };
}

function marketLocalTimeToUtc(year, month, day, hour, minute) {
    const target = Date.UTC(year, month - 1, day, hour, minute);
    let guess = target;
    for (let iteration = 0; iteration < 4; iteration++) {
        const parts = marketTimeParts(new Date(guess));
        const rendered = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
        guess += target - rendered;
    }
    return guess;
}

function isMarketHours(date = new Date()) {
    const parts = marketTimeParts(date);
    if (parts.weekday === "Sat" || parts.weekday === "Sun") return false;
    const minute = parts.hour * 60 + parts.minute;
    return minute >= MARKET_OPEN_MINUTE && minute < MARKET_CLOSE_MINUTE;
}

function nextMarketOpenTime(date = new Date()) {
    const now = date.getTime();
    const parts = marketTimeParts(date);
    let calendar = new Date(Date.UTC(parts.year, parts.month - 1, parts.day));
    const minute = parts.hour * 60 + parts.minute;
    if (calendar.getUTCDay() === 0 || calendar.getUTCDay() === 6 || minute >= MARKET_OPEN_MINUTE) {
        calendar = new Date(calendar.getTime() + 24 * 60 * 60 * 1000);
    }
    while (calendar.getUTCDay() === 0 || calendar.getUTCDay() === 6) {
        calendar = new Date(calendar.getTime() + 24 * 60 * 60 * 1000);
    }
    let open = marketLocalTimeToUtc(calendar.getUTCFullYear(), calendar.getUTCMonth() + 1, calendar.getUTCDate(), 9, 30);
    if (open <= now) {
        do { calendar = new Date(calendar.getTime() + 24 * 60 * 60 * 1000); }
        while (calendar.getUTCDay() === 0 || calendar.getUTCDay() === 6);
        open = marketLocalTimeToUtc(calendar.getUTCFullYear(), calendar.getUTCMonth() + 1, calendar.getUTCDate(), 9, 30);
    }
    return open;
}

function recurringFetchDelay(entry, date = new Date()) {
    const now = date.getTime();
    const interval = entry.intervalSec * 1000;
    if (isMarketHours(date)) {
        const parts = marketTimeParts(date);
        const close = marketLocalTimeToUtc(parts.year, parts.month, parts.day, 16, 0);
        if (now + interval < close) return interval;
    }
    return Math.max(1_000, nextMarketOpenTime(date) - now);
}

function scheduleTabFetch(tab, entry, delayMs, allowOutsideMarket = true) {
    if (entry.timer) clearTimeout(entry.timer);
    entry.timer = setTimeout(() => {
        entry.timer = null;
        if (!allowOutsideMarket && !isMarketHours()) {
            scheduleTabFetch(tab, entry, recurringFetchDelay(entry), false);
            return;
        }
        void runTabFetch(tab, entry);
    }, delayMs);
}

function scheduleRecurringTabFetch(tab, entry) {
    scheduleTabFetch(tab, entry, recurringFetchDelay(entry), false);
}

async function runTabFetch(tab, entry) {
    if (tabFetch.get(tab) !== entry || entry.running || !globalApiKey || !restChartEntries(entry).length) return;
    entry.timer = null;
    entry.running = true;
    const generation = entry.generation;
    const version = entry.version;
    const controller = new AbortController();
    entry.controller = controller;
    const timeout = setTimeout(() => controller.abort(new Error(`API request timed out after ${REQUEST_TIMEOUT_MS}ms`)), REQUEST_TIMEOUT_MS);

    try {
        const jobs = restChartEntries(entry).map(([index, config]) => tickChart(tab, Number(index), config, entry, generation, version, controller.signal));
        await Promise.all(jobs);
    } finally {
        clearTimeout(timeout);
        if (entry.controller === controller) entry.controller = null;
        entry.running = false;
        if (tabFetch.get(tab) !== entry) return;
        if (entry.generation !== generation) {
            if (globalApiKey && restChartEntries(entry).length) scheduleTabFetch(tab, entry, 0);
        } else if (globalApiKey && restChartEntries(entry).length) {
            scheduleRecurringTabFetch(tab, entry);
        }
    }
}

async function tickChart(tab, index, config, entry, generation, version, signal) {
    const controller = new AbortController();
    const combinedSignal = AbortSignal.any([signal, controller.signal]);
    const requests = [
        fetchData(config, globalApiKey, combinedSignal),
        config.futuresTarget ? fetchConversion(config.symbol, config.futuresTarget, globalApiKey, combinedSignal) : Promise.resolve(null),
    ];
    try {
        // A requested futures conversion is mandatory. Never put unconverted index
        // strikes on a futures chart when conversion fails.
        const [data, conversion] = await Promise.all(requests);
        if (tabFetch.get(tab) !== entry || entry.generation !== generation || combinedSignal.aborted) return;
        pushToTab(tab, { type: "data", chart: index, version, ok: true, data, conv: conversion });
    } catch (error) {
        controller.abort(error);
        await Promise.allSettled(requests);
        if (tabFetch.get(tab) !== entry || entry.generation !== generation) return;
        const message = signal.aborted ? (signal.reason?.message || "API request aborted") : String(error?.message || error);
        pushToTab(tab, { type: "data", chart: index, version, ok: false, error: message });
    }
}

function stopTabFetch(tab, syncExpirations = true) {
    const entry = tabFetch.get(tab);
    if (!entry) return;
    if (entry.timer) clearTimeout(entry.timer);
    if (entry.controller) entry.controller.abort(new Error("TradingView tab closed"));
    tabFetch.delete(tab);
    if (syncExpirations) scheduleExpirySync();
}

function clearGlobalApiKey() {
    globalApiKey = "";
    tickerListCache = null;
    quantTickerSet.clear();
    quantBaseSnapshots.clear();
    quantTickerDiscoveryComplete = false;
    quantTickerDiscoveryPromise = null;
    writeApiKeyFile("");
    for (const [tab, entry] of tabFetch) restartTabFetch(tab, entry);
    closeExpirySockets();
    for (const client of clients) deliver(client, { type: "key-status", configured: false });
}

function deliver(client, message) {
    if (!client.contextId) return;
    const serialized = JSON.stringify(message);
    client.send("Runtime.evaluate", {
        contextId: client.contextId,
        expression: `window.__iofPort&&window.__iofPort.deliver(${serialized})`,
    }).catch(() => { });
}

function pushToTab(tab, message) {
    for (const client of clients) if (client.tabId === tab) deliver(client, message);
}

// ---- Minimal CDP client -----------------------------------------------------
function cdp(webSocketUrl) {
    const ws = new WebSocket(webSocketUrl);
    let id = 0;
    const pending = new Map();
    const handlers = {};

    ws.addEventListener("message", (event) => {
        let message;
        try { message = JSON.parse(event.data); } catch { return; }
        if (message.id && pending.has(message.id)) {
            const request = pending.get(message.id);
            pending.delete(message.id);
            message.error ? request.reject(new Error(message.error.message)) : request.resolve(message.result);
        } else if (message.method && handlers[message.method]) {
            handlers[message.method](message.params || {});
        }
    });

    const ready = new Promise((resolve, reject) => {
        ws.addEventListener("open", resolve, { once: true });
        ws.addEventListener("error", reject, { once: true });
    });

    ws.addEventListener("close", () => {
        for (const request of pending.values()) request.reject(new Error("CDP connection closed"));
        pending.clear();
    });

    return {
        ready,
        tabId: null,
        contextId: null,
        send(method, params = {}) {
            return new Promise((resolve, reject) => {
                const requestId = ++id;
                pending.set(requestId, { resolve, reject });
                try { ws.send(JSON.stringify({ id: requestId, method, params })); }
                catch (error) { pending.delete(requestId); reject(error); }
            });
        },
        on(method, handler) { handlers[method] = handler; },
        onClose(handler) { ws.addEventListener("close", handler, { once: true }); },
    };
}

function replyConfig(client, config) {
    if (!client.contextId) return;
    const safeConfig = sanitizeTabConfig(config || {});
    safeConfig.apiKeyConfigured = !!globalApiKey;
    client.send("Runtime.evaluate", {
        contextId: client.contextId,
        expression: `(function(cb){window.__iofCfgCb=null;if(cb)cb({iofConfigV1:${JSON.stringify(safeConfig)}});})(window.__iofCfgCb)`,
    }).catch(() => { });
}

function normalizeTabId(value) {
    const tab = String(value || "tab_default");
    return /^[A-Za-z0-9_-]{1,128}$/.test(tab) ? tab : "tab_default";
}

async function injectBundles(client) {
    const frameTree = await client.send("Page.getFrameTree");
    const frameId = frameTree?.frameTree?.frame?.id;
    if (!frameId) throw new Error("TradingView main frame was not found");

    const world = await client.send("Page.createIsolatedWorld", {
        frameId,
        worldName: ISOLATED_WORLD,
        grantUniveralAccess: false,
    });
    client.contextId = world.executionContextId;
    await client.send("Runtime.evaluate", { contextId: client.contextId, expression: buildContentBundle() });
    await client.send("Runtime.evaluate", { expression: buildInjectedBundle() });
}

function releaseClient(client, targetId) {
    clients.delete(client);
    attached.delete(targetId);
    const tab = client.tabId;
    if (tab && ![...clients].some((candidate) => candidate.tabId === tab)) stopTabFetch(tab);
}

async function attach(target) {
    if (attached.has(target.id)) return;
    attached.add(target.id);
    let client;
    try {
        client = cdp(target.webSocketDebuggerUrl);
        await client.ready;
        await client.send("Runtime.enable");
        await client.send("Page.enable");
        for (const name of ["__iofReqConfig", "__iofSave", "__iofSetConfig"]) {
            await client.send("Runtime.addBinding", { name, executionContextName: ISOLATED_WORLD });
        }

        client.on("Runtime.bindingCalled", ({ name, payload, executionContextId }) => {
            if (!client.contextId || executionContextId !== client.contextId) return;
            try {
                if (name === "__iofReqConfig") {
                    client.tabId = normalizeTabId(payload);
                    replyConfig(client, configs[client.tabId] || {});
                } else if (name === "__iofSave") {
                    const parsed = JSON.parse(payload);
                    const tab = normalizeTabId(parsed.tab);
                    if (client.tabId && tab !== client.tabId) return;
                    configs[tab] = sanitizeTabConfig(parsed.config);
                    writeConfigs();
                } else if (name === "__iofSetConfig") {
                    const parsed = JSON.parse(payload);
                    const tab = normalizeTabId(parsed.tab);
                    if (client.tabId && tab !== client.tabId) return;
                    if (parsed.msg?.type === "clear-api-key") {
                        clearGlobalApiKey();
                    } else if (parsed.msg?.type === "config") {
                        setTabFetch(tab, parsed.msg);
                    } else if (parsed.msg?.type === "ticker-lists-request") {
                        void sendTickerLists(tab, !!parsed.msg.refresh);
                    } else if (parsed.msg?.type === "conversion-request") {
                        void sendConversion(tab, parsed.msg);
                    } else if (parsed.msg?.type === "major-history-request") {
                        void sendMajorHistory(tab, parsed.msg);
                    } else if (parsed.msg?.type === "refresh-expirations") {
                        const entry = tabFetch.get(tab);
                        const chart = Number(parsed.msg.chart);
                        const config = entry?.charts?.[chart];
                        if (config?.quantEnabled && config.symbol === String(parsed.msg.symbol || "").toUpperCase()) {
                            expiryListCache.delete(config.symbol);
                            void sendExpirationList(tab, chart, config, entry);
                        }
                    }
                }
            } catch (error) {
                console.warn(`[iof] ignored invalid renderer message: ${error.message}`);
            }
        });

        // Register before injection so requests made during content startup can
        // receive their replies instead of racing clients.add().
        clients.add(client);
        client.onClose(() => releaseClient(client, target.id));

        let injecting = Promise.resolve();
        const reinject = () => {
            injecting = injecting.catch(() => { }).then(() => injectBundles(client));
            return injecting;
        };
        client.on("Page.loadEventFired", () => reinject().catch((error) => console.warn(`[iof] reinjection failed: ${error.message}`)));

        if (RELOAD_ON_ATTACH) await client.send("Page.reload", {});
        else await reinject();

        console.log(`[iof] injected isolated overlay → ${target.url}`);
    } catch (error) {
        if (client) releaseClient(client, target.id);
        else attached.delete(target.id);
        console.warn(`[iof] attach failed (${target.url || target.id}): ${error.message}`);
    }
}

function isTradingViewChartTarget(target) {
    if (target.type !== "page" || typeof target.url !== "string" || !target.webSocketDebuggerUrl) return false;
    if (TARGET_FILTER) return target.url.includes(TARGET_FILTER);
    try {
        const url = new URL(target.url);
        const host = url.hostname.toLowerCase();
        const tradingViewHost = host === "tradingview.com" || host.endsWith(".tradingview.com");
        return tradingViewHost && url.pathname.includes("/chart");
    } catch { return false; }
}

async function discover() {
    let response;
    try {
        response = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`, { signal: AbortSignal.timeout(2_000) });
    } catch (error) {
        debugFailureCount++;
        console.warn(`[iof] TradingView debug endpoint unavailable (${debugFailureCount}/${DEBUG_FAILURE_LIMIT}): ${error.message}`);
        if (debugFailureCount >= DEBUG_FAILURE_LIMIT) shutdown("TradingView Desktop was closed");
        return;
    }

    // Any HTTP response proves the desktop debug server is still alive. Invalid
    // target data is reported, but must not be mistaken for the app closing.
    debugFailureCount = 0;
    if (!response.ok) {
        console.warn(`[iof] TradingView target discovery returned HTTP ${response.status}`);
        return;
    }
    try {
        const targets = await response.json();
        if (!Array.isArray(targets)) throw new Error("invalid target list");
        for (const target of targets) if (isTradingViewChartTarget(target)) attach(target);
    } catch (error) {
        console.warn(`[iof] invalid TradingView target response: ${error.message}`);
    }
}

async function startCompanion() {
    if (!Number.isInteger(DEBUG_PORT) || DEBUG_PORT < 1 || DEBUG_PORT > 65535) throw new Error(`Invalid IOF_PORT: ${process.env.IOF_PORT}`);
    if (typeof WebSocket === "undefined") throw new Error("Node.js 22 or newer is required (WebSocket is unavailable).");
    for (const asset of ["content.js", "injected.js", "panel.css", "expiry-protobuf.js"]) {
        if (!fs.existsSync(path.join(EXT_DIR, asset))) throw new Error(`Missing overlay asset: ${asset}`);
    }

    console.log(`[iof] gexbot v1.0 companion — isolated renderer, port ${DEBUG_PORT}, secure config ${CONFIG_PATH}`);
    if (!globalApiKey) {
        quantTickerDiscoveryComplete = true;
        console.warn(`[iof] API key is not configured. Edit ${API_KEY_PATH}, then restart.`);
    } else {
        void ensureQuantTickerDiscovery();
    }
    await discover();
    if (!shuttingDown) discoveryTimer = setInterval(discover, 3_000);
}

async function main() {
    loadConfigs();
    writeOwnPidFile();
    await startCompanion();
}

main().catch((error) => {
    console.error(`[iof] ${error.message}`);
    process.exitCode = 1;
});

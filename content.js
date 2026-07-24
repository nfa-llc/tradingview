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

// Isolated-world overlay for TradingView. Draws gexbot profiles (per-strike
// bars + prior dots) and major levels over every chart using price↔pixel mappings
// from injected.js. Credentials remain exclusively in the Node companion.
//
// Split layouts use one independent overlay and config per chart.
// Each chart has its own gexbot ticker.
//  • Futures conversion: strikes/levels can be mapped onto a futures price scale
//    (NDX→NQ, SPX→ES…) using the multiplier/additive from the gexbot API.
(function () {
    "use strict";
    if (window.__iofLoaded) return;
    window.__iofLoaded = true;

    const PRIOR5 = ["1m", "5m", "10m", "15m", "30m"];
    const PRIOR3 = ["5m", "15m", "30m"];
    const PRIOR5C = ["#32CD32", "#FFD700", "#FFA500", "#FF4500", "#FF3B30"];
    const PRIOR3C = ["#22D3EE", "#3B82F6", "#1E40AF"];

    // Profile definitions. source → key in data.sources; idx → value column in a
    // strike row; priorIdx → column holding the priors[] array (or null).
    const PROFILE_DEFS = {
        vol:     { label: "Classic GEX Vol Profile", source: "vol",     aggregations: ["zero", "one", "full"], idx: 1, priorIdx: 3, priorLabels: PRIOR5, def: { show: true, agg: "zero", align: "left",  originPct: 88, widthPx: 160, thickness: 2, verticalOffsetPx: 0, posColor: "#2EA05A", negColor: "#C54A4A", priors: true,  priorSize: 3, priorColors: PRIOR5C.slice() } },
        oi:      { label: "Classic OI Profile",      source: "oi",      aggregations: ["zero", "one", "full"], idx: 2, priorIdx: null, priorLabels: [], def: { show: true, agg: "zero", align: "right", originPct: 12, widthPx: 160, thickness: 2, verticalOffsetPx: 0, posColor: "#37B24D", negColor: "#E64980", priors: false, priorSize: 3, priorColors: PRIOR5C.slice() } },
        // Retained only to migrate settings from the former State data mode.
        s_oi:    { label: "Classic OI Profile",      source: "oi",      aggregations: ["zero", "one", "full"], idx: 2, priorIdx: null, priorLabels: [], def: { show: true, agg: "zero", align: "right", originPct: 8,  widthPx: 120, thickness: 2, verticalOffsetPx: 0, posColor: "#37B24D", negColor: "#E64980", priors: false, priorSize: 3, priorColors: PRIOR5C.slice() } },
        s_gex:   { label: "State GEX Profile",       source: "s_gex",   aggregations: ["zero", "one", "full"], idx: 1, priorIdx: 3, priorLabels: PRIOR5, def: { show: true, agg: "zero", align: "left",  originPct: 78, widthPx: 120, thickness: 2, verticalOffsetPx: 0, posColor: "#2EA05A", negColor: "#C54A4A", priors: true,  priorSize: 3, priorColors: PRIOR5C.slice() } },
        s_gamma: { label: "State Gamma Profile",     source: "s_gamma", aggregations: ["zero", "one"],         idx: 3, priorIdx: 4, priorLabels: PRIOR3, def: { show: true, agg: "zero", align: "right", originPct: 90, widthPx: 120, thickness: 2, verticalOffsetPx: 0, posColor: "#22D3EE", negColor: "#A855F7", priors: true,  priorSize: 3, priorColors: PRIOR3C.slice() } },
    };
    const STANDARD_PROFILE_IDS = ["vol", "oi", "s_gex", "s_gamma"];
    const HISTORY_MAJOR_BITS = { majorPosVol: 1, majorNegVol: 2, zeroGamma: 4 };
    const HISTORY_MAJOR_IDS = Object.keys(HISTORY_MAJOR_BITS);
    const FUTURES_PAIRS = [
        ["SPX", "ES"], ["SPY", "ES"], ["NDX", "NQ"], ["QQQ", "NQ"], ["RUT", "RTY"],
        ["IWM", "RTY"], ["DIA", "YM"], ["GLD", "GC"], ["USO", "CL"],
    ];

    const LEVEL_DEFS = {
        majorPosVol: { source: "vol",     vkey: "majorPosVol", label: "Major Positive Vol", color: "#2EA05A" },
        majorNegVol: { source: "vol",     vkey: "majorNegVol", label: "Major Negative Vol", color: "#C54A4A" },
        zeroGamma:   { source: "vol",     vkey: "zeroGamma",   label: "Zero Gamma",         color: "#E0A94D" },
        majorPosOi:  { source: "oi",      vkey: "majorPosOi",  label: "Major Positive OI",  color: "#3FB950" },
        majorNegOi:  { source: "oi",      vkey: "majorNegOi",  label: "Major Negative OI",  color: "#EC407A" },
        s_zeroGamma: { source: "s_gex",   vkey: "zeroGamma",   label: "State Zero Gamma",   color: "#E0A94D" },
        s_majPos:    { source: "s_gex",   vkey: "majorPosVol", label: "State Major +",      color: "#2EA05A" },
        s_majNeg:    { source: "s_gex",   vkey: "majorNegVol", label: "State Major −",      color: "#C54A4A" },
        g_long:      { source: "s_gamma", vkey: "gammaLong",   label: "Gamma Long",         color: "#22D3EE" },
        g_short:     { source: "s_gamma", vkey: "gammaShort",  label: "Gamma Short",        color: "#A855F7" },
    };

    const EXPIRY_PROFILE_DEFS = {
        classic_vol: { label: "Classic GEX Vol", source: "classic", idx: 1, priorIdx: 3, priorLabels: PRIOR5, priorColors: PRIOR5C, colors: ["#2EA05A", "#C54A4A"] },
        classic_oi:  { label: "Classic GEX OI",  source: "classic", idx: 2, priorIdx: null, priorLabels: [], priorColors: [], colors: ["#37B24D", "#E64980"] },
        state_gex:   { label: "State GEX",       source: "stateGex", idx: 1, priorIdx: 3, priorLabels: PRIOR5, priorColors: PRIOR5C, colors: ["#10B981", "#EF4444"] },
        delta:       { label: "State Delta",     source: "delta", idx: 3, priorIdx: 4, priorLabels: PRIOR3, priorColors: PRIOR3C, colors: ["#60A5FA", "#F97316"] },
        gamma:       { label: "State Gamma",     source: "gamma", idx: 3, priorIdx: 4, priorLabels: PRIOR3, priorColors: PRIOR3C, colors: ["#22D3EE", "#A855F7"] },
        vanna:       { label: "State Vanna",     source: "vanna", idx: 3, priorIdx: 4, priorLabels: PRIOR3, priorColors: PRIOR3C, colors: ["#FACC15", "#F43F5E"] },
        charm:       { label: "State Charm",     source: "charm", idx: 3, priorIdx: 4, priorLabels: PRIOR3, priorColors: PRIOR3C, colors: ["#34D399", "#FB7185"] },
    };
    const EXPIRY_PROFILE_IDS = Object.keys(EXPIRY_PROFILE_DEFS);
    const EXPIRY_DEFAULTS_VERSION = 2; // Defaults version 2 migrated the initial 120px width to 50px.
    const NUMK = { originPct: [0, 100], widthPx: [10, 2000], thickness: [1, 20], verticalOffsetPx: [-5000, 5000, 0], priorSize: [1, 12] };

    function majorStyleDefaults(id, labelPosition = "left") {
        return {
            color: LEVEL_DEFS[id].color,
            labelPosition: labelPosition === "right" ? "right" : "left",
            labelPct: 50,
            lineStyle: "dashed",
            thickness: 1,
            history: false,
            historyColor: LEVEL_DEFS[id].color,
            historyLineStyle: "solid",
            historyThickness: 2,
        };
    }

    function normalizedMajorStyle(id, value, legacyLabelSide) {
        const defaults = majorStyleDefaults(id, legacyLabelSide);
        const raw = value && typeof value === "object" && !Array.isArray(value) ? value : {};
        const labelPct = Number(raw.labelPct);
        const thickness = Number(raw.thickness);
        const historyThickness = Number(raw.historyThickness);
        const color = typeof raw.color === "string" && /^#[0-9A-Fa-f]{6}$/.test(raw.color) ? raw.color : defaults.color;
        return {
            color,
            labelPosition: ["left", "right", "percent"].includes(raw.labelPosition) ? raw.labelPosition : defaults.labelPosition,
            labelPct: Number.isFinite(labelPct) ? clamp(labelPct, 0, 100) : defaults.labelPct,
            lineStyle: ["dashed", "solid", "dotted"].includes(raw.lineStyle) ? raw.lineStyle : defaults.lineStyle,
            thickness: Number.isFinite(thickness) ? clamp(thickness, 1, 20) : defaults.thickness,
            history: raw.history === true,
            historyColor: typeof raw.historyColor === "string" && /^#[0-9A-Fa-f]{6}$/.test(raw.historyColor) ? raw.historyColor : color,
            historyLineStyle: ["dashed", "solid", "dotted", "scatter"].includes(raw.historyLineStyle) ? raw.historyLineStyle : defaults.historyLineStyle,
            historyThickness: Number.isFinite(historyThickness) ? clamp(historyThickness, 1, 20) : defaults.historyThickness,
        };
    }

    function expiryProfileDefaults(id, show = false) {
        const def = EXPIRY_PROFILE_DEFS[id];
        return {
            show,
            align: "right",
            widthPx: 50,
            thickness: 2,
            verticalOffsetPx: 0,
            posColor: def.colors[0],
            negColor: def.colors[1],
            priors: false,
            priorSize: 3,
            priorColors: def.priorColors.slice(),
            anchorMode: "date",
            originPct: 90,
            anchorOffsetPx: 0,
        };
    }

    function normalizedExpiryProfile(id, value, legacyPlacement = null) {
        const def = EXPIRY_PROFILE_DEFS[id];
        const raw = value && typeof value === "object" && !Array.isArray(value) ? value : {};
        const profile = merge(expiryProfileDefaults(id), raw);
        if (legacyPlacement) {
            if (!Object.prototype.hasOwnProperty.call(raw, "anchorMode")) profile.anchorMode = legacyPlacement.anchorMode;
            if (!Object.prototype.hasOwnProperty.call(raw, "originPct")) profile.originPct = legacyPlacement.originPct;
            if (!Object.prototype.hasOwnProperty.call(raw, "anchorOffsetPx")) profile.anchorOffsetPx = legacyPlacement.anchorOffsetPx;
        }
        if (!["date", "window"].includes(profile.anchorMode)) profile.anchorMode = "date";
        profile.originPct = Number.isFinite(Number(profile.originPct)) ? clamp(Number(profile.originPct), 0, 100) : 90;
        profile.anchorOffsetPx = Number.isFinite(Number(profile.anchorOffsetPx)) ? clamp(Number(profile.anchorOffsetPx), -5000, 5000) : 0;
        profile.widthPx = Number.isFinite(Number(profile.widthPx)) ? clamp(Number(profile.widthPx), 10, 2000) : 50;
        profile.thickness = Number.isFinite(Number(profile.thickness)) ? clamp(Number(profile.thickness), 1, 20) : 2;
        profile.verticalOffsetPx = Number.isFinite(Number(profile.verticalOffsetPx)) ? clamp(Number(profile.verticalOffsetPx), -5000, 5000) : 0;
        profile.priorSize = Number.isFinite(Number(profile.priorSize)) ? clamp(Number(profile.priorSize), 1, 12) : 3;
        profile.priors = def.priorIdx != null && profile.priors === true;
        profile.posColor = typeof profile.posColor === "string" && /^#[0-9A-Fa-f]{6}$/.test(profile.posColor) ? profile.posColor : def.colors[0];
        profile.negColor = typeof profile.negColor === "string" && /^#[0-9A-Fa-f]{6}$/.test(profile.negColor) ? profile.negColor : def.colors[1];
        const rawPriorColors = Array.isArray(profile.priorColors) ? profile.priorColors : [];
        profile.priorColors = def.priorColors.map((color, index) =>
            typeof rawPriorColors[index] === "string" && /^#[0-9A-Fa-f]{6}$/.test(rawPriorColors[index]) ? rawPriorColors[index] : color);
        return profile;
    }

    function expirationDefaults(enabled = false, gammaOnly = false, profileTemplate = null) {
        const profiles = {};
        for (const id of EXPIRY_PROFILE_IDS) {
            profiles[id] = profileTemplate?.[id]
                ? normalizedExpiryProfile(id, profileTemplate[id])
                : expiryProfileDefaults(id, gammaOnly && id === "gamma");
        }
        return { enabled, profiles };
    }

    function draftExpirationSubscriptions(chart) {
        const applied = {};
        for (const [date, selection] of Object.entries(chart.expirations?.selections || {}).sort(([a], [b]) => a.localeCompare(b))) {
            if (!selection.enabled) continue;
            const profiles = EXPIRY_PROFILE_IDS.filter((id) => selection.profiles?.[id]?.show);
            if (profiles.length) applied[date] = profiles;
        }
        return applied;
    }

    function sanitizeAppliedSubscriptions(value) {
        const applied = {};
        if (!value || typeof value !== "object" || Array.isArray(value)) return applied;
        for (const [date, profiles] of Object.entries(value).sort(([a], [b]) => a.localeCompare(b))) {
            if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Array.isArray(profiles)) continue;
            const valid = EXPIRY_PROFILE_IDS.filter((id) => profiles.includes(id));
            if (valid.length) applied[date] = valid;
        }
        return applied;
    }

    function expirationConnectionPending(chart) {
        return JSON.stringify(draftExpirationSubscriptions(chart)) !== JSON.stringify(sanitizeAppliedSubscriptions(chart.expirations?.applied));
    }

    function chartDefaults() {
        const profiles = {};
        for (const [id, d] of Object.entries(PROFILE_DEFS)) profiles[id] = clone(d.def);
        const levels = {};
        for (const id of Object.keys(LEVEL_DEFS)) levels[id] = true;
        return {
            standardEnabled: true,
            quantEnabled: true,
            symbol: "SPX",
            futuresTarget: "",   // "" = index prices; "NQ"/"ES"… = auto-convert via API
            manualConversion: null,
            labelSide: "left", // Legacy fallback for major-label placement.
            profiles, levels,
            majorStyles: {},
            quantProfileTemplate: null,
            expirations: { symbol: "SPX", defaultsVersion: EXPIRY_DEFAULTS_VERSION, defaultsInitialized: false, selections: {}, applied: {} },
        };
    }
    function buildDefaultConfig() {
        return { intervalSec: 2, charts: { 0: chartDefaults() } };
    }

    let config = buildDefaultConfig();
    let keyConfigured = false;          // Boolean only; the key never enters this world.
    let tvState = null;                 // { layout, count, maps: [...] }
    let compatibilityError = "";
    let dataByChart = {};               // idx → { ts, sources }
    let convByChart = {};               // idx → { multiplier, additive, contract }
    let statusByChart = {};             // idx → string
    let majorHistoryByChart = {};       // idx → raw intraday major series + bucket cache
    let expiryListsByChart = {};        // idx → { symbol, values, error }
    let expiryDataByChart = {};         // idx → date → source → profile data
    let expiryStatusByChart = {};       // idx → string
    let expiryEditorDateByChart = {};
    let expiryListScrollByChart = {};
    let expiryProfileOpenByKey = {};
    let expiryProfileItemOpenByKey = {};
    let expiryProfileScrollByKey = {};
    let tickerGroupOpenByTab = { base: true, expirations: true };
    let expiryAnchorsByChart = {};
    let majorHistoryCoordinatesByChart = {};
    let tickerLists = { loaded: false, loading: false, normal: null, quant: null, errors: { normal: "", quant: "" } };
    let tickerListRequestTimer = null;
    let anchorRequestId = 0;
    let anchorRequestTimer = null;
    let settingsTab = "base";
    let port = null;
    let dirty = true;                   // redraw only when something actually changed
    let uiChart = 0;                    // which chart the panel is editing
    let uiReady = false;
    let persistTimer = null;
    let dataVersion = 0;
    let lastDataSignature = "";

    function clone(o) { return JSON.parse(JSON.stringify(o)); }
    function merge(base, over) {
        if (!over) return base;
        for (const k of Object.keys(over)) {
            if (over[k] && typeof over[k] === "object" && !Array.isArray(over[k])) base[k] = merge(base[k] || {}, over[k]);
            else base[k] = over[k];
        }
        return base;
    }
    function normalizeChartConfig(chart) {
        let changed = false;
        if (Object.prototype.hasOwnProperty.call(chart, "enabled")) {
            const legacyEnabled = chart.enabled !== false;
            chart.standardEnabled = legacyEnabled;
            chart.quantEnabled = legacyEnabled;
            delete chart.enabled;
            changed = true;
        }
        if (typeof chart.standardEnabled !== "boolean") { chart.standardEnabled = true; changed = true; }
        if (typeof chart.quantEnabled !== "boolean") { chart.quantEnabled = true; changed = true; }
        if (!chart.profiles || typeof chart.profiles !== "object" || Array.isArray(chart.profiles)) {
            chart.profiles = {};
            changed = true;
        }
        for (const [id, def] of Object.entries(PROFILE_DEFS)) {
            const existing = chart.profiles[id] && typeof chart.profiles[id] === "object" && !Array.isArray(chart.profiles[id]) ? chart.profiles[id] : {};
            const normalized = merge(clone(def.def), existing);
            if (JSON.stringify(normalized) !== JSON.stringify(chart.profiles[id])) changed = true;
            chart.profiles[id] = normalized;
        }
        if (chart.standardProfilesVersion !== 1) {
            const legacyMode = chart.mode === "state" ? "state" : "classic";
            const legacyAgg = ["zero", "one", "full"].includes(chart.agg) ? chart.agg : "zero";
            if (legacyMode === "state") {
                chart.profiles.oi = merge(clone(PROFILE_DEFS.oi.def), chart.profiles.s_oi);
                chart.profiles.vol.show = false;
            } else {
                chart.profiles.s_gex.show = false;
                chart.profiles.s_gamma.show = false;
            }
            for (const id of STANDARD_PROFILE_IDS) chart.profiles[id].agg = id === "s_gamma" ? "zero" : legacyAgg;
            chart.standardProfilesVersion = 1;
            delete chart.mode;
            delete chart.agg;
            changed = true;
        }
        for (const id of STANDARD_PROFILE_IDS) {
            const profile = chart.profiles[id];
            const def = PROFILE_DEFS[id];
            if (typeof profile.show !== "boolean") { profile.show = !!def.def.show; changed = true; }
            if (!def.aggregations.includes(profile.agg)) { profile.agg = def.def.agg; changed = true; }
            const verticalOffsetPx = Number(profile.verticalOffsetPx);
            const normalizedVerticalOffsetPx = Number.isFinite(verticalOffsetPx) ? clamp(verticalOffsetPx, -5000, 5000) : 0;
            if (profile.verticalOffsetPx !== normalizedVerticalOffsetPx) { profile.verticalOffsetPx = normalizedVerticalOffsetPx; changed = true; }
        }
        const rawManual = chart.manualConversion;
        const rawMultiplier = Number(rawManual?.multiplier);
        const rawAdditive = Number(rawManual?.additive);
        let manualConversion = rawManual && Number.isFinite(rawMultiplier) && Number.isFinite(rawAdditive)
            ? { multiplier: rawMultiplier, additive: rawAdditive }
            : null;
        const legacyOffset = Number(chart.offset);
        if (!manualConversion && !chart.futuresTarget && Number.isFinite(legacyOffset) && legacyOffset !== 0) {
            manualConversion = { multiplier: 1, additive: legacyOffset };
        }
        if (JSON.stringify(manualConversion) !== JSON.stringify(chart.manualConversion)) changed = true;
        chart.manualConversion = manualConversion;
        if (chart.manualConversion && chart.futuresTarget) { chart.futuresTarget = ""; changed = true; }
        if (Object.prototype.hasOwnProperty.call(chart, "offset")) { delete chart.offset; changed = true; }
        if (!chart.majorStyles || typeof chart.majorStyles !== "object" || Array.isArray(chart.majorStyles)) {
            chart.majorStyles = {};
            changed = true;
        }
        if (!chart.levels || typeof chart.levels !== "object" || Array.isArray(chart.levels)) {
            chart.levels = {};
            changed = true;
        }
        for (const id of Object.keys(LEVEL_DEFS)) {
            const normalized = normalizedMajorStyle(id, chart.majorStyles[id], chart.labelSide);
            if (JSON.stringify(normalized) !== JSON.stringify(chart.majorStyles[id])) changed = true;
            chart.majorStyles[id] = normalized;
            if (typeof chart.levels[id] !== "boolean") {
                chart.levels[id] = true;
                changed = true;
            }
        }
        const rawQuantProfileTemplate = chart.quantProfileTemplate && typeof chart.quantProfileTemplate === "object" && !Array.isArray(chart.quantProfileTemplate)
            ? chart.quantProfileTemplate
            : null;
        if (rawQuantProfileTemplate) {
            const normalizedTemplate = {};
            for (const id of EXPIRY_PROFILE_IDS) normalizedTemplate[id] = normalizedExpiryProfile(id, rawQuantProfileTemplate[id]);
            if (JSON.stringify(normalizedTemplate) !== JSON.stringify(chart.quantProfileTemplate)) changed = true;
            chart.quantProfileTemplate = normalizedTemplate;
        } else if (chart.quantProfileTemplate !== null) {
            chart.quantProfileTemplate = null;
            changed = true;
        }
        if (!chart.expirations || typeof chart.expirations !== "object") {
            chart.expirations = { symbol: chart.symbol || "SPX", defaultsVersion: EXPIRY_DEFAULTS_VERSION, defaultsInitialized: false, selections: {}, applied: {} };
            changed = true;
        }
        if (!chart.expirations.selections || typeof chart.expirations.selections !== "object") {
            chart.expirations.selections = {};
            changed = true;
        }
        const hadAppliedSubscriptions = Object.prototype.hasOwnProperty.call(chart.expirations, "applied");
        if (!chart.expirations.symbol) { chart.expirations.symbol = chart.symbol || "SPX"; changed = true; }
        for (const [date, existingValue] of Object.entries(chart.expirations.selections)) {
            const existing = existingValue && typeof existingValue === "object" && !Array.isArray(existingValue) ? existingValue : {};
            const existingProfiles = existing.profiles && typeof existing.profiles === "object" && !Array.isArray(existing.profiles) ? existing.profiles : {};
            const legacyAnchorMode = ["date", "window"].includes(existing.anchorMode) ? existing.anchorMode : "date";
            const legacyOriginPct = Number.isFinite(Number(existing.originPct)) ? clamp(Number(existing.originPct), 0, 100) : 90;
            const legacyAnchorOffsetPx = Number.isFinite(Number(existing.anchorOffsetPx)) ? clamp(Number(existing.anchorOffsetPx), -5000, 5000) : 0;
            const selection = merge(expirationDefaults(), existing);
            chart.expirations.selections[date] = selection;
            for (const id of EXPIRY_PROFILE_IDS) {
                const profile = normalizedExpiryProfile(id, existingProfiles[id], {
                    anchorMode: legacyAnchorMode,
                    originPct: legacyOriginPct,
                    anchorOffsetPx: legacyAnchorOffsetPx,
                });
                if (JSON.stringify(profile) !== JSON.stringify(existingProfiles[id])) changed = true;
                selection.profiles[id] = profile;
            }
            for (const key of ["anchorMode", "originPct", "anchorOffsetPx"]) {
                if (Object.prototype.hasOwnProperty.call(selection, key)) { delete selection[key]; changed = true; }
            }
        }
        if (!hadAppliedSubscriptions) {
            chart.expirations.applied = draftExpirationSubscriptions(chart);
            changed = true;
        } else {
            const sanitizedApplied = sanitizeAppliedSubscriptions(chart.expirations.applied);
            if (JSON.stringify(sanitizedApplied) !== JSON.stringify(chart.expirations.applied)) changed = true;
            chart.expirations.applied = sanitizedApplied;
        }
        if ((Number(chart.expirations.defaultsVersion) || 0) < EXPIRY_DEFAULTS_VERSION) {
            for (const selection of Object.values(chart.expirations.selections)) {
                for (const profile of Object.values(selection.profiles || {})) {
                    if (Number(profile.widthPx) === 120) profile.widthPx = 50;
                }
            }
            chart.expirations.defaultsVersion = EXPIRY_DEFAULTS_VERSION;
            changed = true;
        }
        return changed;
    }

    function chartCfg(i) {
        if (!config.charts[i]) { config.charts[i] = chartDefaults(); saveConfig(); }
        if (normalizeChartConfig(config.charts[i])) saveConfig();
        return config.charts[i];
    }

    function expirationSelection(chart, date, create = true) {
        normalizeChartConfig(chart);
        if (!chart.expirations.selections[date] && create) {
            chart.expirations.selections[date] = expirationDefaults(false, false, chart.quantProfileTemplate);
        }
        return chart.expirations.selections[date] || null;
    }

    function normalizeTvState(state) {
        if (!state || !Array.isArray(state.maps)) return null;
        const maps = state.maps.slice(0, 8).filter((m) =>
            Number.isInteger(m.idx) && m.idx >= 0 && m.idx <= 15 &&
            [m.paneTop, m.paneLeft, m.paneW, m.H, m.priceTop, m.priceBottom].every(Number.isFinite) &&
            m.paneW > 0 && m.H > 0 && m.priceTop !== m.priceBottom);
        if (!maps.length) return null;
        const occlusions = (Array.isArray(state.occlusions) ? state.occlusions : []).slice(0, 32).filter((rect) =>
            rect && [rect.left, rect.top, rect.w, rect.h].every(Number.isFinite) && rect.w > 0 && rect.h > 0);
        return { layout: String(state.layout || "unknown").slice(0, 32), count: maps.length, maps, occlusions };
    }

    // Keep date-anchored Quant profiles and Major history points moving with the
    // chart at the geometry update rate. Exact time-coordinate lookups remain
    // debounced and reconcile these inexpensive logical-range transformations.
    function transformAnchoredCoordinates(previousState, nextState) {
        if (!previousState) return;
        const transformedExpiryAnchors = {};
        const transformedHistoryCoordinates = {};
        for (const next of nextState.maps) {
            const previous = previousState.maps.find((map) => map.idx === next.idx);
            if (!previous || previous.resolution !== next.resolution ||
                ![previous.logicalFrom, previous.logicalTo, next.logicalFrom, next.logicalTo].every(Number.isFinite) ||
                previous.logicalFrom === previous.logicalTo || next.logicalFrom === next.logicalTo) continue;

            const transform = (coordinates) => {
                const result = {};
                for (const [key, absoluteX] of Object.entries(coordinates || {})) {
                    const oldX = Number(absoluteX);
                    if (!Number.isFinite(oldX)) continue;
                    const logical = previous.logicalFrom + ((oldX - previous.paneLeft) / previous.paneW) * (previous.logicalTo - previous.logicalFrom);
                    const newX = next.paneLeft + ((logical - next.logicalFrom) / (next.logicalTo - next.logicalFrom)) * next.paneW;
                    if (Number.isFinite(newX)) result[key] = newX;
                }
                return result;
            };

            if (expiryAnchorsByChart[next.idx]) transformedExpiryAnchors[next.idx] = transform(expiryAnchorsByChart[next.idx]);
            if (majorHistoryCoordinatesByChart[next.idx]) transformedHistoryCoordinates[next.idx] = transform(majorHistoryCoordinatesByChart[next.idx]);
        }
        expiryAnchorsByChart = transformedExpiryAnchors;
        majorHistoryCoordinatesByChart = transformedHistoryCoordinates;
    }

    window.addEventListener("message", (e) => {
        const d = e.data;
        if (d?.__iofTVPaneSelected && d.bridgeVersion === 2) {
            const index = Number(d.idx);
            if (!Number.isInteger(index) || !tvState?.maps.some((map) => map.idx === index) || uiChart === index) return;
            uiChart = index;
            if (uiReady) renderBody();
            return;
        }
        if (d?.__iofTVAnchors && d.bridgeVersion === 2) {
            if (d.requestId !== anchorRequestId || !d.anchors || typeof d.anchors !== "object") return;
            expiryAnchorsByChart = d.anchors;
            // A newly opened candle or temporarily invalidated pane rectangle can
            // make an exact lookup partial. Merge successful coordinates rather
            // than erasing every already-drawable history point.
            const incomingHistoryCoordinates = d.timeCoordinates && typeof d.timeCoordinates === "object" ? d.timeCoordinates : {};
            for (const [index, coordinates] of Object.entries(incomingHistoryCoordinates)) {
                if (!coordinates || typeof coordinates !== "object") continue;
                majorHistoryCoordinatesByChart[index] = { ...(majorHistoryCoordinatesByChart[index] || {}), ...coordinates };
            }
            dirty = true;
            return;
        }
        if (!d || !d.__iofTV || d.bridgeVersion !== 2) return;
        if (d.error) {
            compatibilityError = String(d.error).slice(0, 180);
            tvState = null;
            dataByChart = {};
            convByChart = {};
            dirty = true;
            if (uiReady) { renderBody(); sendConfig(true); }
            return;
        }

        const nextState = normalizeTvState(d.state);
        if (!nextState) return;
        const previousIndexes = tvState ? tvState.maps.map((m) => m.idx).join(",") : "";
        const nextIndexes = nextState.maps.map((m) => m.idx).join(",");
        const previousActiveIndex = tvState?.maps.find((map) => map.active)?.idx;
        const nextActiveIndex = nextState.maps.find((map) => map.active)?.idx;
        const activeChartChanged = Number.isInteger(nextActiveIndex) && previousActiveIndex !== nextActiveIndex;
        const previousTimeAvailable = tvState?.maps.some((m) => m.idx === uiChart && Number.isFinite(m.timeFrom) && Number.isFinite(m.timeTo));
        const nextTimeAvailable = nextState.maps.some((m) => m.idx === uiChart && Number.isFinite(m.timeFrom) && Number.isFinite(m.timeTo));
        transformAnchoredCoordinates(tvState, nextState);
        tvState = nextState;
        if (activeChartChanged) uiChart = nextActiveIndex;
        compatibilityError = "";
        dirty = true;
        requestExpirationAnchors();
        if (previousIndexes !== nextIndexes) {
            ensureChartConfigs();
            if (uiReady) { renderBody(); sendConfig(true); }
        } else if (uiReady && activeChartChanged) {
            renderBody();
        } else if (uiReady && settingsTab === "expirations" && previousTimeAvailable !== nextTimeAvailable) {
            renderBody();
        }
    });

    function ensureChartConfigs() {
        if (!tvState) return;
        let changed = false;
        for (const m of tvState.maps) {
            if (!config.charts[m.idx]) { config.charts[m.idx] = chartDefaults(); changed = true; }
        }
        if (changed) saveConfig();
    }

    chrome.storage.local.get("iofConfigV1", (r) => {
        const stored = r.iofConfigV1 || {};
        keyConfigured = !!stored.apiKeyConfigured;
        delete stored.apiKey;
        delete stored.apiKeyConfigured;
        config = merge(buildDefaultConfig(), stored);
        let migrated = false;
        for (const chart of Object.values(config.charts || {})) migrated = normalizeChartConfig(chart) || migrated;
        if (migrated) saveConfig();
        buildOverlay();
        buildPanelShell();
        uiReady = true;
        ensureChartConfigs();
        renderBody();
        connect();
        requestTickerLists();
        sendConfig(true);
        requestAnimationFrame(loop);
    });

    function persistConfig() {
        if (persistTimer) clearTimeout(persistTimer);
        persistTimer = null;
        const safe = clone(config);
        delete safe.apiKey;
        delete safe.apiKeyConfigured;
        chrome.storage.local.set({ iofConfigV1: safe });
    }
    function saveConfig() {
        clearTimeout(persistTimer);
        persistTimer = setTimeout(persistConfig, 200);
        dirty = true;
    }
    window.addEventListener("pagehide", () => { if (persistTimer) persistConfig(); });

    function requestExpirationAnchors() {
        const requestId = ++anchorRequestId;
        clearTimeout(anchorRequestTimer);
        anchorRequestTimer = setTimeout(() => {
            anchorRequestTimer = null;
            const requests = [];
            for (const map of tvState?.maps || []) {
                const chart = config.charts[map.idx];
                if (!chart) continue;
                let dates = [];
                if (chart.quantEnabled) {
                    const applied = sanitizeAppliedSubscriptions(chart.expirations?.applied);
                    dates = Object.entries(chart.expirations?.selections || {})
                        .filter(([date, selection]) => (applied[date] || []).some((id) => selection.profiles?.[id]?.anchorMode === "date"))
                        .map(([date]) => date)
                        .slice(0, 30);
                }

                let times = [];
                const historyState = majorHistoryByChart[map.idx];
                if (chart.standardEnabled && majorHistoryMask(chart) && historyState?.symbol === chart.symbol &&
                    Number.isFinite(map.timeFrom) && Number.isFinite(map.timeTo)) {
                    const plots = majorHistoryPlots(historyState, map.resolution);
                    const visibleTimes = new Set();
                    for (const id of HISTORY_MAJOR_IDS) {
                        if (!chart.majorStyles[id]?.history) continue;
                        const points = chart.majorStyles[id]?.historyLineStyle === "scatter"
                            ? plots.scatterSeries[id] || []
                            : plots.series[id] || [];
                        const start = Math.max(0, lowerBoundTimestamp(points, map.timeFrom) - 1);
                        for (let index = start; index < points.length && points[index][0] <= map.timeTo; index++) visibleTimes.add(points[index][0]);
                    }
                    times = [...visibleTimes].sort((a, b) => a - b).slice(0, 1200);
                }
                if (dates.length || times.length) requests.push({ idx: map.idx, dates, times });
            }
            if (requests.length) {
                window.postMessage({ __iofTVAnchorRequest: true, bridgeVersion: 2, requestId, requests }, "*");
            } else {
                expiryAnchorsByChart = {};
                dirty = true;
            }
        }, 50);
    }

    // ---- Companion port ----
    function onPortMsg(msg) {
        if (msg.type === "key-status") {
            keyConfigured = !!msg.configured;
            if (!keyConfigured) {
                clearTimeout(tickerListRequestTimer);
                tickerListRequestTimer = null;
                tickerLists = { loaded: false, loading: false, normal: null, quant: null, errors: { normal: "", quant: "" } };
                dataByChart = {};
                convByChart = {};
                statusByChart = {};
                expiryDataByChart = {};
                expiryStatusByChart = {};
                setStatus("API key not configured", false);
                dirty = true;
                if (uiReady) renderBody();
            }
            return;
        }
        if (msg.type === "ticker-lists") {
            clearTimeout(tickerListRequestTimer);
            tickerListRequestTimer = null;
            const clean = (value, futures = false) => {
                if (!value || typeof value !== "object" || Array.isArray(value)) return null;
                const list = (items) => Array.isArray(items)
                    ? [...new Set(items.filter((ticker) => typeof ticker === "string" && /^[A-Z_]{1,12}$/.test(ticker)))].slice(0, 1000)
                    : [];
                const result = { stocks: list(value.stocks), indexes: list(value.indexes) };
                if (futures) result.futures = list(value.futures);
                return result;
            };
            tickerLists = {
                loaded: true,
                loading: false,
                normal: clean(msg.normal, true),
                quant: clean(msg.quant),
                errors: {
                    normal: String(msg.errors?.normal || "").slice(0, 240),
                    quant: String(msg.errors?.quant || "").slice(0, 240),
                },
            };
            if (uiReady) renderBody();
            return;
        }
        if (msg.type === "major-history") {
            const i = Number(msg.chart);
            if (!Number.isInteger(i)) return;
            const chart = config.charts[i];
            const state = majorHistoryByChart[i];
            const mask = Number(msg.mask) & 7;
            if (!chart || !state || state.symbol !== msg.symbol || chart.symbol !== msg.symbol) return;
            state.pendingMask &= ~mask;
            const desiredMask = majorHistoryMask(chart);
            if (!(desiredMask & mask)) return;
            if (!msg.ok) {
                state.error = String(msg.error || "Historical majors unavailable").slice(0, 180);
                if (i === uiChart && settingsTab === "base") setStatus(`History error: ${state.error}`, false);
                return;
            }
            let acceptedMask = 0;
            for (const id of HISTORY_MAJOR_IDS) {
                const bit = HISTORY_MAJOR_BITS[id];
                if (!(mask & bit) || !(desiredMask & bit)) continue;
                const incoming = Array.isArray(msg.series?.[id]) ? msg.series[id] : [];
                state.series[id] = mergeMajorHistorySeries(state.series[id], incoming);
                acceptedMask |= bit;
            }
            state.loadedMask |= acceptedMask;
            state.error = "";
            state.revision++;
            state.plotCache = {};
            dirty = true;
            requestExpirationAnchors();
            return;
        }
        if (msg.version !== dataVersion) return;
        const i = Number(msg.chart);
        if (!Number.isInteger(i)) return;

        if (msg.type === "conversion") {
            const chart = config.charts[i];
            if (!chart || chart.symbol !== msg.symbol || chart.futuresTarget !== msg.future || chart.manualConversion) return;
            if (msg.ok && Number.isFinite(Number(msg.conv?.multiplier)) && Number.isFinite(Number(msg.conv?.additive))) {
                convByChart[i] = {
                    multiplier: Number(msg.conv.multiplier),
                    additive: Number(msg.conv.additive),
                    contract: String(msg.conv.contract || msg.future),
                };
                populateAutomaticConversionFields(i);
                dirty = true;
            } else if (!msg.ok) {
                statusByChart[i] = `Error: ${String(msg.error || "Futures conversion unavailable")}`;
                if (i === uiChart) setStatus(statusByChart[i], false);
            }
            return;
        }

        if (msg.type === "quant-base-status") {
            if (msg.clearData) {
                delete dataByChart[i];
                delete convByChart[i];
            }
            const text = String(msg.text || "Connection status");
            statusByChart[i] = msg.ok ? text : `Error: ${text}`;
            if (i === uiChart && settingsTab === "base") setStatus(statusByChart[i], !!msg.ok);
            dirty = true;
            return;
        }

        if (msg.type === "expiry-list") {
            if (msg.ok) {
                const values = Array.isArray(msg.expirations) ? msg.expirations : [];
                expiryListsByChart[i] = { symbol: msg.symbol, values, error: "" };
                const chart = chartCfg(i);
                let configChanged = false;
                if (chart.expirations.symbol !== msg.symbol) {
                    chart.expirations = { symbol: msg.symbol, defaultsVersion: EXPIRY_DEFAULTS_VERSION, defaultsInitialized: false, selections: {}, applied: {} };
                    expiryDataByChart[i] = {};
                    configChanged = true;
                }
                const available = new Set(values);
                for (const date of Object.keys(chart.expirations.selections)) {
                    if (!available.has(date)) {
                        delete chart.expirations.selections[date];
                        delete chart.expirations.applied?.[date];
                        configChanged = true;
                    }
                }
                if (!chart.expirations.defaultsInitialized) {
                    const today = new Date().toISOString().slice(0, 10);
                    const fridays = values.filter((date) => date >= today && new Date(`${date}T00:00:00Z`).getUTCDay() === 5).slice(0, 5);
                    for (const date of fridays) chart.expirations.selections[date] = expirationDefaults(true, true, chart.quantProfileTemplate);
                    chart.expirations.applied = draftExpirationSubscriptions(chart);
                    chart.expirations.defaultsInitialized = true;
                    configChanged = true;
                }
                if (configChanged) { saveConfig(); sendConfig(); }
            } else {
                expiryListsByChart[i] = { symbol: msg.symbol, values: [], error: String(msg.error || "Failed to load expirations") };
            }
            if (uiReady && i === uiChart && settingsTab === "expirations") renderBody();
            return;
        }

        if (msg.type === "expiry-data") {
            expiryDataByChart[i] ||= {};
            expiryDataByChart[i][msg.date] ||= {};
            expiryDataByChart[i][msg.date][msg.source] = { ts: msg.ts, ...msg.data };
            dirty = true;
            return;
        }

        if (msg.type === "expiry-status") {
            expiryStatusByChart[i] = msg.text || "";
            if (uiReady && i === uiChart && settingsTab === "expirations") renderBody();
            return;
        }

        if (msg.type !== "data") return;
        if (msg.ok) {
            const d = msg.data;
            for (const s of Object.values(d.sources)) if (s && Array.isArray(s.strikes)) s.strikes.sort((a, b) => a[0] - b[0]);
            dataByChart[i] = d;
            appendLiveMajorHistory(i, d);
            convByChart[i] = msg.conv || null;
            if (msg.conv) populateAutomaticConversionFields(i);
            const t = d.ts ? new Date(d.ts * 1000).toLocaleTimeString() : "—";
            const conv = msg.conv ? `  ·  ${msg.conv.contract} x${(+msg.conv.multiplier).toFixed(4)} ${msg.conv.additive >= 0 ? "+" : ""}${(+msg.conv.additive).toFixed(2)}` : "";
            statusByChart[i] = `OK ${t}${conv}`;
        } else {
            // Do not leave stale or unconverted data painted after a failed update.
            delete dataByChart[i];
            delete convByChart[i];
            statusByChart[i] = `Error: ${msg.error}`;
        }
        if (i === uiChart) setStatus(statusByChart[i], msg.ok);
        dirty = true;
    }
    function connect() {
        try {
            port = chrome.runtime.connect({ name: "gexbot" });
            port.onMessage.addListener(onPortMsg);
            port.onDisconnect.addListener(() => {
                port = null;
                lastDataSignature = "";
                clearTimeout(tickerListRequestTimer);
                tickerListRequestTimer = null;
                if (tickerLists.loading) {
                    tickerLists.loading = false;
                    tickerLists.errors = { normal: "Connection unavailable", quant: "Connection unavailable" };
                    if (uiReady) renderBody();
                }
            });
        } catch (e) { port = null; }
    }
    function ensurePort() { if (!port) connect(); }
    function requestTickerLists(refresh = false) {
        ensurePort();
        clearTimeout(tickerListRequestTimer);
        tickerLists.loading = true;
        tickerLists.errors = { normal: "", quant: "" };
        try {
            port.postMessage({ type: "ticker-lists-request", refresh });
            tickerListRequestTimer = setTimeout(() => {
                tickerListRequestTimer = null;
                if (!tickerLists.loading) return;
                tickerLists.loading = false;
                tickerLists.errors = { normal: "Request timed out", quant: "Request timed out" };
                if (uiReady) renderBody();
            }, 12_000);
        } catch (error) {
            port = null;
            tickerLists.loading = false;
            tickerLists.errors = { normal: "Connection unavailable", quant: "Connection unavailable" };
        }
        if (uiReady) renderBody();
    }

    function majorHistoryMask(chart) {
        let mask = 0;
        for (const id of HISTORY_MAJOR_IDS) if (chart.majorStyles?.[id]?.history) mask |= HISTORY_MAJOR_BITS[id];
        return mask;
    }

    function majorHistoryState(index, chart) {
        let state = majorHistoryByChart[index];
        if (!state || state.symbol !== chart.symbol) {
            state = {
                symbol: chart.symbol,
                loadedMask: 0,
                pendingMask: 0,
                series: { majorPosVol: [], majorNegVol: [], zeroGamma: [] },
                revision: 0,
                plotCache: {},
                error: "",
                requestArmed: true,
            };
            majorHistoryByChart[index] = state;
        }
        return state;
    }

    function mergeMajorHistorySeries(existing, incoming) {
        const byTime = new Map();
        for (const point of [...(Array.isArray(existing) ? existing : []), ...incoming.slice(0, 100000)]) {
            if (!Array.isArray(point) || point.length < 2) continue;
            let timestamp = Number(point[0]);
            const value = Number(point[1]);
            if (timestamp > 100000000000) timestamp /= 1000;
            if (!Number.isFinite(timestamp) || !Number.isFinite(value) || value === 0) continue;
            byTime.set(Math.floor(timestamp), value);
        }
        return [...byTime].sort((a, b) => a[0] - b[0]);
    }

    function appendMajorHistoryValue(series, timestamp, value) {
        if (!Number.isFinite(timestamp) || !Number.isFinite(value) || value === 0) return false;
        timestamp = Math.floor(timestamp > 100000000000 ? timestamp / 1000 : timestamp);
        const last = series[series.length - 1];
        if (!last || timestamp > last[0]) series.push([timestamp, value]);
        else if (timestamp === last[0]) last[1] = value;
        else {
            let low = 0, high = series.length;
            while (low < high) {
                const middle = (low + high) >> 1;
                if (series[middle][0] < timestamp) low = middle + 1;
                else high = middle;
            }
            if (series[low]?.[0] === timestamp) series[low][1] = value;
            else series.splice(low, 0, [timestamp, value]);
        }
        return true;
    }

    function appendLiveMajorHistory(index, data) {
        const chart = config.charts[index];
        if (!chart?.standardEnabled) return;
        const desiredMask = majorHistoryMask(chart);
        if (!desiredMask) return;
        const source = data?.sources?.vol || data?.sources?.oi;
        const levels = source?.levels;
        let timestamp = Number(source?.ts || data?.ts);
        if (!levels || !Number.isFinite(timestamp)) return;
        if (timestamp > 100000000000) timestamp /= 1000;
        const state = majorHistoryState(index, chart);
        let changed = false;
        for (const id of HISTORY_MAJOR_IDS) {
            const bit = HISTORY_MAJOR_BITS[id];
            if (desiredMask & bit) changed = appendMajorHistoryValue(state.series[id], timestamp, Number(levels[id])) || changed;
        }
        if (changed) {
            state.revision++;
            state.plotCache = {};
            dirty = true;
            const map = tvState?.maps.find((candidate) => candidate.idx === index);
            const coordinateStep = map ? Math.max(60, resolutionSeconds(map.resolution)) : null;
            const firstTimestamp = HISTORY_MAJOR_IDS.map((id) => state.series[id]?.[0]?.[0]).find(Number.isFinite);
            const coordinateOrigin = coordinateStep && coordinateStep < 86400 && Number.isFinite(firstTimestamp) ? Math.floor(firstTimestamp / 60) * 60 : 0;
            const bucketTimestamp = coordinateStep ? coordinateOrigin + Math.floor((timestamp - coordinateOrigin) / coordinateStep) * coordinateStep : null;
            if (bucketTimestamp != null && !Number.isFinite(Number(majorHistoryCoordinatesByChart[index]?.[bucketTimestamp]))) requestExpirationAnchors();
        }
    }

    function clearMajorHistorySeries(index, chart, id) {
        const state = majorHistoryState(index, chart);
        const bit = HISTORY_MAJOR_BITS[id];
        state.series[id] = [];
        state.loadedMask &= ~bit;
        state.error = "";
        state.revision++;
        state.plotCache = {};
        dirty = true;
    }

    function requestMajorHistoryForChart(index, chart) {
        if (!chart?.standardEnabled || !keyConfigured) return;
        const desiredMask = majorHistoryMask(chart);
        if (!desiredMask) return;
        const state = majorHistoryState(index, chart);
        if (!state.requestArmed) return;
        const missingMask = desiredMask & ~(state.loadedMask | state.pendingMask);
        state.requestArmed = false;
        if (!missingMask) return;
        state.pendingMask |= missingMask;
        ensurePort();
        try {
            port.postMessage({ type: "major-history-request", chart: index, symbol: chart.symbol, mask: missingMask });
        } catch (error) {
            state.pendingMask &= ~missingMask;
            state.error = "Connection unavailable";
            port = null;
        }
    }

    function sendConfig(force = false) {
        ensurePort();
        const charts = {};
        const activeIndexes = new Set(tvState && !compatibilityError ? tvState.maps.map((m) => String(m.idx)) : []);
        for (const [i, c] of Object.entries(config.charts)) {
            if (!activeIndexes.has(String(i))) continue;
            const profiles = c.standardEnabled ? STANDARD_PROFILE_IDS
                .filter((id) => c.profiles[id]?.show)
                .map((id) => ({ id, agg: c.profiles[id].agg })) : [];
            const expirations = c.quantEnabled ? Object.entries(sanitizeAppliedSubscriptions(c.expirations?.applied))
                .map(([date, selectedProfiles]) => ({ date, profiles: selectedProfiles })) : [];
            charts[i] = {
                symbol: c.symbol,
                futuresTarget: c.manualConversion ? "" : c.futuresTarget,
                standardEnabled: c.standardEnabled,
                quantEnabled: c.quantEnabled,
                profiles,
                expirations,
            };
        }

        const dataConfig = { intervalSec: config.intervalSec, charts };
        const signature = JSON.stringify(dataConfig);
        if (!force && signature === lastDataSignature) return;
        lastDataSignature = signature;
        dataVersion++;
        let sent = false;
        try {
            port.postMessage({ type: "config", version: dataVersion, ...dataConfig });
            sent = true;
            for (const [index, chart] of Object.entries(charts)) {
                if (chart.futuresTarget && (chart.standardEnabled || chart.quantEnabled) && !convByChart[index]) {
                    port.postMessage({
                        type: "conversion-request",
                        version: dataVersion,
                        chart: Number(index),
                        symbol: chart.symbol,
                        future: chart.futuresTarget,
                    });
                }
                requestMajorHistoryForChart(Number(index), config.charts[index]);
            }
        } catch (e) { port = null; lastDataSignature = ""; }
        requestExpirationAnchors();
        return sent;
    }

    function invalidateChartData(index) {
        delete dataByChart[index];
        delete convByChart[index];
        delete statusByChart[index];
        dirty = true;
    }

    // ---- Overlay canvas (one full-viewport canvas, clipped per chart) ----
    let canvas, ctx;
    function buildOverlay() {
        canvas = document.createElement("canvas");
        canvas.id = "iof-overlay";
        Object.assign(canvas.style, { position: "fixed", left: "0", top: "0", pointerEvents: "none", zIndex: "2147483000" });
        document.documentElement.appendChild(canvas);
        resizeCanvas();
        window.addEventListener("resize", resizeCanvas);
    }
    function resizeCanvas() {
        const dpr = window.devicePixelRatio || 1;
        canvas.width = innerWidth * dpr; canvas.height = innerHeight * dpr;
        canvas.style.width = innerWidth + "px"; canvas.style.height = innerHeight + "px";
        ctx = canvas.getContext("2d");
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        dirty = true;
    }

    // gexbot strikes are index prices. When a futures target is set, map them onto
    // the futures scale exactly like the API models it: price*multiplier + additive.
    // (For NDX→NQ / SPX→ES the worker asks for the "additive" model, so multiplier
    // is exactly 1 and additive is the true basis — no ladder rescaling.)
    function scalePrice(price, conv) {
        if (!conv) return price;
        return price * conv.multiplier + conv.additive;
    }

    function priceToY(price, m) {
        let frac;
        if (m.mode === 1) { const lt = Math.log(m.priceTop), lb = Math.log(m.priceBottom); frac = (lt - Math.log(price)) / (lt - lb); }
        else frac = (m.priceTop - price) / (m.priceTop - m.priceBottom);
        return m.paneTop + frac * m.H;
    }

    // ---- Draw ----
    function loop() { if (dirty) { dirty = false; draw(); } requestAnimationFrame(loop); }
    function draw() {
        if (!ctx) return;
        ctx.clearRect(0, 0, innerWidth, innerHeight);
        if (!tvState) return;

        for (const m of tvState.maps) {
            const cfg = config.charts[m.idx];
            if (!cfg || (!cfg.standardEnabled && !cfg.quantEnabled)) continue;
            const data = dataByChart[m.idx] || null;
            const conv = cfg.manualConversion || convByChart[m.idx] || null;
            if (cfg.futuresTarget && !conv) continue;

            // Clip to this chart's pane so a split neighbour can never be painted over.
            ctx.save();
            ctx.beginPath();
            ctx.rect(m.paneLeft, m.paneTop, m.paneW, m.H);
            ctx.clip();

            if (cfg.standardEnabled) {
                if (data) {
                    for (const id of STANDARD_PROFILE_IDS) {
                        const def = PROFILE_DEFS[id];
                        const src = data.sources[def.source];
                        if (src) drawProfile(cfg, cfg.profiles[id], src.strikes, def, m, conv);
                    }
                }
                drawMajorHistory(cfg, m, conv);
                if (data) drawMajors(cfg, data, m, conv);
            }
            if (cfg.quantEnabled) drawExpirationProfiles(cfg, m, conv);

            ctx.restore();
        }

        // The overlay has to sit above TradingView's chart canvases, which also
        // puts it above the app's DOM dialogs. Remove our pixels under every
        // detected dialog/menu so TradingView's own windows remain unobstructed.
        for (const rect of tvState.occlusions || []) ctx.clearRect(rect.left, rect.top, rect.w, rect.h);
    }

    function barRange(o, w, pos, a) { return a === "left" ? [o - w, o] : a === "right" ? [o, o + w] : (pos ? [o, o + w] : [o - w, o]); }
    function dotX(o, w, pos, a) { return a === "left" ? o - w : a === "right" ? o + w : (pos ? o + w : o - w); }

    function movingAverageMajorSeries(series, windowSeconds = 300) {
        const result = [];
        let first = 0;
        let sum = 0;
        for (let index = 0; index < (series || []).length; index++) {
            const timestamp = Number(series[index][0]);
            const value = Number(series[index][1]);
            if (!Number.isFinite(timestamp) || !Number.isFinite(value) || value === 0) continue;
            sum += value;
            while (first < index && Number(series[first][0]) < timestamp - windowSeconds) {
                sum -= Number(series[first][1]) || 0;
                first++;
            }
            result.push([timestamp, sum / (index - first + 1)]);
        }
        return result;
    }

    function resolutionSeconds(value) {
        const text = String(value || "").trim().toUpperCase();
        if (/^\d+$/.test(text)) return Math.max(1, Number(text)) * 60;
        const match = text.match(/^(\d+)?([SHDWM])$/);
        if (!match) return 60;
        const count = Math.max(1, Number(match[1] || 1));
        return count * ({ S: 1, H: 3600, D: 86400, W: 604800, M: 2592000 }[match[2]] || 60);
    }

    function sampleMovingAverageSeries(points, seconds) {
        const result = [];
        let current = null;
        const origin = seconds < 86400 && points.length ? Math.floor(points[0][0] / 60) * 60 : 0;
        for (const point of points) {
            const start = origin + Math.floor((point[0] - origin) / seconds) * seconds;
            if (!current || current[0] !== start) {
                current = [start, point[1]];
                result.push(current);
            } else {
                current[1] = point[1];
            }
        }
        return result;
    }

    function scatterMajorSeries(points, seconds) {
        const origin = seconds < 86400 && points.length ? Math.floor(points[0][0] / 60) * 60 : 0;
        return points.map((point) => [
            origin + Math.floor((point[0] - origin) / seconds) * seconds,
            point[1],
        ]);
    }

    function majorHistoryPlots(state, resolution) {
        const seconds = Math.max(60, resolutionSeconds(resolution));
        const key = String(seconds);
        const cached = state.plotCache[key];
        if (cached?.revision === state.revision) return cached;
        const result = { revision: state.revision, seconds, series: {}, scatterSeries: {} };
        for (const id of HISTORY_MAJOR_IDS) {
            const raw = state.series[id] || [];
            const average = movingAverageMajorSeries(raw, 60);
            result.series[id] = sampleMovingAverageSeries(average, seconds);
            result.scatterSeries[id] = scatterMajorSeries(raw, seconds);
        }
        state.plotCache[key] = result;
        return result;
    }

    function lowerBoundTimestamp(points, timestamp) {
        let low = 0, high = points.length;
        while (low < high) {
            const middle = (low + high) >> 1;
            if (points[middle][0] < timestamp) low = middle + 1;
            else high = middle;
        }
        return low;
    }

    function drawMajorHistory(chart, map, conv) {
        if (!Number.isFinite(map.timeFrom) || !Number.isFinite(map.timeTo) || map.timeFrom === map.timeTo) return;
        const mask = majorHistoryMask(chart);
        if (!mask) return;
        const state = majorHistoryByChart[map.idx];
        if (!state || state.symbol !== chart.symbol) return;
        const plots = majorHistoryPlots(state, map.resolution);
        const coordinates = majorHistoryCoordinatesByChart[map.idx] || {};

        ctx.setLineDash([]);
        ctx.lineJoin = "round";
        ctx.lineCap = "round";
        for (const id of HISTORY_MAJOR_IDS) {
            if (!(mask & HISTORY_MAJOR_BITS[id])) continue;
            const style = chart.majorStyles[id] || majorStyleDefaults(id, chart.labelSide);
            const historyLineStyle = ["dashed", "solid", "dotted", "scatter"].includes(style.historyLineStyle) ? style.historyLineStyle : "solid";
            const points = historyLineStyle === "scatter" ? plots.scatterSeries[id] : plots.series[id];
            if (!points?.length) continue;
            const start = Math.max(0, lowerBoundTimestamp(points, map.timeFrom) - 1);
            const historyThickness = clamp(Number(style.historyThickness) || 2, 1, 20);
            ctx.lineWidth = historyThickness;

            if (historyLineStyle === "scatter") {
                const radius = historyThickness;
                let hasDots = false;
                ctx.fillStyle = style.historyColor || style.color;
                ctx.beginPath();
                for (let index = start; index < points.length; index++) {
                    const [timestamp, value] = points[index];
                    if (timestamp > map.timeTo) break;
                    const x = Number(coordinates[timestamp]);
                    const y = priceToY(scalePrice(value, conv), map);
                    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
                    ctx.moveTo(x + radius, y);
                    ctx.arc(x, y, radius, 0, Math.PI * 2);
                    hasDots = true;
                }
                if (hasDots) ctx.fill();
                continue;
            }

            let started = false;
            let hasDrawableSegment = false;
            let previousTimestamp = null;
            ctx.strokeStyle = style.historyColor || style.color;
            ctx.lineCap = historyLineStyle === "dotted" ? "round" : "butt";
            ctx.setLineDash(historyLineStyle === "solid" ? [] : historyLineStyle === "dotted" ? [1, 3] : [6, 4]);
            ctx.beginPath();
            for (let index = start; index < points.length; index++) {
                const [timestamp, value] = points[index];
                if (timestamp > map.timeTo) break;
                const x = Number(coordinates[timestamp]);
                const y = priceToY(scalePrice(value, conv), map);
                if (!Number.isFinite(x) || !Number.isFinite(y)) {
                    started = false;
                    previousTimestamp = null;
                    continue;
                }
                const gap = previousTimestamp != null && timestamp - previousTimestamp > Math.max(10 * 60, plots.seconds * 2);
                previousTimestamp = timestamp;
                if (!started || gap) {
                    ctx.moveTo(x, y);
                    started = true;
                } else {
                    ctx.lineTo(x, y);
                    hasDrawableSegment = true;
                }
            }
            // A new live bucket can arrive before TradingView exposes its time
            // coordinate. Preserve the already-built path instead of hiding the
            // whole history line because that final point is temporarily absent.
            if (hasDrawableSegment) ctx.stroke();
        }
        ctx.setLineDash([]);
        ctx.lineCap = "butt";
    }

    function expirationDateX(date, map) {
        const exact = expiryAnchorsByChart[map.idx]?.[date];
        if (Number.isFinite(exact)) return exact;
        if (!Number.isFinite(map.timeFrom) || !Number.isFinite(map.timeTo) || map.timeFrom === map.timeTo) return null;
        // Noon UTC places the origin within the expiration's trading date while
        // remaining timezone-independent. Coordinates outside the visible range
        // are naturally clipped until the user pans to that date.
        const timestamp = Date.parse(`${date}T12:00:00Z`) / 1000;
        if (!Number.isFinite(timestamp)) return null;
        return map.paneLeft + ((timestamp - map.timeFrom) / (map.timeTo - map.timeFrom)) * map.paneW;
    }

    function drawExpirationProfiles(chart, map, conv) {
        const selections = chart.expirations?.selections || {};
        const applied = sanitizeAppliedSubscriptions(chart.expirations?.applied);
        const dataForChart = expiryDataByChart[map.idx] || {};
        for (const [date, selection] of Object.entries(selections)) {
            const appliedProfiles = new Set(applied[date] || []);
            if (!appliedProfiles.size) continue;
            const sources = dataForChart[date] || {};
            const labelOrigins = new Map();
            for (const id of EXPIRY_PROFILE_IDS) {
                const profile = selection.profiles?.[id];
                const def = EXPIRY_PROFILE_DEFS[id];
                const source = sources[def.source];
                if (!appliedProfiles.has(id) || !profile?.show || !source) continue;

                let originX;
                if (profile.anchorMode === "window") {
                    originX = map.paneLeft + map.paneW * clamp(Number(profile.originPct), 0, 100) / 100;
                } else {
                    const dateX = expirationDateX(date, map);
                    if (!Number.isFinite(dateX)) continue;
                    originX = dateX + (Number(profile.anchorOffsetPx) || 0);
                }
                drawProfile(chart, profile, source.strikes, def, map, conv, originX);
                if (originX >= map.paneLeft && originX <= map.paneLeft + map.paneW) labelOrigins.set(Math.round(originX), originX);
            }
            for (const originX of labelOrigins.values()) {
                ctx.fillStyle = "#AAB6C8";
                ctx.font = "10px Consolas, monospace";
                ctx.textAlign = "center";
                ctx.textBaseline = "top";
                ctx.fillText(date.slice(5), originX, map.paneTop + 3);
            }
        }
    }

    function drawProfile(chart, cfg, strikes, def, m, conv, originOverride = null) {
        if (!cfg.show || !strikes || !strikes.length) return;
        const idx = def.idx, pIdx = def.priorIdx;
        const withPriors = pIdx != null && cfg.priors;

        let maxAbs = 0;
        for (const s of strikes) {
            const v = Math.abs(Number(s[idx]) || 0); if (v > maxAbs) maxAbs = v;
            if (withPriors && Array.isArray(s[pIdx])) for (const pv of s[pIdx]) { const a = Math.abs(Number(pv) || 0); if (a > maxAbs) maxAbs = a; }
        }
        if (maxAbs === 0) return;

        const top = m.paneTop, bottom = m.paneTop + m.H;
        const profileW = Math.min(cfg.widthPx, m.paneW);
        const originX = Number.isFinite(originOverride) ? originOverride : m.paneLeft + m.paneW * cfg.originPct / 100;
        const priorDotRadius = clamp(Number(cfg.priorSize) || 3, 1, 12);

        ctx.setLineDash([]);
        ctx.lineWidth = cfg.thickness;
        for (const s of strikes) {
            const y = priceToY(scalePrice(Number(s[0]), conv), m) - (Number(cfg.verticalOffsetPx) || 0);
            if (!Number.isFinite(y) || y < top || y > bottom) continue;

            const val = Number(s[idx]) || 0;
            if (val !== 0) {
                const w = Math.max(1, Math.abs(val) / maxAbs * profileW);
                const [x1, x2] = barRange(originX, w, val >= 0, cfg.align);
                ctx.strokeStyle = val >= 0 ? cfg.posColor : cfg.negColor;
                ctx.beginPath(); ctx.moveTo(x1, y); ctx.lineTo(x2, y); ctx.stroke();
            }
            if (withPriors && Array.isArray(s[pIdx])) {
                const priorCount = Math.min(s[pIdx].length, cfg.priorColors.length);
                for (let i = priorCount - 1; i >= 0; i--) {
                    const pv = Number(s[pIdx][i]) || 0;
                    if (pv === 0) continue;
                    const w = Math.max(1, Math.abs(pv) / maxAbs * profileW);
                    const x = dotX(originX, w, pv >= 0, cfg.align);
                    // A dark backing ring separates prior markers from the current
                    // profile bar. Prior snapshots often have identical values and
                    // overlap exactly, in which case the newest color remains on top.
                    ctx.fillStyle = "rgba(10, 14, 22, 0.9)";
                    ctx.beginPath(); ctx.arc(x, y, priorDotRadius + 1, 0, Math.PI * 2); ctx.fill();
                    ctx.fillStyle = cfg.priorColors[i];
                    ctx.beginPath(); ctx.arc(x, y, priorDotRadius, 0, Math.PI * 2); ctx.fill();
                }
            }
        }
    }

    function drawMajors(chart, data, m, conv) {
        const left = m.paneLeft, right = m.paneLeft + m.paneW;
        const top = m.paneTop, bottom = m.paneTop + m.H;

        for (const [id, def] of Object.entries(LEVEL_DEFS)) {
            if (!chart.levels[id]) continue;
            const src = data.sources[def.source];
            if (!src) continue;
            const raw = src.levels[def.vkey];
            if (!(raw > 0)) continue;
            const px = scalePrice(raw, conv);
            const y = priceToY(px, m);
            if (y == null || y < top || y > bottom) continue;

            const style = chart.majorStyles[id] || majorStyleDefaults(id, chart.labelSide);
            const dash = style.lineStyle === "solid" ? [] : style.lineStyle === "dotted" ? [1, 3] : [6, 4];
            ctx.strokeStyle = style.color;
            ctx.lineWidth = clamp(Number(style.thickness) || 1, 1, 20);
            ctx.lineCap = style.lineStyle === "dotted" ? "round" : "butt";
            ctx.setLineDash(dash);
            ctx.beginPath(); ctx.moveTo(left, y); ctx.lineTo(right, y); ctx.stroke();
            ctx.setLineDash([]);
            ctx.lineCap = "butt";

            let labelX;
            if (style.labelPosition === "right") {
                labelX = right - 6;
                ctx.textAlign = "right";
            } else if (style.labelPosition === "percent") {
                labelX = left + m.paneW * clamp(Number(style.labelPct), 0, 100) / 100;
                ctx.textAlign = "center";
            } else {
                labelX = left + 6;
                ctx.textAlign = "left";
            }
            ctx.fillStyle = style.color;
            ctx.font = "11px Consolas, monospace";
            ctx.textBaseline = "middle";
            ctx.fillText(`${def.label} ${fmt(px)}`, labelX, y - 7);
        }
    }

    // ---- Panel ----
    let panel, bodyEl, statusEl;
    function buildPanelShell() {
        panel = document.createElement("div");
        panel.id = "iof-panel";
        panel.innerHTML = `
            <div id="iof-head">
                <span class="iof-dot r" id="iof-close" title="Close"></span>
                <span class="iof-dot y" id="iof-min" title="Minimize"></span>
                <span class="iof-dot g" id="iof-max" title="Expand"></span>
                <b>gexbot&nbsp;v1.0</b>
            </div>
            <div id="iof-body"></div>`;
        document.documentElement.appendChild(panel);
        bodyEl = panel.querySelector("#iof-body");

        panel.querySelector("#iof-min").addEventListener("click", () => panel.classList.add("iof-collapsed"));
        panel.querySelector("#iof-max").addEventListener("click", () => panel.classList.remove("iof-collapsed"));
        panel.querySelector("#iof-close").addEventListener("click", () => { panel.style.display = "none"; reopen.style.display = "flex"; });

        const reopen = document.createElement("div");
        reopen.id = "iof-reopen"; reopen.textContent = "gexbot"; reopen.title = "Open gexbot v1.0";
        reopen.style.display = "none";
        reopen.addEventListener("click", () => { panel.style.display = ""; reopen.style.display = "none"; });
        document.documentElement.appendChild(reopen);

        makeDraggable(panel, panel.querySelector("#iof-head"));
    }

    function profileSectionHtml(id) {
        const d = PROFILE_DEFS[id];
        let h = `<details class="iof-settings-group">
            <summary>${esc(d.label)}</summary>
            <div class="iof-settings-group-body">
                <label class="iof-check"><input type="checkbox" data-pf="${id}" data-k="show"><span>Show ${esc(d.label)}</span></label>
                <div class="iof-g2">
                    <div class="iof-fr"><span>Expiry</span><select data-pf="${id}" data-k="agg">${d.aggregations.map((agg) => `<option value="${agg}">${agg === "zero" ? "0DTE" : agg === "one" ? "1DTE" : "Full"}</option>`).join("")}</select></div>
                    <div class="iof-fr"><span>Alignment</span><select data-pf="${id}" data-k="align"><option value="left">Left</option><option value="right">Right</option><option value="diverge">Diverging</option></select></div>
                    <div class="iof-fr"><span>Origin %</span><input type="number" data-pf="${id}" data-k="originPct"></div>
                    <div class="iof-fr"><span>Max width px</span><input type="number" data-pf="${id}" data-k="widthPx"></div>
                    <div class="iof-fr"><span>Bar thickness</span><input type="number" data-pf="${id}" data-k="thickness"></div>
                    <div class="iof-fr"><span>Vertical offset px (+ up)</span><input type="number" data-pf="${id}" data-k="verticalOffsetPx" min="-5000" max="5000" step="1"></div>
                    <div class="iof-fr"><span>Positive</span><input type="color" data-pf="${id}" data-k="posColor"></div>
                    <div class="iof-fr"><span>Negative</span><input type="color" data-pf="${id}" data-k="negColor"></div>
                </div>`;
        if (d.priorIdx != null) {
            h += `<label class="iof-check"><input type="checkbox" data-pf="${id}" data-k="priors"><span>Prior dots</span></label>
                <div class="iof-fr"><span>Dot size</span><input type="number" data-pf="${id}" data-k="priorSize" style="max-width:80px"></div>
                <div class="iof-priors">${d.priorLabels.map((lb, i) => `<div class="iof-fr"><span>${lb}</span><input type="color" data-pf="${id}" data-pc="${i}"></div>`).join("")}</div>`;
        }
        return `${h}</div></details>`;
    }

    function settingsTabsHtml() {
        return `<div class="iof-settings-tabs">
            <button class="iof-stab${settingsTab === "base" ? " on" : ""}" data-settings-tab="base">Standard</button>
            <button class="iof-stab${settingsTab === "expirations" ? " on" : ""}" data-settings-tab="expirations">Quant</button>
        </div>`;
    }

    function bindCommonPanelTabs() {
        bodyEl.querySelectorAll(".iof-ctab").forEach((button) =>
            button.addEventListener("click", trusted(() => { uiChart = +button.dataset.chart; renderBody(); })));
        bodyEl.querySelectorAll("[data-settings-tab]").forEach((button) =>
            button.addEventListener("click", trusted(() => {
                settingsTab = button.dataset.settingsTab;
                if (!tickerLists.loaded && !tickerLists.loading) requestTickerLists();
                else renderBody();
            })));
    }

    function tickerCategoryHtml(label, values, chart) {
        if (!Array.isArray(values) || !values.length) return "";
        return `<div class="iof-ticker-category">
            <div class="iof-ticker-category-head"><span>${esc(label)}</span><b>${values.length}</b></div>
            <div class="iof-ticker-list">${values.map((ticker) => `<button type="button" data-ticker="${ticker}" class="${chart.symbol === ticker && !chart.futuresTarget ? "selected" : ""}">${esc(ticker)}</button>`).join("")}</div>
        </div>`;
    }

    function tickerSectionHtml(value, error, includeFutures, chart) {
        let contents;
        if (value) {
            contents = tickerCategoryHtml("Stocks", value.stocks, chart) +
                tickerCategoryHtml("Indexes", value.indexes, chart) +
                (includeFutures ? tickerCategoryHtml("Futures", value.futures, chart) : "");
            if (!contents) contents = `<div class="iof-note">No tickers available.</div>`;
        } else {
            const state = tickerLists.loading ? "Loading…" : error || "Unavailable";
            contents = `<div class="iof-note ${error ? "iof-ticker-error" : ""}">${esc(state)}</div>`;
        }
        const pairs = FUTURES_PAIRS.map(([symbol, future]) =>
            `<button type="button" data-pair-symbol="${symbol}" data-pair-future="${future}" class="${chart.symbol === symbol && chart.futuresTarget === future && !chart.manualConversion ? "selected" : ""}">${symbol} → ${future}</button>`).join("");
        return `<details class="iof-settings-group iof-ticker-group" data-ticker-tab="${settingsTab}" ${tickerGroupOpenByTab[settingsTab] !== false ? "open" : ""}>
            <summary>Tickers</summary>
            <div class="iof-settings-group-body">
                <div class="iof-ticker-section">${contents}</div>
                <div class="iof-ticker-category-head"><span>Supported synthetic futures</span><b>${FUTURES_PAIRS.length}</b></div>
                <div class="iof-pair-list">${pairs}</div>
                <div class="iof-ticker-actions"><button id="iof-ticker-refresh" type="button" ${tickerLists.loading ? "disabled" : ""}>${tickerLists.loading ? "Loading…" : "Refresh"}</button></div>
            </div>
        </details>`;
    }

    function manualConversionHtml(chart) {
        const conversion = chart.manualConversion || (chart.futuresTarget ? convByChart[uiChart] : null);
        return `<details class="iof-settings-group">
            <summary>Manual futures conversion</summary>
            <div class="iof-settings-group-body">
                <div class="iof-g2">
                    <div class="iof-fr"><span>Additive</span><input id="iof-manual-additive" type="number" step="any" value="${conversion ? conversion.additive : ""}"></div>
                    <div class="iof-fr"><span>Multiplicative</span><input id="iof-manual-multiplier" type="number" step="any" value="${conversion ? conversion.multiplier : ""}"></div>
                </div>
                <div class="iof-actions"><button id="iof-manual-apply" type="button">Apply</button></div>
            </div>
        </details>`;
    }

    function populateAutomaticConversionFields(index) {
        if (index !== uiChart) return;
        const chart = config.charts[index];
        const conversion = chart?.futuresTarget && !chart.manualConversion ? convByChart[index] : null;
        if (!conversion) return;
        const additive = bodyEl?.querySelector("#iof-manual-additive");
        const multiplier = bodyEl?.querySelector("#iof-manual-multiplier");
        if (!additive || !multiplier || additive.value !== "" || multiplier.value !== "") return;
        additive.value = String(conversion.additive);
        multiplier.value = String(conversion.multiplier);
    }

    function requestPairConversion(index, chart) {
        if (!chart.futuresTarget || (!chart.standardEnabled && !chart.quantEnabled)) return;
        ensurePort();
        try {
            port.postMessage({
                type: "conversion-request",
                version: dataVersion,
                chart: index,
                symbol: chart.symbol,
                future: chart.futuresTarget,
            });
        } catch (error) {
            port = null;
            statusByChart[index] = "Error: Conversion request unavailable";
        }
    }

    function selectChartTicker(chart, index, symbol, futuresTarget = "") {
        const previousSymbol = chart.symbol;
        chart.symbol = symbol;
        chart.futuresTarget = futuresTarget;
        chart.manualConversion = null;
        invalidateChartData(index);
        if (chart.symbol !== previousSymbol) {
            chart.expirations = { symbol: chart.symbol, defaultsVersion: EXPIRY_DEFAULTS_VERSION, defaultsInitialized: false, selections: {}, applied: {} };
            delete majorHistoryByChart[index];
            delete majorHistoryCoordinatesByChart[index];
            delete expiryAnchorsByChart[index];
            delete expiryListsByChart[index];
            delete expiryDataByChart[index];
            delete expiryEditorDateByChart[index];
            delete expiryStatusByChart[index];
        }
        statusByChart[index] = keyConfigured ? "Connecting…" : "API key not configured";
        saveConfig();
        if (!sendConfig()) requestPairConversion(index, chart);
        renderBody();
    }

    function bindTickerControls(chart) {
        const tickerGroup = bodyEl.querySelector(".iof-ticker-group");
        tickerGroup?.addEventListener("toggle", () => { tickerGroupOpenByTab[tickerGroup.dataset.tickerTab] = tickerGroup.open; });
        bodyEl.querySelector("#iof-ticker-refresh")?.addEventListener("click", trusted(() => requestTickerLists(true)));
        bodyEl.querySelectorAll("[data-ticker]").forEach((button) =>
            button.addEventListener("click", trusted(() => selectChartTicker(chart, uiChart, button.dataset.ticker))));
        bodyEl.querySelectorAll("[data-pair-symbol]").forEach((button) =>
            button.addEventListener("click", trusted(() => selectChartTicker(chart, uiChart, button.dataset.pairSymbol, button.dataset.pairFuture))));
        bodyEl.querySelector("#iof-manual-apply")?.addEventListener("click", trusted(() => {
            const additiveText = bodyEl.querySelector("#iof-manual-additive").value.trim();
            const multiplierText = bodyEl.querySelector("#iof-manual-multiplier").value.trim();
            const additive = additiveText === "" ? 0 : Number(additiveText);
            const multiplier = multiplierText === "" ? 1 : Number(multiplierText);
            if (!Number.isFinite(additive) || !Number.isFinite(multiplier)) { setStatus("Invalid conversion", false); return; }
            chart.manualConversion = additiveText === "" && multiplierText === "" ? null : { additive, multiplier };
            chart.futuresTarget = "";
            invalidateChartData(uiChart);
            statusByChart[uiChart] = keyConfigured ? "Connecting…" : "API key not configured";
            saveConfig();
            sendConfig();
            renderBody();
        }));
    }

    function renderExpirationBody(c, tabs, layoutTxt) {
        const listState = expiryListsByChart[uiChart] || { values: [], error: "" };
        const values = listState.symbol === c.symbol ? listState.values : [];
        let selectedDate = expiryEditorDateByChart[uiChart] || "";
        if (selectedDate && !values.includes(selectedDate)) selectedDate = "";
        expiryEditorDateByChart[uiChart] = selectedDate;
        const selection = selectedDate ? expirationSelection(c, selectedDate) : null;
        const chartMap = tvState?.maps.find((map) => map.idx === uiChart);
        const dateAnchoringAvailable = Number.isFinite(expiryAnchorsByChart[uiChart]?.[selectedDate]) ||
            (Number.isFinite(chartMap?.timeFrom) && Number.isFinite(chartMap?.timeTo));
        const connectionPending = expirationConnectionPending(c);

        const dateList = values.length ? values.map((date) => {
            const enabled = !!c.expirations.selections[date]?.enabled;
            const friday = new Date(`${date}T00:00:00Z`).getUTCDay() === 5;
            return `<label class="iof-exp-date${date === selectedDate ? " selected" : ""}">
                <input type="checkbox" data-exp-enable="${date}" ${enabled ? "checked" : ""}>
                <button type="button" data-exp-edit="${date}">${esc(date)}${friday ? " · Fri" : ""}</button>
            </label>`;
        }).join("") : `<div class="iof-note">${listState.error ? esc(listState.error) : "Loading available expirations…"}</div>`;

        const profileKey = `${uiChart}:${selectedDate}`;
        const profileRows = selection ? EXPIRY_PROFILE_IDS.map((id) => {
            const def = EXPIRY_PROFILE_DEFS[id];
            const itemKey = `${profileKey}:${id}`;
            const profile = selection.profiles[id];
            const placementControl = profile.anchorMode === "window"
                ? `<span>Origin %</span><input type="number" data-exp-origin="${id}" min="0" max="100" value="${profile.originPct}">`
                : `<span>Date offset px</span><input type="number" data-exp-offset="${id}" step="1" value="${profile.anchorOffsetPx}">`;
            const priorSettings = def.priorIdx == null ? "" : `<div class="iof-exp-prior-settings">
                <div class="iof-exp-prior-head">
                    <label class="iof-check"><input type="checkbox" data-exp-priors="${id}" ${profile.priors ? "checked" : ""}><span>Prior dots</span></label>
                    <div class="iof-fr"><span>Dot size</span><input type="number" data-exp-prior-size="${id}" min="1" max="12" value="${profile.priorSize}"></div>
                </div>
                <div class="iof-priors" style="grid-template-columns:repeat(${def.priorLabels.length},1fr)">${def.priorLabels.map((label, index) => `<div class="iof-fr"><span>${label}</span><input type="color" data-exp-prior-color="${id}" data-exp-prior-index="${index}" value="${profile.priorColors[index]}"></div>`).join("")}</div>
            </div>`;
            return `<details class="iof-settings-group iof-exp-profile-item" data-exp-profile-item-key="${itemKey}" ${expiryProfileItemOpenByKey[itemKey] ? "open" : ""}>
                <summary>${esc(def.label)}</summary>
                <div class="iof-settings-group-body iof-exp-profile-body">
                <label class="iof-check"><input type="checkbox" data-exp-profile="${id}" ${profile.show ? "checked" : ""}><span>Show ${esc(def.label)}</span></label>
                <div class="iof-g2 iof-exp-profile-placement">
                    <div class="iof-fr"><span>Origin mode</span><select data-exp-anchor="${id}"><option value="date">Expiration date</option><option value="window">Window percentage</option></select></div>
                    <div class="iof-fr">${placementControl}</div>
                </div>
                <div class="iof-g2">
                    <div class="iof-fr"><span>Alignment</span><select data-exp-align="${id}"><option value="left">Left</option><option value="right">Right</option><option value="diverge">Diverging</option></select></div>
                    <div class="iof-fr"><span>Max width px</span><input type="number" data-exp-width="${id}" min="10" max="2000" value="${profile.widthPx}"></div>
                    <div class="iof-fr"><span>Bar thickness</span><input type="number" data-exp-thickness="${id}" min="1" max="20" value="${profile.thickness}"></div>
                    <div class="iof-fr"><span>Vertical offset px (+ up)</span><input type="number" data-exp-vertical-offset="${id}" min="-5000" max="5000" step="1" value="${profile.verticalOffsetPx}"></div>
                    <div class="iof-fr"><span>Positive</span><input type="color" data-exp-pos-color="${id}" value="${profile.posColor}"></div>
                    <div class="iof-fr"><span>Negative</span><input type="color" data-exp-neg-color="${id}" value="${profile.negColor}"></div>
                </div>
                ${priorSettings}
                </div>
            </details>`;
        }).join("") : "";
        const profileSettings = selection ? `<details class="iof-settings-group iof-exp-profile-group" data-exp-profile-key="${profileKey}" ${expiryProfileOpenByKey[profileKey] ? "open" : ""}>
            <summary>Profiles for ${esc(selectedDate)}</summary>
            <div class="iof-settings-group-body">
                <div class="iof-exp-reset-row">
                    <button id="iof-exp-apply-settings-all" type="button">Apply Settings To All Expiration Profiles</button>
                    <button id="iof-exp-reset" type="button">Reset</button>
                </div>
                <div class="iof-exp-profiles-scroll" data-exp-profile-key="${profileKey}"><div class="iof-exp-profiles">${profileRows}</div></div>
                ${!dateAnchoringAvailable && EXPIRY_PROFILE_IDS.some((id) => selection.profiles[id].show && selection.profiles[id].anchorMode === "date") ? `<div class="iof-note iof-ticker-error">Date placement unavailable.</div>` : ""}
            </div>
        </details>` : "";

        bodyEl.innerHTML = `
            <div class="iof-sec">Layout — ${layoutTxt}</div>
            <div class="iof-ctabs">${tabs}</div>
            ${settingsTabsHtml()}
            <label class="iof-check"><input type="checkbox" id="iof-enabled"><span>Draw on this chart</span></label>
            ${tickerSectionHtml(tickerLists.quant, tickerLists.errors.quant, false, c)}
            ${manualConversionHtml(c)}
            <div class="iof-sec">Available expirations — ${esc(c.symbol)}</div>
            <div class="iof-exp-toolbar"><span>${values.length} dates</span><button id="iof-exp-refresh" type="button">Refresh</button></div>
            <div class="iof-exp-dates" data-chart="${uiChart}">${dateList}</div>
            ${profileSettings}
            <div class="iof-actions"><span id="iof-status">${esc(c.quantEnabled ? (expiryStatusByChart[uiChart] || "Waiting for data…") : "Disabled")}</span></div>
            <div class="iof-exp-update">
                <span>${connectionPending ? "Unsaved changes" : "Up to date"}</span>
                <button id="iof-exp-update" type="button" ${connectionPending ? "" : "disabled"}>Apply changes</button>
            </div>`;

        statusEl = bodyEl.querySelector("#iof-status");
        bodyEl.querySelector(".iof-exp-dates").scrollTop = expiryListScrollByChart[uiChart] || 0;
        const profileScroller = bodyEl.querySelector(".iof-exp-profiles-scroll");
        if (profileScroller) profileScroller.scrollTop = expiryProfileScrollByKey[profileScroller.dataset.expProfileKey] || 0;
        const profileGroup = bodyEl.querySelector(".iof-exp-profile-group");
        profileGroup?.addEventListener("toggle", () => { expiryProfileOpenByKey[profileGroup.dataset.expProfileKey] = profileGroup.open; });
        bodyEl.querySelectorAll(".iof-exp-profile-item").forEach((item) =>
            item.addEventListener("toggle", () => { expiryProfileItemOpenByKey[item.dataset.expProfileItemKey] = item.open; }));
        if (!c.quantEnabled) setStatus("Disabled", null);
        else if (listState.error) setStatus(listState.error, false);
        else if (expiryStatusByChart[uiChart]) setStatus(expiryStatusByChart[uiChart], !/error|disconnect|failed|reconnect|too many/i.test(expiryStatusByChart[uiChart]));
        bindCommonPanelTabs();
        bindTickerControls(c);

        const enabled = bodyEl.querySelector("#iof-enabled");
        enabled.checked = c.quantEnabled;
        enabled.addEventListener("change", trusted((event) => {
            c.quantEnabled = event.target.checked;
            if (c.quantEnabled) expiryStatusByChart[uiChart] = "Connecting…";
            else {
                delete expiryDataByChart[uiChart];
                expiryStatusByChart[uiChart] = "Disabled";
            }
            dirty = true;
            saveConfig();
            sendConfig();
            requestExpirationAnchors();
            setStatus(expiryStatusByChart[uiChart], c.quantEnabled ? true : null);
        }));
        bodyEl.querySelector("#iof-exp-refresh").addEventListener("click", trusted(() => {
            delete expiryListsByChart[uiChart];
            expiryStatusByChart[uiChart] = "Refreshing expirations…";
            ensurePort();
            try { port.postMessage({ type: "refresh-expirations", chart: uiChart, symbol: c.symbol }); } catch (e) { port = null; }
            renderBody();
        }));

        bodyEl.querySelectorAll("[data-exp-edit]").forEach((button) =>
            button.addEventListener("click", trusted(() => { expiryEditorDateByChart[uiChart] = button.dataset.expEdit; renderBody(); })));
        bodyEl.querySelectorAll("[data-exp-enable]").forEach((checkbox) =>
            checkbox.addEventListener("change", trusted(() => {
                const current = expirationSelection(c, checkbox.dataset.expEnable);
                current.enabled = checkbox.checked;
                if (current.enabled && !EXPIRY_PROFILE_IDS.some((id) => current.profiles[id].show)) current.profiles.gamma.show = true;
                saveConfig(); renderBody();
            })));

        bodyEl.querySelector("#iof-exp-update").addEventListener("click", trusted(() => {
            for (const current of Object.values(c.expirations.selections)) {
                if (!EXPIRY_PROFILE_IDS.some((id) => current.profiles?.[id]?.show)) current.enabled = false;
            }
            c.expirations.applied = draftExpirationSubscriptions(c);
            expiryStatusByChart[uiChart] = "Applying changes…";
            saveConfig();
            sendConfig();
            requestExpirationAnchors();
            renderBody();
        }));

        if (!selection) return;
        bodyEl.querySelector("#iof-exp-apply-settings-all").addEventListener("click", trusted(() => {
            const template = {};
            for (const id of EXPIRY_PROFILE_IDS) template[id] = normalizedExpiryProfile(id, selection.profiles[id]);
            c.quantProfileTemplate = clone(template);
            for (const current of Object.values(c.expirations.selections)) current.profiles = clone(template);
            saveConfig();
            requestExpirationAnchors();
            renderBody();
        }));
        bodyEl.querySelector("#iof-exp-reset").addEventListener("click", trusted(() => {
            c.expirations.selections[selectedDate] = expirationDefaults(selection.enabled, true);
            saveConfig();
            requestExpirationAnchors();
            renderBody();
        }));
        bodyEl.querySelectorAll("[data-exp-profile]").forEach((checkbox) =>
            checkbox.addEventListener("change", trusted(() => {
                selection.profiles[checkbox.dataset.expProfile].show = checkbox.checked;
                if (checkbox.checked) selection.enabled = true;
                else if (!EXPIRY_PROFILE_IDS.some((id) => selection.profiles[id].show)) selection.enabled = false;
                saveConfig(); renderBody();
            })));
        bodyEl.querySelectorAll("[data-exp-align]").forEach((select) => {
            const profile = selection.profiles[select.dataset.expAlign];
            select.value = profile.align;
            select.addEventListener("change", trusted(() => { profile.align = select.value; saveConfig(); }));
        });
        bodyEl.querySelectorAll("[data-exp-width]").forEach((input) => {
            const profile = selection.profiles[input.dataset.expWidth];
            input.addEventListener("input", trusted(() => { profile.widthPx = clamp(parseFloat(input.value), 10, 2000); saveConfig(); }));
        });
        bodyEl.querySelectorAll("[data-exp-thickness]").forEach((input) => {
            const profile = selection.profiles[input.dataset.expThickness];
            input.addEventListener("input", trusted(() => { profile.thickness = clamp(parseFloat(input.value), 1, 20); saveConfig(); }));
        });
        bodyEl.querySelectorAll("[data-exp-vertical-offset]").forEach((input) => {
            const profile = selection.profiles[input.dataset.expVerticalOffset];
            input.addEventListener("input", trusted(() => {
                const value = parseFloat(input.value);
                profile.verticalOffsetPx = Number.isFinite(value) ? clamp(value, -5000, 5000) : 0;
                saveConfig();
            }));
        });
        bodyEl.querySelectorAll("[data-exp-pos-color]").forEach((input) => {
            const profile = selection.profiles[input.dataset.expPosColor];
            input.addEventListener("input", trusted(() => { profile.posColor = input.value; saveConfig(); }));
        });
        bodyEl.querySelectorAll("[data-exp-neg-color]").forEach((input) => {
            const profile = selection.profiles[input.dataset.expNegColor];
            input.addEventListener("input", trusted(() => { profile.negColor = input.value; saveConfig(); }));
        });
        bodyEl.querySelectorAll("[data-exp-priors]").forEach((checkbox) => {
            const profile = selection.profiles[checkbox.dataset.expPriors];
            checkbox.addEventListener("change", trusted(() => { profile.priors = checkbox.checked; saveConfig(); }));
        });
        bodyEl.querySelectorAll("[data-exp-prior-size]").forEach((input) => {
            const profile = selection.profiles[input.dataset.expPriorSize];
            input.addEventListener("input", trusted(() => { profile.priorSize = clamp(parseFloat(input.value), 1, 12); saveConfig(); }));
        });
        bodyEl.querySelectorAll("[data-exp-prior-color]").forEach((input) => {
            const profile = selection.profiles[input.dataset.expPriorColor];
            const index = Number(input.dataset.expPriorIndex);
            input.addEventListener("input", trusted(() => { profile.priorColors[index] = input.value; saveConfig(); }));
        });
        bodyEl.querySelectorAll("[data-exp-anchor]").forEach((select) => {
            const profile = selection.profiles[select.dataset.expAnchor];
            select.value = profile.anchorMode;
            select.addEventListener("change", trusted(() => {
                profile.anchorMode = select.value;
                saveConfig();
                requestExpirationAnchors();
                renderBody();
            }));
        });
        bodyEl.querySelectorAll("[data-exp-origin]").forEach((input) => {
            const profile = selection.profiles[input.dataset.expOrigin];
            input.addEventListener("input", trusted(() => { profile.originPct = clamp(parseFloat(input.value), 0, 100); saveConfig(); }));
        });
        bodyEl.querySelectorAll("[data-exp-offset]").forEach((input) => {
            const profile = selection.profiles[input.dataset.expOffset];
            input.addEventListener("input", trusted(() => { profile.anchorOffsetPx = clamp(parseFloat(input.value), -5000, 5000); saveConfig(); }));
        });
    }

    function renderBody() {
        const previousExpirationList = bodyEl?.querySelector(".iof-exp-dates");
        if (previousExpirationList) {
            const chart = Number(previousExpirationList.dataset.chart);
            if (Number.isInteger(chart)) expiryListScrollByChart[chart] = previousExpirationList.scrollTop;
        }
        const previousProfileScroller = bodyEl?.querySelector(".iof-exp-profiles-scroll");
        if (previousProfileScroller) expiryProfileScrollByKey[previousProfileScroller.dataset.expProfileKey] = previousProfileScroller.scrollTop;
        const maps = tvState ? tvState.maps : [];
        if (maps.length && !maps.some((m) => m.idx === uiChart)) uiChart = maps[0].idx;
        const c = chartCfg(uiChart);

        // Each chart in a split layout gets its own setup.
        // Split charts are often the same symbol on different timeframes, so the
        // resolution goes in the label — otherwise every tab reads identically.
        const tabs = (maps.length ? maps : [{ idx: 0, symbol: "", active: true }]).map((m) => {
            const on = m.idx === uiChart ? " on" : "";
            const nm = (m.symbol || "").split(":").pop() || `Chart ${m.idx + 1}`;
            const tf = m.resolution ? ` ${fmtRes(m.resolution)}` : "";
            const label = esc(`${nm}${tf}`);
            return `<button class="iof-ctab${on}" data-chart="${m.idx}" title="${label}">#${m.idx + 1} ${label}</button>`;
        }).join("");

        const layoutTxt = tvState ? `${tvState.count} chart${tvState.count > 1 ? "s" : ""} (${esc(tvState.layout)})` : "…";
        if (settingsTab === "expirations") { renderExpirationBody(c, tabs, layoutTxt); return; }

        const profilesHtml = STANDARD_PROFILE_IDS.map(profileSectionHtml).join("");
        const majorsHtml = Object.entries(LEVEL_DEFS)
            .map(([id, d]) => {
                const style = c.majorStyles[id];
                const history = HISTORY_MAJOR_BITS[id] ? `<div class="iof-major-history">
                    <label class="iof-check"><input type="checkbox" data-major-history ${style.history ? "checked" : ""}><span>History</span></label>
                    <input type="color" data-major-history-color value="${style.historyColor}" title="History color">
                    <select data-major-history-style title="History draw style"><option value="solid">Solid</option><option value="dashed">Dashed</option><option value="dotted">Dotted</option><option value="scatter">Scatter</option></select>
                    <input type="number" data-major-history-thickness min="1" max="20" step="1" value="${style.historyThickness}" title="History line thickness / scatter dot radius (px)" aria-label="History thickness">
                </div>` : "";
                return `<div class="iof-major" data-major-row="${id}">
                    <label class="iof-check"><input type="checkbox" data-major-show ${c.levels[id] ? "checked" : ""}><span>${esc(d.label)}</span></label>
                    <input type="color" data-major-color value="${style.color}" title="Color">
                    <select data-major-style title="Line style"><option value="dashed">Dashed</option><option value="solid">Solid</option><option value="dotted">Dotted</option></select>
                    <input type="number" data-major-thickness min="1" max="20" step="1" value="${style.thickness}" title="Line thickness (px)" aria-label="Line thickness">
                    ${history}
                    <div class="iof-major-label">
                        <span>Label</span>
                        <select data-major-position title="Label position"><option value="left">Left</option><option value="right">Right</option><option value="percent">Position %</option></select>
                        <input type="number" data-major-pct min="0" max="100" value="${style.labelPct}" title="Chart pane position" ${style.labelPosition === "percent" ? "" : "disabled"}>
                    </div>
                </div>`;
            }).join("");

        bodyEl.innerHTML = `
            <div class="iof-sec">Layout — ${layoutTxt}</div>
            <div class="iof-ctabs">${tabs}</div>
            ${settingsTabsHtml()}
            <label class="iof-check"><input type="checkbox" id="iof-enabled"><span>Draw on this chart</span></label>

            <div class="iof-keyline">
                <span>API key</span>
                <b id="iof-key-state" class="${keyConfigured ? "ok" : "bad"}">${keyConfigured ? "Configured" : "Not configured"}</b>
            </div>

            ${tickerSectionHtml(tickerLists.normal, tickerLists.errors.normal, true, c)}
            ${manualConversionHtml(c)}
            <div class="iof-actions"><span id="iof-status">Idle</span></div>

            ${profilesHtml}

            <details class="iof-settings-group">
                <summary>Majors</summary>
                <div class="iof-settings-group-body"><div id="iof-majors">${majorsHtml}</div></div>
            </details>`;

        const $ = (s) => bodyEl.querySelector(s);
        statusEl = $("#iof-status");
        if (!c.standardEnabled) setStatus("Disabled", null);
        else if (compatibilityError) setStatus(`Compatibility: ${compatibilityError}`, false);
        else if (!keyConfigured) setStatus("API key not configured", false);
        else if (statusByChart[uiChart]) setStatus(statusByChart[uiChart], !/^Error/.test(statusByChart[uiChart]));

        $("#iof-enabled").checked = c.standardEnabled;

        bindCommonPanelTabs();
        bindTickerControls(c);

        $("#iof-enabled").addEventListener("change", trusted((event) => {
            c.standardEnabled = event.target.checked;
            delete dataByChart[uiChart];
            statusByChart[uiChart] = c.standardEnabled ? "Connecting…" : "Disabled";
            dirty = true;
            saveConfig();
            sendConfig();
            setStatus(statusByChart[uiChart], c.standardEnabled ? true : null);
        }));

        bodyEl.querySelectorAll("[data-pf][data-k]").forEach((el) => {
            const pf = el.dataset.pf, k = el.dataset.k, cur = c.profiles[pf][k];
            if (el.type === "checkbox") el.checked = cur; else el.value = cur;
            const evt = (el.type === "checkbox" || el.tagName === "SELECT") ? "change" : "input";
            el.addEventListener(evt, trusted(() => {
                let v;
                if (el.type === "checkbox") v = el.checked;
                else if (NUMK[k]) {
                    const parsed = parseFloat(el.value);
                    v = Number.isFinite(parsed) ? clamp(parsed, NUMK[k][0], NUMK[k][1]) : (NUMK[k][2] ?? NUMK[k][0]);
                } else v = el.value;
                c.profiles[pf][k] = v;
                saveConfig();
                if (k === "show" || k === "agg") {
                    invalidateChartData(uiChart);
                    sendConfig();
                }
            }));
        });
        bodyEl.querySelectorAll("[data-pf][data-pc]").forEach((el) => {
            const pf = el.dataset.pf, i = +el.dataset.pc;
            el.value = c.profiles[pf].priorColors[i];
            el.addEventListener("input", trusted(() => { c.profiles[pf].priorColors[i] = el.value; saveConfig(); }));
        });
        bodyEl.querySelectorAll("[data-major-row]").forEach((row) => {
            const id = row.dataset.majorRow;
            const style = c.majorStyles[id];
            const show = row.querySelector("[data-major-show]");
            const color = row.querySelector("[data-major-color]");
            const lineStyle = row.querySelector("[data-major-style]");
            const thickness = row.querySelector("[data-major-thickness]");
            const history = row.querySelector("[data-major-history]");
            const historyColor = row.querySelector("[data-major-history-color]");
            const historyLineStyle = row.querySelector("[data-major-history-style]");
            const historyThickness = row.querySelector("[data-major-history-thickness]");
            const labelPosition = row.querySelector("[data-major-position]");
            const labelPct = row.querySelector("[data-major-pct]");
            lineStyle.value = style.lineStyle;
            if (historyLineStyle) historyLineStyle.value = style.historyLineStyle;
            labelPosition.value = style.labelPosition;
            show.addEventListener("change", trusted(() => { c.levels[id] = show.checked; saveConfig(); }));
            color.addEventListener("input", trusted(() => { style.color = color.value; saveConfig(); }));
            lineStyle.addEventListener("change", trusted(() => { style.lineStyle = lineStyle.value; saveConfig(); }));
            thickness.addEventListener("input", trusted(() => { style.thickness = clamp(parseFloat(thickness.value), 1, 20); saveConfig(); }));
            history?.addEventListener("change", trusted(() => {
                style.history = history.checked;
                if (style.history) {
                    majorHistoryState(uiChart, c).requestArmed = true;
                    requestMajorHistoryForChart(uiChart, c);
                } else clearMajorHistorySeries(uiChart, c, id);
                saveConfig();
            }));
            historyColor?.addEventListener("input", trusted(() => { style.historyColor = historyColor.value; saveConfig(); }));
            historyLineStyle?.addEventListener("change", trusted(() => { style.historyLineStyle = historyLineStyle.value; saveConfig(); }));
            historyThickness?.addEventListener("input", trusted(() => { style.historyThickness = clamp(parseFloat(historyThickness.value), 1, 20); saveConfig(); }));
            labelPosition.addEventListener("change", trusted(() => {
                style.labelPosition = labelPosition.value;
                labelPct.disabled = style.labelPosition !== "percent";
                saveConfig();
            }));
            labelPct.addEventListener("input", trusted(() => { style.labelPct = clamp(parseFloat(labelPct.value), 0, 100); saveConfig(); }));
        });
    }

    function setStatus(text, ok) {
        if (!statusEl) return;
        statusEl.textContent = text;
        statusEl.style.color = ok == null ? "#8894A8" : ok ? "#7ee0a4" : "#e88f8f";
    }

    function makeDraggable(el, handle) {
        let sx, sy, ox, oy, drag = false;
        handle.addEventListener("mousedown", (e) => {
            if (e.target.classList.contains("iof-dot") || e.target.closest(".iof-check")) return;
            drag = true; sx = e.clientX; sy = e.clientY;
            const r = el.getBoundingClientRect(); ox = r.left; oy = r.top;
            e.preventDefault();
        });
        window.addEventListener("mousemove", (e) => {
            if (!drag) return;
            el.style.left = (ox + e.clientX - sx) + "px";
            el.style.top = (oy + e.clientY - sy) + "px";
            el.style.right = "auto";
        });
        window.addEventListener("mouseup", () => { drag = false; });
    }

    // TradingView resolutions: "5" → 5m, "60" → 1h, "D"/"W" pass through.
    function fmtRes(r) {
        if (/^\d+$/.test(r)) { const n = +r; return n >= 60 && n % 60 === 0 ? (n / 60) + "h" : n + "m"; }
        return r;
    }

    function trusted(handler) { return (event) => { if (event.isTrusted) handler(event); }; }
    function clamp(v, a, b) { v = isNaN(v) ? a : v; return Math.max(a, Math.min(b, v)); }
    function esc(value) { return String(value).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]); }
    function fmt(n) { return n == null || isNaN(n) ? "—" : Number(n).toLocaleString("en-US", { maximumFractionDigits: 2 }); }
})();

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

// Main-world bridge for TradingView's internal chart API.
//
// It publishes only validated chart geometry to the isolated overlay. No API key,
// gexbot config, or gexbot response data enters this page world. TradingViewApi is
// undocumented, so compatibility failures are surfaced explicitly after a short
// startup/recovery grace period instead of silently polling with bad geometry.
(() => {
    "use strict";
    if (window.__iofTVInjected) return;
    window.__iofTVInjected = true;

    const BRIDGE_VERSION = 2;
    const ERROR_GRACE_MS = 5000;
    const OCCLUSION_SELECTOR = [
        "dialog[open]",
        "[role='dialog']",
        "[role='alertdialog']",
        "[aria-modal='true']",
        "[data-role='dialog']",
        "[data-dialog-name]",
        "[data-name='dialog']",
        "[data-name$='-dialog']",
        "[class^='dialog-']",
        "[class*=' dialog-']",
        "[role='menu']",
        "[role='listbox']",
        "[data-name='popup-menu-container']",
        ".context-menu",
        "[class*='menuWrap-']",
    ].join(",");
    let lastStateKey = "";
    let lastError = "";
    let errorSince = 0;
    let lastComputeAt = 0;
    let pointerInteracting = false;
    let interactionUntil = 0;
    let rects = null;
    let rectsForLayout = "";

    function invalidateRects() { rects = null; }
    window.addEventListener("resize", invalidateRects);
    setInterval(invalidateRects, 1500);
    try {
        new MutationObserver(invalidateRects).observe(document.documentElement, { childList: true, subtree: true });
    } catch { }

    function chartContainers() {
        const selectors = [".chart-container", ".chart-widget", "[data-name='chart-container']"];
        for (const selector of selectors) {
            const elements = document.querySelectorAll(selector);
            if (elements.length) return elements;
        }
        return [];
    }

    function chartIndexAt(target) {
        const containers = chartContainers();
        for (let index = 0; index < containers.length && index < 8; index++) {
            if (containers[index].contains(target)) return index;
        }
        return -1;
    }

    function markInteraction(durationMs = 300) {
        interactionUntil = Math.max(interactionUntil, performance.now() + durationMs);
    }

    // A TradingView pane click selects the matching settings chart. The reverse
    // direction is intentionally absent: settings tabs never activate TV panes.
    document.addEventListener("pointerdown", (event) => {
        const index = chartIndexAt(event.target);
        if (index < 0) return;
        pointerInteracting = true;
        markInteraction();
        window.postMessage({ __iofTVPaneSelected: true, bridgeVersion: BRIDGE_VERSION, idx: index }, "*");
    }, true);
    document.addEventListener("pointermove", () => { if (pointerInteracting) markInteraction(); }, true);
    document.addEventListener("pointerup", () => { if (pointerInteracting) { pointerInteracting = false; markInteraction(500); } }, true);
    document.addEventListener("pointercancel", () => { if (pointerInteracting) { pointerInteracting = false; markInteraction(500); } }, true);
    document.addEventListener("wheel", (event) => { if (chartIndexAt(event.target) >= 0) markInteraction(500); }, { capture: true, passive: true });

    /** Return the pane that contains the chart's main series. */
    function mainSeriesPane(chart) {
        let panes = null;
        try { panes = typeof chart.getPanes === "function" ? chart.getPanes() : null; } catch { }
        if (!panes?.length) return null;
        for (let index = 0; index < panes.length; index++) {
            try {
                if (typeof panes[index].hasMainSeries === "function" && panes[index].hasMainSeries()) {
                    return { pane: panes[index], index };
                }
            } catch { }
        }
        return { pane: panes[0], index: 0 };
    }

    /** Find the DOM rectangle for one TradingView pane canvas. */
    function paneRectIn(container, height, paneIndex = 0) {
        const candidates = [];
        container.querySelectorAll("canvas").forEach((canvas) => {
            const rect = canvas.getBoundingClientRect();
            if (rect.width > 1 && rect.height > 1) candidates.push(rect);
        });
        if (!candidates.length) return null;

        // TradingView creates duplicate drawing canvases for each pane. Price-axis
        // canvases are narrower than the pane canvases. Keep the widest canvases,
        // remove duplicate rectangles, and use their vertical DOM order.
        const maxWidth = Math.max(...candidates.map((rect) => rect.width));
        const paneCanvases = [];
        for (const rect of candidates) {
            if (rect.width < maxWidth - Math.max(3, maxWidth * 0.05)) continue;
            const duplicate = paneCanvases.some((other) =>
                Math.abs(other.top - rect.top) < 2 && Math.abs(other.left - rect.left) < 2 &&
                Math.abs(other.width - rect.width) < 2 && Math.abs(other.height - rect.height) < 2);
            if (!duplicate) paneCanvases.push(rect);
        }
        paneCanvases.sort((a, b) => a.top - b.top || a.left - b.left);

        const ordered = paneCanvases[paneIndex];
        const exact = paneCanvases.find((rect) => Number.isFinite(height) && Math.abs(rect.height - height) < 3);
        const rect = ordered && (!exact || !Number.isFinite(height) || Math.abs(ordered.height - height) < 3)
            ? ordered
            : exact || ordered;
        return rect ? { top: rect.top, left: rect.left, w: rect.width, h: rect.height } : null;
    }

    /** Return the cached DOM rectangle for a chart's main-series pane. */
    function chartPaneRect(chart, index) {
        if (rects?.[index]) return rects[index];
        try {
            const paneInfo = mainSeriesPane(chart);
            if (!paneInfo) return null;
            const height = typeof paneInfo.pane.getHeight === "function" ? Number(paneInfo.pane.getHeight()) : NaN;
            if (Number.isFinite(height) && height <= 1) return null;
            const container = chartContainers()[index];
            return container ? paneRectIn(container, height, paneInfo.index) : null;
        } catch { return null; }
    }

    /** Return the main-series price scale before other pane scales. */
    function panePriceScales(pane) {
        const scales = [];
        const add = (scale) => { if (scale && !scales.includes(scale)) scales.push(scale); };
        try { if (typeof pane.getMainSourcePriceScale === "function") add(pane.getMainSourcePriceScale()); } catch { }
        for (const method of ["getLeftPriceScales", "getRightPriceScales"]) {
            try {
                const values = typeof pane[method] === "function" ? pane[method]() : null;
                if (values?.length) values.forEach(add);
            } catch { }
        }
        const mainIndex = scales.findIndex((scale) => {
            try { return typeof scale.hasMainSeries === "function" && scale.hasMainSeries(); } catch { return false; }
        });
        if (mainIndex > 0) scales.unshift(scales.splice(mainIndex, 1)[0]);
        return scales;
    }

    /** Convert a visible price range to top and bottom prices. */
    function visibleRangeGeometry(owner, inverted = false) {
        let range = null;
        try { if (owner && typeof owner.getVisiblePriceRange === "function") range = owner.getVisiblePriceRange(); } catch { }
        const from = Number(range?.from);
        const to = Number(range?.to);
        if (![from, to].every(Number.isFinite) || from === to) return null;
        const low = Math.min(from, to);
        const high = Math.max(from, to);
        return { priceTop: inverted ? low : high, priceBottom: inverted ? high : low };
    }

    /** Resolve the chart's price endpoints and scale mode. */
    function priceScaleGeometry(chart, pane, height) {
        for (const priceScale of panePriceScales(pane)) {
            let mode = 0;
            let inverted = false;
            try { if (typeof priceScale.getMode === "function") mode = Number(priceScale.getMode()); } catch { }
            try { if (typeof priceScale.isInverted === "function") inverted = priceScale.isInverted() === true; } catch { }
            if (!Number.isFinite(mode)) mode = 0;

            if (typeof priceScale.coordinateToPrice === "function") {
                try {
                    const priceTop = Number(priceScale.coordinateToPrice(0));
                    const priceBottom = Number(priceScale.coordinateToPrice(height));
                    if ([priceTop, priceBottom].every(Number.isFinite) && priceTop !== priceBottom) {
                        return { priceTop, priceBottom, mode };
                    }
                } catch { }
            }
            const range = visibleRangeGeometry(priceScale, inverted);
            if (range) return { ...range, mode };
        }

        const range = visibleRangeGeometry(chart);
        return range ? { ...range, mode: 0 } : null;
    }

    function occlusionRects(maps) {
        const result = [];
        const seen = new Set();
        for (const element of document.querySelectorAll(OCCLUSION_SELECTOR)) {
            if (!(element instanceof HTMLElement) || /^(BUTTON|INPUT|SELECT|OPTION)$/.test(element.tagName) ||
                element.closest("#iof-panel, #iof-reopen")) continue;
            const style = getComputedStyle(element);
            if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0) continue;
            const rect = element.getBoundingClientRect();
            const left = Math.max(0, rect.left - 2);
            const top = Math.max(0, rect.top - 2);
            const right = Math.min(innerWidth, rect.right + 2);
            const bottom = Math.min(innerHeight, rect.bottom + 2);
            if (right - left < 2 || bottom - top < 2) continue;
            if (!maps.some((map) => left < map.paneLeft + map.paneW && right > map.paneLeft &&
                top < map.paneTop + map.H && bottom > map.paneTop)) continue;
            const value = { left, top, w: right - left, h: bottom - top };
            const key = [left, top, value.w, value.h].map((number) => Math.round(number)).join(",");
            if (!seen.has(key)) { seen.add(key); result.push(value); }
            if (result.length >= 32) break;
        }
        return result;
    }

    function unixTime(value) {
        if (Number.isFinite(value)) return Number(value) > 100000000000 ? Number(value) / 1000 : Number(value);
        if (value && Number.isFinite(value.timestamp)) return Number(value.timestamp) > 100000000000 ? Number(value.timestamp) / 1000 : Number(value.timestamp);
        if (typeof value === "string") {
            const parsed = Date.parse(value);
            return Number.isFinite(parsed) ? parsed / 1000 : null;
        }
        return null;
    }

    function visibleTimeRange(chart) {
        let range = null;
        try { if (typeof chart.getVisibleRange === "function") range = chart.getVisibleRange(); } catch { }
        if (!range) {
            try {
                const scale = typeof chart.getTimeScale === "function" ? chart.getTimeScale() : null;
                if (scale && typeof scale.getVisibleRange === "function") range = scale.getVisibleRange();
            } catch { }
        }
        const from = unixTime(range?.from);
        const to = unixTime(range?.to);
        return Number.isFinite(from) && Number.isFinite(to) && from !== to ? { from, to } : null;
    }

    function timestampCoordinate(chart, timestamp, paneLeft, paneWidth) {
        if (!Number.isFinite(timestamp)) return null;
        let scale = null;
        try { scale = typeof chart.getTimeScale === "function" ? chart.getTimeScale() : null; } catch { }
        for (const owner of [scale, chart]) {
            if (!owner || typeof owner.timeToCoordinate !== "function") continue;
            for (const value of [timestamp, { timestamp }]) {
                try {
                    const coordinate = Number(owner.timeToCoordinate(value));
                    if (Number.isFinite(coordinate)) return coordinate >= -paneWidth * 4 && coordinate <= paneWidth * 5 ? paneLeft + coordinate : coordinate;
                } catch { }
            }
        }

        // Current TradingView Desktop exposes coordinateToTime but not its inverse.
        // Invert that monotonic mapping and center the coordinate range belonging to
        // the requested candle timestamp. This preserves bar spacing, session gaps,
        // right-side margins, panning, and horizontal zoom exactly.
        if (!scale || typeof scale.coordinateToTime !== "function") return null;
        const timeAt = (coordinate) => {
            try { return unixTime(scale.coordinateToTime(coordinate)); } catch { return null; }
        };
        let low = -paneWidth * 0.25;
        let high = paneWidth * 1.25;
        const boundaryStep = Math.max(1, paneWidth / 32);
        let lowTime = timeAt(low);
        let highTime = timeAt(high);
        while (!Number.isFinite(lowTime) && low < paneWidth) { low += boundaryStep; lowTime = timeAt(low); }
        while (!Number.isFinite(highTime) && high > low) { high -= boundaryStep; highTime = timeAt(high); }
        if (!Number.isFinite(lowTime) || !Number.isFinite(highTime) || timestamp < lowTime || timestamp > highTime) return null;
        const upperBoundary = high;

        for (let iteration = 0; iteration < 40; iteration++) {
            const middle = (low + high) / 2;
            const value = timeAt(middle);
            if (!Number.isFinite(value) || value < timestamp) low = middle;
            else high = middle;
        }
        const start = high;
        low = start;
        high = upperBoundary;
        for (let iteration = 0; iteration < 40; iteration++) {
            const middle = (low + high) / 2;
            const value = timeAt(middle);
            if (Number.isFinite(value) && value <= timestamp) low = middle;
            else high = middle;
        }
        const coordinate = (start + low) / 2;
        return timeAt(coordinate) === timestamp ? paneLeft + coordinate : null;
    }

    function exactTimeCoordinate(chart, date, paneLeft, paneWidth) {
        const midnight = Date.parse(`${date}T00:00:00Z`) / 1000;
        const noon = Date.parse(`${date}T12:00:00Z`) / 1000;
        if (!Number.isFinite(midnight)) return null;
        return timestampCoordinate(chart, midnight, paneLeft, paneWidth) ?? timestampCoordinate(chart, noon, paneLeft, paneWidth);
    }

    window.addEventListener("message", (event) => {
        const message = event.data;
        if (!message?.__iofTVAnchorRequest || message.bridgeVersion !== BRIDGE_VERSION || !Array.isArray(message.requests)) return;
        const api = window.TradingViewApi;
        if (!api || typeof api.chart !== "function") return;
        const anchors = {};
        const timeCoordinates = {};
        for (const request of message.requests.slice(0, 8)) {
            const index = Number(request.idx);
            if (!Number.isInteger(index) || index < 0 || index > 15) continue;
            let chart;
            try { chart = api.chart(index); } catch { continue; }
            if (!chart) continue;
            const rect = chartPaneRect(chart, index);
            if (!rect) continue;
            anchors[index] = {};
            timeCoordinates[index] = {};
            for (const date of (Array.isArray(request.dates) ? request.dates : []).slice(0, 30)) {
                if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
                const coordinate = exactTimeCoordinate(chart, date, rect.left, rect.w);
                if (Number.isFinite(coordinate)) anchors[index][date] = coordinate;
            }
            for (const rawTimestamp of (Array.isArray(request.times) ? request.times : []).slice(0, 1200)) {
                const timestamp = Math.floor(Number(rawTimestamp));
                if (!Number.isFinite(timestamp)) continue;
                const coordinate = timestampCoordinate(chart, timestamp, rect.left, rect.w);
                if (Number.isFinite(coordinate)) timeCoordinates[index][timestamp] = coordinate;
            }
        }
        window.postMessage({ __iofTVAnchors: true, bridgeVersion: BRIDGE_VERSION, requestId: message.requestId, anchors, timeCoordinates }, "*");
    });

    function compute() {
        try {
            const api = window.TradingViewApi;
            if (!api || typeof api.chart !== "function") return { error: "TradingViewApi is unavailable" };

            const count = typeof api.chartsCount === "function" ? Number(api.chartsCount()) : 1;
            if (!Number.isInteger(count) || count < 1 || count > 16) return { error: "TradingView returned an unsupported chart count" };
            const layout = typeof api.layout === "function" ? String(api.layout()) : "s";
            const activeIndex = typeof api.activeChartIndex === "function" ? Number(api.activeChartIndex()) : 0;
            const containers = chartContainers();
            if (!containers.length) return { error: "TradingView chart containers were not found" };

            if (rects && (rects.length !== count || rectsForLayout !== layout)) rects = null;
            if (!rects) { rects = new Array(count).fill(null); rectsForLayout = layout; }

            const maps = [];
            const failures = [];
            for (let index = 0; index < count && index < 8; index++) {
                let chart;
                try { chart = api.chart(index); } catch { }
                if (!chart) { failures.push(`chart ${index + 1}: chart API was unavailable`); continue; }

                const paneInfo = mainSeriesPane(chart);
                if (!paneInfo) { failures.push(`chart ${index + 1}: main-series pane was unavailable`); continue; }
                const pane = paneInfo.pane;
                let height = NaN;
                try { if (typeof pane.getHeight === "function") height = Number(pane.getHeight()); } catch { }
                if (Number.isFinite(height) && height <= 1) {
                    failures.push(`chart ${index + 1}: main-series pane was collapsed`);
                    continue;
                }

                const container = containers[index];
                if (!container) { failures.push(`chart ${index + 1}: chart container was unavailable`); continue; }
                if (!rects[index]) rects[index] = paneRectIn(container, height, paneInfo.index);
                const rect = rects[index];
                if (!rect) { failures.push(`chart ${index + 1}: pane canvas was unavailable`); continue; }
                if (!Number.isFinite(height) || height <= 0) height = rect.h;

                const geometry = priceScaleGeometry(chart, pane, height);
                if (!geometry) { failures.push(`chart ${index + 1}: visible price range was unavailable`); continue; }
                const { priceTop, priceBottom, mode } = geometry;

                let symbol = "";
                let resolution = "";
                try { symbol = typeof chart.symbol === "function" ? String(chart.symbol()) : ""; } catch { }
                try { resolution = typeof chart.resolution === "function" ? String(chart.resolution()) : ""; } catch { }
                const timeRange = visibleTimeRange(chart);
                let logicalRange = null;
                try { if (typeof chart.getTimeScaleLogicalRange === "function") logicalRange = chart.getTimeScaleLogicalRange(); } catch { }
                const logicalFrom = Number(logicalRange?._left ?? logicalRange?.from);
                const logicalTo = Number(logicalRange?._right ?? logicalRange?.to);

                maps.push({
                    idx: index,
                    symbol: symbol.slice(0, 80),
                    resolution: resolution.slice(0, 16),
                    active: index === activeIndex,
                    paneTop: rect.top,
                    paneLeft: rect.left,
                    paneW: rect.w,
                    H: rect.h,
                    priceTop,
                    priceBottom,
                    timeFrom: timeRange?.from ?? null,
                    timeTo: timeRange?.to ?? null,
                    logicalFrom: Number.isFinite(logicalFrom) ? logicalFrom : null,
                    logicalTo: Number.isFinite(logicalTo) ? logicalTo : null,
                    mode,
                });
            }

            if (!maps.length) {
                const detail = failures.slice(0, 3).join("; ");
                return { error: `TradingView price-scale geometry could not be resolved${detail ? ` (${detail})` : ""}` };
            }
            return { state: { layout: layout.slice(0, 32), count: maps.length, maps, occlusions: occlusionRects(maps) } };
        } catch (error) {
            return { error: `TradingView compatibility failure: ${String(error?.message || error).slice(0, 120)}` };
        }
    }

    function publishError(error, now) {
        if (!errorSince) errorSince = now;
        if (now - errorSince < ERROR_GRACE_MS || error === lastError) return;
        lastError = error;
        lastStateKey = "";
        window.postMessage({ __iofTV: true, bridgeVersion: BRIDGE_VERSION, error }, "*");
    }

    function publishState(state) {
        errorSince = 0;
        lastError = "";
        const key = state.layout + "|" + state.maps.map((map) => [
            map.idx, map.symbol, map.resolution, map.paneTop | 0, map.paneLeft | 0,
            map.paneW | 0, map.H | 0, map.priceTop.toFixed(3), map.priceBottom.toFixed(3),
            Number.isFinite(map.timeFrom) ? map.timeFrom.toFixed(0) : "", Number.isFinite(map.timeTo) ? map.timeTo.toFixed(0) : "",
            Number.isFinite(map.logicalFrom) ? map.logicalFrom.toFixed(4) : "", Number.isFinite(map.logicalTo) ? map.logicalTo.toFixed(4) : "",
            map.mode, map.active ? 1 : 0,
        ].join(",")).join(";") + "|" + (state.occlusions || []).map((rect) => [
            rect.left | 0, rect.top | 0, rect.w | 0, rect.h | 0,
        ].join(",")).join(";");
        if (key === lastStateKey) return;
        lastStateKey = key;
        markInteraction(250);
        window.postMessage({ __iofTV: true, bridgeVersion: BRIDGE_VERSION, state }, "*");
    }

    function tick(now) {
        const active = pointerInteracting || now < interactionUntil;
        const interval = active ? 16 : 100;
        if (now - lastComputeAt >= interval) {
            lastComputeAt = now;
            const result = compute();
            if (result.state) publishState(result.state);
            else publishError(result.error || "Unknown TradingView compatibility failure", now);
        }
        requestAnimationFrame(tick);
    }

    requestAnimationFrame(tick);
})();

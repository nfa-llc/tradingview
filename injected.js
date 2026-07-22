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

    function paneRectIn(container, height) {
        let best = null;
        container.querySelectorAll("canvas").forEach((canvas) => {
            const rect = canvas.getBoundingClientRect();
            if (Math.abs(rect.height - height) < 3 && rect.width > 150 && rect.height > 50 && (!best || rect.width > best.w)) {
                best = { top: rect.top, left: rect.left, w: rect.width };
            }
        });
        return best;
    }

    function chartPaneRect(chart, index) {
        if (rects?.[index]) return rects[index];
        try {
            const pane = typeof chart.getPanes === "function" ? chart.getPanes()?.[0] : null;
            const height = pane && typeof pane.getHeight === "function" ? Number(pane.getHeight()) : NaN;
            const container = chartContainers()[index];
            return container && Number.isFinite(height) && height > 0 ? paneRectIn(container, height) : null;
        } catch { return null; }
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
            for (let index = 0; index < count && index < 8; index++) {
                let chart;
                try { chart = api.chart(index); } catch { continue; }
                if (!chart) continue;

                const panes = typeof chart.getPanes === "function" ? chart.getPanes() : null;
                if (!panes?.length) continue;
                const pane = panes[0];
                const priceScale = typeof pane.getMainSourcePriceScale === "function" ? pane.getMainSourcePriceScale() : null;
                if (!priceScale || typeof priceScale.coordinateToPrice !== "function" || typeof pane.getHeight !== "function") continue;

                const height = Number(pane.getHeight());
                const priceTop = Number(priceScale.coordinateToPrice(0));
                const priceBottom = Number(priceScale.coordinateToPrice(height));
                if (![height, priceTop, priceBottom].every(Number.isFinite) || height <= 0 || priceTop === priceBottom) continue;

                const container = containers[index];
                if (!container) continue;
                if (!rects[index]) rects[index] = paneRectIn(container, height);
                const rect = rects[index];
                if (!rect) continue;

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
                    H: height,
                    priceTop,
                    priceBottom,
                    timeFrom: timeRange?.from ?? null,
                    timeTo: timeRange?.to ?? null,
                    logicalFrom: Number.isFinite(logicalFrom) ? logicalFrom : null,
                    logicalTo: Number.isFinite(logicalTo) ? logicalTo : null,
                    mode: typeof priceScale.getMode === "function" ? Number(priceScale.getMode()) : 0,
                });
            }

            if (!maps.length) return { error: "TradingView price-scale geometry could not be resolved" };
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

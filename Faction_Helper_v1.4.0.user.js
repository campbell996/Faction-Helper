// ==UserScript==
// @name         Faction Helper
// @namespace    https://www.torn.com/
// @version      1.4.0
// @description  Faction scanner with war/outside-hit/OC/Xanax stats, themed draggable panels, custom resize handles, and RWPH-compatible launcher placement.
// @author       BackFromTheDead Gaming
// @match        https://www.torn.com/*
// @connect      api.torn.com
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_deleteValue
// @run-at       document-idle
// ==/UserScript==

(() => {
    'use strict';

    const APP = {
        name: 'Faction Helper',
        version: '1.4.0',
        keyStorage: 'bftd_fws_api_key_v1',
        cacheStorage: 'bftd_fws_stats_cache_v5',
        xanaxCacheStorage: 'bftd_fws_xanax_cache_v1',
        warReportCacheStorage: 'bftd_fh_war_report_cache_v1',
        uiStorage: 'bftd_fws_ui_v1',
        cacheTtlMs: 365 * 24 * 60 * 60 * 1000,
        xanaxCacheTtlMs: 6 * 60 * 60 * 1000,
        requestDelayMs: 850,
        apiBase: 'https://api.torn.com/v2',
        customKeyUrl:
            'https://www.torn.com/preferences.php#tab=api?step=addNewKey&title=Faction%20Helper&user=faction,personalstats&faction=basic,members,attacks,crimes,news,rankedwars,rankedwarreport'
    };

    const state = {
        apiKey: String(GM_getValue(APP.keyStorage, '') || '').trim(),
        keyInfo: null,
        faction: null,
        members: [],
        memberMap: new Map(),
        selectedPreset: '6m',
        search: '',
        currentMember: null,
        mainPanel: null,
        statsPanel: null,
        launcher: null,
        loadingStats: false,
        scanRunning: false,
        scanProgress: null,
        scanError: '',
        abortScan: false,
        lastAggregates: null,
        lastOcAggregates: null,
        lastArmoryXanaxAggregates: null,
        lastRange: null,
        zCounter: 1000000,
        launcherObserver: null,
        launcherSyncTimer: null
    };

    const SUCCESS_RESULTS = new Set(['attacked', 'mugged', 'hospitalized', 'special', 'bounty', 'looted']);
    const FAILURE_RESULTS = new Set(['lost', 'stalemate', 'escape', 'timeout', 'interrupted', 'arrested']);

    const THEME_PRESETS = {
        dark:     { name:'Classic Dark',  bg:'#101214', panel:'#191c20', panel2:'#23272c', header:'#111316', border:'#363c43', text:'#f2f4f6', muted:'#9da7b2', accent:'#e6b94a', input:'#0f1113' },
        midnight: { name:'Midnight Blue', bg:'#0d121b', panel:'#151c28', panel2:'#1d2735', header:'#0f1620', border:'#334258', text:'#eef5ff', muted:'#94a7bf', accent:'#58a6ff', input:'#0b1119' },
        crimson:  { name:'Crimson',       bg:'#140d10', panel:'#1e1418', panel2:'#291b20', header:'#150e11', border:'#51323b', text:'#fff1f3', muted:'#bea1a8', accent:'#ee6677', input:'#120c0e' },
        emerald:  { name:'Emerald',       bg:'#0d1411', panel:'#151e1a', panel2:'#1d2a24', header:'#0f1613', border:'#335044', text:'#effbf5', muted:'#9bb9aa', accent:'#55cc8a', input:'#0b110e' },
        violet:   { name:'Violet',        bg:'#120f18', panel:'#1b1724', panel2:'#262033', header:'#130f1a', border:'#483c60', text:'#f7f2ff', muted:'#b0a3c5', accent:'#a77bff', input:'#100d15' },
        steel:    { name:'Steel',         bg:'#101417', panel:'#192026', panel2:'#222c34', header:'#11171b', border:'#3a4a55', text:'#f0f5f7', muted:'#9dacb5', accent:'#86b8d2', input:'#0d1215' }
    };

    function esc(value) {
        return String(value ?? '')
            .replaceAll('&', '&amp;')
            .replaceAll('<', '&lt;')
            .replaceAll('>', '&gt;')
            .replaceAll('"', '&quot;')
            .replaceAll("'", '&#039;');
    }

    function num(value, fallback = 0) {
        const n = Number(value);
        return Number.isFinite(n) ? n : fallback;
    }

    function round(value, places = 2) {
        const p = 10 ** places;
        return Math.round((num(value) + Number.EPSILON) * p) / p;
    }

    function fmt(value, places = 0) {
        return num(value).toLocaleString(undefined, {
            minimumFractionDigits: places,
            maximumFractionDigits: places
        });
    }

    function sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    function apiErrorMessage(payload, status = 0) {
        if (!payload) return `Torn API request failed${status ? ` (HTTP ${status})` : ''}.`;
        if (typeof payload.error === 'string') return payload.error;
        if (payload.error && typeof payload.error === 'object') {
            return payload.error.error || payload.error.message || `Torn API error ${payload.error.code ?? ''}`.trim();
        }
        if (payload.message) return payload.message;
        return `Torn API request failed${status ? ` (HTTP ${status})` : ''}.`;
    }

    function gmJson(url, key = state.apiKey) {
        return new Promise((resolve, reject) => {
            GM_xmlhttpRequest({
                method: 'GET',
                url,
                headers: {
                    'Authorization': `ApiKey ${key}`,
                    'Accept': 'application/json'
                },
                timeout: 30000,
                onload: response => {
                    let data;
                    try {
                        data = JSON.parse(response.responseText || '{}');
                    } catch {
                        reject(new Error(`Invalid JSON returned by Torn API (HTTP ${response.status}).`));
                        return;
                    }
                    if (response.status < 200 || response.status >= 300 || data?.error) {
                        reject(new Error(apiErrorMessage(data, response.status)));
                        return;
                    }
                    resolve(data);
                },
                ontimeout: () => reject(new Error('Torn API request timed out.')),
                onerror: () => reject(new Error('Could not reach the Torn API.'))
            });
        });
    }

    function apiUrl(path, params = {}) {
        const url = new URL(`${APP.apiBase}${path}`);
        Object.entries(params).forEach(([key, value]) => {
            if (value !== undefined && value !== null && value !== '') {
                url.searchParams.set(key, String(value));
            }
        });
        return url.toString();
    }

    function cleanNextUrl(next) {
        if (!next) return null;
        try {
            const url = new URL(next);
            if (url.hostname !== 'api.torn.com') return null;
            // Authorization header is authoritative. Remove any blank/stale key from pagination links.
            url.searchParams.delete('key');
            return url.toString();
        } catch {
            return null;
        }
    }

    function injectCss() {
        if (document.getElementById('bftd-fws-style')) return;
        const style = document.createElement('style');
        style.id = 'bftd-fws-style';
        style.textContent = `
            :root {
                --bftd-bg: #121416;
                --bftd-panel: #1b1e22;
                --bftd-panel2: #23272c;
                --bftd-border: #363c43;
                --bftd-text: #f1f3f5;
                --bftd-muted: #9ca6b1;
                --bftd-accent: #e6b94a;
                --bftd-good: #55c58a;
                --bftd-bad: #e36b6b;
                --bftd-info: #6aa9e9;
            }
            #bftd-fws-launcher {
                position: fixed;
                right: 18px;
                bottom: 18px;
                z-index: 999999;
                border: 1px solid #6d5725;
                border-radius: 9px;
                background: linear-gradient(180deg,#2b2f34,#1c1f23);
                color: #fff;
                padding: 9px 12px;
                font-weight: 700;
                font-size: 12px;
                cursor: pointer;
                box-shadow: 0 8px 28px rgba(0,0,0,.45);
            }
            #bftd-fws-launcher:hover { border-color: var(--bftd-accent); }
            .bftd-fws-panel {
                position: fixed;
                z-index: 1000000;
                background: var(--bftd-panel);
                color: var(--bftd-text);
                border: 1px solid var(--bftd-border);
                border-radius: 10px;
                box-shadow: 0 18px 55px rgba(0,0,0,.55);
                overflow: hidden;
                font-family: Arial, sans-serif;
                min-width: 320px;
                min-height: 180px;
                resize: both;
            }
            #bftd-fws-main {
                width: 520px;
                height: 650px;
                top: 80px;
                right: 30px;
            }
            #bftd-fws-stats {
                width: 570px;
                height: 650px;
                top: 100px;
                left: 30px;
            }
            .bftd-fws-head {
                height: 42px;
                display: flex;
                align-items: center;
                gap: 8px;
                padding: 0 10px 0 12px;
                background: #15181b;
                border-bottom: 1px solid var(--bftd-border);
                user-select: none;
                cursor: move;
            }
            .bftd-fws-head strong { font-size: 13px; flex: 1; }
            .bftd-fws-sub { color: var(--bftd-muted); font-size: 11px; }
            .bftd-fws-close, .bftd-fws-iconbtn {
                border: 1px solid var(--bftd-border);
                background: #262a2f;
                color: #dce1e6;
                border-radius: 6px;
                height: 26px;
                min-width: 28px;
                cursor: pointer;
                font-weight: 700;
            }
            .bftd-fws-close:hover { border-color: #a94e4e; color: #ff8c8c; }
            .bftd-fws-iconbtn:hover { border-color: var(--bftd-accent); }
            .bftd-fws-body {
                height: calc(100% - 43px);
                overflow: auto;
                padding: 12px;
                box-sizing: border-box;
            }
            .bftd-fws-card {
                border: 1px solid var(--bftd-border);
                background: var(--bftd-panel2);
                border-radius: 8px;
                padding: 10px;
                margin-bottom: 10px;
            }
            .bftd-fws-row {
                display: flex;
                gap: 8px;
                align-items: center;
            }
            .bftd-fws-row.wrap { flex-wrap: wrap; }
            .bftd-fws-grow { flex: 1; min-width: 0; }
            .bftd-fws-input, .bftd-fws-select {
                box-sizing: border-box;
                width: 100%;
                height: 34px;
                border: 1px solid var(--bftd-border);
                border-radius: 7px;
                background: #111315;
                color: var(--bftd-text);
                padding: 0 9px;
                outline: none;
            }
            .bftd-fws-input:focus, .bftd-fws-select:focus { border-color: var(--bftd-accent); }
            .bftd-fws-btn {
                height: 34px;
                border: 1px solid #5a4c28;
                border-radius: 7px;
                background: #332b1b;
                color: #f6d77d;
                padding: 0 11px;
                cursor: pointer;
                font-weight: 700;
                white-space: nowrap;
            }
            .bftd-fws-btn:hover { border-color: var(--bftd-accent); }
            .bftd-fws-btn.secondary {
                border-color: var(--bftd-border);
                background: #292d32;
                color: #dfe4e8;
            }
            .bftd-fws-btn.danger {
                border-color: #633b3b;
                background: #332020;
                color: #f3a0a0;
            }
            .bftd-fws-periods { display:grid; grid-template-columns: repeat(4,1fr); gap:6px; }
            .bftd-fws-period {
                border: 1px solid var(--bftd-border);
                background: #171a1d;
                color: #d6dde4;
                border-radius: 6px;
                height: 32px;
                cursor: pointer;
                font-weight: 700;
                font-size: 11px;
            }
            .bftd-fws-period.active { border-color: var(--bftd-accent); background: #342d1c; color:#ffe09a; }
            .bftd-fws-members { display: flex; flex-direction: column; gap: 6px; }
            .bftd-fws-member {
                width: 100%;
                text-align: left;
                border: 1px solid var(--bftd-border);
                background: #181b1f;
                color: var(--bftd-text);
                border-radius: 7px;
                padding: 8px 9px;
                cursor: pointer;
            }
            .bftd-fws-member:hover { border-color: #65707b; background:#202429; }
            .bftd-fws-member:disabled { opacity:.42; cursor:not-allowed; border-color:#30343a; background:#15171a; }
            .bftd-fws-member:disabled:hover { border-color:#30343a; background:#15171a; }
            .bftd-fws-scanstatus { display:flex; align-items:center; gap:8px; margin-top:8px; }
            .bftd-fws-scanstatus .bftd-fws-grow { line-height:1.35; }
            .bftd-fws-member-name { font-size: 12px; font-weight: 700; }
            .bftd-fws-member-meta { font-size: 10px; color: var(--bftd-muted); margin-top: 3px; }
            .bftd-fws-badge {
                display:inline-block;
                border:1px solid var(--bftd-border);
                border-radius:999px;
                padding:2px 7px;
                font-size:10px;
                color:var(--bftd-muted);
                background:#17191c;
            }
            .bftd-fws-badge.good { color:#9ee8bf; border-color:#35694d; }
            .bftd-fws-badge.bad { color:#f1a7a7; border-color:#6c3a3a; }
            .bftd-fws-badge.info { color:#a6cff7; border-color:#3d5f7d; }
            .bftd-fws-grid {
                display:grid;
                grid-template-columns: repeat(3,1fr);
                gap:8px;
            }
            .bftd-fws-stat {
                min-height:64px;
                background:#15181b;
                border:1px solid var(--bftd-border);
                border-radius:7px;
                padding:8px;
                box-sizing:border-box;
            }
            .bftd-fws-stat .v { font-size:18px; font-weight:800; color:#fff; }
            .bftd-fws-stat .k { font-size:10px; color:var(--bftd-muted); margin-top:4px; }
            .bftd-fws-table { width:100%; border-collapse:collapse; font-size:11px; }
            .bftd-fws-table th, .bftd-fws-table td { padding:7px 6px; border-bottom:1px solid #30353b; text-align:left; }
            .bftd-fws-table th { color:#aab3bc; font-size:10px; }
            .bftd-fws-table td:last-child, .bftd-fws-table th:last-child { text-align:right; }
            .bftd-fws-note { color:var(--bftd-muted); font-size:10px; line-height:1.45; }
            .bftd-fws-error { color:#ffaaaa; border:1px solid #673d3d; background:#2c1c1c; padding:9px; border-radius:7px; font-size:11px; line-height:1.45; }
            .bftd-fws-ok { color:#a9e6c5; border:1px solid #356649; background:#18291f; padding:9px; border-radius:7px; font-size:11px; }
            .bftd-fws-progress {
                height:7px; border-radius:999px; overflow:hidden; background:#111315; border:1px solid #30343a; margin-top:8px;
            }
            .bftd-fws-progress > div {
                height:100%; width:35%; background:linear-gradient(90deg,#806a2b,#e6b94a,#806a2b);
                animation:bftdFwsSlide 1.1s linear infinite;
            }
            @keyframes bftdFwsSlide { from{ transform:translateX(-100%);} to{transform:translateX(300%);} }
            @media (max-width: 700px) {
                #bftd-fws-main, #bftd-fws-stats {
                    width: calc(100vw - 18px) !important;
                    height: calc(100vh - 30px) !important;
                    top: 10px !important;
                    left: 9px !important;
                    right: auto !important;
                }
                .bftd-fws-grid { grid-template-columns: repeat(2,1fr); }
                #bftd-fws-launcher { right:10px; bottom:10px; }
            }
        `;
        document.head.appendChild(style);
    }

    function makeDraggable(panel, handle) {
        let dragging = false;
        let sx = 0, sy = 0, sl = 0, st = 0;

        const start = ev => {
            if (ev.target.closest('button,input,select,a')) return;
            const p = ev.touches ? ev.touches[0] : ev;
            const r = panel.getBoundingClientRect();
            dragging = true;
            sx = p.clientX;
            sy = p.clientY;
            sl = r.left;
            st = r.top;
            panel.style.right = 'auto';
            panel.style.bottom = 'auto';
            ev.preventDefault();
        };

        const move = ev => {
            if (!dragging) return;
            const p = ev.touches ? ev.touches[0] : ev;
            const maxLeft = Math.max(0, window.innerWidth - 80);
            const maxTop = Math.max(0, window.innerHeight - 50);
            panel.style.left = `${Math.min(maxLeft, Math.max(0, sl + p.clientX - sx))}px`;
            panel.style.top = `${Math.min(maxTop, Math.max(0, st + p.clientY - sy))}px`;
        };

        const end = () => { dragging = false; };

        handle.addEventListener('mousedown', start);
        handle.addEventListener('touchstart', start, { passive: false });
        window.addEventListener('mousemove', move);
        window.addEventListener('touchmove', move, { passive: false });
        window.addEventListener('mouseup', end);
        window.addEventListener('touchend', end);
    }


    function loadUiState() {
        const defaults = { theme:{ preset:'dark', custom:{} }, panels:{} };
        try {
            const raw = GM_getValue(APP.uiStorage, '');
            if (!raw) return defaults;
            const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
            return {
                theme: {
                    preset: parsed?.theme?.preset || 'dark',
                    custom: parsed?.theme?.custom || {}
                },
                panels: parsed?.panels && typeof parsed.panels === 'object' ? parsed.panels : {}
            };
        } catch {
            return defaults;
        }
    }

    function saveUiState(ui) {
        try { GM_setValue(APP.uiStorage, JSON.stringify(ui)); } catch {}
    }

    function currentTheme() {
        const ui = loadUiState();
        const preset = THEME_PRESETS[ui.theme?.preset] || THEME_PRESETS.dark;
        return { ...preset, ...(ui.theme?.custom || {}) };
    }

    function applyTheme() {
        const t = currentTheme();
        const root = document.documentElement;
        const vars = {
            '--bftd-bg': t.bg,
            '--bftd-panel': t.panel,
            '--bftd-panel2': t.panel2,
            '--bftd-header': t.header,
            '--bftd-border': t.border,
            '--bftd-text': t.text,
            '--bftd-muted': t.muted,
            '--bftd-accent': t.accent,
            '--bftd-input': t.input
        };
        Object.entries(vars).forEach(([k,v]) => root.style.setProperty(k, v));
    }

    function injectUiV2Css() {
        if (document.getElementById('bftd-fh-ui-v2-style')) return;
        const style = document.createElement('style');
        style.id = 'bftd-fh-ui-v2-style';
        style.textContent = `
            :root { --bftd-header:#111316; --bftd-input:#0f1113; }

            #bftd-fws-launcher {
                position:static !important;
                width:28px !important;
                height:28px !important;
                min-width:28px !important;
                min-height:28px !important;
                padding:0 !important;
                margin:0 0 0 6px !important;
                display:inline-flex !important;
                align-items:center !important;
                justify-content:center !important;
                vertical-align:middle !important;
                border:1px solid color-mix(in srgb,var(--bftd-accent) 58%,#4c5158) !important;
                border-radius:7px !important;
                background:linear-gradient(180deg,color-mix(in srgb,var(--bftd-panel2) 88%,#fff 12%),var(--bftd-panel)) !important;
                color:var(--bftd-text) !important;
                box-shadow:0 3px 12px rgba(0,0,0,.32) !important;
                transition:transform .12s ease,border-color .12s ease,box-shadow .12s ease !important;
            }
            #bftd-fws-launcher:hover {
                transform:translateY(-1px);
                border-color:var(--bftd-accent) !important;
            }
            #bftd-fws-launcher svg { width:19px; height:19px; display:block; pointer-events:none; }

            .bftd-fws-panel,.bftd-fws-panel * { box-sizing:border-box; }
            .bftd-fws-panel {
                display:flex !important;
                flex-direction:column !important;
                resize:none !important;
                min-width:320px !important;
                min-height:230px !important;
                max-width:calc(100vw - 8px) !important;
                max-height:calc(100vh - 8px) !important;
                border-radius:12px !important;
                overflow:hidden !important;
                background:linear-gradient(180deg,color-mix(in srgb,var(--bftd-panel) 96%,#fff 4%),var(--bftd-panel)) !important;
                border-color:color-mix(in srgb,var(--bftd-border) 84%,var(--bftd-accent) 16%) !important;
                box-shadow:0 22px 65px rgba(0,0,0,.58),inset 0 1px rgba(255,255,255,.025) !important;
            }
            #bftd-fws-main {
                width:min(570px,calc(100vw - 40px));
                height:min(700px,calc(100vh - 70px));
                top:70px;
                right:24px;
            }
            #bftd-fws-stats {
                width:min(760px,calc(100vw - 40px));
                height:min(720px,calc(100vh - 70px));
                top:80px;
                left:24px;
            }

            .bftd-fws-head {
                flex:0 0 46px !important;
                height:46px !important;
                min-height:46px !important;
                padding:0 9px 0 23px !important;
                background:linear-gradient(180deg,color-mix(in srgb,var(--bftd-header) 88%,var(--bftd-accent) 4%),var(--bftd-header)) !important;
                position:relative;
                z-index:8;
            }
            .bftd-fws-titlegroup {
                min-width:0;
                flex:1;
                display:flex;
                align-items:baseline;
                gap:8px;
            }
            .bftd-fws-head strong {
                min-width:0;
                overflow:hidden;
                text-overflow:ellipsis;
                white-space:nowrap;
                font-weight:800 !important;
            }
            .bftd-fws-sub { flex:0 0 auto; white-space:nowrap; }

            .bftd-fws-close,.bftd-fws-iconbtn {
                flex:0 0 auto;
                height:28px !important;
                min-width:29px !important;
                border-radius:7px !important;
                background:color-mix(in srgb,var(--bftd-panel2) 88%,#000 12%) !important;
                color:var(--bftd-text) !important;
            }
            .bftd-fws-iconbtn:hover { border-color:var(--bftd-accent) !important; color:var(--bftd-accent) !important; }

            .bftd-fws-body {
                flex:1 1 auto !important;
                min-width:0 !important;
                min-height:0 !important;
                width:100% !important;
                height:auto !important;
                overflow:auto !important;
                overscroll-behavior:contain;
                scrollbar-gutter:stable;
                padding:12px !important;
                background:
                    radial-gradient(circle at top right,color-mix(in srgb,var(--bftd-accent) 5%,transparent) 0,transparent 280px),
                    var(--bftd-bg);
            }
            .bftd-fws-body > * { min-width:0; max-width:100%; }

            .bftd-fws-card {
                min-width:0;
                max-width:100%;
                border-radius:9px !important;
                background:linear-gradient(180deg,color-mix(in srgb,var(--bftd-panel2) 94%,#fff 6%),var(--bftd-panel2)) !important;
                overflow-wrap:anywhere;
            }
            .bftd-fws-card:has(.bftd-fws-table) { overflow:auto; }

            .bftd-fws-row {
                min-width:0;
                max-width:100%;
                flex-wrap:wrap !important;
            }
            .bftd-fws-grow { flex:1 1 180px !important; min-width:0 !important; }

            .bftd-fws-input,.bftd-fws-select {
                min-width:0;
                background:var(--bftd-input) !important;
                color:var(--bftd-text) !important;
            }
            .bftd-fws-input:focus,.bftd-fws-select:focus {
                box-shadow:0 0 0 2px color-mix(in srgb,var(--bftd-accent) 16%,transparent);
            }

            .bftd-fws-btn {
                max-width:100%;
                min-height:34px;
                height:auto !important;
                padding:7px 11px !important;
                white-space:normal !important;
                line-height:1.2;
                border-color:color-mix(in srgb,var(--bftd-accent) 48%,var(--bftd-border)) !important;
                background:color-mix(in srgb,var(--bftd-accent) 13%,var(--bftd-panel2)) !important;
                color:color-mix(in srgb,var(--bftd-accent) 76%,#fff 24%) !important;
            }
            .bftd-fws-btn.secondary {
                border-color:var(--bftd-border) !important;
                background:color-mix(in srgb,var(--bftd-panel2) 90%,#000 10%) !important;
                color:var(--bftd-text) !important;
            }
            .bftd-fws-btn.danger { background:#332020 !important; color:#f3a0a0 !important; border-color:#633b3b !important; }
            .bftd-fws-btn:disabled { opacity:.46; cursor:not-allowed; }

            .bftd-fws-periods { grid-template-columns:repeat(4,minmax(0,1fr)) !important; }
            .bftd-fws-period { min-width:0; background:var(--bftd-input) !important; color:var(--bftd-text) !important; border-radius:7px !important; }
            .bftd-fws-period.active {
                border-color:var(--bftd-accent) !important;
                background:color-mix(in srgb,var(--bftd-accent) 15%,var(--bftd-panel2)) !important;
                color:color-mix(in srgb,var(--bftd-accent) 78%,#fff 22%) !important;
            }

            .bftd-fws-member {
                min-width:0;
                border-radius:8px !important;
                background:color-mix(in srgb,var(--bftd-panel2) 72%,var(--bftd-bg)) !important;
            }
            .bftd-fws-member:hover:not(:disabled) {
                border-color:color-mix(in srgb,var(--bftd-accent) 55%,var(--bftd-border)) !important;
                background:color-mix(in srgb,var(--bftd-accent) 6%,var(--bftd-panel2)) !important;
            }
            .bftd-fws-member-name {
                min-width:0;
                overflow:hidden;
                text-overflow:ellipsis;
                white-space:nowrap;
            }
            .bftd-fws-member-meta,.bftd-fws-note,.bftd-fws-error,.bftd-fws-ok { overflow-wrap:anywhere; }

            .bftd-fws-grid {
                min-width:0;
                grid-template-columns:repeat(auto-fit,minmax(128px,1fr)) !important;
            }
            .bftd-fws-stat {
                min-width:0;
                border-radius:8px !important;
                background:color-mix(in srgb,var(--bftd-panel) 78%,var(--bftd-bg)) !important;
            }
            .bftd-fws-stat .v { min-width:0; overflow-wrap:anywhere; color:var(--bftd-text) !important; }

            .bftd-fws-table {
                min-width:560px;
                width:100%;
            }
            .bftd-fws-table th {
                position:sticky;
                top:0;
                z-index:1;
                background:var(--bftd-panel2);
                color:var(--bftd-muted) !important;
            }
            .bftd-fws-table th,.bftd-fws-table td { white-space:nowrap; border-bottom-color:var(--bftd-border) !important; }

            .bftd-fws-progress { background:var(--bftd-input) !important; border-color:var(--bftd-border) !important; }
            .bftd-fws-progress > div {
                background:linear-gradient(90deg,
                    color-mix(in srgb,var(--bftd-accent) 45%,transparent),
                    var(--bftd-accent),
                    color-mix(in srgb,var(--bftd-accent) 45%,transparent)) !important;
            }

            .bftd-fws-resize {
                position:absolute;
                z-index:30;
                width:20px;
                height:20px;
                touch-action:none;
                opacity:.65;
            }
            .bftd-fws-resize::before,.bftd-fws-resize::after {
                content:'';
                position:absolute;
                height:1.5px;
                width:9px;
                border-radius:2px;
                background:var(--bftd-accent);
                pointer-events:none;
            }
            .bftd-fws-resize::after { width:5px; }
            .bftd-fws-resize:hover { opacity:1; }
            .bftd-fws-resize.tl { left:1px; top:1px; cursor:nwse-resize; }
            .bftd-fws-resize.tl::before { left:3px; top:6px; transform:rotate(-45deg); }
            .bftd-fws-resize.tl::after { left:3px; top:10px; transform:rotate(-45deg); }
            .bftd-fws-resize.bl { left:1px; bottom:1px; cursor:nesw-resize; }
            .bftd-fws-resize.bl::before { left:3px; bottom:6px; transform:rotate(45deg); }
            .bftd-fws-resize.bl::after { left:3px; bottom:10px; transform:rotate(45deg); }
            .bftd-fws-resize.br { right:1px; bottom:1px; cursor:nwse-resize; }
            .bftd-fws-resize.br::before { right:3px; bottom:6px; transform:rotate(-45deg); }
            .bftd-fws-resize.br::after { right:3px; bottom:10px; transform:rotate(-45deg); }

            .bftd-fws-theme-pop {
                position:absolute;
                z-index:25;
                top:43px;
                right:7px;
                width:min(305px,calc(100% - 14px));
                max-height:calc(100% - 52px);
                overflow:auto;
                padding:10px;
                border:1px solid color-mix(in srgb,var(--bftd-accent) 35%,var(--bftd-border));
                border-radius:10px;
                background:color-mix(in srgb,var(--bftd-panel) 96%,#000 4%);
                box-shadow:0 18px 45px rgba(0,0,0,.5);
            }
            .bftd-fws-theme-pop[hidden] { display:none !important; }
            .bftd-fws-theme-title { display:flex; align-items:center; gap:8px; margin-bottom:9px; }
            .bftd-fws-theme-title strong { flex:1; font-size:12px; }
            .bftd-fws-theme-grid { display:grid; grid-template-columns:1fr 1fr; gap:8px; }
            .bftd-fws-theme-field { min-width:0; }
            .bftd-fws-theme-field label { display:block; color:var(--bftd-muted); font-size:9px; margin-bottom:4px; }
            .bftd-fws-color {
                width:100%;
                height:32px;
                padding:2px;
                border:1px solid var(--bftd-border);
                border-radius:6px;
                background:var(--bftd-input);
                cursor:pointer;
            }

            @media (max-width:700px) {
                .bftd-fws-panel {
                    min-width:280px !important;
                    min-height:220px !important;
                    max-width:calc(100vw - 6px) !important;
                    max-height:calc(100vh - 6px) !important;
                }
                #bftd-fws-main,#bftd-fws-stats {
                    width:calc(100vw - 16px);
                    height:calc(100vh - 28px);
                    top:8px;
                    left:8px;
                    right:auto;
                }
                .bftd-fws-grid { grid-template-columns:repeat(auto-fit,minmax(112px,1fr)) !important; }
                .bftd-fws-periods { grid-template-columns:repeat(2,minmax(0,1fr)) !important; }
            }
        `;
        document.head.appendChild(style);
    }

    function panelStateKey(panel) { return panel?.id || 'unknown'; }

    function savePanelGeometry(panel) {
        if (!panel?.isConnected) return;
        const r = panel.getBoundingClientRect();
        const ui = loadUiState();
        ui.panels[panelStateKey(panel)] = {
            left:Math.round(r.left), top:Math.round(r.top),
            width:Math.round(r.width), height:Math.round(r.height)
        };
        saveUiState(ui);
    }

    function constrainPanel(panel) {
        if (!panel?.isConnected) return;
        const r = panel.getBoundingClientRect();
        const minW = Math.min(320, Math.max(280, window.innerWidth - 8));
        const minH = Math.min(230, Math.max(190, window.innerHeight - 8));
        const maxW = Math.max(minW, window.innerWidth - 8);
        const maxH = Math.max(minH, window.innerHeight - 8);
        const width = Math.min(maxW, Math.max(minW, r.width));
        const height = Math.min(maxH, Math.max(minH, r.height));
        const left = Math.min(Math.max(4, r.left), Math.max(4, window.innerWidth - width - 4));
        const top = Math.min(Math.max(4, r.top), Math.max(4, window.innerHeight - height - 4));
        Object.assign(panel.style, {
            width:`${width}px`, height:`${height}px`,
            left:`${left}px`, top:`${top}px`,
            right:'auto', bottom:'auto'
        });
    }

    function restorePanelGeometry(panel) {
        const ui = loadUiState();
        const g = ui.panels?.[panelStateKey(panel)];
        if (g) {
            Object.assign(panel.style, {
                left:`${num(g.left,20)}px`,
                top:`${num(g.top,70)}px`,
                width:`${num(g.width,560)}px`,
                height:`${num(g.height,680)}px`,
                right:'auto', bottom:'auto'
            });
        }
        requestAnimationFrame(() => constrainPanel(panel));
    }

    function bringPanelFront(panel) {
        state.zCounter = Math.max(1000000, num(state.zCounter)) + 1;
        panel.style.zIndex = String(state.zCounter);
    }

    function makePanelDraggable(panel, handle) {
        let dragging = false;
        let sx=0, sy=0, sl=0, st=0;

        const start = ev => {
            if (ev.target.closest('button,input,select,a,.bftd-fws-resize,.bftd-fws-theme-pop')) return;
            const p = ev.touches ? ev.touches[0] : ev;
            const r = panel.getBoundingClientRect();
            dragging = true;
            bringPanelFront(panel);
            sx=p.clientX; sy=p.clientY; sl=r.left; st=r.top;
            panel.style.right='auto'; panel.style.bottom='auto';
            ev.preventDefault();
        };
        const move = ev => {
            if (!dragging) return;
            const p = ev.touches ? ev.touches[0] : ev;
            const r = panel.getBoundingClientRect();
            const maxLeft = Math.max(4, window.innerWidth-r.width-4);
            const maxTop = Math.max(4, window.innerHeight-r.height-4);
            panel.style.left = `${Math.min(maxLeft,Math.max(4,sl+p.clientX-sx))}px`;
            panel.style.top = `${Math.min(maxTop,Math.max(4,st+p.clientY-sy))}px`;
            ev.preventDefault();
        };
        const end = () => {
            if (!dragging) return;
            dragging=false;
            constrainPanel(panel);
            savePanelGeometry(panel);
        };

        handle.addEventListener('mousedown', start);
        handle.addEventListener('touchstart', start, {passive:false});
        window.addEventListener('mousemove', move, {passive:false});
        window.addEventListener('touchmove', move, {passive:false});
        window.addEventListener('mouseup', end);
        window.addEventListener('touchend', end);
    }

    function makeResizable(panel) {
        panel.querySelectorAll('.bftd-fws-resize').forEach(handle => {
            let active=false, startX=0, startY=0, startLeft=0, startTop=0, startWidth=0, startHeight=0;
            const corner=handle.dataset.corner;

            const begin = ev => {
                const p = ev.touches ? ev.touches[0] : ev;
                const r = panel.getBoundingClientRect();
                active=true;
                bringPanelFront(panel);
                startX=p.clientX; startY=p.clientY;
                startLeft=r.left; startTop=r.top; startWidth=r.width; startHeight=r.height;
                panel.style.right='auto'; panel.style.bottom='auto';
                ev.preventDefault(); ev.stopPropagation();
            };
            const move = ev => {
                if (!active) return;
                const p = ev.touches ? ev.touches[0] : ev;
                const dx=p.clientX-startX, dy=p.clientY-startY;
                const minW=Math.min(320,Math.max(280,window.innerWidth-8));
                const minH=Math.min(230,Math.max(190,window.innerHeight-8));
                let left=startLeft, top=startTop, width=startWidth, height=startHeight;

                if (corner==='br') {
                    width=Math.max(minW,startWidth+dx);
                    height=Math.max(minH,startHeight+dy);
                } else if (corner==='bl') {
                    width=Math.max(minW,startWidth-dx);
                    left=startLeft+(startWidth-width);
                    height=Math.max(minH,startHeight+dy);
                } else if (corner==='tl') {
                    width=Math.max(minW,startWidth-dx);
                    height=Math.max(minH,startHeight-dy);
                    left=startLeft+(startWidth-width);
                    top=startTop+(startHeight-height);
                }

                if (left<4) { width += left-4; left=4; }
                if (top<4) { height += top-4; top=4; }
                width=Math.max(minW,Math.min(width,window.innerWidth-left-4));
                height=Math.max(minH,Math.min(height,window.innerHeight-top-4));

                Object.assign(panel.style,{
                    left:`${left}px`,top:`${top}px`,width:`${width}px`,height:`${height}px`
                });
                ev.preventDefault();
            };
            const end = () => {
                if (!active) return;
                active=false;
                constrainPanel(panel);
                savePanelGeometry(panel);
            };

            handle.addEventListener('mousedown', begin);
            handle.addEventListener('touchstart', begin, {passive:false});
            window.addEventListener('mousemove', move, {passive:false});
            window.addEventListener('touchmove', move, {passive:false});
            window.addEventListener('mouseup', end);
            window.addEventListener('touchend', end);
        });
    }

    function resetPanelLayout() {
        const ui=loadUiState();
        ui.panels={};
        saveUiState(ui);
        document.querySelectorAll('.bftd-fws-panel').forEach(panel=>{
            panel.removeAttribute('style');
            requestAnimationFrame(()=>constrainPanel(panel));
        });
    }

    function buildThemePopover(panel) {
        const ui=loadUiState();
        const active=currentTheme();
        const pop=panel.querySelector('.bftd-fws-theme-pop');
        if (!pop) return;

        pop.innerHTML=`
            <div class="bftd-fws-theme-title">
                <strong>Theme & Colours</strong>
                <button class="bftd-fws-iconbtn" data-theme-close title="Close">×</button>
            </div>
            <div class="bftd-fws-theme-field" style="margin-bottom:8px">
                <label>PRESET</label>
                <select class="bftd-fws-select" data-theme-preset>
                    ${Object.entries(THEME_PRESETS).map(([id,t])=>`<option value="${esc(id)}" ${ui.theme?.preset===id?'selected':''}>${esc(t.name)}</option>`).join('')}
                    <option value="custom" ${ui.theme?.preset==='custom'?'selected':''}>Custom</option>
                </select>
            </div>
            <div class="bftd-fws-theme-grid">
                <div class="bftd-fws-theme-field"><label>ACCENT</label><input class="bftd-fws-color" data-theme-colour="accent" type="color" value="${esc(active.accent)}"></div>
                <div class="bftd-fws-theme-field"><label>PANEL</label><input class="bftd-fws-color" data-theme-colour="panel" type="color" value="${esc(active.panel)}"></div>
                <div class="bftd-fws-theme-field"><label>CARDS</label><input class="bftd-fws-color" data-theme-colour="panel2" type="color" value="${esc(active.panel2)}"></div>
                <div class="bftd-fws-theme-field"><label>HEADER</label><input class="bftd-fws-color" data-theme-colour="header" type="color" value="${esc(active.header)}"></div>
                <div class="bftd-fws-theme-field"><label>TEXT</label><input class="bftd-fws-color" data-theme-colour="text" type="color" value="${esc(active.text)}"></div>
                <div class="bftd-fws-theme-field"><label>BORDER</label><input class="bftd-fws-color" data-theme-colour="border" type="color" value="${esc(active.border)}"></div>
            </div>
            <div class="bftd-fws-row" style="margin-top:10px">
                <button class="bftd-fws-btn secondary" data-theme-reset>RESET THEME</button>
                <button class="bftd-fws-btn secondary" data-layout-reset>RESET PANEL LAYOUT</button>
            </div>
        `;

        pop.querySelector('[data-theme-close]')?.addEventListener('click',()=>{ pop.hidden=true; });

        pop.querySelector('[data-theme-preset]')?.addEventListener('change',ev=>{
            const id=ev.target.value;
            const next=loadUiState();
            if (id==='custom') {
                next.theme.preset='custom';
                next.theme.custom={...currentTheme()};
            } else {
                next.theme.preset=id;
                next.theme.custom={};
            }
            saveUiState(next);
            applyTheme();
            buildThemePopover(panel);
            syncLauncher();
        });

        pop.querySelectorAll('[data-theme-colour]').forEach(input=>{
            input.addEventListener('input',ev=>{
                const prop=ev.target.dataset.themeColour;
                const next=loadUiState();
                next.theme.preset='custom';
                next.theme.custom={...currentTheme(),[prop]:ev.target.value};
                saveUiState(next);
                applyTheme();
                const sel=pop.querySelector('[data-theme-preset]');
                if (sel) sel.value='custom';
            });
        });

        pop.querySelector('[data-theme-reset]')?.addEventListener('click',()=>{
            const next=loadUiState();
            next.theme={preset:'dark',custom:{}};
            saveUiState(next);
            applyTheme();
            buildThemePopover(panel);
            syncLauncher();
        });
        pop.querySelector('[data-layout-reset]')?.addEventListener('click',resetPanelLayout);
    }

    function toggleThemePopover(panel) {
        const pop=panel.querySelector('.bftd-fws-theme-pop');
        if (!pop) return;
        const open=pop.hidden;
        document.querySelectorAll('.bftd-fws-theme-pop').forEach(p=>{p.hidden=true;});
        if (open) {
            buildThemePopover(panel);
            pop.hidden=false;
        }
    }

    function getPresetRange(code = state.selectedPreset) {
        const end = new Date();
        const start = new Date(end);
        const months = ({ '1m': 1, '3m': 3, '6m': 6, '12m': 12 }[code] || 6);
        start.setMonth(start.getMonth() - months);
        return {
            code,
            label: `${months} month${months === 1 ? '' : 's'}`,
            from: Math.floor(start.getTime() / 1000),
            to: Math.floor(end.getTime() / 1000)
        };
    }

    function memberLastAction(member) {
        return member?.last_action?.relative || member?.last_action?.status || 'Unknown';
    }

    function memberLastActionTs(member) {
        return num(member?.last_action?.timestamp ?? member?.last_action?.time ?? 0);
    }

    function memberLastOnlineDisplay(member) {
        const ts = memberLastActionTs(member);
        const relative = memberLastAction(member);
        const status = String(member?.last_action?.status || '').trim();
        if (!ts) return relative || 'Unknown';
        return `${dateTime(ts)}${relative ? ` (${relative})` : ''}${status ? ` • ${status}` : ''}`;
    }

    function statusText(member) {
        return member?.status?.state || member?.status?.description || 'Unknown';
    }

    function normalizeMembers(payload) {
        if (Array.isArray(payload?.members)) return payload.members;
        if (payload?.members && typeof payload.members === 'object') {
            return Object.entries(payload.members).map(([id, value]) => ({ id: Number(id), ...value }));
        }
        return [];
    }


    function findFactionHeader() {
        const candidates=[...document.querySelectorAll('h1,h2,h3,h4,[class*="title" i],[class*="header" i]')];
        return candidates.find(el=>{
            if (!el?.isConnected || el.closest('.bftd-fws-panel') || el.offsetParent===null) return false;
            const txt=String(el.textContent||'').replace(/\s+/g,' ').trim();
            return /^(Faction|Faction Warfare)(\b|$)/i.test(txt);
        }) || null;
    }

    function isFactionPage() {
        if (/(^|\/)(factions?\.php|faction_wars\.php)$/i.test(location.pathname)) return true;
        return Boolean(findFactionHeader());
    }

    function findRwphLauncher() {
        const selectors=[
            '#rwph-launcher','#rwphLauncher','#rwph-launch-btn','#rwph-launcher-btn',
            '.rwph-launcher','.rwph-launch-btn','[data-rwph-launcher]',
            '[id*="rwph"][id*="launch" i]','[class*="rwph"][class*="launch" i]'
        ];
        for (const sel of selectors) {
            try {
                const el=document.querySelector(sel);
                if (el && el.id!=='bftd-fws-launcher' && el.offsetParent!==null) return el;
            } catch {}
        }
        return [...document.querySelectorAll('button,a,[role="button"]')].find(el=>{
            if (el.id==='bftd-fws-launcher' || el.closest('.bftd-fws-panel')) return false;
            const probe=`${el.id||''} ${el.className||''} ${el.getAttribute('title')||''} ${el.getAttribute('aria-label')||''}`.toLowerCase();
            return probe.includes('rwph') || probe.includes('ranked war payout helper');
        }) || null;
    }

    function createLauncherButton() {
        const btn=document.createElement('button');
        btn.id='bftd-fws-launcher';
        btn.type='button';
        btn.title=`${APP.name} v${APP.version}`;
        btn.setAttribute('aria-label',APP.name);
        btn.innerHTML=`
            <svg viewBox="0 0 32 32" aria-hidden="true">
                <path d="M16 2.5 27 7v8.2c0 7.2-4.6 11.7-11 14.3C9.6 26.9 5 22.4 5 15.2V7l11-4.5Z"
                      fill="color-mix(in srgb,var(--bftd-accent) 18%,var(--bftd-panel2))"
                      stroke="var(--bftd-accent)" stroke-width="1.6"/>
                <text x="16" y="19.1" text-anchor="middle" font-size="9.2" font-weight="900"
                      font-family="Arial,sans-serif" fill="var(--bftd-text)">FH</text>
            </svg>`;
        btn.addEventListener('click',ev=>{ev.preventDefault();ev.stopPropagation();openMain();});
        return btn;
    }

    function matchLauncherSizeToRwph(btn,rwph) {
        const r=rwph?.getBoundingClientRect?.();
        if (!r) return;
        const size=Math.round(Math.min(r.width||28,r.height||28));
        if (size>=20 && size<=42) {
            btn.style.setProperty('width',`${size}px`,'important');
            btn.style.setProperty('height',`${size}px`,'important');
            btn.style.setProperty('min-width',`${size}px`,'important');
            btn.style.setProperty('min-height',`${size}px`,'important');
        }
    }

    function syncLauncher() {
        let btn=document.getElementById('bftd-fws-launcher') || state.launcher;

        if (!isFactionPage()) {
            if (btn?.isConnected) btn.remove();
            state.launcher=null;
            return;
        }

        if (!btn || !btn.isConnected) {
            btn=createLauncherButton();
            state.launcher=btn;
        }

        const rwph=findRwphLauncher();
        if (rwph?.parentElement) {
            if (btn.parentElement!==rwph.parentElement || btn.previousElementSibling!==rwph) {
                rwph.insertAdjacentElement('afterend',btn);
            }
            matchLauncherSizeToRwph(btn,rwph);
            return;
        }

        const header=findFactionHeader();
        if (!header) {
            if (btn.isConnected) btn.remove();
            return;
        }

        if (btn.parentElement!==header) header.appendChild(btn);
        btn.style.removeProperty('width');
        btn.style.removeProperty('height');
        btn.style.removeProperty('min-width');
        btn.style.removeProperty('min-height');
    }

    function buildLauncher() {
        syncLauncher();
        if (!state.launcherObserver && document.body) {
            let debounce=null;
            state.launcherObserver=new MutationObserver(()=>{
                clearTimeout(debounce);
                debounce=setTimeout(syncLauncher,120);
            });
            state.launcherObserver.observe(document.body,{childList:true,subtree:true});
        }
        if (!state.launcherSyncTimer) state.launcherSyncTimer=window.setInterval(syncLauncher,1800);
    }

    function panelShell(id,title,subtitle='') {
        const panel=document.createElement('section');
        panel.id=id;
        panel.className='bftd-fws-panel';
        panel.innerHTML=`
            <div class="bftd-fws-resize tl" data-corner="tl" title="Drag to resize"></div>
            <div class="bftd-fws-resize bl" data-corner="bl" title="Drag to resize"></div>
            <div class="bftd-fws-resize br" data-corner="br" title="Drag to resize"></div>
            <div class="bftd-fws-head">
                <div class="bftd-fws-titlegroup">
                    <strong>${esc(title)}</strong>
                    <span class="bftd-fws-sub">${esc(subtitle)}</span>
                </div>
                <button class="bftd-fws-iconbtn bftd-fws-theme-btn" title="Theme & colours">◐</button>
                <button class="bftd-fws-close" title="Close">×</button>
            </div>
            <div class="bftd-fws-body"></div>
            <div class="bftd-fws-theme-pop" hidden></div>
        `;
        panel.querySelector('.bftd-fws-close').addEventListener('click',()=>{
            savePanelGeometry(panel);
            panel.remove();
        });
        panel.querySelector('.bftd-fws-theme-btn').addEventListener('click',ev=>{
            ev.stopPropagation();
            toggleThemePopover(panel);
        });
        panel.addEventListener('mousedown',()=>bringPanelFront(panel));
        panel.addEventListener('touchstart',()=>bringPanelFront(panel),{passive:true});
        document.body.appendChild(panel);
        makePanelDraggable(panel,panel.querySelector('.bftd-fws-head'));
        makeResizable(panel);
        restorePanelGeometry(panel);
        buildThemePopover(panel);
        bringPanelFront(panel);
        return panel;
    }

    async function openMain() {
        const existing = document.getElementById('bftd-fws-main');
        if (existing) {
            existing.style.display = '';
            return;
        }
        state.mainPanel = panelShell('bftd-fws-main', APP.name, `v${APP.version}`);
        renderMainLoading('Checking API access…');

        if (!state.apiKey) {
            renderApiSetup();
            return;
        }

        try {
            await authenticateAndLoad();
            renderMain();
        } catch (err) {
            renderLocked(err.message);
        }
    }

    function renderMainLoading(message) {
        const body = state.mainPanel?.querySelector('.bftd-fws-body');
        if (!body) return;
        body.innerHTML = `
            <div class="bftd-fws-card">
                <strong>${esc(message)}</strong>
                <div class="bftd-fws-progress"><div></div></div>
            </div>
        `;
    }

    function renderApiSetup(message = '') {
        const body = state.mainPanel?.querySelector('.bftd-fws-body');
        if (!body) return;
        body.innerHTML = `
            <div class="bftd-fws-card">
                <div style="font-weight:800;margin-bottom:6px">Faction API key required</div>
                <div class="bftd-fws-note">
                    This script only unlocks when your Torn position has <b>Faction API Access</b>.
                    Your key must allow faction <b>basic</b>, <b>members</b>, <b>rankedwars</b>, <b>rankedwarreport</b>, <b>attacks</b>, <b>crimes</b> and <b>news</b>, plus user <b>personalstats</b> for Xanax history.
                    The key is stored locally in this userscript manager and is sent only to Torn's API.
                </div>
            </div>
            ${message ? `<div class="bftd-fws-error">${esc(message)}</div>` : ''}
            <div class="bftd-fws-card">
                <input id="bftd-fws-key" class="bftd-fws-input" type="password" placeholder="Paste Torn API key">
                <div class="bftd-fws-row" style="margin-top:8px">
                    <button id="bftd-fws-save-key" class="bftd-fws-btn">SAVE & VERIFY</button>
                    <button id="bftd-fws-make-key" class="bftd-fws-btn secondary">CREATE CUSTOM KEY</button>
                </div>
            </div>
        `;
        body.querySelector('#bftd-fws-save-key').addEventListener('click', async () => {
            const key = body.querySelector('#bftd-fws-key').value.trim();
            if (!key) return;
            state.apiKey = key;
            GM_setValue(APP.keyStorage, key);
            renderMainLoading('Verifying faction access…');
            try {
                await authenticateAndLoad();
                renderMain();
            } catch (err) {
                renderLocked(err.message);
            }
        });
        body.querySelector('#bftd-fws-make-key').addEventListener('click', () => {
            window.open(APP.customKeyUrl, '_blank', 'noopener,noreferrer');
        });
    }

    function renderLocked(message) {
        const body = state.mainPanel?.querySelector('.bftd-fws-body');
        if (!body) return;
        body.innerHTML = `
            <div class="bftd-fws-error">
                <b>Access locked.</b><br>${esc(message)}
            </div>
            <div class="bftd-fws-card">
                <div class="bftd-fws-note">
                    Required: your Torn faction position must have <b>Faction API Access</b>, and the API key must allow
                    <b>faction/basic</b>, <b>faction/members</b>, <b>faction/rankedwars</b>, <b>faction/rankedwarreport</b>, <b>faction/attacks</b>, <b>faction/crimes</b>, <b>faction/news</b> and <b>user/personalstats</b>.
                </div>
                <div class="bftd-fws-row" style="margin-top:9px">
                    <button id="bftd-fws-retry" class="bftd-fws-btn">RETRY</button>
                    <button id="bftd-fws-newkey" class="bftd-fws-btn secondary">CHANGE KEY</button>
                    <button id="bftd-fws-customkey" class="bftd-fws-btn secondary">CREATE KEY</button>
                </div>
            </div>
        `;
        body.querySelector('#bftd-fws-retry').addEventListener('click', async () => {
            renderMainLoading('Checking access again…');
            try {
                await authenticateAndLoad();
                renderMain();
            } catch (err) {
                renderLocked(err.message);
            }
        });
        body.querySelector('#bftd-fws-newkey').addEventListener('click', () => {
            GM_deleteValue(APP.keyStorage);
            state.apiKey = '';
            state.keyInfo = null;
            state.faction = null;
            state.members = [];
            renderApiSetup();
        });
        body.querySelector('#bftd-fws-customkey').addEventListener('click', () => {
            window.open(APP.customKeyUrl, '_blank', 'noopener,noreferrer');
        });
    }

    async function authenticateAndLoad() {
        // Torn API v2 /key/info currently returns { info: { access, user, ... } }.
        // Older/refactored response shapes have also existed, so normalize both forms.
        const rawKeyInfo = await gmJson(apiUrl('/key/info'));
        const info = rawKeyInfo?.info && typeof rawKeyInfo.info === 'object'
            ? rawKeyInfo.info
            : rawKeyInfo;

        state.keyInfo = info;

        let factionId = num(info?.user?.faction_id ?? info?.access?.faction_id, 0);

        // Public fallback: ask Torn for the API-key owner's faction directly.
        // This prevents a key-info schema change from falsely reporting "not in a faction".
        if (!factionId) {
            try {
                const userFaction = await gmJson(apiUrl('/user/faction'));
                factionId = num(
                    userFaction?.faction?.faction_id
                    ?? userFaction?.faction_id
                    ?? userFaction?.faction?.id
                    ?? userFaction?.id,
                    0
                );
            } catch (_) {
                // Keep going; /faction/basic below is another authoritative fallback.
            }
        }

        // Load own-faction basics/members before deciding the player is factionless.
        // /faction/basic can identify the key owner's faction even if key-info is missing an ID.
        let basic;
        let membersPayload;
        try {
            [basic, membersPayload] = await Promise.all([
                gmJson(apiUrl('/faction/basic')),
                gmJson(apiUrl('/faction/members', { striptags: 'true' }))
            ]);
        } catch (err) {
            if (!factionId) {
                throw new Error(`Faction Helper could not identify your faction. Torn API said: ${err.message}`);
            }
            throw err;
        }

        if (!factionId) {
            factionId = num(
                basic?.id
                ?? basic?.faction_id
                ?? basic?.basic?.id
                ?? basic?.basic?.faction_id,
                0
            );
        }

        if (!factionId) {
            throw new Error('Torn returned faction data but no faction ID. Please create a new Faction Helper API key and retry.');
        }

        // Prefer Torn's key-info permission flag so opening the helper does not burn an
        // extra API call every time. If Torn omits the flag, fall back to one protected
        // endpoint check.
        if (info?.access?.faction === false) {
            throw new Error('Your Torn faction position does not currently have Faction API Access.');
        }
        if (info?.access?.faction !== true) {
            try {
                await gmJson(apiUrl('/faction/attacks', {
                    filters: 'outgoing',
                    limit: 1,
                    sort: 'DESC'
                }));
            } catch (err) {
                throw new Error(`Faction API Access could not be verified. Torn API said: ${err.message}`);
            }
        }

        const members = normalizeMembers(membersPayload);
        if (!members.length) {
            throw new Error('Faction access was detected, but Torn returned no faction members.');
        }

        state.faction = {
            id: factionId,
            name: basic?.name || basic?.basic?.name || `Faction ${factionId}`
        };
        state.members = members.sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')));
        state.memberMap = new Map(state.members.map(m => [Number(m.id), m]));
    }

    function renderMain() {
        const body = state.mainPanel?.querySelector('.bftd-fws-body');
        if (!body) return;

        const accessType = state.keyInfo?.access?.type || 'API key';
        const requestedRange = getPresetRange();
        const cached = getCached(requestedRange);
        const scannedRange = cached?.range || null;
        const ready = Boolean(cached?.aggregates && cached?.ocAggregates && cached?.armoryXanaxAggregates && cached?.warSummary);
        const scanLabel = state.scanRunning ? 'SCANNING…' : (ready ? 'RESCAN FACTION' : 'SCAN FACTION');
        const scanStatus = state.scanRunning
            ? (state.scanProgress?.message || 'Scanning faction data…')
            : ready
                ? `Scan ready • ${cached.warSummary?.warCount || 0} ranked war(s) • ${new Date(cached.generatedAt).toLocaleString()}`
                : 'No completed scan for this period. Members are locked until the scan finishes.';

        body.innerHTML = `
            <div class="bftd-fws-card">
                <div class="bftd-fws-row">
                    <div class="bftd-fws-grow">
                        <div style="font-weight:800">${esc(state.faction?.name || 'Your faction')}</div>
                        <div class="bftd-fws-note">Faction ${esc(state.faction?.id)} • ${esc(accessType)} • ${state.members.length} current members</div>
                    </div>
                    <span class="bftd-fws-badge good">Faction API ✓</span>
                </div>
            </div>

            <div class="bftd-fws-card">
                <div class="bftd-fws-note" style="margin-bottom:6px">SCAN PERIOD</div>
                <div class="bftd-fws-periods">
                    ${['1m','3m','6m','12m'].map(code => `
                        <button class="bftd-fws-period ${state.selectedPreset === code ? 'active' : ''}" data-period="${code}" ${state.scanRunning ? 'disabled' : ''}>
                            ${code.toUpperCase()}
                        </button>
                    `).join('')}
                </div>
                <div class="bftd-fws-note" style="margin-top:7px">
                    The scan first finds every ranked war that <b>started inside the selected period</b>, loads each completed war report, then scans all outgoing faction attacks in the period so war hits, assists, retals and outside hits are classified against the exact war windows/opponents. It then scans completed OCs and faction-armory Xanax actions.
                </div>
                <div class="bftd-fws-scanstatus">
                    <div class="bftd-fws-grow bftd-fws-note"><b>${esc(scanStatus)}</b>${scannedRange ? `<br>${esc(dateTime(scannedRange.from))} → ${esc(dateTime(scannedRange.to))}` : ''}</div>
                    <button id="bftd-fws-scan" class="bftd-fws-btn" ${state.scanRunning ? 'disabled' : ''}>${esc(scanLabel)}</button>
                </div>
                ${state.scanRunning ? `
                    <div class="bftd-fws-progress"><div></div></div>
                    <div class="bftd-fws-note" style="margin-top:6px">
                        ${esc(state.scanProgress?.detail || '')}
                    </div>
                    <button id="bftd-fws-cancel-main-scan" class="bftd-fws-btn danger" style="margin-top:8px">CANCEL SCAN</button>
                ` : ''}
                ${state.scanError ? `<div class="bftd-fws-error" style="margin-top:8px">${esc(state.scanError)}</div>` : ''}
            </div>

            <div class="bftd-fws-row" style="margin-bottom:9px">
                <input id="bftd-fws-search" class="bftd-fws-input bftd-fws-grow" placeholder="Search faction members…" value="${esc(state.search)}">
                <button id="bftd-fws-refresh-members" class="bftd-fws-btn secondary" title="Reload member list" ${state.scanRunning ? 'disabled' : ''}>↻</button>
                <button id="bftd-fws-settings" class="bftd-fws-btn secondary" title="API key settings" ${state.scanRunning ? 'disabled' : ''}>⚙</button>
            </div>

            <div id="bftd-fws-member-count" class="bftd-fws-note" style="margin:0 0 7px"></div>
            <div id="bftd-fws-members" class="bftd-fws-members"></div>
        `;

        body.querySelectorAll('[data-period]').forEach(btn => {
            btn.addEventListener('click', () => {
                state.selectedPreset = btn.dataset.period;
                state.currentMember = null;
                document.getElementById('bftd-fws-stats')?.remove();
                state.statsPanel = null;
                state.scanError = '';
                renderMain();
            });
        });

        body.querySelector('#bftd-fws-scan')?.addEventListener('click', () => runFactionScan(true));
        body.querySelector('#bftd-fws-cancel-main-scan')?.addEventListener('click', () => { state.abortScan = true; });

        const search = body.querySelector('#bftd-fws-search');
        search?.addEventListener('input', () => {
            state.search = search.value;
            renderMemberList();
        });

        body.querySelector('#bftd-fws-refresh-members')?.addEventListener('click', async () => {
            renderMainLoading('Reloading faction members…');
            try {
                await authenticateAndLoad();
                renderMain();
            } catch (err) {
                renderLocked(err.message);
            }
        });

        body.querySelector('#bftd-fws-settings')?.addEventListener('click', () => renderApiSetup());
        renderMemberList();
    }

    function setScanProgress(message, detail = '') {
        state.scanProgress = { message, detail };
        if (state.mainPanel && document.getElementById('bftd-fws-main')) renderMain();
    }

    async function runFactionScan(forceRefresh = true) {
        if (state.scanRunning) return;
        state.scanRunning = true;
        state.abortScan = false;
        state.scanError = '';
        const range = getPresetRange();
        // Keep the last good scan until the replacement scan finishes successfully.
        renderMain();

        try {
            setScanProgress('1/4 — Loading ranked-war history & reports…', 'Finding wars that started inside the selected period. Completed war reports are cached permanently by war ID.');
            const warScan = await scanRankedWarsAndReports(range, (done, total, apiCalls, cacheHits) => {
                setScanProgress('1/4 — Loading ranked-war history & reports…', `${done}/${total} war reports processed • ${apiCalls} API report call(s) • ${cacheHits} cached report(s)`);
            });

            if (state.abortScan) throw new Error('Scan cancelled.');
            await sleep(APP.requestDelayMs);
            setScanProgress('2/4 — Scanning all faction attacks…', `Classifying war hits, assists, retals and outside attacks across ${warScan.wars.length} ranked-war window(s).`);
            const attackScan = await scanFactionAttacks(range, warScan.wars, warScan.reportStats, (pages, attacks) => {
                setScanProgress('2/4 — Scanning all faction attacks…', `${pages} attack page(s) • ${attacks} outgoing attacks checked`);
            });

            if (state.abortScan) throw new Error('Scan cancelled.');
            await sleep(APP.requestDelayMs);
            setScanProgress('3/4 — Scanning completed organized crimes…', 'Counting completed OCs by executed_at and participant slot.');
            const ocScan = await scanFactionCrimes(range, (pages, crimes) => {
                setScanProgress('3/4 — Scanning completed organized crimes…', `${pages} OC page(s) • ${crimes} completed OC(s) checked`);
            });

            if (state.abortScan) throw new Error('Scan cancelled.');
            await sleep(APP.requestDelayMs);
            setScanProgress('4/4 — Scanning faction armory Xanax…', 'Counting Xanax armory actions by member.');
            const armoryScan = await scanFactionArmoryXanax(range, (pages, newsCount) => {
                setScanProgress('4/4 — Scanning faction armory Xanax…', `${pages} armory-news page(s) • ${newsCount} record(s) checked`);
            });

            const warSummary = {
                warCount: warScan.wars.length,
                completedWarCount: warScan.wars.filter(w => w.end > 0).length,
                activeWarCount: warScan.wars.filter(w => !w.end).length,
                historyPages: warScan.historyPages,
                reportApiCalls: warScan.reportApiCalls,
                reportCacheHits: warScan.reportCacheHits,
                wars: warScan.wars.map(w => ({
                    id: w.id,
                    start: w.start,
                    end: w.end,
                    winner: w.winner,
                    opponentId: w.opponentId,
                    opponentName: w.opponentName
                }))
            };

            putCached(
                range,
                attackScan.aggregates,
                ocScan.aggregates,
                armoryScan.aggregates,
                warSummary,
                attackScan.pageCount,
                attackScan.fetchedCount,
                ocScan.pageCount,
                ocScan.crimeCount,
                armoryScan.pageCount,
                armoryScan.newsCount
            );

            state.lastAggregates = attackScan.aggregates;
            state.lastOcAggregates = ocScan.aggregates;
            state.lastArmoryXanaxAggregates = armoryScan.aggregates;
            state.scanProgress = null;
            state.scanError = '';
        } catch (err) {
            state.scanError = err.message || String(err);
        } finally {
            state.scanRunning = false;
            state.abortScan = false;
            renderMain();
        }
    }

    function renderMemberList() {
        const box = document.getElementById('bftd-fws-members');
        const count = document.getElementById('bftd-fws-member-count');
        if (!box || !count) return;

        const range = getPresetRange();
        const cached = getCached(range);
        const ready = Boolean(cached?.aggregates && cached?.ocAggregates && cached?.armoryXanaxAggregates && cached?.warSummary) && !state.scanRunning;
        const q = state.search.trim().toLowerCase();
        const filtered = state.members.filter(m => {
            if (!q) return true;
            return String(m.name || '').toLowerCase().includes(q)
                || String(m.id || '').includes(q)
                || String(m.position || '').toLowerCase().includes(q);
        });

        count.textContent = ready
            ? `${filtered.length} member${filtered.length === 1 ? '' : 's'} shown • scan complete — click a member`
            : `${filtered.length} member${filtered.length === 1 ? '' : 's'} shown • locked until Scan Faction completes`;

        box.innerHTML = filtered.map(m => `
            <button class="bftd-fws-member" data-member-id="${esc(m.id)}" ${ready ? '' : 'disabled'}>
                <div class="bftd-fws-row">
                    <div class="bftd-fws-grow">
                        <div class="bftd-fws-member-name">${esc(m.name)} [${esc(m.id)}]</div>
                        <div class="bftd-fws-member-meta">
                            ${esc(m.position || 'Member')} • Level ${esc(m.level ?? '?')} • ${esc(memberLastAction(m))}
                        </div>
                    </div>
                    <span class="bftd-fws-badge ${String(m.last_action?.status || '').toLowerCase() === 'online' ? 'good' : ''}">
                        ${ready ? esc(statusText(m)) : 'LOCKED'}
                    </span>
                </div>
            </button>
        `).join('') || `<div class="bftd-fws-note">No matching faction members.</div>`;

        if (!ready) return;
        box.querySelectorAll('[data-member-id]').forEach(btn => {
            btn.addEventListener('click', () => {
                const member = state.memberMap.get(Number(btn.dataset.memberId));
                if (member) openStats(member);
            });
        });
    }

    function openStats(member) {
        const requestedRange = getPresetRange();
        const cached = getCached(requestedRange);
        if (!cached?.aggregates || !cached?.ocAggregates || !cached?.armoryXanaxAggregates || !cached?.warSummary) return;

        state.currentMember = member;
        const existing = document.getElementById('bftd-fws-stats');
        if (existing) existing.remove();

        state.statsPanel = panelShell('bftd-fws-stats', `${member.name} — Faction Stats`, `[${member.id}]`);
        const range = cached.range || requestedRange;
        const xanax = getCachedMemberXanax(member, range) || { pending: true };
        renderStats(member, range, cached.aggregates, cached.ocAggregates, cached.armoryXanaxAggregates, xanax, {
            cached: true,
            generatedAt: cached.generatedAt,
            pageCount: cached.pageCount,
            fetchedCount: cached.fetchedCount,
            ocPageCount: cached.ocPageCount,
            ocCount: cached.ocCount,
            armoryPageCount: cached.armoryPageCount,
            armoryNewsCount: cached.armoryNewsCount,
            warSummary: cached.warSummary
        });
    }

    function cacheKey(range) {
        return `${state.faction?.id || 0}:${range.code}`;
    }

    function loadCacheStore() {
        try {
            const raw = GM_getValue(APP.cacheStorage, '{}');
            const obj = typeof raw === 'string' ? JSON.parse(raw) : raw;
            return obj && typeof obj === 'object' ? obj : {};
        } catch {
            return {};
        }
    }

    function saveCacheStore(store) {
        const entries = Object.entries(store)
            .sort((a, b) => num(b[1]?.generatedAt) - num(a[1]?.generatedAt))
            .slice(0, 8);
        GM_setValue(APP.cacheStorage, JSON.stringify(Object.fromEntries(entries)));
    }

    function getCached(range) {
        const store = loadCacheStore();
        const hit = store[cacheKey(range)];
        if (!hit || !hit.aggregates || !hit.range) return null;
        return hit;
    }

    function putCached(range, aggregates, ocAggregates, armoryXanaxAggregates, warSummary, pageCount, fetchedCount, ocPageCount, ocCount, armoryPageCount, armoryNewsCount) {
        const store = loadCacheStore();
        store[cacheKey(range)] = {
            generatedAt: Date.now(),
            range,
            aggregates,
            ocAggregates,
            armoryXanaxAggregates,
            warSummary,
            pageCount,
            fetchedCount,
            ocPageCount,
            ocCount,
            armoryPageCount,
            armoryNewsCount
        };
        saveCacheStore(store);
    }

    function clearPeriodCache(range) {
        const store = loadCacheStore();
        delete store[cacheKey(range)];
        saveCacheStore(store);
    }

    function loadWarReportCache() {
        try {
            const raw = GM_getValue(APP.warReportCacheStorage, '{}');
            const obj = typeof raw === 'string' ? JSON.parse(raw) : raw;
            return obj && typeof obj === 'object' ? obj : {};
        } catch {
            return {};
        }
    }

    function getCachedWarReport(warId) {
        return loadWarReportCache()[String(warId)] || null;
    }

    function putCachedWarReport(warId, report) {
        const store = loadWarReportCache();
        store[String(warId)] = report;
        const compact = Object.fromEntries(Object.entries(store).slice(-250));
        GM_setValue(APP.warReportCacheStorage, JSON.stringify(compact));
    }

    function extractRankedWars(payload) {
        if (Array.isArray(payload?.rankedwars)) return payload.rankedwars;
        if (payload?.rankedwars && typeof payload.rankedwars === 'object') return Object.values(payload.rankedwars);
        return [];
    }

    function warOpponent(war) {
        const factions = Array.isArray(war?.factions) ? war.factions : Object.values(war?.factions || {});
        return factions.find(f => Number(f?.id) !== Number(state.faction?.id)) || null;
    }

    function normalizeWar(war) {
        const opponent = warOpponent(war);
        return {
            id: num(war?.id ?? war?.war_id, 0),
            start: num(war?.start, 0),
            end: num(war?.end, 0),
            winner: num(war?.winner, 0),
            opponentId: num(opponent?.id, 0),
            opponentName: String(opponent?.name || (opponent?.id ? `Faction ${opponent.id}` : 'Unknown opponent'))
        };
    }

    function extractRankedWarReport(payload) {
        return payload?.rankedwarreport || payload?.ranked_war_report || payload?.report || null;
    }

    function reportOwnFaction(report) {
        const factions = Array.isArray(report?.factions) ? report.factions : Object.values(report?.factions || {});
        return factions.find(f => Number(f?.id) === Number(state.faction?.id)) || null;
    }

    function freshReportStat() {
        return { reportAttacks: 0, warScore: 0, wars: {} };
    }

    async function scanRankedWarsAndReports(range, onProgress) {
        const selected = [];
        const seen = new Set();
        let offset = 0;
        let historyPages = 0;

        while (true) {
            if (state.abortScan) throw new Error('Scan cancelled.');
            const payload = await gmJson(apiUrl('/faction/rankedwars', { limit: 100, offset }));
            historyPages += 1;
            const rows = extractRankedWars(payload);
            if (!rows.length) break;

            let oldestStart = 0;
            for (const raw of rows) {
                const war = normalizeWar(raw);
                if (!war.id || !war.start) continue;
                if (!oldestStart || war.start < oldestStart) oldestStart = war.start;
                if (war.start >= range.from && war.start <= range.to && !seen.has(war.id)) {
                    seen.add(war.id);
                    selected.push(war);
                }
            }

            if (rows.length < 100 || (oldestStart && oldestStart < range.from)) break;
            offset += rows.length;
            if (historyPages > 100) throw new Error('Ranked-war history exceeded the safety limit (100 pages).');
            await sleep(APP.requestDelayMs);
        }

        selected.sort((a, b) => a.start - b.start);
        const reportStats = {};
        let reportApiCalls = 0;
        let reportCacheHits = 0;
        let done = 0;
        const completed = selected.filter(w => w.end > 0);

        for (const war of completed) {
            if (state.abortScan) throw new Error('Scan cancelled.');
            let report = getCachedWarReport(war.id);
            if (report) {
                reportCacheHits += 1;
            } else {
                const payload = await gmJson(apiUrl(`/faction/${encodeURIComponent(war.id)}/rankedwarreport`));
                report = extractRankedWarReport(payload);
                reportApiCalls += 1;
                if (report) putCachedWarReport(war.id, report);
                await sleep(APP.requestDelayMs);
            }

            if (report) {
                const own = reportOwnFaction(report);
                const members = Array.isArray(own?.members) ? own.members : Object.values(own?.members || {});
                for (const member of members) {
                    const uid = num(member?.id, 0);
                    if (!uid) continue;
                    if (!reportStats[uid]) reportStats[uid] = freshReportStat();
                    const rs = reportStats[uid];
                    const attacks = num(member?.attacks, 0);
                    const score = num(member?.score, 0);
                    rs.reportAttacks += attacks;
                    rs.warScore += score;
                    rs.wars[String(war.id)] = { reportAttacks: attacks, score };
                }
            }

            done += 1;
            onProgress?.(done, completed.length, reportApiCalls, reportCacheHits);
        }

        return { wars: selected, reportStats, historyPages, reportApiCalls, reportCacheHits };
    }

    function freshWarBreakdown(war) {
        return {
            id: war.id,
            opponentId: war.opponentId,
            opponentName: war.opponentName,
            start: war.start,
            end: war.end,
            reportAttacks: 0,
            score: 0,
            warHits: 0,
            warAssists: 0,
            warRetals: 0,
            warAttempts: 0,
            outsideHits: 0,
            outsideAssists: 0,
            outsideRetals: 0
        };
    }

    function freshAgg() {
        return {
            totalAttempts: 0,
            totalSuccessfulHits: 0,
            totalAssists: 0,
            warHits: 0,
            warAssists: 0,
            warRetals: 0,
            warAttempts: 0,
            warsWithWarHits: 0,
            warsInPeriod: 0,
            reportAttacks: 0,
            warScore: 0,
            outsideHitsDuringWars: 0,
            outsideAssistsDuringWars: 0,
            outsideRetalsDuringWars: 0,
            outsideHitsOutsideWars: 0,
            outsideAssistsOutsideWars: 0,
            outsideRetalsOutsideWars: 0,
            losses: 0,
            stalemates: 0,
            escapes: 0,
            timeouts: 0,
            interrupted: 0,
            mugs: 0,
            hospitalizations: 0,
            attacks: 0,
            otherResults: 0,
            respect: 0,
            respectLoss: 0,
            groupHits: 0,
            overseasHits: 0,
            uniqueTargets: {},
            firstAttackTs: 0,
            lastAttackTs: 0,
            outcomeCounts: {},
            contextOutcomeCounts: { war: {}, duringWar: {}, outsideWar: {} },
            warBreakdown: {}
        };
    }

    function ensureWarBreakdown(stat, war) {
        const key = String(war.id);
        if (!stat.warBreakdown[key]) stat.warBreakdown[key] = freshWarBreakdown(war);
        return stat.warBreakdown[key];
    }

    function applyReportStats(aggregates, wars, reportStats) {
        for (const member of state.members) {
            const uid = Number(member.id);
            if (!aggregates[uid]) aggregates[uid] = freshAgg();
            aggregates[uid].warsInPeriod = wars.length;
        }
        for (const [uidText, rs] of Object.entries(reportStats || {})) {
            const uid = Number(uidText);
            if (!aggregates[uid]) aggregates[uid] = freshAgg();
            const s = aggregates[uid];
            s.reportAttacks += num(rs.reportAttacks, 0);
            s.warScore += num(rs.warScore, 0);
            for (const war of wars) {
                const rw = rs.wars?.[String(war.id)];
                if (!rw) continue;
                const row = ensureWarBreakdown(s, war);
                row.reportAttacks = num(rw.reportAttacks, 0);
                row.score = num(rw.score, 0);
            }
        }
    }

    function attackId(attack, fallback) {
        return String(attack?.id ?? attack?.attack_id ?? fallback ?? '');
    }

    function attackerId(attack) {
        return num(attack?.attacker?.id ?? attack?.attacker_id ?? attack?.attacker?.user_id ?? 0);
    }

    function defenderId(attack) {
        return num(attack?.defender?.id ?? attack?.defender_id ?? attack?.defender?.user_id ?? 0);
    }

    function defenderFactionId(attack) {
        return num(
            attack?.defender?.faction?.id
            ?? attack?.defender?.faction_id
            ?? attack?.defender_faction_id
            ?? 0
        );
    }

    function attackEndTs(attack) {
        return num(attack?.ended ?? attack?.timestamp_ended ?? attack?.end ?? attack?.timestamp ?? 0);
    }

    function attackResult(attack) {
        return String(attack?.result ?? attack?.outcome ?? '').trim();
    }

    function activeWarAt(ts, wars) {
        if (!ts) return null;
        return wars.find(w => ts >= w.start && ts <= (w.end || Number.MAX_SAFE_INTEGER)) || null;
    }

    function targetWarForAttack(ts, defenderFaction, wars) {
        if (!ts || !defenderFaction) return null;
        return wars.find(w => Number(w.opponentId) === Number(defenderFaction)
            && ts >= w.start
            && ts <= (w.end || Number.MAX_SAFE_INTEGER)) || null;
    }

    function incrementOutcome(map, resultRaw) {
        const key = resultRaw || 'Unknown';
        map[key] = (map[key] || 0) + 1;
    }

    function addAttack(aggregates, attack, wars) {
        const aid = attackerId(attack);
        if (!aid) return;
        if (!aggregates[aid]) aggregates[aid] = freshAgg();
        const s = aggregates[aid];

        const ts = attackEndTs(attack);
        const defenderFaction = defenderFactionId(attack);
        const targetWar = targetWarForAttack(ts, defenderFaction, wars);
        const activeWar = activeWarAt(ts, wars);
        const context = targetWar ? 'war' : (activeWar ? 'duringWar' : 'outsideWar');

        const resultRaw = attackResult(attack);
        const result = resultRaw.toLowerCase();
        const respectGain = num(attack?.respect_gain ?? attack?.respect, 0);
        const respectLoss = num(attack?.respect_loss, 0);
        const interrupted = attack?.is_interrupted === true || result === 'interrupted';
        const assist = result === 'assist';
        const success = !assist && !interrupted && (SUCCESS_RESULTS.has(result) || (respectGain > 0 && !FAILURE_RESULTS.has(result)));
        const retal = num(attack?.modifiers?.retaliation, 1) > 1.00001;

        s.totalAttempts += 1;
        s.respect += respectGain;
        s.respectLoss += respectLoss;
        incrementOutcome(s.outcomeCounts, resultRaw);
        incrementOutcome(s.contextOutcomeCounts[context], resultRaw);

        if (success) s.totalSuccessfulHits += 1;
        if (assist) s.totalAssists += 1;

        if (result === 'lost') s.losses += 1;
        else if (result === 'stalemate') s.stalemates += 1;
        else if (result === 'escape') s.escapes += 1;
        else if (result === 'timeout') s.timeouts += 1;
        else if (interrupted) s.interrupted += 1;
        else if (result === 'mugged') s.mugs += 1;
        else if (result === 'hospitalized') s.hospitalizations += 1;
        else if (result === 'attacked') s.attacks += 1;
        else if (!success && !assist) s.otherResults += 1;

        if (success) {
            if (num(attack?.modifiers?.group, 1) > 1.00001) s.groupHits += 1;
            if (num(attack?.modifiers?.overseas, 1) > 1.00001) s.overseasHits += 1;
        }

        if (targetWar) {
            const row = ensureWarBreakdown(s, targetWar);
            row.warAttempts += 1;
            s.warAttempts += 1;
            if (assist) {
                s.warAssists += 1;
                row.warAssists += 1;
            } else if (success) {
                s.warHits += 1;
                row.warHits += 1;
                if (retal) {
                    s.warRetals += 1;
                    row.warRetals += 1;
                }
            }
        } else if (activeWar) {
            const row = ensureWarBreakdown(s, activeWar);
            if (assist) {
                s.outsideAssistsDuringWars += 1;
                row.outsideAssists += 1;
            } else if (success) {
                s.outsideHitsDuringWars += 1;
                row.outsideHits += 1;
                if (retal) {
                    s.outsideRetalsDuringWars += 1;
                    row.outsideRetals += 1;
                }
            }
        } else {
            if (assist) {
                s.outsideAssistsOutsideWars += 1;
            } else if (success) {
                s.outsideHitsOutsideWars += 1;
                if (retal) s.outsideRetalsOutsideWars += 1;
            }
        }

        const did = defenderId(attack);
        if (did) s.uniqueTargets[did] = 1;
        if (ts) {
            if (!s.firstAttackTs || ts < s.firstAttackTs) s.firstAttackTs = ts;
            if (!s.lastAttackTs || ts > s.lastAttackTs) s.lastAttackTs = ts;
        }
    }

    function extractAttacks(payload) {
        if (Array.isArray(payload?.attacks)) return payload.attacks;
        if (payload?.attacks && typeof payload.attacks === 'object') return Object.values(payload.attacks);
        return [];
    }

    async function scanFactionAttacks(range, wars, reportStats, onProgress) {
        const aggregates = {};
        applyReportStats(aggregates, wars, reportStats);
        const seen = new Set();
        let pageCount = 0;
        let fetchedCount = 0;
        let cursorTo = range.to;

        while (cursorTo >= range.from) {
            if (state.abortScan) throw new Error('Scan cancelled.');

            const payload = await gmJson(apiUrl('/faction/attacks', {
                filters: 'outgoing',
                limit: 100,
                sort: 'DESC',
                from: range.from,
                to: cursorTo
            }));
            pageCount += 1;

            const attacks = extractAttacks(payload);
            let oldestTs = 0;
            for (let i = 0; i < attacks.length; i++) {
                const attack = attacks[i];
                const ts = attackEndTs(attack);
                if (ts && (!oldestTs || ts < oldestTs)) oldestTs = ts;
                const id = attackId(attack, `${pageCount}:${i}:${ts}`);
                if (seen.has(id)) continue;
                seen.add(id);
                fetchedCount += 1;
                if (ts && (ts < range.from || ts > range.to)) continue;
                addAttack(aggregates, attack, wars);
            }

            onProgress?.(pageCount, fetchedCount);
            if (!attacks.length || attacks.length < 100 || !oldestTs || oldestTs <= range.from) break;
            const nextTo = oldestTs - 1;
            if (nextTo >= cursorTo) break;
            cursorTo = nextTo;
            await sleep(APP.requestDelayMs);
            if (pageCount > 1500) throw new Error('Attack pagination exceeded the safety limit (1,500 pages).');
        }

        for (const member of state.members) {
            const uid = Number(member.id);
            if (!aggregates[uid]) aggregates[uid] = freshAgg();
            aggregates[uid].warsInPeriod = wars.length;
        }

        for (const stat of Object.values(aggregates)) {
            stat.uniqueTargetCount = Object.keys(stat.uniqueTargets || {}).length;
            delete stat.uniqueTargets;
            stat.warsWithWarHits = Object.values(stat.warBreakdown || {}).filter(w => num(w.warHits) > 0).length;
        }

        return { aggregates, pageCount, fetchedCount };
    }

    function freshOcAgg() {
        return {
            participated: 0,
            successful: 0,
            failed: 0,
            other: 0,
            firstOcTs: 0,
            lastOcTs: 0
        };
    }

    function extractCrimes(payload) {
        if (Array.isArray(payload?.crimes)) return payload.crimes;
        if (payload?.crimes && typeof payload.crimes === 'object') return Object.values(payload.crimes);
        return [];
    }

    function crimeExecutedTs(crime) {
        return num(crime?.executed_at ?? crime?.completed_at ?? crime?.ready_at ?? 0);
    }

    function crimeSlotUserId(slot) {
        return num(slot?.user?.id ?? slot?.user_id ?? slot?.id ?? 0);
    }

    function crimeOutcome(crime) {
        return String(crime?.status ?? crime?.outcome ?? '').trim().toLowerCase();
    }

    async function scanFactionCrimes(range, onProgress) {
        const aggregates = {};
        for (const member of state.members) aggregates[Number(member.id)] = freshOcAgg();

        const seen = new Set();
        let pageCount = 0;
        let crimeCount = 0;
        let cursorTo = range.to;

        while (cursorTo >= range.from) {
            if (state.abortScan) throw new Error('Scan cancelled.');

            // Timestamp-cursor pagination avoids Torn's known repeated-page behaviour
            // when OC queries combine historical filters with offset/auto links.
            const payload = await gmJson(apiUrl('/faction/crimes', {
                cat: 'completed',
                filters: 'executed_at',
                limit: 100,
                sort: 'DESC',
                from: range.from,
                to: cursorTo
            }));

            pageCount += 1;
            const crimes = extractCrimes(payload);
            let oldestTs = 0;

            for (let i = 0; i < crimes.length; i++) {
                const crime = crimes[i];
                const ts = crimeExecutedTs(crime);
                if (ts && (!oldestTs || ts < oldestTs)) oldestTs = ts;

                const id = String(crime?.id ?? crime?.crime_id ?? `${pageCount}:${i}:${ts}`);
                if (seen.has(id)) continue;
                seen.add(id);

                if (ts && (ts < range.from || ts > range.to)) continue;
                crimeCount += 1;

                const outcome = crimeOutcome(crime);
                const success = outcome === 'successful' || outcome === 'success';
                const failure = outcome === 'failed' || outcome === 'failure';
                const slots = Array.isArray(crime?.slots) ? crime.slots : Object.values(crime?.slots || {});
                const credited = new Set();

                for (const slot of slots) {
                    const uid = crimeSlotUserId(slot);
                    if (!uid || credited.has(uid)) continue;
                    credited.add(uid);
                    if (!aggregates[uid]) aggregates[uid] = freshOcAgg();
                    const stat = aggregates[uid];
                    stat.participated += 1;
                    if (success) stat.successful += 1;
                    else if (failure) stat.failed += 1;
                    else stat.other += 1;

                    if (ts) {
                        if (!stat.firstOcTs || ts < stat.firstOcTs) stat.firstOcTs = ts;
                        if (!stat.lastOcTs || ts > stat.lastOcTs) stat.lastOcTs = ts;
                    }
                }
            }

            onProgress?.(pageCount, crimeCount);

            if (!crimes.length || crimes.length < 100 || !oldestTs || oldestTs <= range.from) break;

            const nextTo = oldestTs - 1;
            if (nextTo >= cursorTo) {
                // Torn returned a page that cannot move the cursor backwards.
                // Keep the data already collected instead of failing the whole report.
                break;
            }

            cursorTo = nextTo;
            await sleep(APP.requestDelayMs);

            if (pageCount > 1500) {
                throw new Error('OC pagination exceeded the safety limit (1,500 pages).');
            }
        }

        return { aggregates, pageCount, crimeCount };
    }

    function freshArmoryXanaxAgg() {
        return {
            used: 0,
            events: 0,
            firstTs: 0,
            lastTs: 0
        };
    }

    function extractFactionNews(payload) {
        if (Array.isArray(payload?.news)) return payload.news;
        if (payload?.news && typeof payload.news === 'object') return Object.values(payload.news);
        return [];
    }

    function stripHtml(value) {
        return String(value ?? '')
            .replace(/<[^>]*>/g, ' ')
            .replace(/&nbsp;/gi, ' ')
            .replace(/&amp;/gi, '&')
            .replace(/\s+/g, ' ')
            .trim();
    }

    function armoryNewsMemberId(text) {
        const raw = String(text ?? '');
        const direct = raw.match(/(?:XID|userID|user_id)=(\d+)/i)
            || raw.match(/(?:XID|userID|user_id)["'\s:=]+(\d+)/i);
        if (direct) return num(direct[1], 0);

        // Fallback for rare stripped-tag responses: map the visible name to the current member list.
        const plain = stripHtml(raw).toLowerCase();
        const matches = state.members
            .filter(m => m?.name && plain.includes(String(m.name).toLowerCase()))
            .sort((a, b) => String(b.name).length - String(a.name).length);
        return matches.length ? num(matches[0].id, 0) : 0;
    }

    function armoryXanaxQuantity(text) {
        const plain = stripHtml(text);
        const patterns = [
            /(\d+)\s*x\s*xanax\b/i,
            /\b(?:used|withdrew|withdrawn|withdraw|took)\s+(\d+)\s+(?:of\s+)?(?:the\s+)?(?:faction(?:'s)?\s+)?xanax\b/i,
            /\b(\d+)\s+xanax\b/i
        ];
        for (const pattern of patterns) {
            const match = plain.match(pattern);
            if (match) return Math.max(1, num(match[1], 1));
        }
        return 1;
    }

    function isArmoryXanaxUse(text) {
        const lower = stripHtml(text).toLowerCase();
        if (!lower.includes('xanax')) return false;
        return /\bused\b|\bwithdrew\b|\bwithdrawn\b|\bwithdraw\b|\btook\b/.test(lower);
    }

    function repairArmoryNewsNextUrl(next) {
        const cleaned = cleanNextUrl(next);
        if (!cleaned) return null;
        try {
            const url = new URL(cleaned);
            // Torn had a 2026 pagination issue where news links could flip tag stripping on later pages.
            // Force HTML anchors to remain so XID can be read reliably.
            url.searchParams.delete('stripTags');
            url.searchParams.delete('striptags');
            url.searchParams.set('striptags', 'false');
            return url.toString();
        } catch {
            return cleaned;
        }
    }

    async function scanFactionArmoryXanax(range, onProgress) {
        const aggregates = {};
        for (const member of state.members) aggregates[Number(member.id)] = freshArmoryXanaxAgg();

        const seen = new Set();
        let pageCount = 0;
        let newsCount = 0;
        let cursorTo = range.to;

        while (cursorTo >= range.from) {
            if (state.abortScan) throw new Error('Scan cancelled.');

            const payload = await gmJson(apiUrl('/faction/news', {
                cat: 'armoryAction',
                striptags: 'false',
                limit: 100,
                sort: 'DESC',
                from: range.from,
                to: cursorTo
            }));

            pageCount += 1;
            const news = extractFactionNews(payload);
            let oldestTs = 0;

            for (let i = 0; i < news.length; i++) {
                const entry = news[i];
                const ts = num(entry?.timestamp ?? entry?.time ?? 0);
                if (ts && (!oldestTs || ts < oldestTs)) oldestTs = ts;
                if (ts && (ts < range.from || ts > range.to)) continue;

                const id = String(entry?.id ?? `${pageCount}:${i}:${ts}:${entry?.text ?? ''}`);
                if (seen.has(id)) continue;
                seen.add(id);
                newsCount += 1;

                const text = String(entry?.text ?? entry?.news ?? '');
                if (!isArmoryXanaxUse(text)) continue;

                const uid = armoryNewsMemberId(text);
                if (!uid) continue;
                if (!aggregates[uid]) aggregates[uid] = freshArmoryXanaxAgg();

                const qty = armoryXanaxQuantity(text);
                const stat = aggregates[uid];
                stat.used += qty;
                stat.events += 1;
                if (ts) {
                    if (!stat.firstTs || ts < stat.firstTs) stat.firstTs = ts;
                    if (!stat.lastTs || ts > stat.lastTs) stat.lastTs = ts;
                }
            }

            onProgress?.(pageCount, newsCount);

            if (!news.length || news.length < 100 || !oldestTs || oldestTs <= range.from) break;

            const nextTo = oldestTs - 1;
            if (nextTo >= cursorTo) break;

            cursorTo = nextTo;
            await sleep(APP.requestDelayMs);

            if (pageCount > 1500) {
                throw new Error('Armory-news pagination exceeded the safety limit (1,500 pages).');
            }
        }

        return { aggregates, pageCount, newsCount };
    }

    function loadXanaxCacheStore() {
        try {
            const raw = GM_getValue(APP.xanaxCacheStorage, '{}');
            const obj = typeof raw === 'string' ? JSON.parse(raw) : raw;
            return obj && typeof obj === 'object' ? obj : {};
        } catch {
            return {};
        }
    }

    function xanaxCacheKey(memberId, range) {
        return `${state.faction?.id || 0}:${memberId}:${range.code}:${range.from}:${range.to}`;
    }

    function clearXanaxCache(memberId, range) {
        const store = loadXanaxCacheStore();
        delete store[xanaxCacheKey(memberId, range)];
        GM_setValue(APP.xanaxCacheStorage, JSON.stringify(store));
    }

    function extractNamedNumber(root, wanted) {
        const seen = new Set();
        function walk(value) {
            if (!value || typeof value !== 'object' || seen.has(value)) return null;
            seen.add(value);
            if (Object.prototype.hasOwnProperty.call(value, wanted)) {
                const direct = Number(value[wanted]);
                if (Number.isFinite(direct)) return direct;
            }
            for (const child of Object.values(value)) {
                const found = walk(child);
                if (found !== null) return found;
            }
            return null;
        }
        return walk(root);
    }

    function getCachedMemberXanax(member, range) {
        const store = loadXanaxCacheStore();
        const existing = store[xanaxCacheKey(member.id, range)];
        if (!existing) return null;
        if (Date.now() - num(existing.generatedAt) > APP.xanaxCacheTtlMs) return null;
        return existing;
    }

    async function getMemberXanax(member, range, forceRefresh = false) {
        const store = loadXanaxCacheStore();
        const key = xanaxCacheKey(member.id, range);
        const existing = store[key];
        if (!forceRefresh && existing && Date.now() - num(existing.generatedAt) <= APP.xanaxCacheTtlMs) return existing;

        const startPayload = await gmJson(apiUrl(`/user/${encodeURIComponent(member.id)}/personalstats`, {
            stat: 'xantaken',
            timestamp: range.from
        }));
        await sleep(APP.requestDelayMs);
        const endPayload = await gmJson(apiUrl(`/user/${encodeURIComponent(member.id)}/personalstats`, {
            stat: 'xantaken',
            timestamp: range.to
        }));

        const startTotal = extractNamedNumber(startPayload?.personalstats ?? startPayload, 'xantaken');
        const endTotal = extractNamedNumber(endPayload?.personalstats ?? endPayload, 'xantaken');
        if (startTotal === null || endTotal === null) {
            throw new Error('Torn did not return the xantaken historical personal stat. Check that this API key includes user/personalstats.');
        }

        const result = {
            generatedAt: Date.now(),
            startTotal,
            endTotal,
            taken: Math.max(0, endTotal - startTotal),
            from: range.from,
            to: range.to
        };
        store[key] = result;
        const compact = Object.fromEntries(Object.entries(store).sort((a,b) => num(b[1]?.generatedAt) - num(a[1]?.generatedAt)).slice(0, 40));
        GM_setValue(APP.xanaxCacheStorage, JSON.stringify(compact));
        return result;
    }

    function dateTime(ts) {
        if (!ts) return '—';
        return new Date(ts * 1000).toLocaleString();
    }

    function pct(a, b) {
        if (!b) return '0.0%';
        return `${round((a / b) * 100, 1).toFixed(1)}%`;
    }

    function renderStats(member, range, aggregates, ocAggregates, armoryXanaxAggregates, xanax, meta) {
        const body = state.statsPanel?.querySelector('.bftd-fws-body');
        if (!body) return;

        const s = aggregates?.[Number(member.id)] || freshAgg();
        const oc = ocAggregates?.[Number(member.id)] || freshOcAgg();
        const armoryXanax = armoryXanaxAggregates?.[Number(member.id)] || freshArmoryXanaxAgg();
        const xanaxLoaded = !xanax?.pending && Number.isFinite(Number(xanax?.taken));
        const xanaxDisplay = xanaxLoaded ? fmt(xanax.taken) : 'LOAD';
        const ocSuccessRate = pct(oc.successful, oc.participated);
        const generatedText = new Date(meta.generatedAt).toLocaleString();
        const lastOnline = memberLastOnlineDisplay(member);
        const outsideHitsTotal = num(s.outsideHitsDuringWars) + num(s.outsideHitsOutsideWars);
        const outsideAssistsTotal = num(s.outsideAssistsDuringWars) + num(s.outsideAssistsOutsideWars);
        const outsideRetalsTotal = num(s.outsideRetalsDuringWars) + num(s.outsideRetalsOutsideWars);

        const warRows = Object.values(s.warBreakdown || {})
            .sort((a, b) => num(a.start) - num(b.start))
            .map(w => `
                <tr>
                    <td>${esc(w.opponentName || `Faction ${w.opponentId}`)}<div class="bftd-fws-note">#${esc(w.id)} • ${esc(dateTime(w.start))}</div></td>
                    <td>${fmt(w.warHits)}</td>
                    <td>${fmt(w.warAssists)}</td>
                    <td>${fmt(w.warRetals)}</td>
                    <td>${fmt(w.outsideHits)}</td>
                    <td>${fmt(w.reportAttacks)}</td>
                    <td>${fmt(w.score, 2)}</td>
                </tr>
            `).join('') || `<tr><td colspan="7">No member activity was found in the ranked wars for this period.</td></tr>`;

        const outcomes = Object.entries(s.outcomeCounts || {})
            .sort((a, b) => b[1] - a[1])
            .map(([name, count]) => `<tr><td>${esc(name)}</td><td>${fmt(count)}</td></tr>`)
            .join('') || '<tr><td>No outgoing attacks found</td><td>0</td></tr>';

        body.innerHTML = `
            <div class="bftd-fws-card">
                <div class="bftd-fws-row">
                    <div class="bftd-fws-grow">
                        <div style="font-weight:800">${esc(member.name)} [${esc(member.id)}]</div>
                        <div class="bftd-fws-note">${esc(member.position || 'Member')} • Level ${esc(member.level ?? '?')} • ${esc(range.label)}</div>
                        <div class="bftd-fws-note" style="margin-top:4px"><b>Last online/action:</b> ${esc(lastOnline)}</div>
                    </div>
                    <span class="bftd-fws-badge good">SCAN READY</span>
                </div>
            </div>

            <div class="bftd-fws-card">
                <div style="font-weight:800;margin-bottom:8px">RANKED WAR</div>
                <div class="bftd-fws-grid">
                    <div class="bftd-fws-stat"><div class="v">${fmt(meta.warSummary?.warCount || s.warsInPeriod)}</div><div class="k">FACTION WARS IN PERIOD</div></div>
                    <div class="bftd-fws-stat"><div class="v">${fmt(s.warsWithWarHits)}</div><div class="k">WARS WITH WAR HITS</div></div>
                    <div class="bftd-fws-stat"><div class="v">${fmt(s.warHits)}</div><div class="k">WAR HITS</div></div>
                    <div class="bftd-fws-stat"><div class="v">${fmt(s.warAssists)}</div><div class="k">WAR ASSISTS</div></div>
                    <div class="bftd-fws-stat"><div class="v">${fmt(s.warRetals)}</div><div class="k">WAR RETALS</div></div>
                    <div class="bftd-fws-stat"><div class="v">${fmt(s.warAttempts)}</div><div class="k">WAR-TARGET ATTEMPTS</div></div>
                    <div class="bftd-fws-stat"><div class="v">${fmt(s.reportAttacks)}</div><div class="k">RW REPORT ATTACKS</div></div>
                    <div class="bftd-fws-stat"><div class="v">${fmt(s.warScore, 2)}</div><div class="k">RW REPORT SCORE</div></div>
                </div>
            </div>

            <div class="bftd-fws-card">
                <div style="font-weight:800;margin-bottom:8px">OUTSIDE HITS DURING RANKED WARS</div>
                <div class="bftd-fws-grid">
                    <div class="bftd-fws-stat"><div class="v">${fmt(s.outsideHitsDuringWars)}</div><div class="k">OUTSIDE HITS</div></div>
                    <div class="bftd-fws-stat"><div class="v">${fmt(s.outsideAssistsDuringWars)}</div><div class="k">OUTSIDE ASSISTS</div></div>
                    <div class="bftd-fws-stat"><div class="v">${fmt(s.outsideRetalsDuringWars)}</div><div class="k">OUTSIDE RETALS</div></div>
                </div>
            </div>

            <div class="bftd-fws-card">
                <div style="font-weight:800;margin-bottom:8px">OUTSIDE RANKED-WAR WINDOWS</div>
                <div class="bftd-fws-grid">
                    <div class="bftd-fws-stat"><div class="v">${fmt(s.outsideHitsOutsideWars)}</div><div class="k">OUTSIDE HITS</div></div>
                    <div class="bftd-fws-stat"><div class="v">${fmt(s.outsideAssistsOutsideWars)}</div><div class="k">OUTSIDE ASSISTS</div></div>
                    <div class="bftd-fws-stat"><div class="v">${fmt(s.outsideRetalsOutsideWars)}</div><div class="k">OUTSIDE RETALS</div></div>
                </div>
            </div>

            <div class="bftd-fws-card">
                <div style="font-weight:800;margin-bottom:8px">ALL ATTACK ACTIVITY IN SELECTED PERIOD</div>
                <div class="bftd-fws-grid">
                    <div class="bftd-fws-stat"><div class="v">${fmt(s.totalSuccessfulHits)}</div><div class="k">ALL SUCCESSFUL HITS</div></div>
                    <div class="bftd-fws-stat"><div class="v">${fmt(s.totalAssists)}</div><div class="k">ALL ASSISTS</div></div>
                    <div class="bftd-fws-stat"><div class="v">${fmt(s.totalAttempts)}</div><div class="k">ALL ATTEMPTS</div></div>
                    <div class="bftd-fws-stat"><div class="v">${fmt(outsideHitsTotal)}</div><div class="k">ALL OUTSIDE HITS</div></div>
                    <div class="bftd-fws-stat"><div class="v">${fmt(outsideAssistsTotal)}</div><div class="k">ALL OUTSIDE ASSISTS</div></div>
                    <div class="bftd-fws-stat"><div class="v">${fmt(outsideRetalsTotal)}</div><div class="k">ALL OUTSIDE RETALS</div></div>
                    <div class="bftd-fws-stat"><div class="v">${fmt(s.groupHits)}</div><div class="k">GROUP HITS</div></div>
                    <div class="bftd-fws-stat"><div class="v">${fmt(s.overseasHits)}</div><div class="k">OVERSEAS HITS</div></div>
                    <div class="bftd-fws-stat"><div class="v">${fmt(s.uniqueTargetCount || 0)}</div><div class="k">UNIQUE TARGETS</div></div>
                </div>
                <div class="bftd-fws-row wrap" style="margin-top:9px">
                    <span class="bftd-fws-badge">Leaves ${fmt(s.attacks)}</span>
                    <span class="bftd-fws-badge">Hosp ${fmt(s.hospitalizations)}</span>
                    <span class="bftd-fws-badge">Mugs ${fmt(s.mugs)}</span>
                    <span class="bftd-fws-badge bad">Losses ${fmt(s.losses)}</span>
                    <span class="bftd-fws-badge">Stalemates ${fmt(s.stalemates)}</span>
                    <span class="bftd-fws-badge">Escapes ${fmt(s.escapes)}</span>
                    <span class="bftd-fws-badge">Timeouts ${fmt(s.timeouts)}</span>
                    <span class="bftd-fws-badge bad">Interrupted ${fmt(s.interrupted)}</span>
                </div>
            </div>

            <div class="bftd-fws-card">
                <div style="font-weight:800;margin-bottom:7px">WAR-BY-WAR BREAKDOWN</div>
                <div style="overflow:auto">
                    <table class="bftd-fws-table" style="min-width:700px">
                        <thead><tr><th>WAR / OPPONENT</th><th>WAR HITS</th><th>ASSISTS</th><th>RETALS</th><th>OUTSIDE HITS</th><th>REPORT ATTACKS</th><th>SCORE</th></tr></thead>
                        <tbody>${warRows}</tbody>
                    </table>
                </div>
            </div>

            <div class="bftd-fws-card">
                <div style="font-weight:800;margin-bottom:8px">OC / XANAX</div>
                <div class="bftd-fws-grid">
                    <div class="bftd-fws-stat"><div class="v">${fmt(oc.participated)}</div><div class="k">OCs PARTICIPATED</div></div>
                    <div class="bftd-fws-stat"><div class="v">${fmt(oc.successful)}</div><div class="k">OCs SUCCESSFUL</div></div>
                    <div class="bftd-fws-stat"><div class="v">${esc(ocSuccessRate)}</div><div class="k">OC SUCCESS RATE</div></div>
                    <div class="bftd-fws-stat"><div class="v">${xanaxDisplay}</div><div class="k">XANAX TAKEN${xanaxLoaded ? '' : ' • 2 API'}</div></div>
                    <div class="bftd-fws-stat"><div class="v">${fmt(armoryXanax.used || 0)}</div><div class="k">ARMORY XANAX USED</div></div>
                </div>
            </div>

            <div class="bftd-fws-card">
                <table class="bftd-fws-table">
                    <thead><tr><th>ALL ATTACK RESULTS</th><th>COUNT</th></tr></thead>
                    <tbody>${outcomes}</tbody>
                </table>
            </div>

            <div class="bftd-fws-card">
                <div class="bftd-fws-note">
                    First outgoing attack: <b>${esc(dateTime(s.firstAttackTs))}</b><br>
                    Last outgoing attack: <b>${esc(dateTime(s.lastAttackTs))}</b><br>
                    First completed OC: <b>${esc(dateTime(oc.firstOcTs))}</b><br>
                    Last completed OC: <b>${esc(dateTime(oc.lastOcTs))}</b><br>
                    Xanax snapshot totals: ${xanaxLoaded ? `<b>${fmt(xanax.startTotal)}</b> → <b>${fmt(xanax.endTotal)}</b>` : '<b>Not loaded — use the button below to spend 2 API calls.</b>'}<br>
                    Faction armory Xanax: <b>${fmt(armoryXanax.used || 0)}</b> across <b>${fmt(armoryXanax.events || 0)}</b> armory log event(s)<br>
                    Ranked-war scan: <b>${fmt(meta.warSummary?.warCount || 0)}</b> wars; <b>${fmt(meta.warSummary?.historyPages || 0)}</b> history page(s); <b>${fmt(meta.warSummary?.reportApiCalls || 0)}</b> new war-report API call(s); <b>${fmt(meta.warSummary?.reportCacheHits || 0)}</b> cached war report(s)<br>
                    Attack scan: <b>${fmt(meta.pageCount)}</b> page(s) / <b>${fmt(meta.fetchedCount)}</b> outgoing attacks checked<br>
                    OC scan: <b>${fmt(meta.ocPageCount)}</b> page(s) / <b>${fmt(meta.ocCount)}</b> completed OCs checked<br>
                    Armory scan: <b>${fmt(meta.armoryPageCount)}</b> page(s) / <b>${fmt(meta.armoryNewsCount)}</b> records checked<br>
                    Scan generated: <b>${esc(generatedText)}</b>
                </div>
            </div>

            <div class="bftd-fws-row wrap">
                <button id="bftd-fws-load-xanax" class="bftd-fws-btn secondary">${xanaxLoaded ? 'REFRESH XANAX (2 API)' : 'LOAD XANAX (2 API)'}</button>
                <button id="bftd-fws-profile" class="bftd-fws-btn secondary">OPEN PROFILE</button>
            </div>

            <div class="bftd-fws-note" style="margin-top:9px">
                War hits are successful attacks against the ranked-war opponent inside that war's exact start/end window. War retals are included in war hits and also shown as the retal subtype. Outside hits made while a ranked war is active are kept separate from attacks made outside all ranked-war windows. RW report attacks/score come from Torn's ranked-war report and are shown separately from the detailed attack-log classification.
            </div>
        `;

        body.querySelector('#bftd-fws-load-xanax')?.addEventListener('click', async () => {
            const button = body.querySelector('#bftd-fws-load-xanax');
            if (button) {
                button.disabled = true;
                button.textContent = 'LOADING XANAX…';
            }
            try {
                const loadedXanax = await getMemberXanax(member, range, true);
                renderStats(member, range, aggregates, ocAggregates, armoryXanaxAggregates, loadedXanax, meta);
            } catch (err) {
                if (button) {
                    button.disabled = false;
                    button.textContent = 'XANAX ERROR — RETRY';
                    button.title = err.message;
                }
            }
        });

        body.querySelector('#bftd-fws-profile')?.addEventListener('click', () => {
            window.open(`https://www.torn.com/profiles.php?XID=${encodeURIComponent(member.id)}`, '_blank', 'noopener,noreferrer');
        });
    }

    function init() {
        injectCss();
        injectUiV2Css();
        applyTheme();
        buildLauncher();
        window.addEventListener('resize', () => {
            document.querySelectorAll('.bftd-fws-panel').forEach(panel => {
                constrainPanel(panel);
                savePanelGeometry(panel);
            });
            syncLauncher();
        });
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init, { once: true });
    } else {
        init();
    }
})();

// ==UserScript==
// @name         Faction Helper
// @namespace    https://www.torn.com/
// @version      1.2.3
// @description  Auto-load faction members and inspect ranked-war, organized-crime, Xanax and faction-armory Xanax stats over selectable periods.
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
        version: '1.2.3',
        keyStorage: 'bftd_fws_api_key_v1',
        cacheStorage: 'bftd_fws_stats_cache_v4',
        xanaxCacheStorage: 'bftd_fws_xanax_cache_v1',
        uiStorage: 'bftd_fws_ui_v1',
        cacheTtlMs: 365 * 24 * 60 * 60 * 1000,
        xanaxCacheTtlMs: 6 * 60 * 60 * 1000,
        requestDelayMs: 850,
        apiBase: 'https://api.torn.com/v2',
        customKeyUrl:
            'https://www.torn.com/preferences.php#tab=api?step=addNewKey&title=Faction%20Helper&user=faction,personalstats&faction=basic,members,attacks,crimes,news'
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
        abortScan: false,
        lastAggregates: null,
        lastOcAggregates: null,
        lastArmoryXanaxAggregates: null,
        lastRange: null
    };

    const SUCCESS_RESULTS = new Set(['attacked', 'mugged', 'hospitalized', 'special', 'bounty', 'looted']);
    const FAILURE_RESULTS = new Set(['lost', 'stalemate', 'escape', 'timeout', 'interrupted', 'arrested']);

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

    function buildLauncher() {
        if (state.launcher || document.getElementById('bftd-fws-launcher')) return;
        const btn = document.createElement('button');
        btn.id = 'bftd-fws-launcher';
        btn.textContent = 'FACTION HELPER';
        btn.title = APP.name;
        btn.addEventListener('click', () => openMain());
        document.body.appendChild(btn);
        state.launcher = btn;
    }

    function panelShell(id, title, subtitle = '') {
        const panel = document.createElement('section');
        panel.id = id;
        panel.className = 'bftd-fws-panel';
        panel.innerHTML = `
            <div class="bftd-fws-head">
                <strong>${esc(title)}</strong>
                <span class="bftd-fws-sub">${esc(subtitle)}</span>
                <button class="bftd-fws-close" title="Close">×</button>
            </div>
            <div class="bftd-fws-body"></div>
        `;
        panel.querySelector('.bftd-fws-close').addEventListener('click', () => panel.remove());
        makeDraggable(panel, panel.querySelector('.bftd-fws-head'));
        document.body.appendChild(panel);
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
                    Your key must allow faction <b>basic</b>, <b>members</b>, <b>attacks</b>, <b>crimes</b> and <b>news</b>, plus user <b>personalstats</b> for Xanax history and faction-armory Xanax tracking.
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
                    <b>faction/basic</b>, <b>faction/members</b>, <b>faction/attacks</b>, <b>faction/crimes</b>, <b>faction/news</b> and <b>user/personalstats</b>.
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
                <div class="bftd-fws-note" style="margin-bottom:6px">WAR / OC / XANAX / ARMORY PERIOD</div>
                <div class="bftd-fws-periods">
                    ${['1m','3m','6m','12m'].map(code => `
                        <button class="bftd-fws-period ${state.selectedPreset === code ? 'active' : ''}" data-period="${code}">
                            ${code.toUpperCase()}
                        </button>
                    `).join('')}
                </div>
                <div class="bftd-fws-note" style="margin-top:7px">
                    Click a member below. The first lookup for a period scans ranked-war attacks, completed OCs and faction armory Xanax actions. <b>API Saver</b> keeps that completed period cached until you press Refresh Period, so clicking other members does not rescan Torn. Total Xanax is loaded on demand (2 API calls) and cached for 6 hours.
                </div>
            </div>

            <div class="bftd-fws-row" style="margin-bottom:9px">
                <input id="bftd-fws-search" class="bftd-fws-input bftd-fws-grow" placeholder="Search faction members…" value="${esc(state.search)}">
                <button id="bftd-fws-refresh-members" class="bftd-fws-btn secondary" title="Reload member list">↻</button>
                <button id="bftd-fws-settings" class="bftd-fws-btn secondary" title="API key settings">⚙</button>
            </div>

            <div id="bftd-fws-member-count" class="bftd-fws-note" style="margin:0 0 7px"></div>
            <div id="bftd-fws-members" class="bftd-fws-members"></div>
        `;

        body.querySelectorAll('[data-period]').forEach(btn => {
            btn.addEventListener('click', () => {
                state.selectedPreset = btn.dataset.period;
                body.querySelectorAll('[data-period]').forEach(x => x.classList.toggle('active', x === btn));
                if (state.currentMember && document.getElementById('bftd-fws-stats')) {
                    loadMemberStats(state.currentMember, false);
                }
            });
        });

        const search = body.querySelector('#bftd-fws-search');
        search.addEventListener('input', () => {
            state.search = search.value;
            renderMemberList();
        });

        body.querySelector('#bftd-fws-refresh-members').addEventListener('click', async () => {
            renderMainLoading('Reloading faction members…');
            try {
                await authenticateAndLoad();
                renderMain();
            } catch (err) {
                renderLocked(err.message);
            }
        });

        body.querySelector('#bftd-fws-settings').addEventListener('click', () => renderApiSetup());

        renderMemberList();
    }

    function renderMemberList() {
        const box = document.getElementById('bftd-fws-members');
        const count = document.getElementById('bftd-fws-member-count');
        if (!box || !count) return;

        const q = state.search.trim().toLowerCase();
        const filtered = state.members.filter(m => {
            if (!q) return true;
            return String(m.name || '').toLowerCase().includes(q)
                || String(m.id || '').includes(q)
                || String(m.position || '').toLowerCase().includes(q);
        });

        count.textContent = `${filtered.length} member${filtered.length === 1 ? '' : 's'} shown`;

        box.innerHTML = filtered.map(m => `
            <button class="bftd-fws-member" data-member-id="${esc(m.id)}">
                <div class="bftd-fws-row">
                    <div class="bftd-fws-grow">
                        <div class="bftd-fws-member-name">${esc(m.name)} [${esc(m.id)}]</div>
                        <div class="bftd-fws-member-meta">
                            ${esc(m.position || 'Member')} • Level ${esc(m.level ?? '?')} • Last action ${esc(memberLastAction(m))}
                        </div>
                    </div>
                    <span class="bftd-fws-badge ${String(m.last_action?.status || '').toLowerCase() === 'online' ? 'good' : ''}">
                        ${esc(statusText(m))}
                    </span>
                </div>
            </button>
        `).join('') || `<div class="bftd-fws-note">No matching faction members.</div>`;

        box.querySelectorAll('[data-member-id]').forEach(btn => {
            btn.addEventListener('click', () => {
                const member = state.memberMap.get(Number(btn.dataset.memberId));
                if (member) openStats(member);
            });
        });
    }

    function openStats(member) {
        state.currentMember = member;
        const existing = document.getElementById('bftd-fws-stats');
        if (existing) existing.remove();

        state.statsPanel = panelShell('bftd-fws-stats', `${member.name} — War Stats`, `[${member.id}]`);
        loadMemberStats(member, false);
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
        if (!hit) return null;
        if (!hit.aggregates || !hit.range) return null;
        return hit;
    }

    function putCached(range, aggregates, ocAggregates, armoryXanaxAggregates, pageCount, fetchedCount, ocPageCount, ocCount, armoryPageCount, armoryNewsCount) {
        const store = loadCacheStore();
        store[cacheKey(range)] = {
            generatedAt: Date.now(),
            range,
            aggregates,
            ocAggregates,
            armoryXanaxAggregates,
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

    function renderStatsLoading(member, range, text, pages = 0, attacks = 0) {
        const body = state.statsPanel?.querySelector('.bftd-fws-body');
        if (!body) return;
        body.innerHTML = `
            <div class="bftd-fws-card">
                <div style="font-weight:800">${esc(member.name)} [${esc(member.id)}]</div>
                <div class="bftd-fws-note">${esc(range.label)} • war / OC / Xanax / faction-armory stats</div>
            </div>
            <div class="bftd-fws-card">
                <strong>${esc(text)}</strong>
                <div class="bftd-fws-note" style="margin-top:5px">
                    API pages: ${fmt(pages)} • records checked: ${fmt(attacks)}
                </div>
                <div class="bftd-fws-progress"><div></div></div>
                <div class="bftd-fws-note" style="margin-top:8px">
                    Large factions can have many attack, OC and armory-news pages over long periods. Requests are deliberately paced to stay below Torn's API limit.
                </div>
            </div>
            <button id="bftd-fws-cancel-scan" class="bftd-fws-btn danger">CANCEL SCAN</button>
        `;
        body.querySelector('#bftd-fws-cancel-scan')?.addEventListener('click', () => {
            state.abortScan = true;
        });
    }

    async function loadMemberStats(member, forceRefresh) {
        if (state.loadingStats) return;
        state.loadingStats = true;
        state.abortScan = false;
        const range = getPresetRange();
        state.lastRange = range;

        try {
            if (forceRefresh) {
                clearPeriodCache(range);
                clearXanaxCache(member.id, range);
            }
            const cached = forceRefresh ? null : getCached(range);

            if (cached?.aggregates && cached?.ocAggregates && cached?.armoryXanaxAggregates) {
                const cachedRange = cached.range || range;
                state.lastAggregates = cached.aggregates;
                state.lastOcAggregates = cached.ocAggregates;
                state.lastArmoryXanaxAggregates = cached.armoryXanaxAggregates;
                const xanax = getCachedMemberXanax(member, cachedRange) || { pending: true };
                renderStats(member, cachedRange, cached.aggregates, cached.ocAggregates, cached.armoryXanaxAggregates, xanax, {
                    cached: true,
                    generatedAt: cached.generatedAt,
                    pageCount: cached.pageCount,
                    fetchedCount: cached.fetchedCount,
                    ocPageCount: cached.ocPageCount,
                    ocCount: cached.ocCount,
                    armoryPageCount: cached.armoryPageCount,
                    armoryNewsCount: cached.armoryNewsCount
                });
                return;
            }

            renderStatsLoading(member, range, 'Scanning faction ranked-war attacks…');
            const scan = await scanFactionAttacks(range, (pages, attacks) => {
                renderStatsLoading(member, range, 'Scanning faction ranked-war attacks…', pages, attacks);
            });

            await sleep(APP.requestDelayMs);
            renderStatsLoading(member, range, 'Scanning completed organized crimes…', scan.pageCount, scan.fetchedCount);
            const ocScan = await scanFactionCrimes(range, (pages, crimes) => {
                renderStatsLoading(member, range, 'Scanning completed organized crimes…', scan.pageCount + pages, scan.fetchedCount + crimes);
            });

            await sleep(APP.requestDelayMs);
            renderStatsLoading(
                member,
                range,
                'Scanning faction armory Xanax usage…',
                scan.pageCount + ocScan.pageCount,
                scan.fetchedCount + ocScan.crimeCount
            );
            const armoryScan = await scanFactionArmoryXanax(range, (pages, newsCount) => {
                renderStatsLoading(
                    member,
                    range,
                    'Scanning faction armory Xanax usage…',
                    scan.pageCount + ocScan.pageCount + pages,
                    scan.fetchedCount + ocScan.crimeCount + newsCount
                );
            });

            putCached(
                range,
                scan.aggregates,
                ocScan.aggregates,
                armoryScan.aggregates,
                scan.pageCount,
                scan.fetchedCount,
                ocScan.pageCount,
                ocScan.crimeCount,
                armoryScan.pageCount,
                armoryScan.newsCount
            );
            state.lastAggregates = scan.aggregates;
            state.lastOcAggregates = ocScan.aggregates;
            state.lastArmoryXanaxAggregates = armoryScan.aggregates;

            const xanax = getCachedMemberXanax(member, range) || { pending: true };

            renderStats(member, range, scan.aggregates, ocScan.aggregates, armoryScan.aggregates, xanax, {
                cached: false,
                generatedAt: Date.now(),
                pageCount: scan.pageCount,
                fetchedCount: scan.fetchedCount,
                ocPageCount: ocScan.pageCount,
                ocCount: ocScan.crimeCount,
                armoryPageCount: armoryScan.pageCount,
                armoryNewsCount: armoryScan.newsCount
            });
        } catch (err) {
            const body = state.statsPanel?.querySelector('.bftd-fws-body');
            if (body) {
                body.innerHTML = `
                    <div class="bftd-fws-error"><b>Could not build stats.</b><br>${esc(err.message)}</div>
                    <div class="bftd-fws-row" style="margin-top:9px">
                        <button id="bftd-fws-try-again" class="bftd-fws-btn">TRY AGAIN</button>
                    </div>
                `;
                body.querySelector('#bftd-fws-try-again')?.addEventListener('click', () => loadMemberStats(member, true));
            }
        } finally {
            state.loadingStats = false;
        }
    }

    function freshAgg() {
        return {
            attempts: 0,
            warHits: 0,
            assists: 0,
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
            retaliationHits: 0,
            groupHits: 0,
            overseasHits: 0,
            fairFightSum: 0,
            fairFightCount: 0,
            maxFairFight: 0,
            uniqueTargets: {},
            firstAttackTs: 0,
            lastAttackTs: 0,
            outcomeCounts: {}
        };
    }

    function attackId(attack, fallback) {
        return String(attack?.id ?? attack?.attack_id ?? fallback ?? '');
    }

    function attackerId(attack) {
        return num(
            attack?.attacker?.id
            ?? attack?.attacker_id
            ?? attack?.attacker?.user_id
            ?? 0
        );
    }

    function defenderId(attack) {
        return num(
            attack?.defender?.id
            ?? attack?.defender_id
            ?? attack?.defender?.user_id
            ?? 0
        );
    }

    function attackEndTs(attack) {
        return num(
            attack?.ended
            ?? attack?.timestamp_ended
            ?? attack?.end
            ?? attack?.timestamp
            ?? 0
        );
    }

    function attackResult(attack) {
        return String(attack?.result ?? attack?.outcome ?? '').trim();
    }

    function isRankedWarAttack(attack) {
        if (attack?.is_ranked_war === true) return true;
        if (attack?.is_ranked_war === false) return false;
        return num(attack?.modifiers?.war, 1) > 1;
    }

    function addAttack(aggregates, attack) {
        if (!isRankedWarAttack(attack)) return;

        const aid = attackerId(attack);
        if (!aid) return;
        if (!aggregates[aid]) aggregates[aid] = freshAgg();
        const s = aggregates[aid];

        const resultRaw = attackResult(attack);
        const result = resultRaw.toLowerCase();
        const respectGain = num(attack?.respect_gain ?? attack?.respect, 0);
        const respectLoss = num(attack?.respect_loss, 0);
        const interrupted = attack?.is_interrupted === true || result === 'interrupted';
        const success = !interrupted && (SUCCESS_RESULTS.has(result) || (respectGain > 0 && !FAILURE_RESULTS.has(result) && result !== 'assist'));

        s.attempts += 1;
        s.respect += respectGain;
        s.respectLoss += respectLoss;
        s.outcomeCounts[resultRaw || 'Unknown'] = (s.outcomeCounts[resultRaw || 'Unknown'] || 0) + 1;

        if (success) s.warHits += 1;
        if (result === 'assist') s.assists += 1;
        else if (result === 'lost') s.losses += 1;
        else if (result === 'stalemate') s.stalemates += 1;
        else if (result === 'escape') s.escapes += 1;
        else if (result === 'timeout') s.timeouts += 1;
        else if (interrupted) s.interrupted += 1;
        else if (result === 'mugged') s.mugs += 1;
        else if (result === 'hospitalized') s.hospitalizations += 1;
        else if (result === 'attacked') s.attacks += 1;
        else if (!success) s.otherResults += 1;

        if (success) {
            const retal = num(attack?.modifiers?.retaliation, 1);
            const group = num(attack?.modifiers?.group, 1);
            const overseas = num(attack?.modifiers?.overseas, 1);
            const ff = num(attack?.modifiers?.fair_fight, 1);

            if (retal > 1.00001) s.retaliationHits += 1;
            if (group > 1.00001) s.groupHits += 1;
            if (overseas > 1.00001) s.overseasHits += 1;

            s.fairFightSum += ff;
            s.fairFightCount += 1;
            s.maxFairFight = Math.max(s.maxFairFight, ff);
        }

        const did = defenderId(attack);
        if (did) s.uniqueTargets[did] = 1;

        const ts = attackEndTs(attack);
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

    async function scanFactionAttacks(range, onProgress) {
        const aggregates = {};
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
                addAttack(aggregates, attack);
            }

            onProgress?.(pageCount, fetchedCount);

            if (!attacks.length || attacks.length < 100 || !oldestTs || oldestTs <= range.from) break;

            const nextTo = oldestTs - 1;
            if (nextTo >= cursorTo) {
                // Do not abort the whole report if Torn gives a non-progressing page.
                // Stop this source safely; already fetched rows remain usable.
                break;
            }

            cursorTo = nextTo;
            await sleep(APP.requestDelayMs);

            if (pageCount > 1500) {
                throw new Error('Attack pagination exceeded the safety limit (1,500 pages).');
            }
        }

        for (const member of state.members) {
            if (!aggregates[Number(member.id)]) aggregates[Number(member.id)] = freshAgg();
        }

        for (const value of Object.values(aggregates)) {
            value.uniqueTargetCount = Object.keys(value.uniqueTargets || {}).length;
            delete value.uniqueTargets;
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
                filter: 'executed_at',
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
        const avgFF = s.fairFightCount ? s.fairFightSum / s.fairFightCount : 0;
        const respectPerHit = s.warHits ? s.respect / s.warHits : 0;
        const successRate = pct(s.warHits, s.attempts);
        const ocSuccessRate = pct(oc.successful, oc.participated);
        const generatedText = new Date(meta.generatedAt).toLocaleTimeString();
        const lastOnline = memberLastOnlineDisplay(member);

        const outcomes = Object.entries(s.outcomeCounts || {})
            .sort((a, b) => b[1] - a[1])
            .map(([name, count]) => `<tr><td>${esc(name)}</td><td>${fmt(count)}</td></tr>`)
            .join('') || '<tr><td>No ranked-war attacks found</td><td>0</td></tr>';

        body.innerHTML = `
            <div class="bftd-fws-card">
                <div class="bftd-fws-row">
                    <div class="bftd-fws-grow">
                        <div style="font-weight:800">${esc(member.name)} [${esc(member.id)}]</div>
                        <div class="bftd-fws-note">
                            ${esc(member.position || 'Member')} • Level ${esc(member.level ?? '?')} • ${esc(range.label)}
                        </div>
                        <div class="bftd-fws-note" style="margin-top:4px"><b>Last online/action:</b> ${esc(lastOnline)}</div>
                    </div>
                    <span class="bftd-fws-badge ${meta.cached ? 'info' : 'good'}">${meta.cached ? 'CACHED' : 'FRESH'}</span>
                </div>
            </div>

            <div class="bftd-fws-grid">
                <div class="bftd-fws-stat"><div class="v">${fmt(s.warHits)}</div><div class="k">RANKED-WAR HITS</div></div>
                <div class="bftd-fws-stat"><div class="v">${fmt(s.attempts)}</div><div class="k">RW ATTEMPTS</div></div>
                <div class="bftd-fws-stat"><div class="v">${esc(successRate)}</div><div class="k">RW SUCCESS RATE</div></div>
                <div class="bftd-fws-stat"><div class="v">${fmt(s.respect, 2)}</div><div class="k">WAR SCORE / RESPECT</div></div>
                <div class="bftd-fws-stat"><div class="v">${fmt(respectPerHit, 2)}</div><div class="k">RESPECT PER HIT</div></div>
                <div class="bftd-fws-stat"><div class="v">${fmt(s.assists)}</div><div class="k">ASSISTS</div></div>
                <div class="bftd-fws-stat"><div class="v">${fmt(s.retaliationHits)}</div><div class="k">RETALIATION HITS</div></div>
                <div class="bftd-fws-stat"><div class="v">${fmt(s.groupHits)}</div><div class="k">GROUP HITS</div></div>
                <div class="bftd-fws-stat"><div class="v">${fmt(s.overseasHits)}</div><div class="k">OVERSEAS HITS</div></div>
                <div class="bftd-fws-stat"><div class="v">${fmt(avgFF, 2)}</div><div class="k">AVG FAIR FIGHT</div></div>
                <div class="bftd-fws-stat"><div class="v">${fmt(s.maxFairFight, 2)}</div><div class="k">MAX FAIR FIGHT</div></div>
                <div class="bftd-fws-stat"><div class="v">${fmt(s.uniqueTargetCount || 0)}</div><div class="k">UNIQUE TARGETS</div></div>
                <div class="bftd-fws-stat"><div class="v">${fmt(oc.participated)}</div><div class="k">OCs PARTICIPATED</div></div>
                <div class="bftd-fws-stat"><div class="v">${fmt(oc.successful)}</div><div class="k">OCs SUCCESSFUL</div></div>
                <div class="bftd-fws-stat"><div class="v">${esc(ocSuccessRate)}</div><div class="k">OC SUCCESS RATE</div></div>
                <div class="bftd-fws-stat"><div class="v">${xanaxDisplay}</div><div class="k">XANAX TAKEN${xanaxLoaded ? '' : ' • 2 API'}</div></div>
                <div class="bftd-fws-stat"><div class="v">${fmt(armoryXanax.used || 0)}</div><div class="k">ARMORY XANAX USED</div></div>
            </div>

            <div class="bftd-fws-card" style="margin-top:10px">
                <div class="bftd-fws-row wrap">
                    <span class="bftd-fws-badge">Leaves ${fmt(s.attacks)}</span>
                    <span class="bftd-fws-badge">Hosp ${fmt(s.hospitalizations)}</span>
                    <span class="bftd-fws-badge">Mugs ${fmt(s.mugs)}</span>
                    <span class="bftd-fws-badge bad">Losses ${fmt(s.losses)}</span>
                    <span class="bftd-fws-badge">Stalemates ${fmt(s.stalemates)}</span>
                    <span class="bftd-fws-badge">Escapes ${fmt(s.escapes)}</span>
                    <span class="bftd-fws-badge">Timeouts ${fmt(s.timeouts)}</span>
                    <span class="bftd-fws-badge bad">Interrupted ${fmt(s.interrupted)}</span>
                    <span class="bftd-fws-badge good">OC wins ${fmt(oc.successful)}</span>
                    <span class="bftd-fws-badge bad">OC fails ${fmt(oc.failed)}</span>
                </div>
            </div>

            <div class="bftd-fws-card">
                <table class="bftd-fws-table">
                    <thead><tr><th>RESULT</th><th>COUNT</th></tr></thead>
                    <tbody>${outcomes}</tbody>
                </table>
            </div>

            <div class="bftd-fws-card">
                <div class="bftd-fws-note">
                    First ranked-war attack: <b>${esc(dateTime(s.firstAttackTs))}</b><br>
                    Last ranked-war attack: <b>${esc(dateTime(s.lastAttackTs))}</b><br>
                    First completed OC in period: <b>${esc(dateTime(oc.firstOcTs))}</b><br>
                    Last completed OC in period: <b>${esc(dateTime(oc.lastOcTs))}</b><br>
                    Xanax snapshot totals: ${xanaxLoaded ? `<b>${fmt(xanax.startTotal)}</b> → <b>${fmt(xanax.endTotal)}</b>` : '<b>Not loaded — saves 2 API calls per member.</b>'}<br>
                    Faction armory Xanax: <b>${fmt(armoryXanax.used || 0)}</b> used across <b>${fmt(armoryXanax.events || 0)}</b> armory log event(s)<br>
                    First armory Xanax event: <b>${esc(dateTime(armoryXanax.firstTs))}</b><br>
                    Last armory Xanax event: <b>${esc(dateTime(armoryXanax.lastTs))}</b><br>
                    Scan source: ${fmt(meta.pageCount)} attack pages / ${fmt(meta.fetchedCount)} attacks checked; ${fmt(meta.ocPageCount)} OC pages / ${fmt(meta.ocCount)} completed OCs checked; ${fmt(meta.armoryPageCount)} armory-news pages / ${fmt(meta.armoryNewsCount)} armory records checked.<br>
                    Summary generated: ${esc(generatedText)}.${meta.cached ? '<br><b>API Saver:</b> faction history is being read from the saved period cache. Press Refresh Period (API) only when you want Torn queried again.' : ''}
                </div>
            </div>

            <div class="bftd-fws-row wrap">
                <button id="bftd-fws-load-xanax" class="bftd-fws-btn secondary">${xanaxLoaded ? 'REFRESH XANAX (2 API)' : 'LOAD XANAX (2 API)'}</button>
                <button id="bftd-fws-force-refresh" class="bftd-fws-btn">REFRESH PERIOD (API)</button>
                <button id="bftd-fws-profile" class="bftd-fws-btn secondary">OPEN PROFILE</button>
            </div>

            <div class="bftd-fws-note" style="margin-top:9px">
                Ranked-war hits are successful attacks flagged by Torn as ranked-war attacks. OC totals count completed crimes whose execution time falls inside the selected period and credit each slotted participant once. Total Xanax is intentionally loaded on demand because Torn requires two historical personal-stat snapshots per member; this avoids spending those calls while you browse the member list. Faction Armory Xanax is counted separately from faction armory-action news. Current faction members are shown; former members are not listed.
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

        body.querySelector('#bftd-fws-force-refresh')?.addEventListener('click', () => loadMemberStats(member, true));
        body.querySelector('#bftd-fws-profile')?.addEventListener('click', () => {
            window.open(`https://www.torn.com/profiles.php?XID=${encodeURIComponent(member.id)}`, '_blank', 'noopener,noreferrer');
        });
    }

    function init() {
        injectCss();
        buildLauncher();
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init, { once: true });
    } else {
        init();
    }
})();

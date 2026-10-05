// ==UserScript==
// @name         Faction Helper
// @namespace    https://www.torn.com/
// @version      1.4.3
// @description  Faction scanner with per-member war/outside-hit/OC/Xanax stats, fully themed panels, custom resize handles, and a native Torn faction action button.
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
        version: '1.4.3',
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
        launcherSyncTimer: null,
        factionActionRow: null,
        factionActionTemplate: null
    };

    const SUCCESS_RESULTS = new Set(['attacked', 'mugged', 'hospitalized', 'special', 'bounty', 'looted']);
    const FAILURE_RESULTS = new Set(['lost', 'stalemate', 'escape', 'timeout', 'interrupted', 'arrested']);

    const THEME_PRESETS = {
        rwphGold: {
            name:'RWPH Gold',
            bg:'#0d0f11', panel:'#171a1e', panel2:'#20252a', header:'#111417',
            input:'#0b0d0f', member:'#191d21', stat:'#15191d', tableHeader:'#1d2227',
            primaryButton:'#3a3019', primaryButtonText:'#ffd978',
            secondaryButton:'#252a30', secondaryButtonText:'#edf1f4',
            dangerButton:'#351e20', dangerButtonText:'#ffb2b6',
            badge:'#15191c', progressTrack:'#0b0d0f', progressBar:'#e9bd4e',
            disabled:'#17191c', disabledText:'#717983',
            text:'#f4f5f6', muted:'#9ea7b0', accent:'#e9bd4e', border:'#3a4047',
            good:'#5fd09a', bad:'#ef727d', info:'#70b7f3',
            errorBg:'#2b171a', errorText:'#ffb7bd', successBg:'#13271d', successText:'#a8ebc7',
            scrollbarTrack:'#0d0f11', scrollbarThumb:'#4d555e',
            launcherBg:'#1d2227', launcherBorder:'#e9bd4e',
            launcherIconBg:'#282316', launcherIconStroke:'#f0c85e', launcherText:'#fff4c8'
        },
        tornCrimson: {
            name:'Torn Crimson',
            bg:'#0d0b0c', panel:'#181214', panel2:'#23191c', header:'#120d0f',
            input:'#0b090a', member:'#1c1417', stat:'#171113', tableHeader:'#21171a',
            primaryButton:'#421d24', primaryButtonText:'#ffd9de',
            secondaryButton:'#2a2023', secondaryButtonText:'#f5e9eb',
            dangerButton:'#541f29', dangerButtonText:'#ffd2d8',
            badge:'#1a1214', progressTrack:'#0c090a', progressBar:'#e34b5f',
            disabled:'#181416', disabledText:'#806f73',
            text:'#fff2f4', muted:'#b9a2a8', accent:'#e34b5f', border:'#4b3037',
            good:'#62cf8e', bad:'#ff6478', info:'#79aef2',
            errorBg:'#35161c', errorText:'#ffc0ca', successBg:'#14271c', successText:'#a7e9c2',
            scrollbarTrack:'#0d0b0c', scrollbarThumb:'#62414a',
            launcherBg:'#25171b', launcherBorder:'#e34b5f',
            launcherIconBg:'#361a21', launcherIconStroke:'#ff6578', launcherText:'#ffe8ec'
        },
        cyberBlue: {
            name:'Cyber Blue',
            bg:'#081018', panel:'#101b27', panel2:'#172637', header:'#0b1520',
            input:'#071019', member:'#122131', stat:'#0f1d2b', tableHeader:'#152435',
            primaryButton:'#123b58', primaryButtonText:'#bcecff',
            secondaryButton:'#1b2d3d', secondaryButtonText:'#e5f5ff',
            dangerButton:'#3b2028', dangerButtonText:'#ffc0ca',
            badge:'#0f1d29', progressTrack:'#071019', progressBar:'#38bdf8',
            disabled:'#101923', disabledText:'#697b89',
            text:'#eef9ff', muted:'#91aabd', accent:'#38bdf8', border:'#2c4a60',
            good:'#51d6a0', bad:'#ff6b78', info:'#5dc8ff',
            errorBg:'#2c171d', errorText:'#ffb6c0', successBg:'#102a20', successText:'#a2efd0',
            scrollbarTrack:'#081018', scrollbarThumb:'#31566d',
            launcherBg:'#102233', launcherBorder:'#38bdf8',
            launcherIconBg:'#0d2f46', launcherIconStroke:'#54d2ff', launcherText:'#dff7ff'
        },
        emeraldOps: {
            name:'Emerald Ops',
            bg:'#08110d', panel:'#101d16', panel2:'#17281f', header:'#0b1711',
            input:'#07100c', member:'#132219', stat:'#102018', tableHeader:'#15251d',
            primaryButton:'#173e2b', primaryButtonText:'#c9f8dd',
            secondaryButton:'#1b2e25', secondaryButtonText:'#e7f7ee',
            dangerButton:'#3b2024', dangerButtonText:'#ffc6cc',
            badge:'#0f1d16', progressTrack:'#07100c', progressBar:'#45d483',
            disabled:'#101913', disabledText:'#6d7d73',
            text:'#eefaf3', muted:'#92b0a0', accent:'#45d483', border:'#2f4b3d',
            good:'#5ee29c', bad:'#f4767f', info:'#72b6ef',
            errorBg:'#2d181b', errorText:'#ffb8bf', successBg:'#0f2b1d', successText:'#a6f1ca',
            scrollbarTrack:'#08110d', scrollbarThumb:'#345845',
            launcherBg:'#11271b', launcherBorder:'#45d483',
            launcherIconBg:'#153823', launcherIconStroke:'#64e69c', launcherText:'#e0ffed'
        },
        royalViolet: {
            name:'Royal Violet',
            bg:'#0e0a14', panel:'#191323', panel2:'#241b31', header:'#120d1a',
            input:'#0c0911', member:'#1d1628', stat:'#181121', tableHeader:'#22192f',
            primaryButton:'#3b2858', primaryButtonText:'#eadcff',
            secondaryButton:'#2b2237', secondaryButtonText:'#f3edfb',
            dangerButton:'#412027', dangerButtonText:'#ffc1ca',
            badge:'#181220', progressTrack:'#0c0911', progressBar:'#a879ff',
            disabled:'#18141d', disabledText:'#7a7183',
            text:'#f8f2ff', muted:'#b0a2c2', accent:'#a879ff', border:'#4b3d5f',
            good:'#65d69b', bad:'#f27182', info:'#75b8f0',
            errorBg:'#32191f', errorText:'#ffbac6', successBg:'#14271d', successText:'#a7ebc6',
            scrollbarTrack:'#0e0a14', scrollbarThumb:'#564468',
            launcherBg:'#22182f', launcherBorder:'#a879ff',
            launcherIconBg:'#302043', launcherIconStroke:'#bd99ff', launcherText:'#f3eaff'
        },
        graphiteIce: {
            name:'Graphite Ice',
            bg:'#0c1115', panel:'#171d22', panel2:'#20282f', header:'#11161a',
            input:'#0a0f12', member:'#1a2127', stat:'#151c21', tableHeader:'#1d252b',
            primaryButton:'#223946', primaryButtonText:'#d5f2ff',
            secondaryButton:'#283139', secondaryButtonText:'#edf3f6',
            dangerButton:'#3c2327', dangerButtonText:'#ffc5cb',
            badge:'#151b20', progressTrack:'#0a0f12', progressBar:'#82c7e8',
            disabled:'#161b1f', disabledText:'#747e85',
            text:'#f1f6f8', muted:'#9cabb3', accent:'#82c7e8', border:'#3d4b54',
            good:'#67d39e', bad:'#eb7681', info:'#82c7e8',
            errorBg:'#2d191c', errorText:'#ffbcc3', successBg:'#14281e', successText:'#a7e9c8',
            scrollbarTrack:'#0c1115', scrollbarThumb:'#4b5d67',
            launcherBg:'#202a31', launcherBorder:'#82c7e8',
            launcherIconBg:'#233743', launcherIconStroke:'#9bdbf6', launcherText:'#effbff'
        },
        ember: {
            name:'Ember',
            bg:'#120d09', panel:'#1e1610', panel2:'#2a1e15', header:'#160f0b',
            input:'#100b08', member:'#241911', stat:'#1d140e', tableHeader:'#281c13',
            primaryButton:'#4b2d12', primaryButtonText:'#ffe1b5',
            secondaryButton:'#32271f', secondaryButtonText:'#f8eee6',
            dangerButton:'#472024', dangerButtonText:'#ffc1c7',
            badge:'#1c130e', progressTrack:'#100b08', progressBar:'#f28a32',
            disabled:'#1b1714', disabledText:'#81756c',
            text:'#fff5ec', muted:'#c0aa99', accent:'#f28a32', border:'#554033',
            good:'#65d595', bad:'#f37278', info:'#77b8ed',
            errorBg:'#34181b', errorText:'#ffb9bf', successBg:'#16291d', successText:'#a8ebc5',
            scrollbarTrack:'#120d09', scrollbarThumb:'#665044',
            launcherBg:'#2b1d13', launcherBorder:'#f28a32',
            launcherIconBg:'#3c2410', launcherIconStroke:'#ff9d47', launcherText:'#fff0dc'
        },
        neonRose: {
            name:'Neon Rose',
            bg:'#100911', panel:'#1b101d', panel2:'#28162b', header:'#140b16',
            input:'#0e0810', member:'#211225', stat:'#1b101e', tableHeader:'#251329',
            primaryButton:'#4b1848', primaryButtonText:'#ffd7fb',
            secondaryButton:'#312036', secondaryButtonText:'#f8ebfa',
            dangerButton:'#471d27', dangerButtonText:'#ffc4cf',
            badge:'#1d111f', progressTrack:'#0e0810', progressBar:'#ff5ed8',
            disabled:'#1a141b', disabledText:'#817184',
            text:'#fff2fd', muted:'#c2a4bf', accent:'#ff5ed8', border:'#593357',
            good:'#64d9a0', bad:'#ff6f86', info:'#78b8ff',
            errorBg:'#351721', errorText:'#ffc0cd', successBg:'#12291d', successText:'#a9efc9',
            scrollbarTrack:'#100911', scrollbarThumb:'#684061',
            launcherBg:'#29152b', launcherBorder:'#ff5ed8',
            launcherIconBg:'#3a1838', launcherIconStroke:'#ff82e2', launcherText:'#fff0fd'
        },
        blackout: {
            name:'Blackout',
            bg:'#050607', panel:'#0c0e10', panel2:'#13161a', header:'#080a0c',
            input:'#050607', member:'#101317', stat:'#0d1013', tableHeader:'#111419',
            primaryButton:'#20262c', primaryButtonText:'#ffffff',
            secondaryButton:'#181c20', secondaryButtonText:'#e5e8eb',
            dangerButton:'#2b1719', dangerButtonText:'#ffb7bd',
            badge:'#0c0f12', progressTrack:'#050607', progressBar:'#dfe6eb',
            disabled:'#0c0e10', disabledText:'#60676d',
            text:'#f5f7f8', muted:'#899198', accent:'#dfe6eb', border:'#2b3035',
            good:'#67d9a0', bad:'#f36f7c', info:'#75b9ed',
            errorBg:'#251417', errorText:'#ffb8c0', successBg:'#10231a', successText:'#a5e9c4',
            scrollbarTrack:'#050607', scrollbarThumb:'#33393f',
            launcherBg:'#101317', launcherBorder:'#dfe6eb',
            launcherIconBg:'#171b20', launcherIconStroke:'#f0f4f7', launcherText:'#ffffff'
        },
        arcticLight: {
            name:'Arctic Light',
            bg:'#e9eef2', panel:'#f7f9fb', panel2:'#ffffff', header:'#dde5eb',
            input:'#ffffff', member:'#f2f6f8', stat:'#edf3f6', tableHeader:'#e2eaf0',
            primaryButton:'#d9edf7', primaryButtonText:'#17435a',
            secondaryButton:'#e7edf1', secondaryButtonText:'#24343d',
            dangerButton:'#f8dadd', dangerButtonText:'#7d202b',
            badge:'#edf2f5', progressTrack:'#d9e1e6', progressBar:'#2b8dbd',
            disabled:'#e1e6e9', disabledText:'#8a959c',
            text:'#1d2a31', muted:'#64747d', accent:'#2b8dbd', border:'#b8c6ce',
            good:'#218b58', bad:'#c43d4e', info:'#267eb2',
            errorBg:'#f8dfe2', errorText:'#8d2632', successBg:'#dff3e7', successText:'#246d48',
            scrollbarTrack:'#e4eaee', scrollbarThumb:'#a3b4bd',
            launcherBg:'#f4f8fa', launcherBorder:'#2b8dbd',
            launcherIconBg:'#dceff8', launcherIconStroke:'#2b8dbd', launcherText:'#173f53'
        }
    };

    const THEME_DEFAULTS = {
        bg:'#101214',
        panel:'#191c20',
        panel2:'#23272c',
        header:'#111316',
        input:'#0f1113',
        member:'#181b1f',
        stat:'#15181b',
        tableHeader:'#23272c',
        primaryButton:'#332b1b',
        primaryButtonText:'#f6d77d',
        secondaryButton:'#292d32',
        secondaryButtonText:'#dfe4e8',
        dangerButton:'#332020',
        dangerButtonText:'#f3a0a0',
        badge:'#17191c',
        progressTrack:'#111315',
        progressBar:'#e6b94a',
        disabled:'#15171a',
        disabledText:'#7f8790',
        text:'#f2f4f6',
        muted:'#9da7b2',
        accent:'#e6b94a',
        border:'#363c43',
        good:'#55c58a',
        bad:'#e36b6b',
        info:'#6aa9e9',
        errorBg:'#2c1c1c',
        errorText:'#ffaaaa',
        successBg:'#18291f',
        successText:'#a9e6c5',
        scrollbarTrack:'#101214',
        scrollbarThumb:'#48515a',
        launcherBg:'#23272c',
        launcherBorder:'#e6b94a',
        launcherIconBg:'#23272c',
        launcherIconStroke:'#e6b94a',
        launcherText:'#f2f4f6'
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
        const defaults = { theme:{ preset:'rwphGold', custom:{} }, panels:{} };
        try {
            const raw = GM_getValue(APP.uiStorage, '');
            if (!raw) return defaults;
            const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
            return {
                theme: {
                    preset: parsed?.theme?.preset || 'rwphGold',
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
        const preset = THEME_PRESETS[ui.theme?.preset] || THEME_PRESETS.rwphGold;
        return { ...THEME_DEFAULTS, ...preset, ...(ui.theme?.custom || {}) };
    }

    function applyTheme() {
        const t = currentTheme();
        const root = document.documentElement;
        const vars = {
            '--bftd-bg': t.bg,
            '--bftd-panel': t.panel,
            '--bftd-panel2': t.panel2,
            '--bftd-header': t.header,
            '--bftd-input': t.input,
            '--bftd-member': t.member,
            '--bftd-stat': t.stat,
            '--bftd-table-header': t.tableHeader,
            '--bftd-btn-primary': t.primaryButton,
            '--bftd-btn-primary-text': t.primaryButtonText,
            '--bftd-btn-secondary': t.secondaryButton,
            '--bftd-btn-secondary-text': t.secondaryButtonText,
            '--bftd-btn-danger': t.dangerButton,
            '--bftd-btn-danger-text': t.dangerButtonText,
            '--bftd-badge': t.badge,
            '--bftd-progress-track': t.progressTrack,
            '--bftd-progress-bar': t.progressBar,
            '--bftd-disabled': t.disabled,
            '--bftd-disabled-text': t.disabledText,
            '--bftd-text': t.text,
            '--bftd-muted': t.muted,
            '--bftd-accent': t.accent,
            '--bftd-border': t.border,
            '--bftd-good': t.good,
            '--bftd-bad': t.bad,
            '--bftd-info': t.info,
            '--bftd-error-bg': t.errorBg,
            '--bftd-error-text': t.errorText,
            '--bftd-success-bg': t.successBg,
            '--bftd-success-text': t.successText,
            '--bftd-scroll-track': t.scrollbarTrack,
            '--bftd-scroll-thumb': t.scrollbarThumb,
            '--bftd-launcher-bg': t.launcherBg,
            '--bftd-launcher-border': t.launcherBorder,
            '--bftd-launcher-icon-bg': t.launcherIconBg,
            '--bftd-launcher-icon-stroke': t.launcherIconStroke,
            '--bftd-launcher-text': t.launcherText
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
                margin:0 !important;
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
            #bftd-fh-launcher-slot {
                display:inline-flex !important;
                align-items:center !important;
                justify-content:center !important;
                flex:0 0 auto !important;
                vertical-align:middle !important;
                margin-left:5px !important;
                padding:0 !important;
                width:auto !important;
                height:auto !important;
                position:relative !important;
                z-index:999999 !important;
            }

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


            /* Full colour coverage: every visible panel surface uses a theme variable. */
            .bftd-fws-panel {
                background:var(--bftd-panel) !important;
                border-color:var(--bftd-border) !important;
                color:var(--bftd-text) !important;
            }
            .bftd-fws-head { background:var(--bftd-header) !important; border-bottom-color:var(--bftd-border) !important; color:var(--bftd-text) !important; }
            .bftd-fws-body { background:var(--bftd-bg) !important; color:var(--bftd-text) !important; }
            .bftd-fws-card { background:var(--bftd-panel2) !important; border-color:var(--bftd-border) !important; color:var(--bftd-text) !important; }
            .bftd-fws-input,.bftd-fws-select { background:var(--bftd-input) !important; color:var(--bftd-text) !important; border-color:var(--bftd-border) !important; }
            .bftd-fws-member { background:var(--bftd-member) !important; color:var(--bftd-text) !important; border-color:var(--bftd-border) !important; }
            .bftd-fws-member:hover:not(:disabled) { background:color-mix(in srgb,var(--bftd-member) 85%,var(--bftd-accent) 15%) !important; border-color:var(--bftd-accent) !important; }
            .bftd-fws-member:disabled,.bftd-fws-member:disabled:hover { background:var(--bftd-disabled) !important; color:var(--bftd-disabled-text) !important; border-color:var(--bftd-border) !important; }
            .bftd-fws-stat { background:var(--bftd-stat) !important; border-color:var(--bftd-border) !important; color:var(--bftd-text) !important; }
            .bftd-fws-stat .v { color:var(--bftd-text) !important; }
            .bftd-fws-table th { background:var(--bftd-table-header) !important; color:var(--bftd-muted) !important; border-bottom-color:var(--bftd-border) !important; }
            .bftd-fws-table td { color:var(--bftd-text) !important; border-bottom-color:var(--bftd-border) !important; }
            .bftd-fws-btn { background:var(--bftd-btn-primary) !important; color:var(--bftd-btn-primary-text) !important; border-color:var(--bftd-accent) !important; }
            .bftd-fws-btn:hover:not(:disabled) { background:color-mix(in srgb,var(--bftd-btn-primary) 84%,var(--bftd-accent) 16%) !important; }
            .bftd-fws-btn.secondary,.bftd-fws-iconbtn,.bftd-fws-close { background:var(--bftd-btn-secondary) !important; color:var(--bftd-btn-secondary-text) !important; border-color:var(--bftd-border) !important; }
            .bftd-fws-btn.secondary:hover:not(:disabled),.bftd-fws-iconbtn:hover { background:color-mix(in srgb,var(--bftd-btn-secondary) 84%,var(--bftd-accent) 16%) !important; border-color:var(--bftd-accent) !important; }
            .bftd-fws-btn.danger,.bftd-fws-close:hover { background:var(--bftd-btn-danger) !important; color:var(--bftd-btn-danger-text) !important; border-color:var(--bftd-bad) !important; }
            .bftd-fws-btn:disabled { background:var(--bftd-disabled) !important; color:var(--bftd-disabled-text) !important; border-color:var(--bftd-border) !important; }
            .bftd-fws-period { background:var(--bftd-input) !important; color:var(--bftd-text) !important; border-color:var(--bftd-border) !important; }
            .bftd-fws-period.active { background:var(--bftd-btn-primary) !important; color:var(--bftd-btn-primary-text) !important; border-color:var(--bftd-accent) !important; }
            .bftd-fws-badge { background:var(--bftd-badge) !important; color:var(--bftd-muted) !important; border-color:var(--bftd-border) !important; }
            .bftd-fws-badge.good { color:var(--bftd-good) !important; border-color:var(--bftd-good) !important; }
            .bftd-fws-badge.bad { color:var(--bftd-bad) !important; border-color:var(--bftd-bad) !important; }
            .bftd-fws-badge.info { color:var(--bftd-info) !important; border-color:var(--bftd-info) !important; }
            .bftd-fws-error { background:var(--bftd-error-bg) !important; color:var(--bftd-error-text) !important; border-color:var(--bftd-bad) !important; }
            .bftd-fws-ok { background:var(--bftd-success-bg) !important; color:var(--bftd-success-text) !important; border-color:var(--bftd-good) !important; }
            .bftd-fws-progress { background:var(--bftd-progress-track) !important; border-color:var(--bftd-border) !important; }
            .bftd-fws-progress > div { background:var(--bftd-progress-bar) !important; }
            .bftd-fws-note,.bftd-fws-sub,.bftd-fws-member-meta,.bftd-fws-stat .k,.bftd-fws-theme-field label { color:var(--bftd-muted) !important; }
            .bftd-fws-resize::before,.bftd-fws-resize::after { background:var(--bftd-accent) !important; }
            .bftd-fws-theme-pop { background:var(--bftd-panel) !important; color:var(--bftd-text) !important; border-color:var(--bftd-border) !important; }
            .bftd-fws-color { background:var(--bftd-input) !important; border-color:var(--bftd-border) !important; }
            .bftd-fws-body,.bftd-fws-theme-pop,.bftd-fws-card { scrollbar-color:var(--bftd-scroll-thumb) var(--bftd-scroll-track); }
            .bftd-fws-body::-webkit-scrollbar,.bftd-fws-theme-pop::-webkit-scrollbar,.bftd-fws-card::-webkit-scrollbar { width:10px; height:10px; }
            .bftd-fws-body::-webkit-scrollbar-track,.bftd-fws-theme-pop::-webkit-scrollbar-track,.bftd-fws-card::-webkit-scrollbar-track { background:var(--bftd-scroll-track); }
            .bftd-fws-body::-webkit-scrollbar-thumb,.bftd-fws-theme-pop::-webkit-scrollbar-thumb,.bftd-fws-card::-webkit-scrollbar-thumb { background:var(--bftd-scroll-thumb); border:2px solid var(--bftd-scroll-track); border-radius:999px; }
            #bftd-fws-launcher { background:var(--bftd-launcher-bg) !important; border-color:var(--bftd-launcher-border) !important; color:var(--bftd-launcher-text) !important; }
            #bftd-fws-launcher:hover { border-color:var(--bftd-launcher-border) !important; }


            #bftd-fh-action-button { cursor:pointer; }
            #bftd-fh-action-item { position:relative; }

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

        const groups = [
            ['PANEL SURFACES', [
                ['bg','Body / Scroll Area'], ['panel','Panel Shell'], ['panel2','Cards'], ['header','Title Bar'],
                ['input','Inputs / Selects'], ['member','Member Rows'], ['stat','Stat Tiles'], ['tableHeader','Table Header']
            ]],
            ['BUTTONS & CONTROLS', [
                ['primaryButton','Primary Button'], ['primaryButtonText','Primary Button Text'],
                ['secondaryButton','Secondary Button'], ['secondaryButtonText','Secondary Button Text'],
                ['dangerButton','Danger / Close Button'], ['dangerButtonText','Danger Button Text'],
                ['badge','Badge Background'], ['disabled','Disabled Background'], ['disabledText','Disabled Text'],
                ['progressTrack','Progress Track'], ['progressBar','Progress Bar']
            ]],
            ['TEXT & STATES', [
                ['text','Main Text'], ['muted','Muted / Labels'], ['accent','Accent / Resize Handles'], ['border','Borders'],
                ['good','Success / Good'], ['bad','Error / Bad'], ['info','Info'],
                ['errorBg','Error Box'], ['errorText','Error Box Text'], ['successBg','Success Box'], ['successText','Success Box Text']
            ]],
            ['SCROLLBARS', [
                ['scrollbarTrack','Scrollbar Track'], ['scrollbarThumb','Scrollbar Thumb']
            ]],
            ['LEGACY LOGO COLOURS (not used by native Torn button)', [
                ['launcherBg','Launcher Background'], ['launcherBorder','Launcher Border'],
                ['launcherIconBg','Launcher Shield Fill'], ['launcherIconStroke','Launcher Shield Outline'], ['launcherText','Launcher FH Text']
            ]]
        ];

        pop.innerHTML=`
            <div class="bftd-fws-theme-title">
                <strong>Theme & Every Panel Colour</strong>
                <button class="bftd-fws-iconbtn" data-theme-close title="Close">×</button>
            </div>
            <div class="bftd-fws-theme-field" style="margin-bottom:10px">
                <label>PRESET</label>
                <select class="bftd-fws-select" data-theme-preset>
                    ${Object.entries(THEME_PRESETS).map(([id,t])=>`<option value="${esc(id)}" ${ui.theme?.preset===id?'selected':''}>${esc(t.name)}</option>`).join('')}
                    <option value="custom" ${ui.theme?.preset==='custom'?'selected':''}>Custom</option>
                </select>
            </div>
            ${groups.map(([title,fields])=>`
                <div class="bftd-fws-card" style="padding:8px;margin-bottom:8px">
                    <div class="bftd-fws-note" style="font-weight:800;margin-bottom:7px">${esc(title)}</div>
                    <div class="bftd-fws-theme-grid">
                        ${fields.map(([key,label])=>`
                            <div class="bftd-fws-theme-field">
                                <label>${esc(label.toUpperCase())}</label>
                                <input class="bftd-fws-color" data-theme-colour="${esc(key)}" type="color" value="${esc(active[key])}">
                            </div>`).join('')}
                    </div>
                </div>`).join('')}
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
                const live=currentTheme();
                next.theme.preset='custom';
                next.theme.custom={...live,[prop]:ev.target.value};
                saveUiState(next);
                applyTheme();
                const sel=pop.querySelector('[data-theme-preset]');
                if (sel) sel.value='custom';
            });
        });

        pop.querySelector('[data-theme-reset]')?.addEventListener('click',()=>{
            const next=loadUiState();
            next.theme={preset:'rwphGold',custom:{}};
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


    function normalizeActionText(value) {
        return String(value || '').replace(/\s+/g, ' ').trim().toLowerCase();
    }

    function visibleActionControl(el) {
        if (!el?.isConnected || el.closest('.bftd-fws-panel')) return false;
        if (el.offsetParent === null) return false;
        const r = el.getBoundingClientRect?.();
        return !!r && r.width > 8 && r.height > 8;
    }

    function actionTextMatches(el, wanted) {
        if (!visibleActionControl(el)) return false;
        return normalizeActionText(el.textContent) === normalizeActionText(wanted);
    }

    function findFactionActionControls() {
        const controls = [...document.querySelectorAll('a,button,[role="button"]')]
            .filter(visibleActionControl);

        const find = label => controls.find(el => actionTextMatches(el, label)) || null;

        return {
            warfare: find('Faction Warfare'),
            forum: find('Forum'),
            leave: find('Leave Faction')
        };
    }

    function commonAncestor(nodes) {
        const valid = nodes.filter(Boolean);
        if (!valid.length) return null;

        let cur = valid[0].parentElement;
        while (cur && cur !== document.body) {
            if (valid.every(node => cur.contains(node))) return cur;
            cur = cur.parentElement;
        }
        return null;
    }

    function scoreFactionActionRow(row, controls) {
        if (!row) return -1;
        let found = 0;
        for (const control of Object.values(controls)) {
            if (control && row.contains(control)) found += 1;
        }
        if (found < 2) return -1;

        const clickableCount = row.querySelectorAll('a,button,[role="button"]').length;
        return found * 1000 - clickableCount * 5 - row.children.length;
    }

    function findFactionActionRow() {
        const controls = findFactionActionControls();
        const seeds = Object.values(controls).filter(Boolean);
        if (seeds.length < 2) return { row:null, controls };

        const candidates = new Set();
        for (const seed of seeds) {
            let cur = seed.parentElement;
            let depth = 0;
            while (cur && cur !== document.body && depth < 7) {
                candidates.add(cur);
                cur = cur.parentElement;
                depth += 1;
            }
        }

        const shared = commonAncestor(seeds);
        if (shared) candidates.add(shared);

        let best = null;
        let bestScore = -1;
        for (const row of candidates) {
            const score = scoreFactionActionRow(row, controls);
            if (score > bestScore) {
                best = row;
                bestScore = score;
            }
        }

        return { row:best, controls };
    }

    function directChildWithin(row, node) {
        if (!row || !node || !row.contains(node)) return null;
        let cur = node;
        while (cur.parentElement && cur.parentElement !== row) cur = cur.parentElement;
        return cur.parentElement === row ? cur : null;
    }

    function stripCloneIds(root) {
        if (!root) return;
        root.removeAttribute?.('id');
        root.querySelectorAll?.('[id]').forEach(el => el.removeAttribute('id'));
    }

    function sanitizeNativeClone(root) {
        if (!root) return;
        stripCloneIds(root);

        const all = [root, ...root.querySelectorAll('*')];
        for (const el of all) {
            for (const attr of [...el.attributes || []]) {
                const name = attr.name.toLowerCase();
                if (
                    name === 'onclick' ||
                    name === 'target' ||
                    name === 'download' ||
                    name.startsWith('data-route') ||
                    name.startsWith('data-action') ||
                    name.startsWith('data-url')
                ) {
                    el.removeAttribute(attr.name);
                }
            }
        }
    }

    function findClickableInItem(item) {
        if (!item) return null;
        if (item.matches?.('a,button,[role="button"]')) return item;
        return item.querySelector('a,button,[role="button"]');
    }

    function setFactionHelperButtonText(control) {
        if (!control) return;
        control.textContent = 'Faction Helper';
        control.id = 'bftd-fh-action-button';
        control.setAttribute('aria-label', 'Faction Helper');
        control.setAttribute('title', `Faction Helper v${APP.version}`);

        if (control.tagName === 'A') control.setAttribute('href', '#');
        if (control.tagName === 'BUTTON') control.type = 'button';
    }

    function createFactionHelperAction(row, controls) {
        const templateControl = controls.forum || controls.warfare || controls.leave;
        if (!row || !templateControl) return null;

        const templateItem = directChildWithin(row, templateControl) || templateControl;
        const clone = templateItem.cloneNode(true);
        sanitizeNativeClone(clone);
        clone.id = 'bftd-fh-action-item';

        const control = findClickableInItem(clone) || clone;
        setFactionHelperButtonText(control);

        control.addEventListener('click', ev => {
            ev.preventDefault();
            ev.stopPropagation();
            openMain();
        });

        return clone;
    }

    function insertFactionHelperAction(row, controls, item) {
        if (!row || !item) return false;

        const forumItem = directChildWithin(row, controls.forum);
        const warfareItem = directChildWithin(row, controls.warfare);
        const leaveItem = directChildWithin(row, controls.leave);

        // Preferred native order:
        // Faction Warfare | Forum | Faction Helper | Leave Faction
        if (forumItem?.parentElement === row) {
            forumItem.insertAdjacentElement('afterend', item);
            return true;
        }

        if (leaveItem?.parentElement === row) {
            row.insertBefore(item, leaveItem);
            return true;
        }

        if (warfareItem?.parentElement === row) {
            warfareItem.insertAdjacentElement('afterend', item);
            return true;
        }

        row.appendChild(item);
        return true;
    }

    function cleanupOldLaunchers() {
        document.querySelector('#bftd-fws-launcher')?.remove();
        document.querySelector('#bftd-fh-launcher-slot')?.remove();
    }

    function syncLauncher() {
        cleanupOldLaunchers();

        const existing = document.getElementById('bftd-fh-action-item');
        const { row, controls } = findFactionActionRow();

        if (!row) return;

        state.factionActionRow = row;
        state.factionActionTemplate = controls.forum || controls.warfare || controls.leave || null;

        if (existing?.isConnected && existing.parentElement === row) {
            state.launcher = existing;
            return;
        }

        existing?.remove();

        const item = createFactionHelperAction(row, controls);
        if (!item) return;

        insertFactionHelperAction(row, controls, item);
        state.launcher = item;
    }

    function buildLauncher() {
        syncLauncher();

        if (!state.launcherObserver && document.body) {
            let debounce = null;
            state.launcherObserver = new MutationObserver(() => {
                clearTimeout(debounce);
                debounce = setTimeout(syncLauncher, 180);
            });
            state.launcherObserver.observe(document.body, {
                childList:true,
                subtree:true
            });
        }

        if (!state.launcherSyncTimer) {
            state.launcherSyncTimer = window.setInterval(syncLauncher, 2500);
        }
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

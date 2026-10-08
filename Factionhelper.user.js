// ==UserScript==
// @name         Faction Helper
// @namespace    https://www.torn.com/
// @version      1.7.10
// @description  Faction scanner with 1-12 month rolling presets plus temporary Custom scans, Basic/Fast or detailed war-data modes, a rolling 12-month master local data cache, optional accurate per-chain reports, a separate faction-members panel, per-member war/chain/OC/Xanax stats, themed panels, and Torn faction integration.
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
        version: '1.7.10',
        keyStorage: 'bftd_fws_api_key_v1',
        cacheStorage: 'bftd_fws_stats_cache_v5',
        xanaxCacheStorage: 'bftd_fws_xanax_cache_v1',
        warReportCacheStorage: 'bftd_fh_war_report_cache_v1',
        chainReportCacheStorage: 'bftd_fh_chain_report_cache_v1',
        includeChainsStorage: 'bftd_fh_include_chains_v1',
        detailedWarDataStorage: 'bftd_fh_detailed_war_data_v1',
        uiStorage: 'bftd_fws_ui_v1',
        cacheTtlMs: 365 * 24 * 60 * 60 * 1000,
        xanaxCacheTtlMs: 6 * 60 * 60 * 1000,
        requestDelayMs: 1500,
        chainReportDelayMs: 2000,
        rateLimitPauseMs: 65000,
        maxRateLimitRetries: 6,
        maxTransientRetries: 3,
        apiBase: 'https://api.torn.com/v2',
        customKeyUrl:
            'https://www.torn.com/preferences.php#tab=api?step=addNewKey&title=Faction%20Helper&user=faction,personalstats&faction=basic,members,attacks,crimes,news,rankedwars,rankedwarreport,chains,chainreport'
    };

    const state = {
        apiKey: String(GM_getValue(APP.keyStorage, '') || '').trim(),
        keyInfo: null,
        faction: null,
        members: [],
        memberMap: new Map(),
        selectedPreset: 'rolling',
        selectedMonths: 6,
        customStart: '',
        customEnd: '',
        includeChains: Boolean(GM_getValue(APP.includeChainsStorage, false)),
        detailedWarData: Boolean(GM_getValue(APP.detailedWarDataStorage, true)),
        search: '',
        currentMember: null,
        mainPanel: null,
        statsPanel: null,
        cachedPanel: null,
        memberPanel: null,
        launcher: null,
        loadingStats: false,
        scanRunning: false,
        scanProgress: null,
        scanError: '',
        shareMessage: '',
        shareMessageType: '',
        abortScan: false,
        lastAggregates: null,
        lastOcAggregates: null,
        lastArmoryXanaxAggregates: null,
        lastRange: null,
        zCounter: 1000000,
        launcherObserver: null,
        launcherSyncTimer: null,
        factionActionRow: null,
        factionActionTemplate: null,
        masterWindowAnchorTo: 0,
        transientHistory: null
    };

    const HISTORY_DB_NAME = 'BFTD_Faction_Helper_History';
    const HISTORY_DB_VERSION = 1;
    const ATTACK_HISTORY_SCHEMA_VERSION = 2;
    let historyDbPromise = null;
    let historyDbUnavailable = false;

    function idbRequest(request) {
        return new Promise((resolve, reject) => {
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error || new Error('IndexedDB request failed.'));
        });
    }

    function idbTransactionDone(tx) {
        return new Promise((resolve, reject) => {
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error || new Error('IndexedDB transaction failed.'));
            tx.onabort = () => reject(tx.error || new Error('IndexedDB transaction was aborted.'));
        });
    }

    function openHistoryDb() {
        if (historyDbUnavailable) return Promise.resolve(null);
        if (historyDbPromise) return historyDbPromise;
        if (typeof indexedDB === 'undefined') {
            historyDbUnavailable = true;
            return Promise.resolve(null);
        }
        historyDbPromise = new Promise((resolve) => {
            try {
                const request = indexedDB.open(HISTORY_DB_NAME, HISTORY_DB_VERSION);
                request.onupgradeneeded = () => {
                    const db = request.result;
                    if (!db.objectStoreNames.contains('records')) {
                        const store = db.createObjectStore('records', { keyPath: 'key' });
                        store.createIndex('byFactionTypeTs', ['factionId', 'type', 'ts'], { unique: false });
                    }
                    if (!db.objectStoreNames.contains('coverage')) {
                        db.createObjectStore('coverage', { keyPath: 'key' });
                    }
                };
                request.onsuccess = () => resolve(request.result);
                request.onerror = () => {
                    historyDbUnavailable = true;
                    resolve(null);
                };
                request.onblocked = () => resolve(null);
            } catch {
                historyDbUnavailable = true;
                resolve(null);
            }
        });
        return historyDbPromise;
    }

    function historyFactionId() {
        return Number(state.faction?.id || 0);
    }

    function historyCoverageKey(type) {
        return `${historyFactionId()}:${type}`;
    }

    function mergeCoverageIntervals(intervals) {
        const rows = (Array.isArray(intervals) ? intervals : [])
            .map(row => [Math.floor(num(row?.[0])), Math.floor(num(row?.[1]))])
            .filter(([from, to]) => from > 0 && to >= from)
            .sort((a, b) => a[0] - b[0]);
        const merged = [];
        for (const row of rows) {
            const last = merged[merged.length - 1];
            if (!last || row[0] > last[1] + 1) merged.push(row.slice());
            else last[1] = Math.max(last[1], row[1]);
        }
        return merged;
    }

    async function historyGetCoverage(type) {
        const db = await openHistoryDb();
        if (!db || !historyFactionId()) return [];
        try {
            const tx = db.transaction('coverage', 'readonly');
            const row = await idbRequest(tx.objectStore('coverage').get(historyCoverageKey(type)));
            return mergeCoverageIntervals(row?.intervals || []);
        } catch {
            return [];
        }
    }

    async function historyMarkCoverage(type, from, to) {
        from = Math.floor(num(from));
        to = Math.floor(num(to));
        if (!historyFactionId() || !from || to < from) return;

        // Custom scans are strictly read-through: missing data may be downloaded,
        // but coverage discovered by that scan must never expand the rolling master.
        if (state.transientHistory) {
            const current = state.transientHistory.coverage[type] || [];
            state.transientHistory.coverage[type] = mergeCoverageIntervals([...current, [from, to]]);
            return;
        }

        const db = await openHistoryDb();
        if (!db) return;
        const rolling = rollingMasterWindow();
        from = Math.max(from, rolling.from);
        to = Math.min(to, rolling.to);
        if (!from || to < from) return;
        try {
            const existing = await historyGetCoverage(type);
            const intervals = mergeCoverageIntervals([...existing, [from, to]])
                .map(([a, b]) => [Math.max(a, rolling.from), Math.min(b, rolling.to)])
                .filter(([a, b]) => b >= a);
            const tx = db.transaction('coverage', 'readwrite');
            tx.objectStore('coverage').put({ key: historyCoverageKey(type), intervals, updatedAt: Date.now() });
            await idbTransactionDone(tx);
        } catch {
            // Local history caching is an optimization; scans still work if IndexedDB is unavailable.
        }
    }

    async function historyMissingRanges(type, from, to) {
        from = Math.floor(num(from));
        to = Math.floor(num(to));
        if (!state.transientHistory) {
            const rolling = rollingMasterWindow();
            from = Math.max(from, rolling.from);
            to = Math.min(to, rolling.to);
        }
        if (!from || !to || to < from) return [];
        const db = await openHistoryDb();
        if ((!db && !state.transientHistory) || !historyFactionId()) return [[from, to]];
        let masterCoverage = db ? await historyGetCoverage(type) : [];
        if (type === 'attacks' && db) {
            const meta = await historyGetRecordById('masterMeta', 'latest');
            if (num(meta?.attackHistorySchemaVersion) !== ATTACK_HISTORY_SCHEMA_VERSION) masterCoverage = [];
        }
        const transientCoverage = state.transientHistory?.coverage?.[type] || [];
        const coverage = mergeCoverageIntervals([...masterCoverage, ...transientCoverage]);
        const missing = [];
        let cursor = from;
        for (const [a, b] of coverage) {
            if (b < cursor) continue;
            if (a > to) break;
            if (a > cursor) missing.push([cursor, Math.min(to, a - 1)]);
            cursor = Math.max(cursor, b + 1);
            if (cursor > to) break;
        }
        if (cursor <= to) missing.push([cursor, to]);
        return missing;
    }

    async function buildMasterCacheScanPlan(range) {
        const from = Math.floor(num(range?.from));
        const to = Math.floor(num(range?.to));
        if (!from || !to || to < from) {
            return { wars: [], attacks: [], chains: [], crimes: [], armory: [] };
        }

        const [wars, attacks, chains, crimes, armory] = await Promise.all([
            historyMissingRanges('wars', from, to),
            historyMissingRanges('attacks', from, to),
            historyMissingRanges('chains', from, to),
            historyMissingRanges('crimes', from, to),
            historyMissingRanges('armory', from, to)
        ]);

        return { wars, attacks, chains, crimes, armory };
    }

    function cloneMissingRanges(rows) {
        return (Array.isArray(rows) ? rows : [])
            .map(row => [Math.floor(num(row?.[0])), Math.floor(num(row?.[1]))])
            .filter(([from, to]) => from > 0 && to >= from);
    }

    async function historyCheckpointCoverage(type, sourceRanges, verifiedFrom, verifiedTo) {
        const from = Math.floor(num(verifiedFrom));
        const to = Math.floor(num(verifiedTo));
        if (!from || !to || to < from) return;
        for (const [rangeFrom, rangeTo] of cloneMissingRanges(sourceRanges)) {
            const a = Math.max(from, rangeFrom);
            const b = Math.min(to, rangeTo);
            if (b >= a) await historyMarkCoverage(type, a, b);
        }
    }

    function scanPlanSummary(plan) {
        const parts = [
            ['wars', 'wars'],
            ['attacks', 'attacks'],
            ['chains', 'chains'],
            ['crimes', 'OCs'],
            ['armory', 'armory']
        ].map(([key, label]) => `${label}: ${cloneMissingRanges(plan?.[key]).length} missing range(s)`);
        return parts.join(' • ');
    }

    async function historyPutRecords(type, rows, idGetter, tsGetter) {
        const factionId = historyFactionId();
        if (!factionId || !Array.isArray(rows) || !rows.length) return;

        // Custom-scan downloads are held in a temporary in-memory overlay. They
        // participate in this scan's calculations but are never written to master.
        if (state.transientHistory) {
            if (!state.transientHistory.records[type]) state.transientHistory.records[type] = new Map();
            const bucket = state.transientHistory.records[type];
            for (const data of rows) {
                const id = String(idGetter(data) ?? '');
                const ts = Math.floor(num(tsGetter(data)));
                if (!id || !ts) continue;
                bucket.set(id, { id, ts, data });
            }
            return;
        }

        const db = await openHistoryDb();
        if (!db) return;
        try {
            const tx = db.transaction('records', 'readwrite');
            const store = tx.objectStore('records');
            for (const data of rows) {
                const id = String(idGetter(data) ?? '');
                const ts = Math.floor(num(tsGetter(data)));
                if (!id || !ts) continue;
                if (type !== 'masterMeta') {
                    const rolling = rollingMasterWindow();
                    if (ts < rolling.from || ts > rolling.to) continue;
                }
                store.put({
                    key: `${factionId}:${type}:${id}`,
                    factionId,
                    type,
                    ts,
                    data
                });
            }
            await idbTransactionDone(tx);
        } catch {
            // Ignore local-cache write failures and keep the live scan usable.
        }
    }

    async function historyGetRecords(type, from, to) {
        const db = await openHistoryDb();
        const factionId = historyFactionId();
        if (!factionId) return [];
        const start = Math.floor(num(from));
        const end = Math.floor(num(to));
        const combined = new Map();
        if (db) {
            try {
                const tx = db.transaction('records', 'readonly');
                const index = tx.objectStore('records').index('byFactionTypeTs');
                const range = IDBKeyRange.bound([factionId, type, start], [factionId, type, end]);
                const rows = await idbRequest(index.getAll(range));
                for (const row of rows || []) combined.set(String(row.key), row.data);
            } catch {
                // Continue with any temporary custom-scan overlay.
            }
        }
        const bucket = state.transientHistory?.records?.[type];
        if (bucket) {
            for (const entry of bucket.values()) {
                if (entry.ts < start || entry.ts > end) continue;
                combined.set(`temp:${type}:${entry.id}`, entry.data);
            }
        }
        let values = [...combined.values()].filter(Boolean);
        if (type === 'attacks') values = values.filter(row => num(row?._schema) === ATTACK_HISTORY_SCHEMA_VERSION);
        return values;
    }

    function historyRecordKey(type, id) {
        return `${historyFactionId()}:${type}:${String(id ?? '')}`;
    }

    async function historyGetRecordById(type, id) {
        const factionId = historyFactionId();
        if (!factionId || id === undefined || id === null || id === '') return null;
        const temp = state.transientHistory?.records?.[type]?.get(String(id));
        if (temp?.data) return temp.data;
        const db = await openHistoryDb();
        if (!db) return null;
        try {
            const tx = db.transaction('records', 'readonly');
            const row = await idbRequest(tx.objectStore('records').get(historyRecordKey(type, id)));
            return row?.data || null;
        } catch {
            return null;
        }
    }

    async function historyCountType(type) {
        const db = await openHistoryDb();
        const factionId = historyFactionId();
        if (!db || !factionId) return 0;
        try {
            const tx = db.transaction('records', 'readonly');
            const index = tx.objectStore('records').index('byFactionTypeTs');
            const range = IDBKeyRange.bound(
                [factionId, type, 0],
                [factionId, type, Number.MAX_SAFE_INTEGER]
            );
            return await idbRequest(index.count(range));
        } catch {
            return 0;
        }
    }

    function coverageSpanText(intervals) {
        const rows = mergeCoverageIntervals(intervals);
        if (!rows.length) return 'None yet';
        const first = rows[0]?.[0];
        const last = rows[rows.length - 1]?.[1];
        return `${dateTime(first)} → ${dateTime(last)}${rows.length > 1 ? ` • ${rows.length} covered ranges` : ''}`;
    }

    async function getMasterCacheStats() {
        const [attacks, wars, warReports, chains, chainReports, crimes, armory, attackCoverage, warCoverage, chainCoverage, crimeCoverage, armoryCoverage, meta] = await Promise.all([
            historyCountType('attacks'),
            historyCountType('wars'),
            historyCountType('warReports'),
            historyCountType('chains'),
            historyCountType('chainReports'),
            historyCountType('crimes'),
            historyCountType('armory'),
            historyGetCoverage('attacks'),
            historyGetCoverage('wars'),
            historyGetCoverage('chains'),
            historyGetCoverage('crimes'),
            historyGetCoverage('armory'),
            historyGetRecordById('masterMeta', 'latest')
        ]);
        return {
            attacks, wars, warReports, chains, chainReports, crimes, armory,
            attackCoverage, warCoverage, chainCoverage, crimeCoverage, armoryCoverage,
            updatedAt: num(meta?.updatedAt),
            completedScans: Math.max(0, num(meta?.completedScans))
        };
    }

    async function touchMasterCache(range, extra = {}) {
        const current = await historyGetRecordById('masterMeta', 'latest');
        const completedScans = Math.max(0, num(current?.completedScans)) + 1;
        const nowSec = Math.floor(Date.now() / 1000);
        await historyPutRecords(
            'masterMeta',
            [{
                id: 'latest',
                ts: nowSec,
                updatedAt: Date.now(),
                completedScans,
                lastRange: {
                    from: Math.floor(num(range?.from)),
                    to: Math.floor(num(range?.to))
                },
                chainsIncluded: Boolean(extra?.chainsIncluded),
                lastScanDurationMs: Math.max(0, num(extra?.scanDurationMs)),
                attackHistorySchemaVersion: ATTACK_HISTORY_SCHEMA_VERSION
            }],
            row => row.id,
            row => row.ts
        );
    }

    async function clearMasterCacheForFaction() {
        const db = await openHistoryDb();
        const factionId = historyFactionId();
        if (!db || !factionId) return;

        async function clearStoreRows(storeName, shouldDelete) {
            const tx = db.transaction(storeName, 'readwrite');
            const store = tx.objectStore(storeName);
            await new Promise((resolve, reject) => {
                const request = store.openCursor();
                request.onerror = () => reject(request.error || new Error(`Could not clear ${storeName}.`));
                request.onsuccess = () => {
                    const cursor = request.result;
                    if (!cursor) return resolve();
                    if (shouldDelete(cursor)) cursor.delete();
                    cursor.continue();
                };
            });
            await idbTransactionDone(tx);
        }

        try {
            await clearStoreRows('records', cursor => Number(cursor.value?.factionId) === factionId);
            await clearStoreRows('coverage', cursor => String(cursor.key || '').startsWith(`${factionId}:`));
        } catch (err) {
            throw new Error(`Could not clear the master data cache: ${err?.message || err}`);
        }

        // v1.7.0 and older kept completed war reports in a separate userscript value.
        // Clear that compatibility copy as well so a deliberate master reset stays a real reset.
        GM_setValue(APP.warReportCacheStorage, '{}');
        GM_setValue(APP.chainReportCacheStorage, '{}');
    }

    async function clearMasterCacheTypeForFaction(type) {
        const db = await openHistoryDb();
        const factionId = historyFactionId();
        if (!db || !factionId || !type) return;
        try {
            const tx = db.transaction('records', 'readwrite');
            const store = tx.objectStore('records');
            await new Promise((resolve, reject) => {
                const request = store.openCursor();
                request.onerror = () => reject(request.error || new Error(`Could not clear ${type} master records.`));
                request.onsuccess = () => {
                    const cursor = request.result;
                    if (!cursor) return resolve();
                    const row = cursor.value || {};
                    if (Number(row.factionId) === factionId && row.type === type) cursor.delete();
                    cursor.continue();
                };
            });
            await idbTransactionDone(tx);

            const covTx = db.transaction('coverage', 'readwrite');
            covTx.objectStore('coverage').delete(historyCoverageKey(type));
            await idbTransactionDone(covTx);
        } catch (err) {
            throw new Error(`Could not refresh the ${type} Master Cache: ${err?.message || err}`);
        }
    }

    async function ensureDetailedAttackHistorySchema() {
        const meta = await historyGetRecordById('masterMeta', 'latest');
        if (num(meta?.attackHistorySchemaVersion) === ATTACK_HISTORY_SCHEMA_VERSION) return false;

        // v1.7.8 and older compacted attacks without Torn's is_ranked_war flag
        // or started timestamp. Those records cannot reproduce RWPH Advanced
        // classification reliably, especially final hits that end after the RW timer.
        await clearMasterCacheTypeForFaction('attacks');
        const nowSec = Math.floor(Date.now() / 1000);
        await historyPutRecords('masterMeta', [{
            ...(meta || {}),
            id: 'latest',
            ts: nowSec,
            updatedAt: Date.now(),
            attackHistorySchemaVersion: ATTACK_HISTORY_SCHEMA_VERSION
        }], row => row.id, row => row.ts);
        return true;
    }


    const MASTER_CACHE_EXPORT_TYPES = ['attacks', 'wars', 'warReports', 'chains', 'chainReports', 'crimes', 'armory'];
    const MASTER_CACHE_COVERAGE_TYPES = ['attacks', 'wars', 'chains', 'crimes', 'armory'];

    async function pruneMasterCacheToRollingWindow() {
        const db = await openHistoryDb();
        const factionId = historyFactionId();
        const rolling = rollingMasterWindow();
        if (!db || !factionId || !rolling.from || !rolling.to) return { deletedRecords:0, clippedCoverage:0, ...rolling };

        let deletedRecords = 0;
        let clippedCoverage = 0;
        try {
            const tx = db.transaction('records', 'readwrite');
            const store = tx.objectStore('records');
            await new Promise((resolve, reject) => {
                const request = store.openCursor();
                request.onerror = () => reject(request.error || new Error('Could not prune master records.'));
                request.onsuccess = () => {
                    const cursor = request.result;
                    if (!cursor) return resolve();
                    const row = cursor.value || {};
                    if (Number(row.factionId) === factionId && row.type !== 'masterMeta') {
                        const ts = Math.floor(num(row.ts));
                        if (!ts || ts < rolling.from || ts > rolling.to) {
                            cursor.delete();
                            deletedRecords += 1;
                        }
                    }
                    cursor.continue();
                };
            });
            await idbTransactionDone(tx);

            const covTx = db.transaction('coverage', 'readwrite');
            const covStore = covTx.objectStore('coverage');
            await new Promise((resolve, reject) => {
                const request = covStore.openCursor();
                request.onerror = () => reject(request.error || new Error('Could not prune master coverage.'));
                request.onsuccess = () => {
                    const cursor = request.result;
                    if (!cursor) return resolve();
                    if (String(cursor.key || '').startsWith(`${factionId}:`)) {
                        const intervals = mergeCoverageIntervals(cursor.value?.intervals || [])
                            .map(([from, to]) => [Math.max(from, rolling.from), Math.min(to, rolling.to)])
                            .filter(([from, to]) => to >= from);
                        if (intervals.length) cursor.update({ ...cursor.value, intervals, updatedAt: Date.now() });
                        else cursor.delete();
                        clippedCoverage += 1;
                    }
                    cursor.continue();
                };
            });
            await idbTransactionDone(covTx);
        } catch (err) {
            throw new Error(`Could not maintain the rolling 12-month Master Data Cache: ${err?.message || err}`);
        }
        return { deletedRecords, clippedCoverage, ...rolling };
    }

    async function historyGetAllRecords(type) {
        return historyGetRecords(type, 0, Number.MAX_SAFE_INTEGER);
    }

    async function exportMasterCacheFile() {
        const factionId = historyFactionId();
        if (!factionId) throw new Error('Faction details are not loaded yet.');
        await pruneMasterCacheToRollingWindow();
        const records = {};
        const coverage = {};
        for (const type of MASTER_CACHE_EXPORT_TYPES) records[type] = await historyGetAllRecords(type);
        for (const type of MASTER_CACHE_COVERAGE_TYPES) coverage[type] = await historyGetCoverage(type);
        const masterMeta = await historyGetRecordById('masterMeta', 'latest');
        const payload = {
            kind: 'FactionHelperMasterCache',
            schemaVersion: 2,
            attackHistorySchemaVersion: ATTACK_HISTORY_SCHEMA_VERSION,
            appVersion: APP.version,
            exportedAt: Date.now(),
            faction: {
                id: factionId,
                name: String(state.faction?.name || '')
            },
            coverage,
            records,
            masterMeta: masterMeta || null
        };
        const factionPart = safeDownloadName(state.faction?.name || `Faction_${factionId}`);
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        downloadTextFile(`Faction_Helper_Master_Cache_${factionPart}_${stamp}.json`, JSON.stringify(payload));
    }

    async function importMasterCacheFile(file) {
        if (!file) return;
        let payload;
        try {
            payload = JSON.parse(await file.text());
        } catch {
            throw new Error('The selected master-cache file is not valid JSON.');
        }
        if (!payload || payload.kind !== 'FactionHelperMasterCache' || ![1, 2].includes(Number(payload.schemaVersion))) {
            throw new Error('This is not a valid Faction Helper Master Data Cache file.');
        }
        const factionId = Number(payload?.faction?.id || 0);
        if (!factionId || factionId !== historyFactionId()) {
            throw new Error(`This master cache belongs to faction ${factionId || 'unknown'}, not faction ${historyFactionId() || 'unknown'}.`);
        }

        const records = payload.records && typeof payload.records === 'object' ? payload.records : {};
        const importedAttackSchemaOk = Number(payload.attackHistorySchemaVersion) === ATTACK_HISTORY_SCHEMA_VERSION;
        const importedAttacks = importedAttackSchemaOk
            ? (Array.isArray(records.attacks) ? records.attacks.filter(row => num(row?._schema) === ATTACK_HISTORY_SCHEMA_VERSION) : [])
            : [];
        const specs = [
            ['attacks', importedAttacks, row => row?.id, row => row?.ended],
            ['wars', records.wars, row => row?.id, row => row?.start],
            ['warReports', records.warReports, row => row?.id, row => row?.ts || row?.start],
            ['chains', records.chains, row => row?.id, row => row?.start],
            ['chainReports', records.chainReports, row => row?.id, row => row?.ts || row?.start],
            ['crimes', records.crimes, row => row?.id, row => row?.executed_at],
            ['armory', records.armory, row => row?.id, row => row?.timestamp]
        ];
        for (const [type, rows, idGetter, tsGetter] of specs) {
            if (!Array.isArray(rows) || !rows.length) continue;
            const existingRows = await historyGetAllRecords(type);
            const existingById = new Map(existingRows.map(row => [String(idGetter(row) ?? ''), row]));
            const toWrite = [];
            for (const row of rows) {
                const id = String(idGetter(row) ?? '');
                if (!id) continue;
                const existing = existingById.get(id);
                if (!existing) {
                    toWrite.push(row);
                    continue;
                }
                // Ranked-war history can be exported while a war is active. Only let an
                // imported row replace a local row when it is demonstrably more complete.
                if (type === 'wars' && num(row?.end) > num(existing?.end)) toWrite.push(row);
            }
            if (toWrite.length) await historyPutRecords(type, toWrite, idGetter, tsGetter);
        }

        const coverage = payload.coverage && typeof payload.coverage === 'object' ? payload.coverage : {};
        for (const type of MASTER_CACHE_COVERAGE_TYPES) {
            // Old master exports do not contain enough detailed attack fields for
            // Advanced/RWPH-equivalent classification. Never import their attack
            // coverage, otherwise the corrected scanner could think the range is complete.
            if (type === 'attacks' && !importedAttackSchemaOk) continue;
            for (const row of mergeCoverageIntervals(coverage[type] || [])) {
                await historyMarkCoverage(type, row[0], row[1]);
            }
        }

        const incomingMeta = payload.masterMeta && typeof payload.masterMeta === 'object' ? payload.masterMeta : null;
        const currentMeta = await historyGetRecordById('masterMeta', 'latest');
        const nowSec = Math.floor(Date.now() / 1000);
        await historyPutRecords('masterMeta', [{
            id: 'latest',
            ts: nowSec,
            updatedAt: Date.now(),
            completedScans: Math.max(num(currentMeta?.completedScans), num(incomingMeta?.completedScans)),
            lastRange: incomingMeta?.lastRange || currentMeta?.lastRange || null,
            chainsIncluded: Boolean(incomingMeta?.chainsIncluded || currentMeta?.chainsIncluded),
            lastScanDurationMs: Math.max(0, num(incomingMeta?.lastScanDurationMs || currentMeta?.lastScanDurationMs)),
            attackHistorySchemaVersion: ATTACK_HISTORY_SCHEMA_VERSION
        }], row => row.id, row => row.ts);
        await pruneMasterCacheToRollingWindow();
    }

    const SUCCESS_RESULTS = new Set(['attacked', 'mugged', 'hospitalized', 'special', 'bounty', 'looted']);
    const FAILURE_RESULTS = new Set(['lost', 'stalemate', 'escape', 'timeout', 'interrupted', 'arrested']);

    const THEME_PRESETS = {
        rwphGold: {
            name:'RWPH Gold',
            body:'#0d0f11',
            surface:'#20252a',
            text:'#f4f5f6',
            outline:'#e9bd4e'
        },
        tornCrimson: {
            name:'Torn Crimson',
            body:'#0d0b0c',
            surface:'#23191c',
            text:'#fff2f4',
            outline:'#e34b5f'
        },
        cyberBlue: {
            name:'Cyber Blue',
            body:'#081018',
            surface:'#172637',
            text:'#eef9ff',
            outline:'#38bdf8'
        },
        emeraldOps: {
            name:'Emerald Ops',
            body:'#08110d',
            surface:'#17281f',
            text:'#eefaf3',
            outline:'#45d483'
        },
        royalViolet: {
            name:'Royal Violet',
            body:'#0e0a14',
            surface:'#241b31',
            text:'#f8f2ff',
            outline:'#a879ff'
        },
        graphiteIce: {
            name:'Graphite Ice',
            body:'#0c1115',
            surface:'#20282f',
            text:'#f1f6f8',
            outline:'#82c7e8'
        },
        ember: {
            name:'Ember',
            body:'#120d09',
            surface:'#2a1e15',
            text:'#fff5ec',
            outline:'#f28a32'
        },
        arcticLight: {
            name:'Arctic Light',
            body:'#e9eef2',
            surface:'#ffffff',
            text:'#1d2a31',
            outline:'#2b8dbd'
        },
        neonRose: {
            name:'Neon Rose',
            body:'#100911',
            surface:'#28162b',
            text:'#fff2fd',
            outline:'#ff5ed8'
        },
        blackout: {
            name:'Blackout',
            body:'#050607',
            surface:'#13161a',
            text:'#f5f7f8',
            outline:'#dfe6eb'
        }
    };

    const THEME_DEFAULTS = {
        body:'#0d0f11',
        surface:'#20252a',
        text:'#f4f5f6',
        outline:'#e9bd4e'
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

    function formatScanDuration(ms) {
        const totalSeconds = Math.max(0, Math.round(num(ms) / 1000));
        const minutes = Math.floor(totalSeconds / 60);
        const seconds = totalSeconds % 60;
        return `${minutes}m ${String(seconds).padStart(2, '0')}s`;
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

    let apiRequestQueue = Promise.resolve();
    let lastApiRequestStartedAt = 0;

    function makeApiError(message, payload = null, status = 0, kind = '') {
        const err = new Error(message);
        err.tornCode = num(payload?.error?.code, 0);
        err.httpStatus = num(status, 0);
        err.kind = kind || '';
        return err;
    }

    function gmJsonRaw(url, key = state.apiKey) {
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
                        reject(makeApiError(`Invalid JSON returned by Torn API (HTTP ${response.status}).`, null, response.status, 'invalid-json'));
                        return;
                    }
                    if (response.status < 200 || response.status >= 300 || data?.error) {
                        reject(makeApiError(apiErrorMessage(data, response.status), data, response.status, 'api'));
                        return;
                    }
                    resolve(data);
                },
                ontimeout: () => reject(makeApiError('Torn API request timed out.', null, 0, 'timeout')),
                onerror: () => reject(makeApiError('Could not reach the Torn API.', null, 0, 'network'))
            });
        });
    }

    function isRateLimitError(err) {
        const msg = String(err?.message || '').toLowerCase();
        return num(err?.tornCode, 0) === 5 || num(err?.httpStatus, 0) === 429 || msg.includes('too many requests') || msg.includes('rate limit');
    }

    function isTransientApiError(err) {
        const code = num(err?.tornCode, 0);
        const status = num(err?.httpStatus, 0);
        return code === 17 || code === 24 || ['timeout','network'].includes(String(err?.kind || '')) || status === 408 || status === 425 || status === 502 || status === 503 || status === 504;
    }

    async function interruptibleApiWait(ms) {
        const end = Date.now() + Math.max(0, num(ms));
        while (Date.now() < end) {
            if (state.scanRunning && state.abortScan) throw new Error('Scan cancelled.');
            await sleep(Math.min(500, Math.max(1, end - Date.now())));
        }
    }

    function showApiBackoff(message) {
        if (!state.scanRunning || !state.scanProgress) return;
        const current = String(state.scanProgress.detail || '').replace(/\s*•\s*Torn API rate limit reached.*$/i, '').trim();
        state.scanProgress = {
            ...state.scanProgress,
            detail: `${current}${current ? ' • ' : ''}${message}`
        };
        if (state.mainPanel && document.getElementById('bftd-fws-main')) renderMain();
    }

    async function runQueuedApiRequest(url, key, minDelayMs = APP.requestDelayMs) {
        let rateRetries = 0;
        let transientRetries = 0;

        while (true) {
            const elapsed = Date.now() - lastApiRequestStartedAt;
            if (elapsed < minDelayMs) {
                await interruptibleApiWait(minDelayMs - elapsed);
            }

            if (state.scanRunning && state.abortScan) throw new Error('Scan cancelled.');
            lastApiRequestStartedAt = Date.now();

            try {
                return await gmJsonRaw(url, key);
            } catch (err) {
                if (isRateLimitError(err) && rateRetries < APP.maxRateLimitRetries) {
                    rateRetries += 1;
                    const waitMs = APP.rateLimitPauseMs;
                    showApiBackoff(`Torn API rate limit reached — pausing ${Math.round(waitMs / 1000)}s, then retrying automatically (${rateRetries}/${APP.maxRateLimitRetries}).`);
                    await interruptibleApiWait(waitMs);
                    continue;
                }

                if (isTransientApiError(err) && transientRetries < APP.maxTransientRetries) {
                    transientRetries += 1;
                    const waitMs = transientRetries * 5000;
                    showApiBackoff(`Temporary Torn API error — waiting ${Math.round(waitMs / 1000)}s before retry ${transientRetries}/${APP.maxTransientRetries}.`);
                    await interruptibleApiWait(waitMs);
                    continue;
                }

                if (isRateLimitError(err)) {
                    throw new Error(`Torn API is still rate-limiting this user after ${APP.maxRateLimitRetries} automatic retries. Other Torn scripts may also be using the same per-user request allowance. Try again after those requests settle.`);
                }
                throw err;
            }
        }
    }

    function gmJson(url, key = state.apiKey) {
        const run = () => runQueuedApiRequest(url, key, APP.requestDelayMs);
        const pending = apiRequestQueue.then(run, run);
        apiRequestQueue = pending.catch(() => undefined);
        return pending;
    }

    function gmJsonWithMinDelay(url, minDelayMs, key = state.apiKey) {
        const delay = Math.max(APP.requestDelayMs, Math.floor(num(minDelayMs, APP.requestDelayMs)));
        const run = () => runQueuedApiRequest(url, key, delay);
        const pending = apiRequestQueue.then(run, run);
        apiRequestQueue = pending.catch(() => undefined);
        return pending;
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
            #bftd-fws-cache {
                width: 540px;
                height: 560px;
                top: 120px;
                left: 80px;
            }
            #bftd-fws-members-panel {
                width: 520px;
                height: 620px;
                top: 105px;
                left: 110px;
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
            .bftd-fws-custom-dates {
                display:grid;
                grid-template-columns:repeat(2,minmax(0,1fr));
                gap:9px;
                margin-top:10px;
            }
            .bftd-fws-date-card {
                position:relative;
                display:block;
                border:2px solid color-mix(in srgb, var(--bftd-accent) 65%, var(--bftd-border));
                background:linear-gradient(180deg, rgba(230,185,74,.10), rgba(0,0,0,.06));
                border-radius:9px;
                padding:9px;
                box-shadow:0 0 0 1px rgba(255,255,255,.025), inset 0 0 18px rgba(230,185,74,.04);
                transition:border-color .15s ease, box-shadow .15s ease, transform .15s ease;
            }
            .bftd-fws-date-card:hover, .bftd-fws-date-card:focus-within {
                border-color:var(--bftd-accent);
                box-shadow:0 0 0 2px rgba(230,185,74,.18), 0 0 18px rgba(230,185,74,.12);
            }
            .bftd-fws-date-label {
                display:flex;
                align-items:center;
                justify-content:space-between;
                gap:8px;
                margin-bottom:7px;
                color:var(--bftd-text);
                font-size:10px;
                font-weight:900;
                letter-spacing:.35px;
            }
            .bftd-fws-date-input-row { display:flex; align-items:center; gap:6px; }
            .bftd-fws-date-input-row .bftd-fws-input {
                height:40px;
                border-color:color-mix(in srgb, var(--bftd-accent) 42%, var(--bftd-border));
                font-weight:700;
                background:#0f1113;
            }
            .bftd-fws-date-input-row .bftd-fws-input:focus {
                border-color:var(--bftd-accent);
                box-shadow:0 0 0 2px rgba(230,185,74,.14);
            }
            .bftd-fws-date-input-row input[type="datetime-local"]::-webkit-calendar-picker-indicator {
                cursor:pointer;
                opacity:1;
                filter:invert(85%) sepia(49%) saturate(591%) hue-rotate(350deg) brightness(101%) contrast(91%);
            }
            .bftd-fws-picker-btn {
                width:42px;
                min-width:42px;
                height:40px;
                border:2px solid var(--bftd-accent);
                border-radius:8px;
                background:#342d1c;
                color:#ffe09a;
                cursor:pointer;
                font-size:19px;
                line-height:1;
                box-shadow:0 0 12px rgba(230,185,74,.12);
            }
            .bftd-fws-picker-btn:hover { background:#443a22; box-shadow:0 0 16px rgba(230,185,74,.22); }
            .bftd-fws-picker-btn:disabled { opacity:.45; cursor:not-allowed; box-shadow:none; }
            .bftd-fws-periods { display:grid; grid-template-columns: repeat(6,1fr); gap:6px; }
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
            .bftd-fws-warning { color:#f6d77d; border:1px solid #6b592d; background:#2a2417; padding:9px; border-radius:7px; font-size:11px; line-height:1.45; }
            .bftd-fws-progress {
                height:7px; border-radius:999px; overflow:hidden; background:#111315; border:1px solid #30343a; margin-top:8px;
            }
            .bftd-fws-progress > div {
                height:100%; width:35%; background:linear-gradient(90deg,#806a2b,#e6b94a,#806a2b);
                animation:bftdFwsSlide 1.1s linear infinite;
            }
            @keyframes bftdFwsSlide { from{ transform:translateX(-100%);} to{transform:translateX(300%);} }
            @media (max-width: 700px) {
                .bftd-fws-custom-dates { grid-template-columns:1fr; }
                #bftd-fws-main, #bftd-fws-stats, #bftd-fws-cache, #bftd-fws-members-panel {
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
            const oldCustom = parsed?.theme?.custom || {};
            const migratedCustom = {
                ...(oldCustom.body ? {body:oldCustom.body} : {}),
                ...(oldCustom.surface ? {surface:oldCustom.surface} : {}),
                ...(oldCustom.text ? {text:oldCustom.text} : {}),
                ...(oldCustom.outline ? {outline:oldCustom.outline} : {})
            };

            if (!Object.keys(migratedCustom).length && Object.keys(oldCustom).length) {
                if (oldCustom.bg || oldCustom.input) migratedCustom.body = oldCustom.bg || oldCustom.input;
                if (oldCustom.panel2 || oldCustom.panel || oldCustom.header) migratedCustom.surface = oldCustom.panel2 || oldCustom.panel || oldCustom.header;
                if (oldCustom.text || oldCustom.muted) migratedCustom.text = oldCustom.text || oldCustom.muted;
                if (oldCustom.border || oldCustom.accent) migratedCustom.outline = oldCustom.border || oldCustom.accent;
            }

            return {
                theme: {
                    preset: parsed?.theme?.preset || 'rwphGold',
                    custom: migratedCustom
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

        const body = t.body;
        const surface = t.surface;
        const text = t.text;
        const outline = t.outline;

        const vars = {
            '--bftd-bg': body,
            '--bftd-panel': surface,
            '--bftd-panel2': surface,
            '--bftd-header': surface,
            '--bftd-input': body,
            '--bftd-member': surface,
            '--bftd-stat': surface,
            '--bftd-table-header': surface,

            '--bftd-primary-btn': surface,
            '--bftd-primary-btn-text': text,
            '--bftd-secondary-btn': surface,
            '--bftd-secondary-btn-text': text,
            '--bftd-danger-btn': surface,
            '--bftd-danger-btn-text': text,

            '--bftd-badge': surface,
            '--bftd-progress-track': body,
            '--bftd-progress-bar': outline,
            '--bftd-disabled': surface,
            '--bftd-disabled-text': text,

            '--bftd-text': text,
            '--bftd-muted': text,
            '--bftd-accent': outline,
            '--bftd-border': outline,

            '--bftd-good': outline,
            '--bftd-bad': outline,
            '--bftd-info': outline,

            '--bftd-error-bg': surface,
            '--bftd-error-text': text,
            '--bftd-success-bg': surface,
            '--bftd-success-text': text,

            '--bftd-scrollbar-track': body,
            '--bftd-scrollbar-thumb': outline,

            '--bftd-launcher-bg': surface,
            '--bftd-launcher-border': outline,
            '--bftd-launcher-icon-bg': surface,
            '--bftd-launcher-icon-stroke': outline,
            '--bftd-launcher-text': text
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
            #bftd-fws-members-panel {
                width:min(560px,calc(100vw - 40px));
                height:min(660px,calc(100vh - 70px));
                top:90px;
                left:70px;
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

            .bftd-fws-periods { grid-template-columns:repeat(6,minmax(0,1fr)) !important; }
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
            .bftd-fws-member-meta,.bftd-fws-note,.bftd-fws-error,.bftd-fws-ok,.bftd-fws-warning { overflow-wrap:anywhere; }

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
            .bftd-fws-warning { background:color-mix(in srgb,var(--bftd-accent) 10%,var(--bftd-panel2)) !important; color:color-mix(in srgb,var(--bftd-accent) 82%,var(--bftd-text) 18%) !important; border-color:color-mix(in srgb,var(--bftd-accent) 55%,var(--bftd-border)) !important; }
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


            /* v1.4.6 simplified four-colour theme mapping */
            .bftd-fws-panel {
                background:var(--bftd-panel) !important;
                border-color:var(--bftd-border) !important;
            }
            .bftd-fws-body {
                background:var(--bftd-bg) !important;
                color:var(--bftd-text) !important;
            }
            .bftd-fws-head,
            .bftd-fws-card,
            .bftd-fws-member,
            .bftd-fws-stat,
            .bftd-fws-table th,
            .bftd-fws-theme-pop,
            .bftd-fws-btn,
            .bftd-fws-btn.secondary,
            .bftd-fws-btn.danger,
            .bftd-fws-badge,
            .bftd-fws-ok,
            .bftd-fws-error {
                background:var(--bftd-panel2) !important;
                color:var(--bftd-text) !important;
                border-color:var(--bftd-border) !important;
            }
            .bftd-fws-input,
            .bftd-fws-select,
            .bftd-fws-period,
            .bftd-fws-progress {
                background:var(--bftd-bg) !important;
                color:var(--bftd-text) !important;
                border-color:var(--bftd-border) !important;
            }
            .bftd-fws-period.active {
                background:var(--bftd-panel2) !important;
                color:var(--bftd-text) !important;
                border-color:var(--bftd-border) !important;
                box-shadow:none !important;
            }
            .bftd-fws-note,
            .bftd-fws-sub,
            .bftd-fws-member-meta,
            .bftd-fws-stat .k,
            .bftd-fws-table th,
            .bftd-fws-theme-field label {
                color:var(--bftd-text) !important;
            }
            .bftd-fws-stat .v,
            .bftd-fws-member-name,
            .bftd-fws-head strong,
            .bftd-fws-table td {
                color:var(--bftd-text) !important;
            }
            .bftd-fws-badge.good,
            .bftd-fws-badge.bad,
            .bftd-fws-badge.info {
                color:var(--bftd-text) !important;
                border-color:var(--bftd-border) !important;
            }
            .bftd-fws-progress > div {
                background:var(--bftd-border) !important;
            }
            .bftd-fws-resize::before,
            .bftd-fws-resize::after {
                background:var(--bftd-border) !important;
            }
            .bftd-fws-body::-webkit-scrollbar-track,
            .bftd-fws-theme-pop::-webkit-scrollbar-track {
                background:var(--bftd-bg) !important;
            }
            .bftd-fws-body::-webkit-scrollbar-thumb,
            .bftd-fws-theme-pop::-webkit-scrollbar-thumb {
                background:var(--bftd-border) !important;
            }

            @media (max-width:700px) {
                .bftd-fws-panel {
                    min-width:280px !important;
                    min-height:220px !important;
                    max-width:calc(100vw - 6px) !important;
                    max-height:calc(100vh - 6px) !important;
                }
                #bftd-fws-main,#bftd-fws-stats,#bftd-fws-members-panel,#bftd-fws-cache {
                    width:calc(100vw - 16px);
                    height:calc(100vh - 28px);
                    top:8px;
                    left:8px;
                    right:auto;
                }
                .bftd-fws-grid { grid-template-columns:repeat(auto-fit,minmax(112px,1fr)) !important; }
                .bftd-fws-periods { grid-template-columns:repeat(3,minmax(0,1fr)) !important; }
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
                <div class="bftd-fws-theme-field">
                    <label>BODY / SCROLL / INPUTS / SELECTS</label>
                    <input class="bftd-fws-color" data-theme-colour="body" type="color" value="${esc(active.body)}">
                </div>

                <div class="bftd-fws-theme-field">
                    <label>CARDS / MEMBER ROWS / TITLE BAR</label>
                    <input class="bftd-fws-color" data-theme-colour="surface" type="color" value="${esc(active.surface)}">
                </div>

                <div class="bftd-fws-theme-field">
                    <label>ALL TEXT</label>
                    <input class="bftd-fws-color" data-theme-colour="text" type="color" value="${esc(active.text)}">
                </div>

                <div class="bftd-fws-theme-field">
                    <label>ALL OUTLINES / BORDERS</label>
                    <input class="bftd-fws-color" data-theme-colour="outline" type="color" value="${esc(active.outline)}">
                </div>
            </div>

            <div class="bftd-fws-note" style="margin-top:9px">
                These four colours control the entire Faction Helper interface.
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
            next.theme={preset:'rwphGold',custom:{}};
            saveUiState(next);
            applyTheme();
            buildThemePopover(panel);
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

    function localDateTimeInputValue(dateOrTs) {
        const d = dateOrTs instanceof Date ? new Date(dateOrTs.getTime()) : new Date(Number(dateOrTs));
        if (!Number.isFinite(d.getTime())) return '';
        const pad = n => String(n).padStart(2, '0');
        return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
    }

    function parseLocalDateTimeInput(value) {
        const text = String(value || '').trim();
        if (!text) return null;
        const match = text.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/);
        if (!match) return null;
        const [, y, mo, da, h, mi, se] = match;
        const d = new Date(Number(y), Number(mo) - 1, Number(da), Number(h), Number(mi), Number(se || 0), 0);
        if (!Number.isFinite(d.getTime())) return null;
        if (d.getFullYear() !== Number(y) || d.getMonth() !== Number(mo) - 1 || d.getDate() !== Number(da)
            || d.getHours() !== Number(h) || d.getMinutes() !== Number(mi)) return null;
        return d;
    }

    function addCalendarMonthsClamped(date, months) {
        const source = new Date(date.getTime());
        const day = source.getDate();
        const result = new Date(source.getTime());
        result.setDate(1);
        result.setMonth(result.getMonth() + Number(months || 0));
        const lastDay = new Date(result.getFullYear(), result.getMonth() + 1, 0).getDate();
        result.setDate(Math.min(day, lastDay));
        return result;
    }


    function rollingMasterWindow(nowValue = null) {
        const effectiveNow = nowValue ?? (state.masterWindowAnchorTo ? state.masterWindowAnchorTo * 1000 : Date.now());
        const end = effectiveNow instanceof Date ? new Date(effectiveNow.getTime()) : new Date(effectiveNow);
        if (!Number.isFinite(end.getTime())) return { start:null, end:null, from:0, to:0 };
        end.setMilliseconds(0);
        const start = addCalendarMonthsClamped(end, -12);
        return {
            start,
            end,
            from: Math.floor(start.getTime() / 1000),
            to: Math.floor(end.getTime() / 1000)
        };
    }

    function clampPresetMonths(value) {
        return Math.max(1, Math.min(12, Math.floor(num(value, 1))));
    }

    function inferPresetMonths(range) {
        const from = Math.floor(num(range?.from));
        const to = Math.floor(num(range?.to));
        if (!from || !to || to <= from) return clampPresetMonths(state.selectedMonths || 6);
        const end = new Date(to * 1000);
        let bestMonth = 1;
        let bestDiff = Number.POSITIVE_INFINITY;
        for (let month = 1; month <= 12; month += 1) {
            const expected = Math.floor(addCalendarMonthsClamped(end, -month).getTime() / 1000);
            const diff = Math.abs(expected - from);
            if (diff < bestDiff) {
                bestDiff = diff;
                bestMonth = month;
            }
        }
        return bestMonth;
    }

    function customRangeValidation() {
        const start = parseLocalDateTimeInput(state.customStart);
        const end = parseLocalDateTimeInput(state.customEnd);
        const customMode = state.selectedPreset === 'custom';
        if (!start || !end) return { valid:false, message:customMode ? 'Choose both a Custom Scan start and end date/time.' : 'Choose a 1-12 month preset.' };
        if (end.getTime() <= start.getTime()) return { valid:false, message:'The scan start must be before the scan end.' };
        const now = new Date();
        now.setMilliseconds(0);
        if (end.getTime() > now.getTime() + 5000) return { valid:false, message:'The scan end cannot be later than the current date/time.' };

        if (customMode) {
            const earliestForEnd = addCalendarMonthsClamped(end, -60);
            if (start.getTime() < earliestForEnd.getTime() - 1000) {
                return { valid:false, message:'Custom Scans are limited to a maximum of 60 calendar months (5 years).' };
            }
            return { valid:true, start, end, custom:true };
        }

        const rolling = rollingMasterWindow(Date.now());
        const earliestForEnd = addCalendarMonthsClamped(end, -12);
        if (start.getTime() < earliestForEnd.getTime() - 1000) {
            return { valid:false, message:'Rolling scans are limited to a maximum of 12 calendar months.' };
        }
        return { valid:true, start, end, rolling, custom:false };
    }

    function ensureScanRangeInitialized() {
        if (parseLocalDateTimeInput(state.customStart) && parseLocalDateTimeInput(state.customEnd)) return;
        applyQuickRange(state.selectedMonths || 6);
    }

    function applyQuickRange(months) {
        months = clampPresetMonths(months);
        const end = new Date();
        end.setMilliseconds(0);
        const start = addCalendarMonthsClamped(end, -months);
        state.selectedMonths = months;
        state.customStart = localDateTimeInputValue(start);
        state.customEnd = localDateTimeInputValue(end);
        state.selectedPreset = 'rolling';
    }

    function activateCustomRange() {
        ensureScanRangeInitialized();
        state.selectedPreset = 'custom';
    }

    function getPresetRange() {
        ensureScanRangeInitialized();
        const validation = customRangeValidation();
        const customMode = state.selectedPreset === 'custom';
        if (!validation.valid) {
            return { code:customMode ? 'custom' : 'rolling', label:customMode ? 'Custom Scan' : 'Selected time period', from:0, to:0, valid:false, validationMessage:validation.message, custom:customMode };
        }
        return {
            code:customMode ? 'custom' : 'rolling',
            label:customMode ? 'Custom Scan' : `Last ${clampPresetMonths(state.selectedMonths)} month${clampPresetMonths(state.selectedMonths) === 1 ? '' : 's'}`,
            from: Math.floor(validation.start.getTime() / 1000),
            to: Math.floor(validation.end.getTime() / 1000),
            valid:true,
            custom:customMode
        };
    }

    function createTransientHistory(range) {
        return {
            range: { from: Math.floor(num(range?.from)), to: Math.floor(num(range?.to)) },
            records: {},
            coverage: {}
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

    function directFactionDays(member) {
        const candidates = [
            member?.days_in_faction,
            member?.faction_days,
            member?.daysInFaction,
            member?.faction?.days_in_faction,
            member?.faction?.days
        ];
        for (const value of candidates) {
            const days = Number(value);
            if (Number.isFinite(days) && days >= 0) return Math.floor(days);
        }
        return null;
    }

    function explicitFactionJoinTimestamp(member) {
        const candidates = [
            member?.joined,
            member?.joined_at,
            member?.joined_timestamp,
            member?.faction_joined,
            member?.faction_joined_at,
            member?.faction?.joined,
            member?.faction?.joined_at
        ];
        for (const value of candidates) {
            let ts = Number(value);
            if (!Number.isFinite(ts) || ts <= 0) continue;
            if (ts > 100000000000) ts = Math.floor(ts / 1000);
            if (ts > 946684800) return Math.floor(ts);
        }
        return 0;
    }

    function memberFactionTenure(member, range, generatedAt = Date.now()) {
        const referenceTs = Math.floor(num(generatedAt, Date.now()) / 1000);
        let days = directFactionDays(member);
        let joinedTs = explicitFactionJoinTimestamp(member);
        let estimated = false;

        if (!joinedTs && days !== null) {
            joinedTs = Math.max(0, referenceTs - (days * 86400));
            estimated = true;
        }
        if (days === null && joinedTs) {
            days = Math.max(0, Math.floor((referenceTs - joinedTs) / 86400));
        }

        const joinedDuringPeriod = joinedTs
            ? joinedTs >= num(range?.from) && joinedTs <= num(range?.to)
            : null;

        return { days, joinedTs, estimated, joinedDuringPeriod };
    }

    function memberWarsInFaction(tenure, wars, referenceTs = Math.floor(Date.now() / 1000)) {
        if (!tenure?.joinedTs || !Array.isArray(wars)) return null;
        const joinedTs = num(tenure.joinedTs, 0);
        const nowTs = num(referenceTs, Math.floor(Date.now() / 1000));
        if (!joinedTs) return null;

        return wars.filter(war => {
            const start = num(war?.start, 0);
            if (!start) return false;
            const end = num(war?.end, 0) || nowTs;
            return joinedTs <= end;
        }).length;
    }

    function cloneMembersSnapshot(members = state.members) {
        try {
            return JSON.parse(JSON.stringify(Array.isArray(members) ? members : []));
        } catch {
            return [];
        }
    }

    function normalizeMembers(payload) {
        if (Array.isArray(payload?.members)) return payload.members;
        if (payload?.members && typeof payload.members === 'object') {
            return Object.entries(payload.members).map(([id, value]) => ({ id: Number(id), ...value }));
        }
        return [];
    }


    function normalizeActionText(value) {
        return String(value || '')
            .replace(/\u00a0/g, ' ')
            .replace(/\s+/g, ' ')
            .trim()
            .toLowerCase();
    }

    function directVisibleText(el) {
        if (!el) return '';
        const text = [...el.childNodes]
            .filter(node => node.nodeType === Node.TEXT_NODE)
            .map(node => node.nodeValue || '')
            .join(' ');
        return normalizeActionText(text);
    }

    function isVisibleFactionActionPart(el) {
        if (!el?.isConnected || el.closest('.bftd-fws-panel')) return false;
        if (el.offsetParent === null) return false;
        const r = el.getBoundingClientRect?.();
        return !!r && r.width > 3 && r.height > 3;
    }

    function matchesKnownFactionAction(text, type) {
        const t = normalizeActionText(text);
        if (type === 'warfare') return t === 'faction warfare';
        if (type === 'forum') return t === 'forum';
        if (type === 'leave') return t === 'leave faction';
        return false;
    }

    function findExactFactionActionLabel(type) {
        const selectors = 'a,button,[role="button"],span,div,li,p,strong,b';
        const all = [...document.querySelectorAll(selectors)];

        // Prefer the smallest visible element whose direct text is the exact Torn label.
        const direct = all.find(el =>
            isVisibleFactionActionPart(el) &&
            matchesKnownFactionAction(directVisibleText(el), type)
        );
        if (direct) return direct;

        // Accept an exact full-text match only; no partial/fuzzy/fallback matching.
        return all.find(el =>
            isVisibleFactionActionPart(el) &&
            matchesKnownFactionAction(el.textContent, type) &&
            [...el.children].every(child => !matchesKnownFactionAction(child.textContent, type))
        ) || null;
    }

    function closestNativeClickable(el) {
        if (!el) return null;
        return el.closest('a,button,[role="button"]');
    }

    function findActionItemRoot(clickable) {
        if (!clickable) return null;

        // Walk only a short distance upward. We want the individual native action item,
        // never a large generic faction/header container.
        let cur = clickable;
        for (let i = 0; i < 4 && cur?.parentElement; i += 1) {
            const parent = cur.parentElement;
            const clickableChildren = [...parent.children].filter(child =>
                child.matches?.('a,button,[role="button"]') ||
                child.querySelector?.('a,button,[role="button"]')
            );

            if (clickableChildren.length >= 2) return cur;
            cur = parent;
        }

        return clickable;
    }

    function directChildWithin(row, node) {
        if (!row || !node || !row.contains(node)) return null;
        let cur = node;
        while (cur.parentElement && cur.parentElement !== row) cur = cur.parentElement;
        return cur.parentElement === row ? cur : null;
    }

    function nearestSharedActionRow(items) {
        const valid = items.filter(Boolean);
        if (valid.length < 2) return null;

        let cur = valid[0].parentElement;
        let depth = 0;

        while (cur && cur !== document.body && depth < 8) {
            const contained = valid.filter(item => cur.contains(item));
            if (contained.length >= 2) {
                const directItems = valid
                    .map(item => directChildWithin(cur, item))
                    .filter(Boolean);

                // Strict validation: at least two known Torn action items must become
                // separate direct children in the same compact container.
                if (new Set(directItems).size >= 2 && cur.children.length <= 12) {
                    return cur;
                }
            }
            cur = cur.parentElement;
            depth += 1;
        }

        return null;
    }

    function findStrictFactionActionRow() {
        const labels = {
            warfare: findExactFactionActionLabel('warfare'),
            forum: findExactFactionActionLabel('forum'),
            leave: findExactFactionActionLabel('leave')
        };

        const clickables = {
            warfare: closestNativeClickable(labels.warfare),
            forum: closestNativeClickable(labels.forum),
            leave: closestNativeClickable(labels.leave)
        };

        const items = {
            warfare: findActionItemRoot(clickables.warfare),
            forum: findActionItemRoot(clickables.forum),
            leave: findActionItemRoot(clickables.leave)
        };

        const confirmedTypes = Object.keys(items).filter(key => items[key]);
        if (confirmedTypes.length < 2) {
            return { row:null, labels, clickables, items };
        }

        const row = nearestSharedActionRow(Object.values(items));
        if (!row) return { row:null, labels, clickables, items };

        // Final strict check: the row must actually contain at least two exact known labels.
        const confirmedInside = confirmedTypes.filter(type => row.contains(labels[type]));
        if (confirmedInside.length < 2) {
            return { row:null, labels, clickables, items };
        }

        return { row, labels, clickables, items };
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

    function findExactLabelInside(root, originalText) {
        if (!root) return null;
        const wanted = normalizeActionText(originalText);
        const all = [root, ...root.querySelectorAll('span,div,p,strong,b,a,button')];

        return all.find(el => directVisibleText(el) === wanted)
            || all.find(el => normalizeActionText(el.textContent) === wanted)
            || null;
    }

    function createStrictFactionHelperAction(row, found) {
        // Strict template priority only from confirmed native actions in this exact row.
        const templateType = ['forum', 'warfare', 'leave'].find(type =>
            found.items[type] && row.contains(found.items[type])
        );
        if (!templateType) return null;

        const sourceItem = directChildWithin(row, found.items[templateType]);
        if (!sourceItem) return null;

        const sourceLabel = found.labels[templateType];
        const sourceClickable = found.clickables[templateType];
        if (!sourceLabel || !sourceClickable) return null;

        const clone = sourceItem.cloneNode(true);
        sanitizeNativeClone(clone);
        clone.id = 'bftd-fh-action-item';

        const originalLabelText = normalizeActionText(sourceLabel.textContent);
        const clonedLabel = findExactLabelInside(clone, originalLabelText);
        if (!clonedLabel) return null;

        // Change only the visible native label so the Torn styling/layout remains intact.
        clonedLabel.textContent = 'Faction Helper';

        let clonedClickable = null;
        if (sourceItem === sourceClickable && clone.matches?.('a,button,[role="button"]')) {
            clonedClickable = clone;
        } else {
            clonedClickable = clone.querySelector('a,button,[role="button"]');
        }
        if (!clonedClickable) return null;

        clonedClickable.id = 'bftd-fh-action-button';
        clonedClickable.setAttribute('aria-label', 'Faction Helper');
        clonedClickable.setAttribute('title', `Faction Helper v${APP.version}`);

        if (clonedClickable.tagName === 'A') {
            clonedClickable.setAttribute('href', '#');
        } else if (clonedClickable.tagName === 'BUTTON') {
            clonedClickable.type = 'button';
        }

        clonedClickable.addEventListener('click', ev => {
            ev.preventDefault();
            ev.stopPropagation();
            openMain();
        });

        return clone;
    }

    function insertStrictFactionHelperAction(row, found, item) {
        if (!row || !item) return false;

        const forumItem = found.items.forum ? directChildWithin(row, found.items.forum) : null;
        const leaveItem = found.items.leave ? directChildWithin(row, found.items.leave) : null;
        const warfareItem = found.items.warfare ? directChildWithin(row, found.items.warfare) : null;

        // NO FALLBACKS:
        // Only these exact, native insertion anchors are allowed.
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

        return false;
    }

    function cleanupLegacyLaunchers() {
        document.querySelector('#bftd-fws-launcher')?.remove();
        document.querySelector('#bftd-fh-launcher-slot')?.remove();
    }

    function getAllFactionHelperActionItems() {
        return [...document.querySelectorAll('#bftd-fh-action-item,[data-bftd-fh-action-item="1"]')];
    }

    function dedupeFactionHelperActions(preferredRow = null) {
        const all = getAllFactionHelperActionItems();
        if (!all.length) return null;

        let keep = null;

        // Prefer the single instance already living in the currently verified Torn row.
        if (preferredRow) {
            keep = all.find(item => item.isConnected && item.parentElement === preferredRow) || null;
        }

        // If there is no verified row yet, keep the first connected instance temporarily.
        if (!keep) {
            keep = all.find(item => item.isConnected) || null;
        }

        for (const item of all) {
            if (item !== keep) item.remove();
        }

        return keep;
    }

    function syncLauncher() {
        cleanupLegacyLaunchers();

        const found = findStrictFactionActionRow();

        // First remove any duplicate instances Torn may have copied while rebuilding.
        let existing = dedupeFactionHelperActions(found.row || null);

        // NO FALLBACK: if the exact native Torn action section cannot be verified,
        // Faction Helper does not render a launcher anywhere else.
        if (!found.row) {
            getAllFactionHelperActionItems().forEach(item => item.remove());
            state.launcher = null;
            state.factionActionRow = null;
            state.factionActionTemplate = null;
            return;
        }

        const row = found.row;
        state.factionActionRow = row;

        // If the surviving instance is already in the correct verified row, keep it.
        // Remove any late duplicate that may have appeared after the first dedupe pass.
        if (existing?.isConnected && existing.parentElement === row) {
            existing.id = 'bftd-fh-action-item';
            existing.setAttribute('data-bftd-fh-action-item', '1');

            for (const item of getAllFactionHelperActionItems()) {
                if (item !== existing) item.remove();
            }

            state.launcher = existing;
            return;
        }

        // Any surviving instance in an old/replaced row must be removed before creating
        // the one and only valid instance.
        getAllFactionHelperActionItems().forEach(item => item.remove());

        const item = createStrictFactionHelperAction(row, found);
        if (!item) {
            state.launcher = null;
            return;
        }

        item.id = 'bftd-fh-action-item';
        item.setAttribute('data-bftd-fh-action-item', '1');

        if (!insertStrictFactionHelperAction(row, found, item)) {
            item.remove();
            state.launcher = null;
            return;
        }

        // Final hard single-instance enforcement after insertion.
        for (const duplicate of getAllFactionHelperActionItems()) {
            if (duplicate !== item) duplicate.remove();
        }

        state.launcher = item;
    }

    function buildLauncher() {
        syncLauncher();

        if (!state.launcherObserver && document.body) {
            let debounce = null;
            state.launcherObserver = new MutationObserver(() => {
                clearTimeout(debounce);
                debounce = setTimeout(syncLauncher, 200);
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
                    Your key must allow faction <b>basic</b>, <b>members</b>, <b>rankedwars</b>, <b>rankedwarreport</b>, <b>crimes</b> and <b>news</b>, plus user <b>personalstats</b> for Xanax history. <b>faction/attacks</b> is only required when Detailed War Data is enabled. <b>chains</b> and <b>chainreport</b> are only required when the Include Chains option is enabled.
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
                    <b>faction/basic</b>, <b>faction/members</b>, <b>faction/rankedwars</b>, <b>faction/rankedwarreport</b>, <b>faction/crimes</b>, <b>faction/news</b> and <b>user/personalstats</b>. <b>faction/attacks</b> is additionally required only when Detailed War Data is enabled. <b>faction/chains</b> and <b>faction/chainreport</b> are additionally required only when Include Chains is enabled.
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
                await gmJson(apiUrl('/faction/rankedwars', { limit: 1 }));
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
        try {
            await pruneMasterCacheToRollingWindow();
        } catch {
            // Master-cache maintenance must never prevent the helper from opening.
        }
    }

    function safeDownloadName(value, fallback = 'faction-helper') {
        const cleaned = String(value || '')
            .replace(/[\\/:*?\"<>|]+/g, '-')
            .replace(/\s+/g, '_')
            .replace(/_+/g, '_')
            .replace(/^[-_.]+|[-_.]+$/g, '')
            .slice(0, 120);
        return cleaned || fallback;
    }

    function downloadTextFile(filename, text, mime = 'application/json;charset=utf-8') {
        const blob = new Blob([text], { type: mime });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        a.style.display = 'none';
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
    }


    function renderMain() {
        const body = state.mainPanel?.querySelector('.bftd-fws-body');
        if (!body) return;

        const accessType = state.keyInfo?.access?.type || 'API key';
        ensureScanRangeInitialized();
        const requestedRange = getPresetRange();
        const customValidation = customRangeValidation();
        const cached = requestedRange.valid !== false ? getCached(requestedRange) : null;
        const scannedRange = cached?.range || null;
        const ready = Boolean(cached?.aggregates && cached?.ocAggregates && cached?.armoryXanaxAggregates && cached?.warSummary);
        const scanLabel = state.scanRunning ? 'SCANNING…' : (state.selectedPreset === 'custom' ? (ready ? 'RESCAN CUSTOM' : 'SCAN CUSTOM') : (ready ? 'RESCAN FACTION' : 'SCAN FACTION'));
        const scanStatus = state.scanRunning
            ? (state.scanProgress?.message || 'Scanning faction data…')
            : ready
                ? `Scan ready • ${cached.warSummary?.warCount || 0} ranked war(s) • ${cached.detailedWarDataIncluded === false ? 'Basic/Fast war data' : 'Detailed war data'} • ${cached.chainSummary ? 'chains included' : 'chains not included'}${cached.scanDurationMs ? ` • completed in ${formatScanDuration(cached.scanDurationMs)}` : ''} • ${new Date(cached.generatedAt).toLocaleString()}${cached.importedAt ? ` • imported ${new Date(cached.importedAt).toLocaleString()}` : ''}`
                : 'No completed scan for this exact Start/End range. Members are locked until the scan finishes.';

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
                <div class="bftd-fws-note" style="margin-bottom:6px">SCAN DATE / TIME RANGE</div>
                <div class="bftd-fws-periods" style="margin-bottom:9px">
                    ${Array.from({length:12}, (_, index) => index + 1).map(months => `
                        <button class="bftd-fws-period ${state.selectedPreset !== 'custom' && clampPresetMonths(state.selectedMonths) === months ? 'active' : ''}" data-quick-months="${months}" ${state.scanRunning ? 'disabled' : ''}>${months}M</button>
                    `).join('')}
                    <button class="bftd-fws-period ${state.selectedPreset === 'custom' ? 'active' : ''}" id="bftd-fws-custom-mode" title="Custom Scan can reuse Master Cache data, but any additional data it downloads is temporary and will NOT be saved into the rolling 12-month Master Cache." ${state.scanRunning ? 'disabled' : ''}>CUSTOM ⚠</button>
                </div>
                ${state.selectedPreset === 'custom' ? `
                    <div class="bftd-fws-warning" style="margin:0 0 8px"><b>⚠ CUSTOM SCAN — DOES NOT UPDATE MASTER DATA:</b> Choose your own Start and End date/time (maximum 60 months / 5 years). Faction Helper will reuse any matching records already present in the rolling 12-month Master Cache, but any missing data downloaded for this Custom Scan is temporary only. It will <b>not</b> be added to, expand, or replace the Master Cache. The completed Custom Scan can still be saved as a quick-reload snapshot.</div>
                ` : `
                    <div class="bftd-fws-note" style="margin:-2px 0 8px">Choose how far back to scan. <b>End Date / Time is always the current local date/time</b>, and Start Date / Time is automatically set exactly 1-12 calendar months earlier. The dates cannot be edited manually.</div>
                `}
                <div class="bftd-fws-custom-dates">
                    <label class="bftd-fws-date-card">
                        <span class="bftd-fws-date-label"><span>START DATE / TIME</span><span>${state.selectedPreset === 'custom' ? '📅' : '🔒'}</span></span>
                        <span class="bftd-fws-date-input-row">
                            <input id="bftd-fws-custom-start" class="bftd-fws-input" type="datetime-local" step="1" value="${esc(state.customStart)}" ${state.selectedPreset === 'custom' ? '' : 'readonly aria-readonly="true" style="pointer-events:none"'}>
                        </span>
                    </label>
                    <label class="bftd-fws-date-card">
                        <span class="bftd-fws-date-label"><span>END DATE / TIME</span><span>${state.selectedPreset === 'custom' ? '📅' : '🕒'}</span></span>
                        <span class="bftd-fws-date-input-row">
                            <input id="bftd-fws-custom-end" class="bftd-fws-input" type="datetime-local" step="1" value="${esc(state.customEnd)}" ${state.selectedPreset === 'custom' ? '' : 'readonly aria-readonly="true" style="pointer-events:none"'}>
                        </span>
                    </label>
                </div>
                <div class="bftd-fws-note" style="margin-top:6px">
                    ${state.selectedPreset === 'custom'
                        ? 'Custom Scans can use any Start/End range up to <b>60 calendar months (5 years)</b>, ending no later than now. They read through the Master Cache but never write new Custom Scan data into it.'
                        : 'Rolling scans are limited to the <b>most recent 12 months</b>. Selecting a preset refreshes End to now and sets Start exactly that many calendar months back. Starting a rolling scan refreshes the range to now again.'}
                </div>
                ${!customValidation.valid && (state.customStart || state.customEnd) ? `<div class="bftd-fws-error" style="margin-top:8px">${esc(customValidation.message)}</div>` : ''}
                <div class="bftd-fws-card" style="margin-top:8px;padding:9px 10px">
                    <label class="bftd-fws-row" style="cursor:${state.scanRunning ? 'default' : 'pointer'};align-items:flex-start">
                        <input id="bftd-fws-detailed-war-data" type="checkbox" ${state.detailedWarData ? 'checked' : ''} ${state.scanRunning ? 'disabled' : ''} style="margin:2px 2px 0 0;transform:scale(1.2);accent-color:var(--bftd-accent)">
                        <span class="bftd-fws-grow">
                            <b>DETAILED WAR DATA</b><br>
                            <span class="bftd-fws-note">${state.detailedWarData ? 'ON — full outgoing attack history is read for assists, outside hits, retals, overseas/group hits and detailed outcomes.' : 'OFF — Basic/Fast war mode uses ranked-war reports only for war-hit totals and skips the attack-history stage.'}</span>
                        </span>
                    </label>
                    <div class="bftd-fws-warning" style="margin-top:8px"><b>⚠ DETAILED WAR DATA MAY ADD TIME:</b> Enabling this option can add extra API pages and may make the scan take longer, especially across larger periods. Leave it unticked for the faster RWPH-style Basic war calculation.</div>
                </div>
                <div class="bftd-fws-card" style="margin-top:8px;padding:9px 10px">
                    <label class="bftd-fws-row" style="cursor:${state.scanRunning ? 'default' : 'pointer'};align-items:flex-start">
                        <input id="bftd-fws-include-chains" type="checkbox" ${state.includeChains ? 'checked' : ''} ${state.scanRunning ? 'disabled' : ''} style="margin:2px 2px 0 0;transform:scale(1.2);accent-color:var(--bftd-accent)">
                        <span class="bftd-fws-grow">
                            <b>INCLUDE CHAINS IN THIS SCAN</b><br>
                            <span class="bftd-fws-note">${state.includeChains ? 'ON — completed chains and accurate per-chain reports will be included.' : 'OFF — chain history/report API calls will be skipped.'}</span>
                        </span>
                    </label>
                    <div class="bftd-fws-warning" style="margin-top:8px"><b>⚠ CHAIN SCANNING CAN ADD A LOT OF TIME:</b> Each uncached completed chain report is loaded one-by-one with a minimum <b>2-second</b> gap. Reports already stored in the Master Data Cache are reused without another chain-report API call.</div>
                </div>
                <div class="bftd-fws-note" style="margin-top:7px">
                    ${state.selectedPreset === 'custom'
                        ? `Custom Scan first reads every matching record already available in the Master Data Cache, then requests only missing coverage/report IDs into a <b>temporary scan overlay</b>. The completed result is built from Master Cache data + that temporary data, but none of the newly downloaded Custom Scan data is written back to Master. Ranked wars are processed first.${state.detailedWarData ? ' Detailed War Data is <b>ON</b>, so missing outgoing attack-history coverage is loaded next.' : ' Detailed War Data is <b>OFF</b>, so the outgoing attack-history stage is skipped and war hits come from ranked-war reports only.'}${state.includeChains ? ' Missing chain reports are fetched accurately one-by-one at the 2-second report pace into the temporary overlay.' : ' Chain scanning is currently <b>OFF</b>.'} Completed OCs and faction-armory Xanax actions follow.`
                        : `The scan first checks the Master Data Cache for the complete selected Start/End range. It loads all cached data inside that period, requests only missing coverage, writes the new records into the Master Cache, then builds the finished scan from the Master Cache across the full period. Ranked wars are processed first.${state.detailedWarData ? ' Detailed War Data is <b>ON</b>, so missing outgoing attack-history coverage is loaded next.' : ' Detailed War Data is <b>OFF</b>, so the outgoing attack-history stage is skipped and war hits come from ranked-war reports only.'}${state.includeChains ? ' Completed chains are then loaded and each missing chain report is fetched accurately one-by-one at the 2-second report pace.' : ' Chain scanning is currently <b>OFF</b>.'} Completed OCs and faction-armory Xanax actions follow.`}
                    Every successful exact range is also saved as a disposable quick-reload snapshot.
                </div>
                <div class="bftd-fws-ok" style="margin-top:8px"><b>ROLLING 12-MONTH MASTER DATA CACHE:</b> Ranked-war history/reports, attacks, completed chain lists/reports, completed OCs and armory logs accumulate in one reusable local browser cache covering only the rolling most recent 12 months. Before every scan, Faction Helper prunes expired data, checks the selected range against the remaining master data, requests only uncovered intervals/report IDs, and then rebuilds the result from the Master Cache. Separate quick-reload snapshots can be deleted without removing master history. <b>Custom Scans may read this cache but never add their downloaded data to it.</b></div>
                <div class="bftd-fws-warning" style="margin-top:8px"><b>⚠ LONGER SCANS TAKE LONGER:</b> The first scan of a large uncached period can still take significantly longer. Once that history is cached locally, overlapping scans should need far fewer Torn API calls.</div>
                <div class="bftd-fws-scanstatus">
                    <div class="bftd-fws-grow bftd-fws-note"><b>${esc(scanStatus)}</b>${scannedRange ? `<br>${esc(dateTime(scannedRange.from))} → ${esc(dateTime(scannedRange.to))}` : ''}</div>
                    <button id="bftd-fws-scan" class="bftd-fws-btn" ${(state.scanRunning || !customValidation.valid) ? 'disabled' : ''}>${esc(scanLabel)}</button>
                </div>
                <div class="bftd-fws-row wrap" style="margin-top:8px">
                    <button id="bftd-fws-cached-scans" class="bftd-fws-btn secondary" ${state.scanRunning ? 'disabled' : ''}>CACHED SCANS</button>
                    <button id="bftd-fws-open-members" class="bftd-fws-btn secondary">MEMBERS</button>
                    <button id="bftd-fws-settings" class="bftd-fws-btn secondary" title="API key settings" ${state.scanRunning ? 'disabled' : ''}>⚙ SETTINGS</button>
                </div>
                ${state.shareMessage ? `<div class="${state.shareMessageType === 'error' ? 'bftd-fws-error' : 'bftd-fws-ok'}" style="margin-top:8px">${esc(state.shareMessage)}</div>` : ''}
                ${state.scanRunning ? `
                    <div class="bftd-fws-progress"><div></div></div>
                    <div class="bftd-fws-note" style="margin-top:6px">
                        ${esc(state.scanProgress?.detail || '')}
                    </div>
                    <button id="bftd-fws-cancel-main-scan" class="bftd-fws-btn danger" style="margin-top:8px">CANCEL SCAN</button>
                ` : ''}
                ${state.scanError ? `<div class="bftd-fws-error" style="margin-top:8px">${esc(state.scanError)}</div>` : ''}
            </div>

        `;

        body.querySelectorAll('[data-quick-months]').forEach(btn => {
            btn.addEventListener('click', () => {
                applyQuickRange(Number(btn.dataset.quickMonths));
                state.currentMember = null;
                document.getElementById('bftd-fws-stats')?.remove();
                state.statsPanel = null;
                state.scanError = '';
                state.shareMessage = '';
                state.shareMessageType = '';
                renderMain();
                if (document.getElementById('bftd-fws-members-panel')) renderMemberList();
            });
        });

        body.querySelector('#bftd-fws-custom-mode')?.addEventListener('click', () => {
            activateCustomRange();
            state.currentMember = null;
            document.getElementById('bftd-fws-stats')?.remove();
            state.statsPanel = null;
            state.scanError = '';
            state.shareMessage = '';
            state.shareMessageType = '';
            renderMain();
        });
        for (const selector of ['#bftd-fws-custom-start', '#bftd-fws-custom-end']) {
            body.querySelector(selector)?.addEventListener('change', event => {
                if (state.selectedPreset !== 'custom') return;
                if (selector.endsWith('start')) state.customStart = event.target.value;
                else state.customEnd = event.target.value;
                state.currentMember = null;
                document.getElementById('bftd-fws-stats')?.remove();
                state.statsPanel = null;
                state.scanError = '';
                state.shareMessage = '';
                state.shareMessageType = '';
                renderMain();
                if (document.getElementById('bftd-fws-members-panel')) renderMemberList();
            });
        }

        body.querySelector('#bftd-fws-scan')?.addEventListener('click', () => runFactionScan(true));
        body.querySelector('#bftd-fws-cancel-main-scan')?.addEventListener('click', () => { state.abortScan = true; });
        body.querySelector('#bftd-fws-detailed-war-data')?.addEventListener('change', event => {
            state.detailedWarData = Boolean(event.target.checked);
            GM_setValue(APP.detailedWarDataStorage, state.detailedWarData);
            state.shareMessage = '';
            state.shareMessageType = '';
            renderMain();
        });
        body.querySelector('#bftd-fws-include-chains')?.addEventListener('change', event => {
            state.includeChains = Boolean(event.target.checked);
            GM_setValue(APP.includeChainsStorage, state.includeChains);
            state.shareMessage = '';
            state.shareMessageType = '';
            renderMain();
        });
        body.querySelector('#bftd-fws-cached-scans')?.addEventListener('click', openCachedScansPanel);
        body.querySelector('#bftd-fws-open-members')?.addEventListener('click', openMemberListPanel);
        body.querySelector('#bftd-fws-settings')?.addEventListener('click', () => renderApiSetup());
    }

    function openCachedScansPanel() {
        const existing = document.getElementById('bftd-fws-cache');
        if (existing) {
            state.cachedPanel = existing;
            renderCachedScansPanel();
            bringPanelFront(existing);
            return;
        }
        state.cachedPanel = panelShell('bftd-fws-cache', 'Cached Scans', 'Quick reload + master history');
        renderCachedScansPanel();
    }

    async function renderCachedScansPanel() {
        const panel = document.getElementById('bftd-fws-cache');
        const body = panel?.querySelector('.bftd-fws-body');
        if (!body) return;
        await pruneMasterCacheToRollingWindow();
        const scans = getLocalCachedScans();
        body.innerHTML = '<div class="bftd-fws-note">Loading local cache information…</div>';

        const master = await getMasterCacheStats();
        if (!body.isConnected) return;
        const masterUpdated = master.updatedAt ? new Date(master.updatedAt).toLocaleString() : 'Never';
        const masterTotal = master.attacks + master.wars + master.warReports + master.chains + master.chainReports + master.crimes + master.armory;

        body.innerHTML = `
            <div class="bftd-fws-card">
                <div class="bftd-fws-row" style="align-items:flex-start">
                    <div class="bftd-fws-grow">
                        <div style="font-weight:800">ROLLING 12-MONTH MASTER DATA CACHE</div>
                        <div class="bftd-fws-note" style="margin-top:4px">This is the rolling reusable faction-history cache. It keeps only the most recent 12 calendar months. Each new scan reuses everything still inside that window, adds only missing newer data, and automatically removes records that have rolled past the 12-month cutoff. Deleting a quick scan below does not remove this master data.</div>
                    </div>
                    <div class="bftd-fws-row wrap" style="justify-content:flex-end">
                        <button class="bftd-fws-btn secondary" id="bftd-fws-download-master-cache" ${masterTotal ? '' : 'disabled'}>DOWNLOAD MASTER</button>
                        <button class="bftd-fws-btn secondary" id="bftd-fws-upload-master-cache">UPLOAD MASTER</button>
                        <button class="bftd-fws-btn danger" id="bftd-fws-clear-master-cache" ${masterTotal ? '' : 'disabled'}>CLEAR DATA</button>
                        <input id="bftd-fws-upload-master-file" type="file" accept=".json,application/json" hidden>
                    </div>
                </div>
                <div class="bftd-fws-note" style="margin-top:8px">
                    ${fmt(master.attacks)} attack(s) • ${fmt(master.wars)} war(s) • ${fmt(master.warReports)} war report(s) • ${fmt(master.chains)} chain(s) • ${fmt(master.chainReports)} chain report(s) • ${fmt(master.crimes)} OC(s) • ${fmt(master.armory)} armory record(s)<br>
                    Attack coverage: ${esc(coverageSpanText(master.attackCoverage))}<br>
                    War coverage: ${esc(coverageSpanText(master.warCoverage))}<br>
                    Chain coverage: ${esc(coverageSpanText(master.chainCoverage))}<br>
                    OC coverage: ${esc(coverageSpanText(master.crimeCoverage))}<br>
                    Armory coverage: ${esc(coverageSpanText(master.armoryCoverage))}<br>
                    Last master update: ${esc(masterUpdated)}
                </div>
            </div>
            <div class="bftd-fws-card">
                <div style="font-weight:800">QUICK-RELOAD SCANS</div>
                <div class="bftd-fws-note" style="margin-top:4px">Every successfully completed exact range is saved here for instant reload. These are disposable result snapshots: DELETE removes only that quick scan, while the Master Data Cache above remains available for future calculations.</div>
            </div>
            ${scans.length ? scans.map((row, index) => {
                const range = row.range || {};
                const generated = row.generatedAt ? new Date(row.generatedAt).toLocaleString() : 'Unknown';
                const duration = row.scanDurationMs ? formatScanDuration(row.scanDurationMs) : '—';
                const chains = row.chainSummary || row.chainsIncluded ? 'Included' : 'Not included';
                return `
                    <div class="bftd-fws-card">
                        <div class="bftd-fws-row" style="align-items:flex-start">
                            <div class="bftd-fws-grow">
                                <div style="font-weight:800">${esc(dateTime(range.from))}</div>
                                <div class="bftd-fws-note">to ${esc(dateTime(range.to))}</div>
                            </div>
                            <button class="bftd-fws-btn" data-load-cache="${index}">LOAD</button>
                            <button class="bftd-fws-btn danger" data-delete-cache="${index}">DELETE</button>
                        </div>
                        <div class="bftd-fws-note" style="margin-top:7px">
                            Saved ${esc(generated)} • ${row.scanMode === 'custom' || row.range?.code === 'custom' ? '<b>Custom Scan</b> • ' : ''}${fmt(row.warSummary?.warCount || 0)} war(s) • War data: ${row.detailedWarDataIncluded === false ? 'Basic/Fast' : 'Detailed'} • Chains: ${esc(chains)} • Scan time: ${esc(duration)}${row.importedAt ? ` • Imported ${esc(new Date(row.importedAt).toLocaleString())}` : ''}
                        </div>
                    </div>
                `;
            }).join('') : '<div class="bftd-fws-note">No quick-reload scans are available for this faction on this browser yet.</div>'}
        `;

        body.querySelectorAll('[data-load-cache]').forEach(btn => {
            btn.addEventListener('click', () => {
                const row = scans[Number(btn.dataset.loadCache)];
                const range = row?.range;
                if (!range?.from || !range?.to) return;
                if (num(range.to) > Math.floor(Date.now() / 1000) + 5) {
                    state.shareMessage = 'That quick scan ends in the future and cannot be loaded.';
                    state.shareMessageType = 'error';
                    renderMain();
                    return;
                }
                state.customStart = localDateTimeInputValue(range.from * 1000);
                state.customEnd = localDateTimeInputValue(range.to * 1000);
                const savedMode = row?.scanMode || range?.code;
                if (savedMode === 'custom') {
                    state.selectedPreset = 'custom';
                } else {
                    state.selectedMonths = inferPresetMonths(range);
                    state.selectedPreset = 'rolling';
                }
                state.currentMember = null;
                document.getElementById('bftd-fws-stats')?.remove();
                state.statsPanel = null;
                state.scanError = '';
                state.shareMessage = `Cached scan loaded • ${dateTime(range.from)} → ${dateTime(range.to)}.`;
                state.shareMessageType = 'ok';
                renderMain();
                openMemberListPanel();
                if (state.memberPanel?.isConnected) bringPanelFront(state.memberPanel);
            });
        });

        body.querySelectorAll('[data-delete-cache]').forEach(btn => {
            btn.addEventListener('click', async () => {
                const row = scans[Number(btn.dataset.deleteCache)];
                const range = row?.range;
                if (!range?.from || !range?.to) return;
                clearPeriodCache(range);
                state.shareMessage = `Quick scan deleted • ${dateTime(range.from)} → ${dateTime(range.to)}. Master history was kept.`;
                state.shareMessageType = 'ok';
                renderMain();
                await renderCachedScansPanel();
            });
        });

        body.querySelector('#bftd-fws-download-master-cache')?.addEventListener('click', async () => {
            try {
                state.shareMessage = 'Preparing full Master Data Cache export…';
                state.shareMessageType = 'ok';
                renderMain();
                await exportMasterCacheFile();
                state.shareMessage = 'Full Master Data Cache downloaded.';
                state.shareMessageType = 'ok';
                renderMain();
            } catch (err) {
                state.shareMessage = err?.message || String(err);
                state.shareMessageType = 'error';
                renderMain();
            }
        });

        const masterUploadInput = body.querySelector('#bftd-fws-upload-master-file');
        body.querySelector('#bftd-fws-upload-master-cache')?.addEventListener('click', () => masterUploadInput?.click());
        masterUploadInput?.addEventListener('change', async () => {
            const file = masterUploadInput.files?.[0];
            if (!file) return;
            try {
                await importMasterCacheFile(file);
                state.shareMessage = 'Master Data Cache imported and merged with existing local master data.';
                state.shareMessageType = 'ok';
                renderMain();
                await renderCachedScansPanel();
            } catch (err) {
                state.shareMessage = err?.message || String(err);
                state.shareMessageType = 'error';
                renderMain();
            } finally {
                masterUploadInput.value = '';
            }
        });

        body.querySelector('#bftd-fws-clear-master-cache')?.addEventListener('click', async () => {
            const factionName = state.faction?.name || `Faction ${state.faction?.id || ''}`;
            const confirmed = window.confirm(
                `WARNING — CLEAR COMPLETE MASTER DATA?\n\n` +
                `This will permanently clear the complete reusable Master Data Cache for ${factionName}, including cached attacks, ranked wars/reports, completed chains, chain reports, organized crimes and armory history.\n\n` +
                `Future scans will need to download that history from Torn again. Your separate quick-reload scan snapshots will NOT be deleted.\n\n` +
                `Continue and clear the master data?`
            );
            if (!confirmed) return;
            try {
                await clearMasterCacheForFaction();
                state.shareMessage = 'Master Data Cache cleared. Quick-reload scans were kept.';
                state.shareMessageType = 'ok';
                renderMain();
                await renderCachedScansPanel();
            } catch (err) {
                state.shareMessage = err?.message || String(err);
                state.shareMessageType = 'error';
                renderMain();
            }
        });
    }

    function setScanProgress(message, detail = '') {
        state.scanProgress = { message, detail };
        if (state.mainPanel && document.getElementById('bftd-fws-main')) renderMain();
    }

    async function runFactionScan(forceRefresh = true) {
        if (state.scanRunning) return;
        const customScan = state.selectedPreset === 'custom';
        if (!customScan) applyQuickRange(state.selectedMonths || 6);
        const range = getPresetRange();
        if (!range.valid) {
            state.scanError = range.validationMessage || 'Choose a valid start and end date/time first.';
            renderMain();
            return;
        }

        const includeChains = Boolean(state.includeChains);
        const detailedWarData = Boolean(state.detailedWarData);
        const totalStages = 3 + (detailedWarData ? 1 : 0) + (includeChains ? 1 : 0);
        state.masterWindowAnchorTo = customScan ? 0 : Math.floor(num(range.to));
        state.scanRunning = true;
        let scanSucceeded = false;
        const scanStartedAt = Date.now();
        state.abortScan = false;
        state.scanError = '';
        state.shareMessage = '';
        state.shareMessageType = '';
        // Keep the last good quick-reload scan until the replacement finishes successfully.
        renderMain();

        try {
            setScanProgress('Maintaining rolling 12-month Master Data Cache…', customScan
                ? 'Custom Scan is read-only against Master Data. Expired master records are pruned to keep Master limited to the rolling last 12 months, but this Custom Scan will not add anything new to Master.'
                : 'Removing master records and coverage older than exactly 12 calendar months from the current date/time before planning this scan.');
            const pruneInfo = await pruneMasterCacheToRollingWindow();

            if (customScan) state.transientHistory = createTransientHistory(range);

            if (detailedWarData && !customScan) {
                const resetOldAttackCache = await ensureDetailedAttackHistorySchema();
                if (resetOldAttackCache) {
                    setScanProgress('Refreshing old detailed attack cache…', 'Faction Helper found pre-v1.7.9 attack records that do not contain Torn\'s ranked-war flag/start timestamp. Only the attack-history portion was cleared so it can be rebuilt correctly; all other Master Data was preserved.');
                }
            }

            setScanProgress(customScan ? 'Checking Master Data + temporary Custom Scan gaps…' : 'Checking Master Data Cache…',
                customScan
                    ? `Rolling master window: ${dateTime(pruneInfo.from)} → ${dateTime(pruneInfo.to)}. Reusing any Master Data that overlaps ${dateTime(range.from)} → ${dateTime(range.to)}; missing data will be downloaded into temporary memory only.`
                    : `Rolling master window: ${dateTime(pruneInfo.from)} → ${dateTime(pruneInfo.to)} • ${pruneInfo.deletedRecords || 0} expired record(s) removed. Loading all cached data already available inside the selected range before any historical Torn requests are made.`);
            const cachePlan = await buildMasterCacheScanPlan(range);
            if (!detailedWarData) cachePlan.attacks = [];
            if (!includeChains) cachePlan.chains = [];
            setScanProgress(customScan ? 'Master Data checked — Custom downloads stay temporary' : 'Master Data Cache checked', `${scanPlanSummary(cachePlan)}${detailedWarData ? '' : ' • attacks: skipped (Basic/Fast war mode)'}${includeChains ? '' : ' • chains: skipped'}. Only uncovered intervals and missing report IDs will be requested from Torn. Coverage is checkpointed after every successfully saved API page, so partial scans resume from the remaining gap instead of rereading completed pages.${customScan ? ' Newly downloaded Custom Scan data will NOT be written to Master.' : ''}`);

            setScanProgress(`1/${totalStages} — Loading ranked-war history & reports…`, `Using Master Data Cache first • ${cachePlan.wars.length} uncovered war-history range(s). Completed war reports are cached permanently by war ID.`);
            const warScan = await scanRankedWarsAndReports(range, (done, total, apiCalls, cacheHits) => {
                setScanProgress(`1/${totalStages} — Loading ranked-war history & reports…`, `${done}/${total} war reports processed • ${apiCalls} new API report call(s) • ${cacheHits} master-cache report(s)`);
            }, cachePlan.wars);

            let stage = 2;
            let attackScan;
            if (detailedWarData) {
                if (state.abortScan) throw new Error('Scan cancelled.');
                setScanProgress(`${stage}/${totalStages} — Scanning detailed faction attacks…`, customScan ? 'Detailed War Data is ON. Reusing matching Master attacks and downloading only missing attack-history gaps into temporary Custom Scan memory.' : 'Detailed War Data is ON. Loading only attack-history gaps not already covered by the Master Data Cache, then rebuilding the full selected-period attack dataset from master history.');
                const attackStage = stage;
                attackScan = await scanFactionAttacks(range, warScan.wars, warScan.reportStats, (pages, attacks, missingRanges, currentRange, cacheReuse) => {
                    setScanProgress(`${attackStage}/${totalStages} — Scanning detailed faction attacks…`, `${pages} new API page(s) • ${attacks} attack record(s) • ${cacheReuse || 0} reused from master history • missing ranges ${currentRange || 0}/${missingRanges || 0}`);
                }, cachePlan.attacks);
                stage += 1;
            } else {
                attackScan = buildBasicFastWarScan(warScan.wars, warScan.reportStats);
                setScanProgress(`Basic/Fast war data ready`, `Attack-history API stage skipped. ${attackScan.fetchedCount || 0} ranked-war report attack(s) were used as war hits; assists, outside hits, retals, overseas/group hits and detailed attack outcomes were not read.`);
            }

            let chainScan = { chains: [], historyPages: 0, apiChainsSeen: 0, cacheCount: 0, missingRangesFetched: 0, reportApiCalls: 0, reportCacheHits: 0, summary: null };
            let chainSummary = null;
            if (includeChains) {
                if (state.abortScan) throw new Error('Scan cancelled.');
                const chainStage = stage;
                setScanProgress(`${chainStage}/${totalStages} — Loading completed chains & reports…`, 'Checking cached chain history and permanent chain reports first. Only missing chain reports are requested, one at a time with a minimum 2-second gap.');
                chainScan = await scanFactionChainsAndReports(range, info => {
                    if (info?.phase === 'history') {
                        setScanProgress(`${chainStage}/${totalStages} — Loading completed chains & reports…`, `${info.pages || 0} new chain-history page(s) • ${info.chainsFound || 0} chain row(s) fetched • missing range ${info.currentRange || 0}/${info.totalRanges || 0}`);
                    } else {
                        setScanProgress(`${chainStage}/${totalStages} — Loading completed chains & reports…`, `${info.done || 0}/${info.total || 0} chain report(s) processed • ${info.apiCalls || 0} new report call(s) • ${info.cacheHits || 0} master-cache report(s) • 2s minimum report pacing`);
                    }
                }, cachePlan.chains);
                chainSummary = chainScan.summary;
                stage += 1;
            }

            if (state.abortScan) throw new Error('Scan cancelled.');
            setScanProgress(`${stage}/${totalStages} — Scanning completed organized crimes…`, customScan ? 'Reusing matching Master OC data and downloading only missing OC-history gaps into temporary Custom Scan memory.' : 'Loading only OC-history gaps, writing them into the Master Cache, then rebuilding the full selected period from master data.');
            const ocStage = stage;
            const ocScan = await scanFactionCrimes(range, (pages, crimes, cacheReuse, missingRanges, currentRange) => {
                setScanProgress(`${ocStage}/${totalStages} — Scanning completed organized crimes…`, `${pages} new OC API page(s) • ${crimes} completed OC record(s) • ${cacheReuse || 0} reused from master history • missing ranges ${currentRange || 0}/${missingRanges || 0}`);
            }, cachePlan.crimes);
            stage += 1;

            if (state.abortScan) throw new Error('Scan cancelled.');
            setScanProgress(`${stage}/${totalStages} — Scanning faction armory Xanax…`, customScan ? 'Reusing matching Master armory data and downloading only missing armory-history gaps into temporary Custom Scan memory.' : 'Loading only armory-history gaps, writing them into the Master Cache, then rebuilding the full selected period from master data.');
            const armoryStage = stage;
            const armoryScan = await scanFactionArmoryXanax(range, (pages, newsCount, cacheReuse, missingRanges, currentRange) => {
                setScanProgress(`${armoryStage}/${totalStages} — Scanning faction armory Xanax…`, `${pages} new armory API page(s) • ${newsCount} record(s) • ${cacheReuse || 0} reused from master history • missing ranges ${currentRange || 0}/${missingRanges || 0}`);
            }, cachePlan.armory);

            // Rolling scans build from the persistent Master Cache. Custom scans use a
            // read-through in-memory overlay for any data missing from Master.
            setScanProgress(customScan ? 'Building finished Custom Scan…' : 'Building finished scan from Master Data Cache…',
                customScan
                    ? 'Building the complete selected Start/End result from reusable Master Data plus the temporary Custom Scan overlay. Temporary downloads will be discarded after the quick-reload snapshot is saved.'
                    : 'All newly fetched data is stored. Building the complete selected Start/End result from the combined cached history.');

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
                chainSummary,
                attackScan.pageCount,
                attackScan.fetchedCount,
                ocScan.pageCount,
                ocScan.crimeCount,
                armoryScan.pageCount,
                armoryScan.newsCount,
                Date.now() - scanStartedAt,
                includeChains,
                detailedWarData,
                {
                    attacks: detailedWarData
                        ? { apiPages: attackScan.pageCount, apiFetched: attackScan.apiFetchedCount, reused: attackScan.cacheReuseCount, missingRanges: attackScan.missingRangeCount, skipped: false }
                        : { apiPages: 0, apiFetched: 0, reused: 0, missingRanges: 0, skipped: true },
                    crimes: { apiPages: ocScan.pageCount, apiFetched: ocScan.apiFetchedCount, reused: ocScan.cacheReuseCount, missingRanges: ocScan.missingRangeCount },
                    armory: { apiPages: armoryScan.pageCount, apiFetched: armoryScan.apiFetchedCount, reused: armoryScan.cacheReuseCount, missingRanges: armoryScan.missingRangeCount },
                    chains: includeChains ? {
                        apiPages: chainScan.historyPages,
                        apiFetched: chainScan.apiChainsSeen,
                        reused: Math.max(0, (chainScan.cacheCount || 0) - (chainScan.apiChainsSeen || 0)),
                        missingRanges: chainScan.missingRangesFetched || 0,
                        reportApiCalls: chainScan.reportApiCalls || 0,
                        reportCacheHits: chainScan.reportCacheHits || 0
                    } : null
                }
            );
            if (!customScan) {
                await touchMasterCache(range, {
                    chainsIncluded: includeChains,
                    detailedWarDataIncluded: detailedWarData,
                    scanDurationMs: Date.now() - scanStartedAt
                });
                await pruneMasterCacheToRollingWindow();
            }
            if (document.getElementById('bftd-fws-cache')) renderCachedScansPanel();

            const completedIn = formatScanDuration(Date.now() - scanStartedAt);
            const historyPagesFetched = num(attackScan.pageCount) + num(ocScan.pageCount) + num(armoryScan.pageCount) + (includeChains ? num(chainScan.historyPages) : 0);
            const historyRecordsReused = num(attackScan.cacheReuseCount) + num(ocScan.cacheReuseCount) + num(armoryScan.cacheReuseCount);
            state.shareMessage = `${customScan ? 'Custom scan' : 'Scan'} completed in ${completedIn} • ${detailedWarData ? 'Detailed war data' : 'Basic/Fast war data'}${includeChains ? ` • chains included • ${num(chainScan.reportApiCalls)} new chain report call(s) • ${num(chainScan.reportCacheHits)} chain report(s) reused` : ' • chains not included'} • ${historyPagesFetched} new history API page(s) • ${historyRecordsReused} cached record(s) reused${customScan ? ' • Custom downloads were temporary and Master Data was not updated' : ''}.`;
            state.shareMessageType = '';
            state.lastAggregates = attackScan.aggregates;
            state.lastOcAggregates = ocScan.aggregates;
            state.lastArmoryXanaxAggregates = armoryScan.aggregates;
            state.scanProgress = null;
            state.scanError = '';
            scanSucceeded = true;
        } catch (err) {
            state.scanError = err.message || String(err);
        } finally {
            state.scanRunning = false;
            state.abortScan = false;
            state.masterWindowAnchorTo = 0;
            state.transientHistory = null;
            renderMain();
            if (scanSucceeded) openMemberListPanel();
            else if (document.getElementById('bftd-fws-members-panel')) renderMemberList();
        }
    }

    function openMemberListPanel() {
        const existing = document.getElementById('bftd-fws-members-panel');
        if (existing) {
            state.memberPanel = existing;
            renderMemberList();
            bringPanelFront(existing);
            return;
        }
        state.memberPanel = panelShell('bftd-fws-members-panel', 'Faction Members', `${state.faction?.name || 'Faction'} • ${state.members.length} current`);
        renderMemberList();
    }

    function renderMemberList() {
        const panel = document.getElementById('bftd-fws-members-panel');
        const body = panel?.querySelector('.bftd-fws-body');
        if (!body) return;

        const range = getPresetRange();
        const cached = getCached(range);
        const ready = Boolean(cached?.aggregates && cached?.ocAggregates && cached?.armoryXanaxAggregates && cached?.warSummary) && !state.scanRunning;
        const membersForDisplay = ready && Array.isArray(cached?.membersSnapshot) && cached.membersSnapshot.length
            ? cached.membersSnapshot
            : state.members;
        const q = state.search.trim().toLowerCase();
        const filtered = membersForDisplay.filter(m => {
            if (!q) return true;
            return String(m.name || '').toLowerCase().includes(q)
                || String(m.id || '').includes(q)
                || String(m.position || '').toLowerCase().includes(q);
        });
        const status = ready
            ? `${filtered.length} member${filtered.length === 1 ? '' : 's'} shown • scan complete — click a member`
            : `${filtered.length} member${filtered.length === 1 ? '' : 's'} shown • locked until Scan Faction completes for the selected range`;

        body.innerHTML = `
            <div class="bftd-fws-card">
                <div class="bftd-fws-row" style="margin-bottom:8px">
                    <input id="bftd-fws-search" class="bftd-fws-input bftd-fws-grow" placeholder="Search faction members…" value="${esc(state.search)}">
                    <button id="bftd-fws-refresh-members" class="bftd-fws-btn secondary" title="Reload current faction member list" ${state.scanRunning ? 'disabled' : ''}>↻</button>
                </div>
                <div id="bftd-fws-member-count" class="bftd-fws-note">${esc(status)}</div>
            </div>
            <div id="bftd-fws-members" class="bftd-fws-members">
                ${filtered.map(m => `
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
                `).join('') || `<div class="bftd-fws-note">No matching faction members.</div>`}
            </div>
        `;

        const search = body.querySelector('#bftd-fws-search');
        search?.addEventListener('input', () => {
            state.search = search.value;
            renderMemberList();
            const next = document.querySelector('#bftd-fws-members-panel #bftd-fws-search');
            if (next) {
                next.focus();
                try { next.setSelectionRange(next.value.length, next.value.length); } catch {}
            }
        });

        body.querySelector('#bftd-fws-refresh-members')?.addEventListener('click', async () => {
            body.innerHTML = '<div class="bftd-fws-note">Reloading current faction members…</div>';
            try {
                await authenticateAndLoad();
                renderMain();
                renderMemberList();
            } catch (err) {
                body.innerHTML = `<div class="bftd-fws-error">${esc(err?.message || String(err))}</div>`;
            }
        });

        if (!ready) return;
        body.querySelectorAll('[data-member-id]').forEach(btn => {
            btn.addEventListener('click', () => {
                const memberId = Number(btn.dataset.memberId);
                const member = membersForDisplay.find(m => Number(m?.id) === memberId) || state.memberMap.get(memberId);
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
            warSummary: cached.warSummary,
            chainSummary: cached.chainSummary || null,
            detailedWarDataIncluded: cached.detailedWarDataIncluded !== false,
            historyCacheStats: cached.historyCacheStats || null,
            memberSnapshot: Array.isArray(cached.membersSnapshot) && cached.membersSnapshot.length > 0
        });
    }

    function cacheKey(range) {
        const factionId = state.faction?.id || 0;
        return `${factionId}:range:${Math.floor(num(range?.from))}:${Math.floor(num(range?.to))}`;
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
        // Quick-scan snapshots are intentionally user-managed. Keep every unique
        // completed range until the user deletes it from Cached Scans.
        const entries = Object.entries(store)
            .sort((a, b) => num(b[1]?.generatedAt) - num(a[1]?.generatedAt));
        GM_setValue(APP.cacheStorage, JSON.stringify(Object.fromEntries(entries)));
    }

    function cacheEntryMatchesRange(row, range) {
        return Math.floor(num(row?.range?.from)) === Math.floor(num(range?.from))
            && Math.floor(num(row?.range?.to)) === Math.floor(num(range?.to));
    }

    function getCached(range) {
        const store = loadCacheStore();
        const direct = store[cacheKey(range)];
        if (direct?.aggregates && direct?.range) return direct;
        const factionPrefix = `${state.faction?.id || 0}:`;
        let best = null;
        for (const [key, row] of Object.entries(store)) {
            if (!key.startsWith(factionPrefix) || !row?.aggregates || !row?.range) continue;
            if (!cacheEntryMatchesRange(row, range)) continue;
            if (!best || num(row.generatedAt) > num(best.generatedAt)) best = row;
        }
        return best;
    }

    function getLocalCachedScans() {
        const store = loadCacheStore();
        const factionPrefix = `${state.faction?.id || 0}:`;
        const byRange = new Map();
        for (const [key, row] of Object.entries(store)) {
            if (!key.startsWith(factionPrefix) || !row?.aggregates || !row?.range) continue;
            const from = Math.floor(num(row.range.from));
            const to = Math.floor(num(row.range.to));
            if (!from || !to || to <= from) continue;
            if (to > Math.floor(Date.now() / 1000) + 5) continue;
            const id = `${from}:${to}`;
            const prev = byRange.get(id);
            if (!prev || num(row.generatedAt) > num(prev.generatedAt)) byRange.set(id, row);
        }
        return [...byRange.values()].sort((a,b) => num(b.generatedAt) - num(a.generatedAt));
    }

    function savePeriodCacheEntry(range, entry) {
        const store = loadCacheStore();
        const factionPrefix = `${state.faction?.id || 0}:`;
        for (const [key, row] of Object.entries(store)) {
            if (!key.startsWith(factionPrefix)) continue;
            if (cacheEntryMatchesRange(row, range)) delete store[key];
        }
        const normalizedRange = { ...(entry?.range || range), code:(range?.code === 'custom' ? 'custom' : 'rolling'), label:(range?.code === 'custom' ? 'Custom Scan' : 'Selected time period'), from:Math.floor(num(range.from)), to:Math.floor(num(range.to)), valid:true, custom:range?.code === 'custom' };
        store[cacheKey(normalizedRange)] = { ...entry, range: normalizedRange };
        saveCacheStore(store);
    }

    function putCached(range, aggregates, ocAggregates, armoryXanaxAggregates, warSummary, chainSummary, pageCount, fetchedCount, ocPageCount, ocCount, armoryPageCount, armoryNewsCount, scanDurationMs = 0, chainsIncluded = false, detailedWarDataIncluded = true, historyCacheStats = null) {
        savePeriodCacheEntry(range, {
            generatedAt: Date.now(),
            range,
            aggregates,
            ocAggregates,
            armoryXanaxAggregates,
            warSummary,
            chainSummary,
            chainsIncluded: Boolean(chainsIncluded),
            detailedWarDataIncluded: Boolean(detailedWarDataIncluded),
            scanMode: range?.code === 'custom' ? 'custom' : 'rolling',
            pageCount,
            fetchedCount,
            ocPageCount,
            ocCount,
            armoryPageCount,
            armoryNewsCount,
            scanDurationMs: Math.max(0, num(scanDurationMs)),
            historyCacheStats: historyCacheStats && typeof historyCacheStats === 'object' ? historyCacheStats : null,
            membersSnapshot: cloneMembersSnapshot(state.members)
        });
    }

    function clearPeriodCache(range) {
        const store = loadCacheStore();
        const factionPrefix = `${state.faction?.id || 0}:`;
        for (const [key, row] of Object.entries(store)) {
            if (key.startsWith(factionPrefix) && cacheEntryMatchesRange(row, range)) delete store[key];
        }
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

    async function getCachedWarReport(warId, warStart = 0) {
        const master = await historyGetRecordById('warReports', warId);
        if (master?.report) return master.report;
        if (master && !master.report) return master;

        // Backward compatibility: lazily migrate any v1.7.0-or-older report into
        // the master data cache the first time it is needed.
        const legacy = loadWarReportCache()[String(warId)] || null;
        if (legacy) await putCachedWarReport(warId, legacy, warStart);
        return legacy;
    }

    async function putCachedWarReport(warId, report, warStart = 0) {
        if (!report) return;
        const ts = Math.floor(num(warStart)) || Math.floor(Date.now() / 1000);
        await historyPutRecords(
            'warReports',
            [{ id: String(warId), ts, report }],
            row => row.id,
            row => row.ts
        );

        // Keep a compatibility mirror so a temporary downgrade can still reopen
        // recent reports. The master IndexedDB cache is the authoritative source.
        if (!state.transientHistory) {
            const store = loadWarReportCache();
            store[String(warId)] = report;
            const compact = Object.fromEntries(Object.entries(store).slice(-1000));
            GM_setValue(APP.warReportCacheStorage, JSON.stringify(compact));
        }
    }

    function extractChains(payload) {
        if (Array.isArray(payload?.chains)) return payload.chains;
        if (payload?.chains && typeof payload.chains === 'object') return Object.values(payload.chains);
        return [];
    }

    function normalizeChain(chain) {
        return {
            id: num(chain?.id ?? chain?.chain_id, 0),
            chain: num(chain?.chain ?? chain?.size ?? 0),
            respect: num(chain?.respect, 0),
            start: num(chain?.start, 0),
            end: num(chain?.end, 0)
        };
    }


    function extractChainReport(payload) {
        return payload?.chainreport || payload?.chain_report || payload?.report || null;
    }

    function loadLegacyChainReportCache() {
        try {
            const raw = GM_getValue(APP.chainReportCacheStorage, '{}');
            const obj = typeof raw === 'string' ? JSON.parse(raw) : raw;
            return obj && typeof obj === 'object' ? obj : {};
        } catch {
            return {};
        }
    }

    async function getCachedChainReport(chainId, chainStart = 0) {
        const master = await historyGetRecordById('chainReports', chainId);
        if (master?.report) return master.report;
        if (master && !master.report) return master;

        // Migrate chain reports saved by older Faction Helper builds into the
        // authoritative Master Data Cache instead of downloading them again.
        const legacy = loadLegacyChainReportCache()[String(chainId)] || null;
        if (legacy) await putCachedChainReport(chainId, legacy, chainStart || legacy?.start);
        return legacy;
    }

    async function putCachedChainReport(chainId, report, chainStart = 0) {
        if (!report) return;
        const ts = Math.floor(num(chainStart || report?.start)) || Math.floor(Date.now() / 1000);
        await historyPutRecords(
            'chainReports',
            [{ id: String(chainId), ts, report }],
            row => row.id,
            row => row.ts
        );
    }

    function chainReportAttackValue(attacks, ...keys) {
        for (const key of keys) {
            if (attacks?.[key] !== undefined && attacks?.[key] !== null) return num(attacks[key], 0);
        }
        return 0;
    }

    function normalizeChainReportMember(chain, report, attacker) {
        const attacks = attacker?.attacks || {};
        const respect = attacker?.respect || {};
        const leave = chainReportAttackValue(attacks, 'leave', 'leaves');
        const mug = chainReportAttackValue(attacks, 'mug', 'mugs');
        const hosp = chainReportAttackValue(attacks, 'hospitalize', 'hospitalized', 'hospitalise', 'hosp');
        return {
            id: chain.id,
            start: num(report?.start, chain.start),
            end: num(report?.end, chain.end),
            chain: num(report?.details?.chain, chain.chain),
            factionRespect: num(report?.details?.respect, chain.respect),
            hits: leave + mug + hosp,
            respect: num(respect?.total, 0),
            best: num(respect?.best, 0),
            avg: num(respect?.average ?? respect?.avg, 0),
            attacks: chainReportAttackValue(attacks, 'total', 'attacks'),
            leave,
            mug,
            hosp,
            war: chainReportAttackValue(attacks, 'war', 'war_hits', 'warHits'),
            assist: chainReportAttackValue(attacks, 'assists', 'assist'),
            retal: chainReportAttackValue(attacks, 'retaliations', 'retaliation', 'retals', 'retal'),
            overseas: chainReportAttackValue(attacks, 'overseas', 'abroad'),
            draw: chainReportAttackValue(attacks, 'draws', 'draw', 'stalemates', 'stalemate'),
            escape: chainReportAttackValue(attacks, 'escapes', 'escape'),
            loss: chainReportAttackValue(attacks, 'losses', 'loss')
        };
    }

    async function buildChainSummaryFromMaster(chainScan, reportApiCalls = 0, reportCacheHits = 0) {
        const memberParticipation = {};
        const chains = Array.isArray(chainScan?.chains) ? chainScan.chains : [];
        for (const chain of chains) {
            const report = await getCachedChainReport(chain.id, chain.start);
            if (!report) continue;
            const attackers = Array.isArray(report?.attackers) ? report.attackers : Object.values(report?.attackers || {});
            for (const attacker of attackers) {
                const uid = num(attacker?.id, 0);
                if (!uid) continue;
                if (!memberParticipation[uid]) memberParticipation[uid] = [];
                memberParticipation[uid].push(normalizeChainReportMember(chain, report, attacker));
            }
        }
        for (const rows of Object.values(memberParticipation)) rows.sort((a, b) => num(a.start) - num(b.start));
        return {
            chainCount: chains.length,
            historyPages: num(chainScan?.historyPages),
            reportApiCalls,
            reportCacheHits,
            derivedFromReports: true,
            chains,
            memberParticipation
        };
    }

    async function scanFactionChainsAndReports(range, onProgress, plannedMissingRanges = null) {
        const chainScan = await scanFactionChainHistory(range, (pages, chainsFound, totalRanges, currentRange) => {
            onProgress?.({ phase: 'history', pages, chainsFound, totalRanges, currentRange, done: 0, total: 0, apiCalls: 0, cacheHits: 0 });
        }, plannedMissingRanges);

        let reportApiCalls = 0;
        let reportCacheHits = 0;
        let done = 0;
        const chains = Array.isArray(chainScan?.chains) ? chainScan.chains : [];

        for (const chain of chains) {
            if (state.abortScan) throw new Error('Scan cancelled.');
            let report = await getCachedChainReport(chain.id, chain.start);
            if (report) {
                reportCacheHits += 1;
            } else {
                const payload = await gmJsonWithMinDelay(
                    apiUrl(`/faction/${encodeURIComponent(chain.id)}/chainreport`),
                    APP.chainReportDelayMs
                );
                report = extractChainReport(payload);
                reportApiCalls += 1;
                if (report) await putCachedChainReport(chain.id, report, chain.start);
            }
            done += 1;
            onProgress?.({ phase: 'reports', pages: chainScan.historyPages, chainsFound: chains.length, done, total: chains.length, apiCalls: reportApiCalls, cacheHits: reportCacheHits });
        }

        // Build the finished chain dataset only from the Master Data Cache after all
        // missing reports have been fetched and written there.
        const summary = await buildChainSummaryFromMaster(chainScan, reportApiCalls, reportCacheHits);
        return { ...chainScan, summary, reportApiCalls, reportCacheHits };
    }

    async function scanFactionChainHistory(range, onProgress, plannedMissingRanges = null) {
        const now = Math.floor(Date.now() / 1000);
        // /faction/chains can temporarily omit a just-finished chain while it is still cooling down.
        // Keep the most recent 15 minutes refreshable instead of permanently marking that tail as complete.
        const stableTo = Math.min(range.to, now - 15 * 60);
        // The scan preflight decides which exact chain intervals are not covered by
        // the Master Data Cache. The newest cooldown tail intentionally remains
        // uncovered until it is old enough to be considered stable.
        const fetchRanges = plannedMissingRanges === null
            ? await historyMissingRanges('chains', range.from, range.to)
            : cloneMissingRanges(plannedMissingRanges);

        let historyPages = 0;
        let apiChainsSeen = 0;
        const fetchedChains = [];
        for (let r = 0; r < fetchRanges.length; r++) {
            const [gapFrom, gapTo] = fetchRanges[r];
            let cursorTo = gapTo;
            let nextUrl = apiUrl('/faction/chains', {
                limit: 100,
                sort: 'DESC',
                from: gapFrom,
                to: gapTo
            });
            let gapComplete = true;
            const seenPageUrls = new Set();
            while (nextUrl && cursorTo >= gapFrom) {
                if (state.abortScan) throw new Error('Scan cancelled.');
                if (seenPageUrls.has(nextUrl)) {
                    gapComplete = false;
                    break;
                }
                seenPageUrls.add(nextUrl);
                const payload = await gmJson(nextUrl);
                historyPages += 1;
                const rows = extractChains(payload).map(normalizeChain).filter(row => row.id && row.start);
                apiChainsSeen += rows.length;
                fetchedChains.push(...rows);
                await historyPutRecords('chains', rows, row => row.id, row => row.start);

                let oldestStart = 0;
                for (const chain of rows) {
                    if (!oldestStart || chain.start < oldestStart) oldestStart = chain.start;
                }
                if (oldestStart) {
                    const checkpointTo = Math.min(cursorTo, stableTo);
                    const checkpointFrom = Math.max(gapFrom, oldestStart + 1);
                    if (checkpointTo >= checkpointFrom) {
                        await historyMarkCoverage('chains', checkpointFrom, checkpointTo);
                    }
                }
                onProgress?.(historyPages, apiChainsSeen, fetchRanges.length, r + 1);
                if (!rows.length) break;

                const apiNext = cleanNextUrl(payload?._metadata?.links?.next);
                if (apiNext) {
                    nextUrl = apiNext;
                } else if (rows.length >= 100 && oldestStart && oldestStart > gapFrom) {
                    const nextTo = oldestStart - 1;
                    if (nextTo >= cursorTo) {
                        gapComplete = false;
                        break;
                    }
                    cursorTo = nextTo;
                    nextUrl = apiUrl('/faction/chains', {
                        limit: 100,
                        sort: 'DESC',
                        from: gapFrom,
                        to: cursorTo
                    });
                } else {
                    nextUrl = null;
                }
                if (historyPages > 1000) throw new Error('Chain history exceeded the safety limit (1,000 pages).');
            }
            // Do not freeze the recent cooldown tail into coverage; it is intentionally refreshed later.
            // Stable history is still finalized even when the requested gap also includes that live tail.
            if (gapComplete && gapFrom <= stableTo) {
                await historyMarkCoverage('chains', gapFrom, Math.min(gapTo, stableTo));
            }
        }

        const cachedChains = await historyGetRecords('chains', range.from, range.to);
        const selected = cachedChains
            .map(normalizeChain)
            .filter(chain => chain.id && chain.start >= range.from && chain.start <= range.to)
            .sort((a, b) => a.start - b.start);
        const deduped = [];
        const seen = new Set();
        for (const chain of selected) {
            if (seen.has(chain.id)) continue;
            seen.add(chain.id);
            deduped.push(chain);
        }
        return {
            chains: deduped,
            historyPages,
            apiChainsSeen,
            cacheCount: deduped.length,
            missingRangesFetched: fetchRanges.length
        };
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

    function reportOpponentFaction(report) {
        const factions = Array.isArray(report?.factions) ? report.factions : Object.values(report?.factions || {});
        return factions.find(f => Number(f?.id) !== Number(state.faction?.id)) || null;
    }

    function freshReportStat() {
        return { reportAttacks: 0, warScore: 0, wars: {} };
    }

    async function scanRankedWarsAndReports(range, onProgress, plannedMissingRanges = null) {
        let historyPages = 0;
        let reportApiCalls = 0;
        let reportCacheHits = 0;

        // Ranked-war rows are part of the master cache too. Only walk Torn's
        // ranked-war history when some part of this exact date range is missing.
        const missingRanges = plannedMissingRanges === null
            ? await historyMissingRanges('wars', range.from, range.to)
            : cloneMissingRanges(plannedMissingRanges);
        if (missingRanges.length) {
            const earliestNeeded = Math.min(...missingRanges.map(row => num(row?.[0])).filter(Boolean));
            let offset = 0;
            let historyComplete = false;

            while (true) {
                if (state.abortScan) throw new Error('Scan cancelled.');
                const payload = await gmJson(apiUrl('/faction/rankedwars', { limit: 100, offset }));
                historyPages += 1;
                const rows = extractRankedWars(payload);
                if (!rows.length) {
                    historyComplete = true;
                    break;
                }

                const normalized = rows.map(normalizeWar).filter(w => w.id && w.start);
                if (normalized.length) {
                    await historyPutRecords('wars', normalized, row => row.id, row => row.start);
                }

                let oldestStart = 0;
                for (const war of normalized) {
                    if (!oldestStart || war.start < oldestStart) oldestStart = war.start;
                }

                // Persist verified history coverage after every successful page. If a scan is
                // interrupted later (rate limit, daily read limit, cancel, browser close), the
                // pages already downloaded remain reusable on the next scan. Keep the oldest
                // page-boundary second open until the next page/final completion so equal-time
                // records cannot be skipped.
                if (oldestStart) {
                    await historyCheckpointCoverage('wars', missingRanges, oldestStart + 1, range.to);
                }

                if (rows.length < 100 || (oldestStart && oldestStart <= earliestNeeded)) {
                    historyComplete = true;
                    break;
                }
                offset += rows.length;
                if (historyPages > 500) throw new Error('Ranked-war history exceeded the safety limit (500 pages).');
            }

            if (historyComplete) {
                for (const [from, to] of missingRanges) await historyMarkCoverage('wars', from, to);
            }
        }

        // Do not make a "just in case" ranked-war refresh when the selected
        // interval is already covered. A later scan whose End time moves forward
        // creates a new uncovered tail and will refresh the newest ranked-war page
        // as part of that missing interval instead.

        const cachedWars = await historyGetRecords('wars', range.from, range.to);
        const byId = new Map();
        for (const war of cachedWars) {
            if (!war?.id || !war?.start || war.start < range.from || war.start > range.to) continue;
            const prev = byId.get(String(war.id));
            if (!prev || num(war.end) >= num(prev.end)) byId.set(String(war.id), war);
        }
        const selected = [...byId.values()].sort((a, b) => a.start - b.start);

        const reportStats = {};
        let done = 0;
        const completed = selected.filter(w => w.end > 0);

        for (const war of completed) {
            if (state.abortScan) throw new Error('Scan cancelled.');
            let report = await getCachedWarReport(war.id, war.start);
            if (report) {
                reportCacheHits += 1;
            } else {
                const payload = await gmJson(apiUrl(`/faction/${encodeURIComponent(war.id)}/rankedwarreport`));
                report = extractRankedWarReport(payload);
                reportApiCalls += 1;
                if (report) await putCachedWarReport(war.id, report, war.start);
            }

            if (report) {
                const reportOpponent = reportOpponentFaction(report);
                if (reportOpponent?.id && (!war.opponentId || Number(war.opponentId) !== Number(reportOpponent.id))) {
                    war.opponentId = num(reportOpponent.id, 0);
                    war.opponentName = String(reportOpponent.name || `Faction ${reportOpponent.id}`);
                    await historyPutRecords('wars', [war], row => row.id, row => row.start);
                }
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


    function buildBasicFastWarScan(wars, reportStats) {
        const aggregates = {};
        applyReportStats(aggregates, wars, reportStats);
        let totalReportAttacks = 0;

        for (const member of state.members) {
            const uid = Number(member.id);
            if (!aggregates[uid]) aggregates[uid] = freshAgg();
        }

        for (const s of Object.values(aggregates)) {
            let warHits = 0;
            let warsWithHits = 0;
            for (const row of Object.values(s.warBreakdown || {})) {
                const hits = Math.max(0, num(row.reportAttacks, 0));
                row.warHits = hits;
                row.warAttempts = hits;
                row.warAssists = 0;
                row.warRetals = 0;
                row.outsideHits = 0;
                row.outsideAssists = 0;
                row.outsideRetals = 0;
                warHits += hits;
                if (hits > 0) warsWithHits += 1;
            }
            s.warHits = warHits;
            s.warAttempts = warHits;
            s.warsWithWarHits = warsWithHits;
            // Basic/Fast mode intentionally does not populate assists, outside-hit
            // classifications, retals, overseas/group modifiers or general attack outcomes.
            totalReportAttacks += warHits;
        }

        return {
            aggregates,
            pageCount: 0,
            fetchedCount: totalReportAttacks,
            apiFetchedCount: 0,
            cacheReuseCount: 0,
            missingRangeCount: 0,
            attacks: [],
            skippedDetailedAttacks: true
        };
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

    function attackStartedTs(attack) {
        return num(attack?.started ?? attack?.timestamp_started ?? attack?.start ?? attack?.timestamp ?? 0);
    }

    function attackEndTs(attack) {
        return num(attack?.ended ?? attack?.timestamp_ended ?? attack?.end ?? attack?.timestamp ?? 0);
    }

    function attackerFactionId(attack) {
        return num(
            attack?.attacker?.faction?.id
            ?? attack?.attacker?.faction_id
            ?? attack?.attacker_faction_id
            ?? 0
        );
    }

    function attackIsRankedWar(attack) {
        return attack?.is_ranked_war === true
            || attack?.is_ranked_war === 1
            || String(attack?.is_ranked_war || '').toLowerCase() === 'true';
    }

    function attackResult(attack) {
        return String(attack?.result ?? attack?.outcome ?? '').trim();
    }

    function activeWarAt(ts, wars) {
        if (!ts) return null;
        return wars.find(w => ts >= w.start && ts <= (w.end || Number.MAX_SAFE_INTEGER)) || null;
    }

    function attackOverlapsWar(attack, war, toleranceSeconds = 5) {
        const started = attackStartedTs(attack) || attackEndTs(attack);
        const ended = attackEndTs(attack) || started;
        if (!started || !war?.start) return false;
        const warEnd = num(war.end) || Number.MAX_SAFE_INTEGER;
        return started <= warEnd + toleranceSeconds && ended >= num(war.start) - toleranceSeconds;
    }

    function targetWarForAttack(attack, wars) {
        const defenderFaction = defenderFactionId(attack);
        const ts = attackEndTs(attack) || attackStartedTs(attack);
        if (!ts) return null;

        // Primary match: exact RW opponent + attack interval overlap. Using the
        // full attack interval handles Torn's documented final-hit edge case where
        // the attack starts before the war end but its `ended` timestamp is later.
        if (defenderFaction) {
            const exact = wars.find(w => Number(w.opponentId) === Number(defenderFaction) && attackOverlapsWar(attack, w));
            if (exact) return exact;
        }

        // Torn's is_ranked_war flag / war modifier is authoritative for the hit
        // classification. If opponent metadata is incomplete, associate it with the
        // one overlapping ranked war rather than dropping the hit completely.
        const warFlag = attackIsRankedWar(attack) || num(attack?.modifiers?.war, 1) > 1.00001;
        if (warFlag) {
            const overlapping = wars.filter(w => attackOverlapsWar(attack, w));
            if (overlapping.length === 1) return overlapping[0];
            if (defenderFaction) {
                const sameOpponent = wars
                    .filter(w => Number(w.opponentId) === Number(defenderFaction))
                    .sort((a, b) => {
                        const dist = w => {
                            const start = num(w.start);
                            const end = num(w.end) || start;
                            if (ts >= start && ts <= end) return 0;
                            return Math.min(Math.abs(ts - start), Math.abs(ts - end));
                        };
                        return dist(a) - dist(b);
                    })[0];
                if (sameOpponent) return sameOpponent;
            }
        }
        return null;
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

        const ts = attackEndTs(attack) || attackStartedTs(attack);
        const targetWar = targetWarForAttack(attack, wars);
        const activeWar = activeWarAt(ts, wars);

        const resultRaw = attackResult(attack);
        const result = resultRaw.toLowerCase();
        const respectGain = num(attack?.respect_gain ?? attack?.respect, 0);
        const respectLoss = num(attack?.respect_loss, 0);
        const interrupted = attack?.is_interrupted === true || result === 'interrupted';
        const assist = result === 'assist';
        const success = !assist && !interrupted && (SUCCESS_RESULTS.has(result) || (respectGain > 0 && !FAILURE_RESULTS.has(result)));
        const retal = num(attack?.modifiers?.retaliation, 1) > 1.00001;
        const rankedWarFlag = attackIsRankedWar(attack) || num(attack?.modifiers?.war, 1) > 1.00001;
        const isWarTarget = Boolean(targetWar) || rankedWarFlag;
        const context = isWarTarget ? 'war' : (activeWar ? 'duringWar' : 'outsideWar');

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

        if (isWarTarget) {
            // RWPH Advanced precedence: a retal on the ranked-war opponent is still
            // a war hit and additionally receives the retal subtype. A non-war retal
            // stays an outside hit and receives the retal subtype there.
            const rowWar = targetWar || activeWar;
            const row = rowWar ? ensureWarBreakdown(s, rowWar) : null;
            s.warAttempts += 1;
            if (row) row.warAttempts += 1;
            if (assist) {
                s.warAssists += 1;
                if (row) row.warAssists += 1;
            } else if (success) {
                s.warHits += 1;
                if (row) row.warHits += 1;
                if (retal) {
                    s.warRetals += 1;
                    if (row) row.warRetals += 1;
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

    function compactAttackForHistory(attack, fallback) {
        const id = attackId(attack, fallback);
        return {
            id,
            _schema: ATTACK_HISTORY_SCHEMA_VERSION,
            started: attackStartedTs(attack),
            ended: attackEndTs(attack),
            result: attackResult(attack),
            respect_gain: num(attack?.respect_gain ?? attack?.respect, 0),
            respect_loss: num(attack?.respect_loss, 0),
            is_interrupted: attack?.is_interrupted === true,
            is_ranked_war: attackIsRankedWar(attack),
            is_raid: attack?.is_raid === true,
            chain: num(attack?.chain ?? attack?.chain_count ?? attack?.chain_position, 0),
            attacker: {
                id: attackerId(attack),
                faction: { id: attackerFactionId(attack) }
            },
            defender: {
                id: defenderId(attack),
                faction: { id: defenderFactionId(attack) }
            },
            modifiers: attack?.modifiers && typeof attack.modifiers === 'object'
                ? { ...attack.modifiers }
                : {}
        };
    }

    function reconcileDetailedWarHitsWithReports(aggregates, wars, reportStats) {
        // Torn's ranked-war report is the authoritative successful war-hit count.
        // The detailed attack log is still used for assists, outside hits, retal
        // subtypes, overseas/group modifiers and outcomes. This mirrors RWPH
        // Advanced and prevents a timestamp/API-flag edge case from deleting hits.
        for (const [uidText, rs] of Object.entries(reportStats || {})) {
            const uid = Number(uidText);
            if (!aggregates[uid]) aggregates[uid] = freshAgg();
            const stat = aggregates[uid];
            for (const war of wars || []) {
                const reportRow = rs?.wars?.[String(war.id)];
                if (!reportRow) continue;
                const row = ensureWarBreakdown(stat, war);
                const expected = Math.max(0, num(reportRow.reportAttacks, 0));
                const classified = Math.max(0, num(row.warHits, 0));
                row.classifiedWarHits = classified;
                row.warHitsReconciled = expected !== classified;
                row.warHits = expected;
            }
        }

        for (const stat of Object.values(aggregates || {})) {
            stat.warHits = Object.values(stat.warBreakdown || {}).reduce((sum, row) => sum + Math.max(0, num(row.warHits)), 0);
            stat.warsWithWarHits = Object.values(stat.warBreakdown || {}).filter(row => num(row.warHits) > 0).length;
        }
    }

    async function scanFactionAttacks(range, wars, reportStats, onProgress, plannedMissingRanges = null) {
        const aggregates = {};
        applyReportStats(aggregates, wars, reportStats);
        let pageCount = 0;
        const fetchedRows = [];
        const missingRanges = plannedMissingRanges === null
            ? await historyMissingRanges('attacks', range.from, range.to)
            : cloneMissingRanges(plannedMissingRanges);

        for (let r = 0; r < missingRanges.length; r++) {
            const [gapFrom, gapTo] = missingRanges[r];
            let cursorTo = gapTo;
            let nextUrl = apiUrl('/faction/attacks', {
                filters: 'outgoing',
                limit: 100,
                sort: 'DESC',
                from: gapFrom,
                to: gapTo
            });
            let gapComplete = true;
            const gapSeen = new Set();
            const seenPageUrls = new Set();

            while (nextUrl && cursorTo >= gapFrom) {
                if (state.abortScan) throw new Error('Scan cancelled.');
                if (seenPageUrls.has(nextUrl)) {
                    gapComplete = false;
                    break;
                }
                seenPageUrls.add(nextUrl);

                const payload = await gmJson(nextUrl);
                pageCount += 1;

                const attacks = extractAttacks(payload);
                const compactPage = [];
                let oldestTs = 0;
                for (let i = 0; i < attacks.length; i++) {
                    const raw = attacks[i];
                    const ts = attackEndTs(raw);
                    if (ts && (!oldestTs || ts < oldestTs)) oldestTs = ts;
                    const compact = compactAttackForHistory(raw, `${pageCount}:${i}:${ts}`);
                    if (!compact.id || gapSeen.has(compact.id)) continue;
                    gapSeen.add(compact.id);
                    if (compact.ended && (compact.ended < gapFrom || compact.ended > gapTo)) continue;
                    compactPage.push(compact);
                    fetchedRows.push(compact);
                }
                await historyPutRecords('attacks', compactPage, row => row.id, row => row.ended);
                if (oldestTs) {
                    const checkpointFrom = Math.max(gapFrom, oldestTs + 1);
                    if (cursorTo >= checkpointFrom) {
                        await historyMarkCoverage('attacks', checkpointFrom, cursorTo);
                    }
                }
                onProgress?.(pageCount, fetchedRows.length, missingRanges.length, r + 1, 0);

                if (!attacks.length) break;

                // Prefer Torn's own cursor/next link. It preserves records that share the
                // same ended timestamp, which a naive oldestTimestamp-1 paginator can skip.
                const apiNext = cleanNextUrl(payload?._metadata?.links?.next);
                if (apiNext) {
                    nextUrl = apiNext;
                } else if (attacks.length >= 100 && oldestTs && oldestTs > gapFrom) {
                    const nextTo = oldestTs - 1;
                    if (nextTo >= cursorTo) {
                        gapComplete = false;
                        break;
                    }
                    cursorTo = nextTo;
                    nextUrl = apiUrl('/faction/attacks', {
                        filters: 'outgoing',
                        limit: 100,
                        sort: 'DESC',
                        from: gapFrom,
                        to: cursorTo
                    });
                } else {
                    nextUrl = null;
                }

                if (pageCount > 6000) throw new Error('Attack pagination exceeded the safety limit (6,000 pages).');
            }
            if (gapComplete) await historyMarkCoverage('attacks', gapFrom, gapTo);
        }

        // The finished period is always rebuilt from the Master Data Cache after
        // any missing pages have been written there. Live API rows are never used
        // as a separate second source of truth.
        const cachedRows = await historyGetRecords('attacks', range.from, range.to);
        const allById = new Map();
        for (const row of cachedRows) if (row?.id) allById.set(String(row.id), row);
        const allAttacks = Array.from(allById.values()).sort((a, b) => num(a.ended) - num(b.ended));
        const fetchedIdSet = new Set(fetchedRows.map(row => String(row.id)));
        const cacheReuseCount = allAttacks.reduce((n, row) => n + (fetchedIdSet.has(String(row.id)) ? 0 : 1), 0);

        for (let i = 0; i < allAttacks.length; i++) {
            if (state.abortScan) throw new Error('Scan cancelled.');
            const attack = allAttacks[i];
            addAttack(aggregates, attack, wars);
            if (i % 1000 === 0) onProgress?.(pageCount, allAttacks.length, missingRanges.length, missingRanges.length, cacheReuseCount);
        }

        reconcileDetailedWarHitsWithReports(aggregates, wars, reportStats);

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

        return {
            aggregates,
            pageCount,
            fetchedCount: allAttacks.length,
            apiFetchedCount: fetchedRows.length,
            cacheReuseCount,
            missingRangeCount: missingRanges.length,
            attacks: allAttacks
        };
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

    function compactCrimeForHistory(crime, fallback) {
        const ts = crimeExecutedTs(crime);
        const slots = (Array.isArray(crime?.slots) ? crime.slots : Object.values(crime?.slots || {}))
            .map(slot => ({ user: { id: crimeSlotUserId(slot) } }))
            .filter(slot => num(slot?.user?.id) > 0);
        return {
            id: String(crime?.id ?? crime?.crime_id ?? fallback ?? ''),
            executed_at: ts,
            status: String(crime?.status ?? crime?.outcome ?? ''),
            slots
        };
    }

    async function scanFactionCrimes(range, onProgress, plannedMissingRanges = null) {
        const aggregates = {};
        for (const member of state.members) aggregates[Number(member.id)] = freshOcAgg();

        let pageCount = 0;
        const fetchedRows = [];
        const missingRanges = plannedMissingRanges === null
            ? await historyMissingRanges('crimes', range.from, range.to)
            : cloneMissingRanges(plannedMissingRanges);

        for (let r = 0; r < missingRanges.length; r++) {
            const [gapFrom, gapTo] = missingRanges[r];
            let cursorTo = gapTo;
            let gapComplete = true;
            const gapSeen = new Set();

            while (cursorTo >= gapFrom) {
                if (state.abortScan) throw new Error('Scan cancelled.');
                const payload = await gmJson(apiUrl('/faction/crimes', {
                    cat: 'completed',
                    filters: 'executed_at',
                    limit: 100,
                    sort: 'DESC',
                    from: gapFrom,
                    to: cursorTo
                }));
                pageCount += 1;
                const crimes = extractCrimes(payload);
                const compactPage = [];
                let oldestTs = 0;

                for (let i = 0; i < crimes.length; i++) {
                    const raw = crimes[i];
                    const ts = crimeExecutedTs(raw);
                    if (ts && (!oldestTs || ts < oldestTs)) oldestTs = ts;
                    const compact = compactCrimeForHistory(raw, `${pageCount}:${i}:${ts}`);
                    if (!compact.id || gapSeen.has(compact.id)) continue;
                    gapSeen.add(compact.id);
                    if (compact.executed_at && (compact.executed_at < gapFrom || compact.executed_at > gapTo)) continue;
                    compactPage.push(compact);
                    fetchedRows.push(compact);
                }
                await historyPutRecords('crimes', compactPage, row => row.id, row => row.executed_at);
                if (oldestTs) {
                    const checkpointFrom = Math.max(gapFrom, oldestTs + 1);
                    if (cursorTo >= checkpointFrom) {
                        await historyMarkCoverage('crimes', checkpointFrom, cursorTo);
                    }
                }
                onProgress?.(pageCount, fetchedRows.length, 0, missingRanges.length, r + 1);

                if (!crimes.length || crimes.length < 100 || !oldestTs || oldestTs <= gapFrom) break;
                const nextTo = oldestTs - 1;
                if (nextTo >= cursorTo) {
                    gapComplete = false;
                    break;
                }
                cursorTo = nextTo;
                if (pageCount > 6000) throw new Error('OC pagination exceeded the safety limit (6,000 pages).');
            }
            if (gapComplete) await historyMarkCoverage('crimes', gapFrom, gapTo);
        }

        const cachedRows = await historyGetRecords('crimes', range.from, range.to);
        const allById = new Map();
        for (const row of cachedRows) if (row?.id) allById.set(String(row.id), row);
        const allCrimes = Array.from(allById.values()).sort((a, b) => num(a.executed_at) - num(b.executed_at));
        const fetchedIdSet = new Set(fetchedRows.map(row => String(row.id)));
        const cacheReuseCount = allCrimes.reduce((n, row) => n + (fetchedIdSet.has(String(row.id)) ? 0 : 1), 0);

        for (const crime of allCrimes) {
            const ts = crimeExecutedTs(crime);
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
        onProgress?.(pageCount, allCrimes.length, cacheReuseCount, missingRanges.length, missingRanges.length);

        return {
            aggregates,
            pageCount,
            crimeCount: allCrimes.length,
            apiFetchedCount: fetchedRows.length,
            cacheReuseCount,
            missingRangeCount: missingRanges.length
        };
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

    function compactArmoryNewsForHistory(entry, fallback) {
        const ts = num(entry?.timestamp ?? entry?.time ?? 0);
        const text = String(entry?.text ?? entry?.news ?? '');
        const isXanax = isArmoryXanaxUse(text);
        return {
            id: String(entry?.id ?? fallback ?? ''),
            timestamp: ts,
            text,
            isXanax,
            memberId: isXanax ? armoryNewsMemberId(text) : 0,
            qty: isXanax ? armoryXanaxQuantity(text) : 0
        };
    }

    async function scanFactionArmoryXanax(range, onProgress, plannedMissingRanges = null) {
        const aggregates = {};
        for (const member of state.members) aggregates[Number(member.id)] = freshArmoryXanaxAgg();

        let pageCount = 0;
        const fetchedRows = [];
        const missingRanges = plannedMissingRanges === null
            ? await historyMissingRanges('armory', range.from, range.to)
            : cloneMissingRanges(plannedMissingRanges);

        for (let r = 0; r < missingRanges.length; r++) {
            const [gapFrom, gapTo] = missingRanges[r];
            let cursorTo = gapTo;
            let gapComplete = true;
            const gapSeen = new Set();

            while (cursorTo >= gapFrom) {
                if (state.abortScan) throw new Error('Scan cancelled.');
                const payload = await gmJson(apiUrl('/faction/news', {
                    cat: 'armoryAction',
                    striptags: 'false',
                    limit: 100,
                    sort: 'DESC',
                    from: gapFrom,
                    to: cursorTo
                }));
                pageCount += 1;
                const news = extractFactionNews(payload);
                const compactPage = [];
                let oldestTs = 0;

                for (let i = 0; i < news.length; i++) {
                    const entry = news[i];
                    const ts = num(entry?.timestamp ?? entry?.time ?? 0);
                    if (ts && (!oldestTs || ts < oldestTs)) oldestTs = ts;
                    const compact = compactArmoryNewsForHistory(entry, `${pageCount}:${i}:${ts}:${entry?.text ?? ''}`);
                    if (!compact.id || gapSeen.has(compact.id)) continue;
                    gapSeen.add(compact.id);
                    if (compact.timestamp && (compact.timestamp < gapFrom || compact.timestamp > gapTo)) continue;
                    compactPage.push(compact);
                    fetchedRows.push(compact);
                }
                await historyPutRecords('armory', compactPage, row => row.id, row => row.timestamp);
                if (oldestTs) {
                    const checkpointFrom = Math.max(gapFrom, oldestTs + 1);
                    if (cursorTo >= checkpointFrom) {
                        await historyMarkCoverage('armory', checkpointFrom, cursorTo);
                    }
                }
                onProgress?.(pageCount, fetchedRows.length, 0, missingRanges.length, r + 1);

                if (!news.length || news.length < 100 || !oldestTs || oldestTs <= gapFrom) break;
                const nextTo = oldestTs - 1;
                if (nextTo >= cursorTo) {
                    gapComplete = false;
                    break;
                }
                cursorTo = nextTo;
                if (pageCount > 6000) throw new Error('Armory-news pagination exceeded the safety limit (6,000 pages).');
            }
            if (gapComplete) await historyMarkCoverage('armory', gapFrom, gapTo);
        }

        const cachedRows = await historyGetRecords('armory', range.from, range.to);
        const allById = new Map();
        for (const row of cachedRows) if (row?.id) allById.set(String(row.id), row);
        const allNews = Array.from(allById.values()).sort((a, b) => num(a.timestamp) - num(b.timestamp));
        const fetchedIdSet = new Set(fetchedRows.map(row => String(row.id)));
        const cacheReuseCount = allNews.reduce((n, row) => n + (fetchedIdSet.has(String(row.id)) ? 0 : 1), 0);

        for (const entry of allNews) {
            if (!entry?.isXanax) continue;
            const uid = num(entry?.memberId, 0) || armoryNewsMemberId(entry?.text || '');
            if (!uid) continue;
            if (!aggregates[uid]) aggregates[uid] = freshArmoryXanaxAgg();
            const qty = Math.max(1, num(entry?.qty, 1));
            const ts = num(entry?.timestamp, 0);
            const stat = aggregates[uid];
            stat.used += qty;
            stat.events += 1;
            if (ts) {
                if (!stat.firstTs || ts < stat.firstTs) stat.firstTs = ts;
                if (!stat.lastTs || ts > stat.lastTs) stat.lastTs = ts;
            }
        }
        onProgress?.(pageCount, allNews.length, cacheReuseCount, missingRanges.length, missingRanges.length);

        return {
            aggregates,
            pageCount,
            newsCount: allNews.length,
            apiFetchedCount: fetchedRows.length,
            cacheReuseCount,
            missingRangeCount: missingRanges.length
        };
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

    function downloadStatsPanelHtml(member, range, meta) {
        const panel = state.statsPanel;
        if (!panel?.isConnected) throw new Error('The member stats panel is not open.');

        const clone = panel.cloneNode(true);
        clone.querySelectorAll('.bftd-fws-resize,.bftd-fws-close,.bftd-fws-theme-btn,.bftd-fws-theme-pop,#bftd-fws-download-html').forEach(el => el.remove());
        clone.style.position = 'relative';
        clone.style.left = 'auto';
        clone.style.top = 'auto';
        clone.style.right = 'auto';
        clone.style.bottom = 'auto';
        clone.style.width = 'min(100%, 980px)';
        clone.style.height = 'auto';
        clone.style.maxHeight = 'none';
        clone.style.margin = '0 auto';
        clone.style.zIndex = '1';
        const cloneBody = clone.querySelector('.bftd-fws-body');
        if (cloneBody) {
            cloneBody.style.maxHeight = 'none';
            cloneBody.style.height = 'auto';
            cloneBody.style.overflow = 'visible';
        }

        const cssText = ['bftd-fws-style','bftd-fh-ui-v2-style']
            .map(id => document.getElementById(id)?.textContent || '')
            .join('\n');
        const computed = getComputedStyle(document.documentElement);
        const vars = [
            '--bftd-bg','--bftd-panel','--bftd-panel2','--bftd-header','--bftd-input','--bftd-member',
            '--bftd-stat','--bftd-table-header','--bftd-text','--bftd-muted','--bftd-accent','--bftd-border',
            '--bftd-good','--bftd-bad','--bftd-info','--bftd-primary-btn','--bftd-primary-btn-text',
            '--bftd-secondary-btn','--bftd-secondary-btn-text','--bftd-danger-btn','--bftd-danger-btn-text',
            '--bftd-btn-primary','--bftd-btn-primary-text','--bftd-btn-secondary','--bftd-btn-secondary-text',
            '--bftd-btn-danger','--bftd-btn-danger-text','--bftd-badge','--bftd-progress-track','--bftd-progress-bar',
            '--bftd-disabled','--bftd-disabled-text','--bftd-error-bg','--bftd-error-text','--bftd-success-bg',
            '--bftd-success-text','--bftd-scrollbar-track','--bftd-scrollbar-thumb','--bftd-scroll-track',
            '--bftd-scroll-thumb','--bftd-launcher-bg','--bftd-launcher-border','--bftd-launcher-text'
        ];
        const rootVars = vars.map(name => `${name}:${computed.getPropertyValue(name).trim()};`).join('');
        const title = `${member.name} [${member.id}] — Faction Stats — ${dateTime(range.from)} to ${dateTime(range.to)}`;
        const generated = new Date(meta.generatedAt || Date.now()).toLocaleString();
        const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>
<style>
:root{${rootVars}}
${cssText}
html,body{margin:0;min-height:100%;background:var(--bftd-bg);color:var(--bftd-text);font-family:Arial,Helvetica,sans-serif;}
body{padding:20px;box-sizing:border-box;}
.bftd-fws-panel{position:relative!important;left:auto!important;top:auto!important;right:auto!important;bottom:auto!important;width:min(100%,980px)!important;height:auto!important;max-height:none!important;margin:0 auto!important;z-index:1!important;}
.bftd-fws-body{height:auto!important;max-height:none!important;overflow:visible!important;}
.bftd-fws-resize{display:none!important;}
@media print{body{padding:0}.bftd-fws-panel{width:100%!important;border:none!important;box-shadow:none!important;}}
</style>
</head>
<body>
${clone.outerHTML}
<!-- Exported by Faction Helper v${esc(APP.version)}. Scan generated: ${esc(generated)} -->
</body>
</html>`;

        const factionPart = safeDownloadName(state.faction?.name || `Faction_${state.faction?.id || 0}`);
        const memberPart = safeDownloadName(`${member.name}_${member.id}`);
        const filename = `Faction_Helper_${factionPart}_${memberPart}_Range_Stats.html`;
        downloadTextFile(filename, html, 'text/html;charset=utf-8');
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
        const tenure = memberFactionTenure(member, range, meta.memberSnapshot ? meta.generatedAt : Date.now());
        const tenureDays = tenure.days === null ? '—' : fmt(tenure.days);
        const joinedDuringText = tenure.joinedDuringPeriod === null ? 'UNKNOWN' : (tenure.joinedDuringPeriod ? 'YES' : 'NO');
        const joinedDateText = tenure.joinedTs ? dateTime(tenure.joinedTs) : 'Unknown';
        const warsInFaction = memberWarsInFaction(
            tenure,
            meta.warSummary?.wars || [],
            Math.floor(num(meta.generatedAt, Date.now()) / 1000)
        );
        const warsInFactionDisplay = warsInFaction === null ? '—' : fmt(warsInFaction);
        const detailedWarDataIncluded = meta.detailedWarDataIncluded !== false;
        const chainSummaryAvailable = Boolean(meta.chainSummary && typeof meta.chainSummary === 'object');
        const memberChains = chainSummaryAvailable
            ? (meta.chainSummary?.memberParticipation?.[String(member.id)] || meta.chainSummary?.memberParticipation?.[Number(member.id)] || [])
            : [];
        const totalChainHits = memberChains.reduce((sum, row) => sum + num(row?.hits), 0);
        const chainRows = memberChains
            .slice()
            .sort((a, b) => num(a.start) - num(b.start))
            .map(c => {
                const hasReportData = c.attacks !== undefined || c.leave !== undefined || c.best !== undefined;
                const val = (value, decimals = 0) => hasReportData ? fmt(value, decimals) : '—';
                return `
                <tr>
                    <td><b>${esc(dateTime(c.start))}</b><div class="bftd-fws-note">${esc(dateTime(c.end))} • Chain #${esc(c.id)}</div></td>
                    <td>${val(c.respect, 2)}</td>
                    <td>${val(c.best, 2)}</td>
                    <td>${val(c.avg, 2)}</td>
                    <td>${val(c.attacks)}</td>
                    <td>${val(c.leave)}</td>
                    <td>${val(c.mug)}</td>
                    <td>${val(c.hosp)}</td>
                    <td>${val(c.war)}</td>
                    <td>${val(c.assist)}</td>
                    <td>${val(c.retal)}</td>
                    <td>${val(c.overseas)}</td>
                    <td>${val(c.draw)}</td>
                    <td>${val(c.escape)}</td>
                    <td>${val(c.loss)}</td>
                </tr>`;
            }).join('') || `<tr><td colspan="15">${chainSummaryAvailable ? 'No completed-chain participation was found for this member in the selected period.' : 'Chain participation was not included in this saved scan. Enable Include Chains and rescan this period to add chain-report data.'}</td></tr>`;

        const warRows = Object.values(s.warBreakdown || {})
            .sort((a, b) => num(a.start) - num(b.start))
            .map(w => detailedWarDataIncluded ? `
                <tr>
                    <td>${esc(w.opponentName || `Faction ${w.opponentId}`)}<div class="bftd-fws-note">#${esc(w.id)} • ${esc(dateTime(w.start))}</div></td>
                    <td>${fmt(w.warHits)}</td>
                    <td>${fmt(w.warAssists)}</td>
                    <td>${fmt(w.warRetals)}</td>
                    <td>${fmt(w.outsideHits)}</td>
                    <td>${fmt(w.reportAttacks)}</td>
                    <td>${fmt(w.score, 2)}</td>
                </tr>
            ` : `
                <tr>
                    <td>${esc(w.opponentName || `Faction ${w.opponentId}`)}<div class="bftd-fws-note">#${esc(w.id)} • ${esc(dateTime(w.start))}</div></td>
                    <td>${fmt(w.warHits)}</td>
                    <td>${fmt(w.score, 2)}</td>
                </tr>
            `).join('') || `<tr><td colspan="${detailedWarDataIncluded ? 7 : 3}">No member activity was found in the ranked wars for this period.</td></tr>`;

        const outcomes = Object.entries(s.outcomeCounts || {})
            .sort((a, b) => b[1] - a[1])
            .map(([name, count]) => `<tr><td>${esc(name)}</td><td>${fmt(count)}</td></tr>`)
            .join('') || '<tr><td>No outgoing attacks found</td><td>0</td></tr>';

        body.innerHTML = `
            <div class="bftd-fws-card">
                <div style="font-weight:800;margin-bottom:8px">FACTION TENURE</div>
                <div class="bftd-fws-grid">
                    <div class="bftd-fws-stat"><div class="v">${esc(tenureDays)}</div><div class="k">DAYS IN FACTION</div></div>
                    <div class="bftd-fws-stat"><div class="v">${esc(joinedDuringText)}</div><div class="k">JOINED DURING USED PERIOD</div></div>
                </div>
                <div class="bftd-fws-note" style="margin-top:8px"><b>Faction join date:</b> ${esc(joinedDateText)}${tenure.estimated ? ' <span class="bftd-fws-note">(estimated from days in faction)</span>' : ''}</div>
            </div>

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
                    <div class="bftd-fws-stat"><div class="v">${esc(warsInFactionDisplay)}</div><div class="k">WARS MEMBER WAS IN FACTION</div></div>
                    <div class="bftd-fws-stat"><div class="v">${fmt(s.warsWithWarHits)}</div><div class="k">WARS WITH WAR HITS</div></div>
                    <div class="bftd-fws-stat"><div class="v">${fmt(s.warHits)}</div><div class="k">WAR HITS</div></div>
                    ${detailedWarDataIncluded ? `
                    <div class="bftd-fws-stat"><div class="v">${fmt(s.warAssists)}</div><div class="k">WAR ASSISTS</div></div>
                    <div class="bftd-fws-stat"><div class="v">${fmt(s.warRetals)}</div><div class="k">WAR RETALS</div></div>
                    <div class="bftd-fws-stat"><div class="v">${fmt(s.warAttempts)}</div><div class="k">WAR-TARGET ATTEMPTS</div></div>
                    <div class="bftd-fws-stat"><div class="v">${fmt(s.reportAttacks)}</div><div class="k">RW REPORT ATTACKS</div></div>
                    ` : ''}
                    <div class="bftd-fws-stat"><div class="v">${fmt(s.warScore, 2)}</div><div class="k">RW REPORT SCORE</div></div>
                </div>
            </div>

            ${detailedWarDataIncluded ? `
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

            ` : `
            <div class="bftd-fws-card">
                <div style="font-weight:800;margin-bottom:7px">BASIC / FAST WAR DATA</div>
                <div class="bftd-fws-note">This saved scan used ranked-war reports only for war-hit totals. Assists, outside hits, retals, overseas/group modifiers, general attack outcomes and other detailed outgoing-attack classifications were intentionally not read.</div>
            </div>
            `}
            <div class="bftd-fws-card">
                <div style="font-weight:800;margin-bottom:7px">WAR-BY-WAR BREAKDOWN</div>
                <div style="overflow:auto">
                    <table class="bftd-fws-table" style="min-width:${detailedWarDataIncluded ? '700px' : '460px'}">
                        <thead>${detailedWarDataIncluded
                            ? '<tr><th>WAR / OPPONENT</th><th>WAR HITS</th><th>ASSISTS</th><th>RETALS</th><th>OUTSIDE HITS</th><th>REPORT ATTACKS</th><th>SCORE</th></tr>'
                            : '<tr><th>WAR / OPPONENT</th><th>WAR HITS</th><th>SCORE</th></tr>'}</thead>
                        <tbody>${warRows}</tbody>
                    </table>
                </div>
            </div>

            <div class="bftd-fws-card">
                <div style="font-weight:800;margin-bottom:8px">CHAIN PARTICIPATION</div>
                <div class="bftd-fws-grid" style="margin-bottom:9px">
                    <div class="bftd-fws-stat"><div class="v">${chainSummaryAvailable ? fmt(memberChains.length) : '—'}</div><div class="k">CHAINS PARTICIPATED</div></div>
                    <div class="bftd-fws-stat"><div class="v">${chainSummaryAvailable ? fmt(totalChainHits) : '—'}</div><div class="k">CHAIN HITS</div></div>
                    <div class="bftd-fws-stat"><div class="v">${chainSummaryAvailable ? fmt(meta.chainSummary?.chainCount || 0) : '—'}</div><div class="k">FACTION CHAINS IN PERIOD</div></div>
                </div>
                <div style="overflow:auto">
                    <table class="bftd-fws-table" style="min-width:1320px">
                        <thead><tr><th>DATE / TIME</th><th>RESPECT</th><th>BEST</th><th>AVG</th><th>ATTACKS</th><th>LEAVE</th><th>MUG</th><th>HOSP</th><th>WAR</th><th>ASSIST</th><th>RETAL</th><th>OVERSEAS</th><th>DRAW</th><th>ESCAPE</th><th>LOSS</th></tr></thead>
                        <tbody>${chainRows}</tbody>
                    </table>
                </div>
                <div class="bftd-fws-note" style="margin-top:8px">Chain rows now come directly from Torn's per-chain reports. Missing reports are fetched once at the 2-second report pace and stored permanently in the Master Data Cache for reuse.</div>
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
                    ${detailedWarDataIncluded ? `First outgoing attack: <b>${esc(dateTime(s.firstAttackTs))}</b><br>
                    Last outgoing attack: <b>${esc(dateTime(s.lastAttackTs))}</b><br>` : `Detailed outgoing attack history: <b>Not scanned — Basic/Fast war mode</b><br>`}
                    First completed OC: <b>${esc(dateTime(oc.firstOcTs))}</b><br>
                    Last completed OC: <b>${esc(dateTime(oc.lastOcTs))}</b><br>
                    Xanax snapshot totals: ${xanaxLoaded ? `<b>${fmt(xanax.startTotal)}</b> → <b>${fmt(xanax.endTotal)}</b>` : '<b>Not loaded — use the button below to spend 2 API calls.</b>'}<br>
                    Faction armory Xanax: <b>${fmt(armoryXanax.used || 0)}</b> across <b>${fmt(armoryXanax.events || 0)}</b> armory log event(s)<br>
                    Ranked-war scan: <b>${fmt(meta.warSummary?.warCount || 0)}</b> wars; <b>${fmt(meta.warSummary?.historyPages || 0)}</b> history page(s); <b>${fmt(meta.warSummary?.reportApiCalls || 0)}</b> new war-report API call(s); <b>${fmt(meta.warSummary?.reportCacheHits || 0)}</b> cached war report(s)<br>
                    Chain scan: ${chainSummaryAvailable ? `<b>${fmt(meta.chainSummary?.chainCount || 0)}</b> completed chain(s); <b>${fmt(meta.chainSummary?.historyPages || 0)}</b> new chain-history API page(s); <b>${fmt(meta.chainSummary?.reportApiCalls || 0)}</b> new chain-report call(s); <b>${fmt(meta.chainSummary?.reportCacheHits || 0)}</b> chain report(s) reused from the Master Cache` : '<b>Not included in this saved scan</b>'}<br>
                    Local history reuse: ${detailedWarDataIncluded ? `<b>${fmt(meta.historyCacheStats?.attacks?.reused || 0)}</b> attack(s), ` : ''}<b>${fmt(meta.historyCacheStats?.crimes?.reused || 0)}</b> OC(s), <b>${fmt(meta.historyCacheStats?.armory?.reused || 0)}</b> armory record(s)<br>
                    ${detailedWarDataIncluded ? `Attack scan: <b>${fmt(meta.pageCount)}</b> new API page(s) / <b>${fmt(meta.fetchedCount)}</b> outgoing attacks checked` : 'Attack scan: <b>Skipped — Basic/Fast war mode</b>'}<br>
                    OC scan: <b>${fmt(meta.ocPageCount)}</b> new API page(s) / <b>${fmt(meta.ocCount)}</b> completed OCs checked<br>
                    Armory scan: <b>${fmt(meta.armoryPageCount)}</b> new API page(s) / <b>${fmt(meta.armoryNewsCount)}</b> records checked<br>
                    Scan generated: <b>${esc(generatedText)}</b>
                </div>
            </div>

            <div class="bftd-fws-row wrap">
                <button id="bftd-fws-load-xanax" class="bftd-fws-btn secondary">${xanaxLoaded ? 'REFRESH XANAX (2 API)' : 'LOAD XANAX (2 API)'}</button>
                <button id="bftd-fws-profile" class="bftd-fws-btn secondary">OPEN PROFILE</button>
                <button id="bftd-fws-download-html" class="bftd-fws-btn secondary">DOWNLOAD HTML</button>
            </div>

            <div class="bftd-fws-note" style="margin-top:9px">
                ${detailedWarDataIncluded
                    ? "Detailed mode follows RWPH Advanced classification. Torn ranked-war report attacks are the authoritative WAR HITS total. Detailed outgoing attacks provide assists, outside hits, retal subtypes, overseas/group modifiers and outcomes. Torn's is_ranked_war flag / war modifier is preserved and used so valid war hits are not lost on war-end timestamp edge cases. War retals remain war hits plus the retal subtype; non-war retals remain outside hits plus the retal subtype."
                    : "Basic/Fast war mode uses Torn's ranked-war report attack totals as WAR HITS. Detailed attack-history classifications such as assists, outside hits, retals, overseas/group modifiers and result breakdowns are intentionally not scanned."}
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
        body.querySelector('#bftd-fws-download-html')?.addEventListener('click', () => {
            try {
                downloadStatsPanelHtml(member, range, meta);
            } catch (err) {
                const button = body.querySelector('#bftd-fws-download-html');
                if (button) {
                    button.textContent = 'HTML EXPORT ERROR';
                    button.title = err.message || String(err);
                }
            }
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

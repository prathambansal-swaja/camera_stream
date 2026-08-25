const axios = require("axios");
const AxiosDigestAuth =
    require("@mhoc/axios-digest-auth").default;
const https = require("https");

const CAMERA_IP = "192.168.1.2";
const USERNAME = "admin";
const PASSWORD = "admin";
const BASE_URL = `https://${CAMERA_IP}`;

const PAGE_SIZE = 21;
const MAX_UUIDS = 21;
const STATS_PAGES = 3;
const POLL_INTERVAL_MS = 20000;

const httpsAgent = new https.Agent({
    rejectUnauthorized: false
});

const digestAuth = new AxiosDigestAuth({
    username: USERNAME,
    password: PASSWORD
});

let sessionCookie = null;
let csrfToken = null;
let groupMapCache = null;
let verbose = true;
let loopRunning = false;
let loopTimer = null;
let loopInFlight = false;
const liveFaces = new Map();

function cameraTimestamp(date = new Date()) {
    const pad = (value) => String(value).padStart(2, "0");

    return (
        `${date.getFullYear()}-` +
        `${pad(date.getMonth() + 1)}-` +
        `${pad(date.getDate())}@` +
        `${pad(date.getHours())}:` +
        `${pad(date.getMinutes())}:` +
        `${pad(date.getSeconds())}`
    );
}

function dateTimeText(date) {
    const pad = (value) => String(value).padStart(2, "0");

    return (
        `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
        `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
    );
}

function searchWindow() {
    const end = new Date();
    const start = new Date(end.getTime() - 180 * 24 * 60 * 60 * 1000);

    return {
        StartTime: dateTimeText(start),
        EndTime: dateTimeText(end)
    };
}

async function login() {
    console.log("Logging in...");

    const response = await digestAuth.request({
        method: "POST",
        url: `${BASE_URL}/API/Web/Login`,
        data: {
            data: {
                support_new_schedule: true,
                remote_terminal_info: "WEB,chrome"
            }
        },
        headers: {
            "Content-Type": "application/json"
        },
        httpsAgent
    });

    const setCookie = response.headers["set-cookie"];

    if (setCookie) {
        const session = setCookie.find((cookie) =>
            cookie.startsWith("session_443=")
        );

        if (session) {
            sessionCookie = session.split(";")[0];
        }
    }

    csrfToken =
        response.headers["x-csrftoken"] ||
        response.headers["X-CSRFToken"];

    console.log("Login status:", response.status);
    console.log("Session cookie:", sessionCookie ? "OK" : "NOT FOUND");
    console.log("CSRF token:", csrfToken ? "OK" : "NOT FOUND");

    if (!sessionCookie) {
        throw new Error("session_443 cookie was not received.");
    }

    if (!csrfToken) {
        throw new Error("CSRF token was not received.");
    }

    console.log("Login successful.\n");
}

async function heartbeat() {
    await apiRequest({
        method: "POST",
        url: `${BASE_URL}/API/Login/Heartbeat?${cameraTimestamp()}`,
        data: {
            version: "1.0",
            data: {},
            actionType: "create"
        }
    });
}

async function ensureSession() {
    if (sessionCookie && csrfToken && groupMapCache) {
        return groupMapCache;
    }

    await login();
    groupMapCache = await getGroups();
    return groupMapCache;
}

function resetSession() {
    sessionCookie = null;
    csrfToken = null;
    groupMapCache = null;
}

async function apiRequest(options) {
    const headers = {
        Accept: "application/json; charset=utf-8",
        "Content-Type": "application/json",
        Cookie: sessionCookie,
        Origin: BASE_URL,
        Referer: `${BASE_URL}/`,
        "X-CSRFToken": csrfToken,
        "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) " +
            "AppleWebKit/537.36 (KHTML, like Gecko) " +
            "Chrome/151.0.0.0 Safari/537.36"
    };

    if (verbose) {
        console.log("\nAPI REQUEST:");
        console.log(options.method, options.url);
    }

    const response = await axios({
        ...options,
        headers,
        httpsAgent,
        timeout: options.timeout || 120000,
        maxContentLength: Infinity,
        maxBodyLength: Infinity
    });

    return response.data;
}

async function getGroups() {
    console.log("Fetching groups...");

    const payload = {
        version: "1.0",
        data: {
            MsgId: null,
            TypeFlags: 1,
            DefaultVal: 0,
            WithInternal: 0,
            SimpleInfo: 0,
            GroupsId: []
        }
    };

    const url = `${BASE_URL}/API/AI/FDGroup/Get?${cameraTimestamp()}`;
    console.log("URL:", url);

    const response = await apiRequest({
        method: "POST",
        url,
        data: payload
    });

    const groups = response.data?.Group || [];
    const groupMap = new Map();

    for (const group of groups) {
        groupMap.set(Number(group.Id), group.Name);
    }

    console.log(`Groups received: ${groupMap.size}`);

    for (const [id, name] of groupMap) {
        console.log(`  ${id} -> ${name}`);
    }

    return groupMap;
}

function decodeFaceJpeg(face) {
    const raw = String(face.FaceImage || "").replace(/\s+/g, "");

    if (!raw) {
        return null;
    }

    const jpeg = Buffer.from(raw, "base64");

    if (jpeg.length < 16 || jpeg[0] !== 0xff || jpeg[1] !== 0xd8) {
        return null;
    }

    return jpeg;
}

function listLiveFaces() {
    return [...liveFaces.values()].sort((a, b) => b.time - a.time);
}

function getLiveFaceJpeg(uuid) {
    return liveFaces.get(String(uuid || ""))?.jpeg || null;
}

function setLiveGallery(entries) {
    liveFaces.clear();

    for (const entry of entries) {
        liveFaces.set(entry.uuid, entry);
    }
}

async function getUuids() {
    if (verbose) {
        console.log("Fetching latest snapped-face UUIDs...");
    }

    const window = searchWindow();

    const search = await apiRequest({
        method: "POST",
        url: `${BASE_URL}/API/AI/SnapedFaces/Search?${cameraTimestamp()}`,
        data: {
            version: "1.0",
            data: {
                MsgId: "",
                Engine: 1,
                StartTime: window.StartTime,
                EndTime: window.EndTime
            }
        }
    });

    const searchCount = Number(search.data?.Count || 0);
    const startIndex = Math.max(0, searchCount - PAGE_SIZE);

    if (verbose) {
        console.log("SnapedFaces Search Count:", searchCount);
        console.log("GetByIndex StartIndex (latest page):", startIndex);
    }

    const index = await apiRequest({
        method: "POST",
        url: `${BASE_URL}/API/AI/SnapedFaces/GetByIndex?${cameraTimestamp()}`,
        data: {
            version: "1.0",
            data: {
                MsgId: "",
                Engine: 1,
                StartIndex: startIndex,
                Count: PAGE_SIZE,
                StartTime: window.StartTime,
                EndTime: window.EndTime,
                SimpleInfo: 1,
                WithFaceImage: 0,
                WithBodyImage: 0,
                WithBackgroud: 0,
                WithFeature: 0
            }
        }
    });

    const faces = index.data?.SnapedFaceInfo || [];
    const latest = [...faces]
        .sort((a, b) => Number(b.StartTime || 0) - Number(a.StartTime || 0))
        .slice(0, MAX_UUIDS);

    const uuids = latest
        .map((face) => face.UUId)
        .filter(Boolean);

    if (verbose) {
        console.log(
            `GetByIndex returned ${faces.length} face(s), ` +
            `TotalCount=${index.data?.TotalCount}, Count=${index.data?.Count}`
        );

        if (latest[0]) {
            console.log("Newest face on this page:", {
                UUId: latest[0].UUId,
                StartTime: latest[0].StartTime,
                EndTime: latest[0].EndTime
            });
        }

        console.log(`Latest UUIDs: ${uuids.length}`);
    }

    return uuids;
}

async function getFacesById(uuids) {
    if (!uuids.length) {
        return [];
    }

    if (verbose) {
        console.log(`Fetching ${uuids.length} face(s) via GetById...`);
    }

    const response = await apiRequest({
        method: "POST",
        url: `${BASE_URL}/API/AI/SnapedFaces/GetById?${cameraTimestamp()}`,
        timeout: 120000,
        data: {
            version: "1.0",
            data: {
                MsgId: "",
                Engine: 1,
                UUIds: uuids,
                WithBackgroud: 0,
                WithBodyImage: 0,
                WithFaceImage: 1,
                WithFeature: 0
            }
        }
    });

    const faces = response.data?.SnapedFaceInfo || [];
    if (verbose) {
        console.log(`GetById Count: ${response.data?.Count}, faces: ${faces.length}`);

        if (faces[0]) {
            console.log("First face:", {
                UUId: faces[0].UUId,
                StartTime: faces[0].StartTime,
                EndTime: faces[0].EndTime,
                SnapId: faces[0].SnapId,
                hasFaceImage: Boolean(faces[0].FaceImage)
            });
        }
    }

    return faces;
}

async function getLatestStatistics() {
    if (verbose) {
        console.log("Fetching latest Face Statistics...");
    }

    const window = searchWindow();

    const search = await apiRequest({
        method: "POST",
        url: `${BASE_URL}/API/AI/FaceStatistics/Search?${cameraTimestamp()}`,
        data: {
            version: "1.0",
            data: {
                MsgId: "",
                StartTime: window.StartTime,
                EndTime: window.EndTime
            }
        }
    });

    const searchCount = Number(search.data?.Count || 0);
    const fetchCount = PAGE_SIZE * STATS_PAGES;
    const startIndex = Math.max(0, searchCount - fetchCount);

    if (verbose) {
        console.log("FaceStatistics Search Count:", searchCount);
        console.log("FaceStatistics StartIndex (latest pages):", startIndex);
    }

    const stats = [];

    for (let index = startIndex; index < searchCount; index += PAGE_SIZE) {
        const count = Math.min(PAGE_SIZE, searchCount - index);
        const response = await apiRequest({
            method: "POST",
            url: `${BASE_URL}/API/AI/FaceStatistics/Get?${cameraTimestamp()}`,
            data: {
                version: "1.0",
                data: {
                    MsgId: "",
                    StartIndex: index,
                    Count: count,
                    StartTime: window.StartTime,
                    EndTime: window.EndTime
                }
            }
        });

        const page = response.data?.Statistics || [];
        stats.push(...page);

        if (verbose) {
            console.log(
                `FaceStatistics Get StartIndex=${index} Count=${count} ` +
                `returned ${page.length}`
            );
        }
    }

    if (stats[0]) {
        const sample = { ...stats[0] };

        for (const key of Object.keys(sample)) {
            if (typeof sample[key] === "string" && sample[key].length > 80) {
                sample[key] = `[${sample[key].length} chars]`;
            }
        }

        if (verbose) {
            console.log("First statistic:", sample);
        }
    }

    return stats;
}

function matchStatistic(face, statistics, usedIndexes) {
    const start = Number(face.StartTime);
    const end = Number(face.EndTime);

    for (let i = 0; i < statistics.length; i++) {
        if (usedIndexes.has(i)) {
            continue;
        }

        const row = statistics[i];
        const time = Number(row.Time ?? row.time);

        if (Number.isNaN(time) || Number.isNaN(start) || Number.isNaN(end)) {
            continue;
        }

        if (time >= start && time <= end) {
            usedIndexes.add(i);
            return row;
        }
    }

    return null;
}

async function fetchLatestFaces() {
    let groupMap;

    try {
        groupMap = await ensureSession();
        await heartbeat();
    }
    catch (error) {
        resetSession();
        groupMap = await ensureSession();
    }

    const uuids = await getUuids();

    if (!uuids.length) {
        console.log("[fetchFaces] No faces from camera.");
        return { saved: 0, skipped: 0, unmatched: 0 };
    }

    const missing = uuids.filter((uuid) => !liveFaces.has(uuid));
    const fetched = missing.length ? await getFacesById(missing) : [];
    const fetchedById = new Map(
        fetched.map((face) => [face.UUId, face])
    );
    const statistics = missing.length ? await getLatestStatistics() : [];
    const usedStats = new Set();
    const nextGallery = [];
    let saved = 0;
    let skipped = 0;
    let unmatched = 0;

    for (const uuid of uuids) {
        const cached = liveFaces.get(uuid);

        if (cached) {
            nextGallery.push(cached);
            skipped += 1;
            continue;
        }

        const face = fetchedById.get(uuid);

        if (!face) {
            unmatched += 1;
            continue;
        }

        const stat = matchStatistic(face, statistics, usedStats);

        if (!stat) {
            unmatched += 1;
            console.log(
                `No FaceStatistics match for ${face.UUId} ` +
                `(StartTime=${face.StartTime}, EndTime=${face.EndTime})`
            );
            continue;
        }

        const groupId = Number(stat.Group ?? stat.group);
        const groupName = groupMap.get(groupId) || `Group ${groupId}`;
        const time = Number(stat.Time ?? stat.time);

        console.log(
            `Match ${face.UUId}: Group ${groupId} (${groupName}) Time=${time}`
        );

        const jpeg = decodeFaceJpeg(face);

        if (!jpeg) {
            unmatched += 1;
            continue;
        }

        nextGallery.push({
            uuid,
            group: groupName,
            time,
            jpeg,
            fetchedAt: Date.now()
        });
        saved += 1;
    }

    setLiveGallery(nextGallery);

    console.log(
        `[fetchFaces] live ${nextGallery.length} (new ${saved}, cached ${skipped}, unmatched ${unmatched})`
    );

    return { saved, skipped, unmatched };
}

function startFetchFacesLoop(intervalMs = POLL_INTERVAL_MS) {
    if (loopRunning) {
        return;
    }

    loopRunning = true;
    verbose = false;

    const tick = async () => {
        if (!loopRunning || loopInFlight) {
            return;
        }

        loopInFlight = true;

        try {
            await fetchLatestFaces();
        }
        catch (error) {
            resetSession();
            console.error(
                "[fetchFaces]",
                error.response?.data || error.message || error
            );
        }
        finally {
            loopInFlight = false;

            if (loopRunning) {
                loopTimer = setTimeout(tick, intervalMs);
            }
        }
    };

    console.log(
        `[fetchFaces] polling latest faces every ${intervalMs / 1000}s`
    );
    tick();
}

function stopFetchFacesLoop() {
    loopRunning = false;

    if (loopTimer) {
        clearTimeout(loopTimer);
        loopTimer = null;
    }
}

module.exports = {
    fetchLatestFaces,
    startFetchFacesLoop,
    stopFetchFacesLoop,
    listLiveFaces,
    getLiveFaceJpeg
};

if (require.main === module) {
    startFetchFacesLoop();
}

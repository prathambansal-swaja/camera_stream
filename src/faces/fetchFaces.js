const axios = require("axios");
const AxiosDigestAuth =
    require("@mhoc/axios-digest-auth").default;
const https = require("https");
const fs = require("fs");
const path = require("path");

const CAMERA_IP = "192.168.1.2";
const USERNAME = "admin";
const PASSWORD = "admin";
const BASE_URL = `https://${CAMERA_IP}`;

const PAGE_SIZE = 21;
const MAX_UUIDS = 21;
const OUTPUT_DIR = path.join(__dirname, "face_images");

const httpsAgent = new https.Agent({
    rejectUnauthorized: false
});

const digestAuth = new AxiosDigestAuth({
    username: USERNAME,
    password: PASSWORD
});

let sessionCookie = null;
let csrfToken = null;

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

    console.log("\nAPI REQUEST:");
    console.log(options.method, options.url);

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

function loadSavedUuids() {
    if (!fs.existsSync(OUTPUT_DIR)) {
        return new Set();
    }

    const ids = new Set();

    for (const file of fs.readdirSync(OUTPUT_DIR)) {
        const match = String(file).match(/_(.+)\.jpg$/i);

        if (match) {
            ids.add(match[1]);
        }
    }

    return ids;
}

async function getUuids() {
    console.log("Fetching latest snapped-face UUIDs...");

    const window = searchWindow();
    const savedUuids = loadSavedUuids();

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

    console.log("SnapedFaces Search Count:", searchCount);
    console.log("GetByIndex StartIndex (latest page):", startIndex);

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
        .filter(Boolean)
        .filter((uuid) => !savedUuids.has(uuid));

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

    console.log(`Already saved: ${savedUuids.size}`);
    console.log(`New UUIDs to fetch: ${uuids.length}`);

    return uuids;
}

async function getFacesById(uuids) {
    if (!uuids.length) {
        return [];
    }

    console.log(`Fetching ${uuids.length} face(s) via GetById...`);

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

    return faces;
}

function saveFaceImage(face) {
    const raw = String(face.FaceImage || "").replace(/\s+/g, "");

    if (!raw) {
        console.log(`No FaceImage for ${face.UUId}`);
        return false;
    }

    const jpeg = Buffer.from(raw, "base64");

    if (jpeg.length < 16 || jpeg[0] !== 0xff || jpeg[1] !== 0xd8) {
        console.log(`FaceImage is not JPEG for ${face.UUId}`);
        return false;
    }

    const safeId = String(face.UUId || "unknown").replace(/[<>:"/\\|?*]/g, "_");
    const filename = `${face.StartTime}_${safeId}.jpg`;
    const outputPath = path.join(OUTPUT_DIR, filename);

    if (fs.existsSync(outputPath)) {
        console.log(`Already exists, skipped: ${filename}`);
        return false;
    }

    fs.writeFileSync(outputPath, jpeg);
    console.log(`Saved: ${filename} (${jpeg.length} bytes)`);
    return true;
}

async function main() {
    try {
        fs.mkdirSync(OUTPUT_DIR, { recursive: true });

        await login();
        await getGroups();

        const uuids = await getUuids();

        if (!uuids.length) {
            console.log("Latest 21 faces are already in the folder. Nothing new to add.");
            return;
        }

        const faces = await getFacesById(uuids);
        let saved = 0;
        let skipped = 0;

        for (const face of faces) {
            if (saveFaceImage(face)) {
                saved += 1;
            }
            else {
                skipped += 1;
            }
        }

        console.log("\n================================");
        console.log(`New images added: ${saved}`);
        console.log(`Skipped: ${skipped}`);
        console.log(`Folder now has: ${loadSavedUuids().size} file(s)`);
        console.log(`Folder: ${OUTPUT_DIR}`);
        console.log("================================");
    }
    catch (error) {
        console.error("\nERROR:");
        console.error(
            error.response?.data ||
            error.message ||
            error
        );
    }
}

main();

const fs = require("fs");
const path = require("path");

const {
    createCameraHttpsClient
} = require("./cameraHttps");

const snapsDir = path.join(__dirname, "..", "..", "snaps");
const indexFile = path.join(snapsDir, "index.json");
const pagerTemplateFile = path.join(snapsDir, "pager-template.json");

const PAGE_SIZE = 21;
const MAX_PAGES = Number(process.env.FACE_MAX_PAGES || 80);
const PAGE_DELAY_MS = 1500;

let client;
let syncing = false;
let lastError = null;
let lastSyncAt = null;
let pollTimer = null;
let lastBrowserAttempt = 0;
let syncProgress = null;
let pendingFull = false;
let cameraBrowser = null;
let cameraPage = null;
let cameraSessionReady = false;
let sessionStart = null;
let keepAliveTimer = null;

function getClient() {
    if (!client) {
        client = createCameraHttpsClient({
            ip: process.env.CAMERA_IP,
            username: process.env.CAMERA_USERNAME,
            password: process.env.CAMERA_PASSWORD
        });
    }

    return client;
}

function pad(value) {
    return String(value).padStart(2, "0");
}

function cameraTimestamp(date = new Date()) {
    return (
        `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
        `@${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
    );
}

function safeName(value) {
    return String(value || "unknown").replace(/[^\w.-]+/g, "_");
}

function loadIndex() {
    try {
        return JSON.parse(fs.readFileSync(indexFile, "utf8"));
    }
    catch {
        return [];
    }
}

function saveIndex(entries) {
    fs.writeFileSync(indexFile, JSON.stringify(entries, null, 2));
}

function loadPagerTemplate() {
    try {
        const parsed = JSON.parse(fs.readFileSync(pagerTemplateFile, "utf8"));

        if (parsed && parsed.url) {
            return {
                method: parsed.method || "POST",
                url: parsed.url,
                post: parsed.post || ""
            };
        }
    }
    catch {
        // no saved pager yet
    }

    return null;
}

function savePagerTemplate(item) {
    if (!item || !item.post) {
        return;
    }

    fs.mkdirSync(snapsDir, { recursive: true });
    fs.writeFileSync(pagerTemplateFile, JSON.stringify({
        method: item.method || "POST",
        url: String(item.url || "").replace(/\?.*$/, ""),
        post: item.post,
        savedAt: new Date().toISOString()
    }, null, 2));
}

function listSavedFaces() {
    fs.mkdirSync(snapsDir, { recursive: true });

    const files = fs.readdirSync(snapsDir)
        .filter((name) => name.toLowerCase().endsWith(".jpg"))
        .map((name) => {
            const full = path.join(snapsDir, name);
            const stats = fs.statSync(full);

            return {
                file: name,
                bytes: stats.size,
                savedAt: stats.mtime.toISOString()
            };
        })
        .sort((a, b) => b.savedAt.localeCompare(a.savedAt));

    return {
        dir: snapsDir,
        count: files.length,
        lastSyncAt,
        lastError,
        syncing,
        loggedIn: cameraSessionReady,
        progress: syncProgress,
        files
    };
}

function decodeFaceJpeg(faceImage) {
    if (!faceImage || typeof faceImage !== "string") {
        return null;
    }

    const raw = faceImage.replace(/\s+/g, "");
    const buffer = Buffer.from(raw, "base64");

    if (buffer.length < 16 || buffer[0] !== 0xff || buffer[1] !== 0xd8) {
        return null;
    }

    return buffer;
}

function chromePath() {
    const candidates = [
        process.env.PUPPETEER_EXECUTABLE_PATH,
        "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
        "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
        path.join(process.env.LOCALAPPDATA || "", "Google\\Chrome\\Application\\chrome.exe")
    ].filter(Boolean);

    return candidates.find((candidate) => fs.existsSync(candidate));
}

async function loginFromPage(page, username, password) {
    await page.evaluate(async (user, pass) => {
        const payloads = [
            { data: { UserName: user, PassWord: pass } },
            { data: { UserName: user, Password: pass } }
        ];

        for (const body of payloads) {
            try {
                const response = await fetch("/API/Web/Login", {
                    method: "POST",
                    credentials: "include",
                    headers: {
                        Accept: "*/*",
                        "Content-Type": "application/json",
                        "X-Requested-With": "XMLHttpRequest"
                    },
                    body: JSON.stringify(body)
                });

                if (response.ok) {
                    return true;
                }
            }
            catch {
                // try the next payload
            }
        }

        return false;
    }, username, password);
}

async function loginCameraWebUi(page, { ip, username, password }) {
    await page.authenticate({ username, password });
    await page.goto(`https://${ip}/`, {
        waitUntil: "domcontentloaded",
        timeout: 60000
    });
    await sleep(2500);
    await loginFromPage(page, username, password);

    let passwordField = null;

    try {
        passwordField = await page.waitForSelector('input[type="password"]', {
            timeout: 8000,
            visible: true
        });
    }
    catch {
        passwordField = await page.$('input[type="password"]');
    }

    if (!passwordField) {
        console.log("[Faces] Camera UI has no login form; using session cookie");
        return true;
    }

    const userField = await page.$(
        'input[type="text"], input[name="username"], input[name="UserName"]'
    );

    if (userField) {
        await userField.click({ clickCount: 3 });
        await userField.type(username, { delay: 20 });
    }

    await passwordField.click({ clickCount: 3 });
    await passwordField.type(password, { delay: 20 });

    const clickedLogin = await page.evaluate((user, pass) => {
        const match = Array.from(
            document.querySelectorAll("button, input[type='submit'], a, div, span")
        ).find((node) => {
            const text = `${node.innerText || ""} ${node.value || ""}`.trim();
            return /^(login|log in|sign in|ok)$/i.test(text);
        });

        if (match) {
            match.click();
            return true;
        }

        const form = document.querySelector("form");

        if (form) {
            form.dispatchEvent(new Event("submit", { bubbles: true }));
            return true;
        }

        return false;
    }, username, password);

    if (!clickedLogin) {
        await page.keyboard.press("Enter");
    }

    await page.waitForFunction(
        () => !document.querySelector('input[type="password"]'),
        { timeout: 20000 }
    ).catch(() => {});

    await sleep(2000);
    return !(await page.$('input[type="password"]'));
}

async function sessionStillLoggedIn(page) {
    if (!page || page.isClosed()) {
        return false;
    }

    try {
        return await page.evaluate(() => !document.querySelector('input[type="password"]'));
    }
    catch {
        return !page.isClosed();
    }
}

async function closeCameraSession() {
    cameraSessionReady = false;
    cameraPage = null;

    if (keepAliveTimer) {
        clearInterval(keepAliveTimer);
        keepAliveTimer = null;
    }

    if (cameraBrowser) {
        try {
            await cameraBrowser.close();
        }
        catch {
            // already closed
        }
    }

    cameraBrowser = null;
}

async function ensureHttpsSession() {
    const camera = getClient();

    if (camera.isLoggedIn()) {
        cameraSessionReady = true;
        startSessionKeepAlive();
        return true;
    }

    console.log("[Faces] Logging into camera via /API/Web/Login");
    const ok = await camera.login();
    cameraSessionReady = Boolean(ok);

    if (!ok) {
        throw new Error("Camera /API/Web/Login failed");
    }

    startSessionKeepAlive();
    console.log("[Faces] Camera HTTPS session is logged in");
    return true;
}

function startSessionKeepAlive() {
    if (keepAliveTimer) {
        return;
    }

    keepAliveTimer = setInterval(() => {
        if (syncing) {
            return;
        }

        const camera = getClient();

        camera.request("/", {
            keepAlive: false,
            retries: 1,
            timeoutMs: 15000,
            headers: {
                Origin: `https://${process.env.CAMERA_IP}`,
                Referer: `https://${process.env.CAMERA_IP}/`
            }
        })
            .then(() => {
                cameraSessionReady = true;
            })
            .catch(() => camera.login())
            .then((ok) => {
                if (ok === false) {
                    cameraSessionReady = false;
                    throw new Error("Camera /API/Web/Login failed");
                }

                cameraSessionReady = true;
            })
            .catch((error) => {
                cameraSessionReady = false;
                console.error("[Faces] Camera re-login failed:", error.message);
            });
    }, 5 * 60 * 1000);
}

async function launchCameraBrowser(executablePath) {
    const puppeteer = require("puppeteer");

    return puppeteer.launch({
        headless: process.env.FACE_HEADLESS === "1",
        ignoreHTTPSErrors: true,
        protocolTimeout: 180000,
        executablePath,
        args: [
            "--ignore-certificate-errors",
            "--ignore-certificate-errors-spki-list",
            "--no-sandbox",
            "--disable-setuid-sandbox",
            "--no-first-run",
            "--no-default-browser-check",
            "--disable-gpu",
            "--window-size=1400,900"
        ]
    });
}

async function ensureCameraSession() {
    if (sessionStart) {
        return sessionStart;
    }

    sessionStart = (async () => {
        await ensureHttpsSession();

        if (cameraPage && await sessionStillLoggedIn(cameraPage)) {
            cameraSessionReady = true;
            return cameraPage;
        }

        if (syncing && cameraPage && !cameraPage.isClosed()) {
            cameraSessionReady = true;
            return cameraPage;
        }

        if (cameraBrowser) {
            try {
                await cameraBrowser.close();
            }
            catch {
                // already closed
            }

            cameraBrowser = null;
            cameraPage = null;
        }

        const ip = process.env.CAMERA_IP;
        const username = process.env.CAMERA_USERNAME;
        const password = process.env.CAMERA_PASSWORD;
        const executablePath = chromePath();

        if (!executablePath) {
            throw new Error("Google Chrome was not found for camera web login");
        }

        console.log("[Faces] Opening Chrome with the HTTPS session cookie");

        try {
            cameraBrowser = await launchCameraBrowser(executablePath);
            cameraBrowser.on("disconnected", () => {
                cameraBrowser = null;
                cameraPage = null;
            });

            const page = await cameraBrowser.newPage();
            page.setDefaultTimeout(120000);
            page.setDefaultNavigationTimeout(120000);
            await page.setBypassCSP(true);
            await page.setViewport({ width: 1400, height: 900 });
            await page.setExtraHTTPHeaders({
                Referer: `https://${ip}/`,
                Accept: "application/json, text/plain, */*"
            });

            const cookies = getClient().getCookies();

            if (cookies.length) {
                await page.setCookie(...cookies.map((cookie) => ({
                    name: cookie.name,
                    value: cookie.value,
                    url: `https://${ip}/`,
                    path: "/"
                })));
            }

            const loggedIn = await loginCameraWebUi(page, {
                ip,
                username,
                password
            });

            if (!loggedIn) {
                throw new Error("Camera web login failed");
            }

            await sleep(3000);

            cameraPage = page;
            cameraSessionReady = true;
            startSessionKeepAlive();
            console.log("[Faces] Camera gallery session is ready");
            return page;
        }
        catch (error) {
            if (cameraBrowser) {
                try {
                    await cameraBrowser.close();
                }
                catch {
                    // already closed
                }

                cameraBrowser = null;
                cameraPage = null;
            }

            throw error;
        }
    })();

    try {
        return await sessionStart;
    }
    finally {
        sessionStart = null;
    }
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function faceKeys(faces) {
    return (faces || [])
        .map((face) => String(face.UUId || face.SnapId || ""))
        .filter(Boolean)
        .join("|");
}

function minStartTime(faces) {
    const times = (faces || [])
        .map((face) => Number(face.StartTime))
        .filter((value) => Number.isFinite(value) && value > 0);

    return times.length ? Math.min(...times) : 0;
}

function getByIdUrl(ip, extraQuery) {
    const stamp = cameraTimestamp();
    const prefix = extraQuery ? `${extraQuery}&` : "";
    return `https://${ip}/API/AI/SnapedFaces/GetById?${prefix}${stamp}`;
}

function parseSnapedPayload(json) {
    const data = json && json.data ? json.data : {};
    const raw = Array.isArray(data.SnapedFaceInfo) ? data.SnapedFaceInfo : [];
    const faces = raw.map((face) => {
        const copy = Object.assign({}, face);
        delete copy.Feature;
        return copy;
    });

    return {
        count: data.Count,
        total: data.Total
            || data.TotalCount
            || data.TotalNum
            || data.PageCount
            || null,
        keys: Object.keys(data),
        faces
    };
}

function stripFeatureFields(text) {
    return String(text || "").replace(
        /"Feature"\s*:\s*"(?:\\.|[^"\\])*"/g,
        '"Feature":""'
    );
}

function parseSnapedText(text) {
    const trimmed = String(text || "").trim();
    const start = trimmed.indexOf("{");
    const jsonText = start >= 0 ? trimmed.slice(start) : trimmed;
    return parseSnapedPayload(JSON.parse(stripFeatureFields(jsonText)));
}

async function fireCameraXhr(page, spec) {
    await page.evaluate(async (spec) => {
        const url = String(spec.url || "").replace(/^https?:\/\/[^/]+/, "");
        await new Promise((resolve, reject) => {
            const xhr = new XMLHttpRequest();
            xhr.open(spec.method || "GET", url, true);
            xhr.setRequestHeader("Accept", "*/*");
            xhr.setRequestHeader("X-Requested-With", "XMLHttpRequest");

            if (spec.body) {
                xhr.setRequestHeader("Content-Type", "application/json");
            }

            xhr.onload = () => resolve();
            xhr.onerror = () => reject(new Error("XHR network error"));
            xhr.send(spec.body ? JSON.stringify(spec.body) : null);
        });
    }, spec);
}

async function cameraFetchJson(page, spec) {
    return page.evaluate(async (spec) => {
        const url = String(spec.url || "").replace(/^https?:\/\/[^/]+/, "");
        const text = await new Promise((resolve, reject) => {
            const xhr = new XMLHttpRequest();
            xhr.open(spec.method || "GET", url, true);
            xhr.setRequestHeader("Accept", "*/*");
            xhr.setRequestHeader("X-Requested-With", "XMLHttpRequest");

            if (spec.body) {
                xhr.setRequestHeader("Content-Type", "application/json");
            }

            xhr.onload = () => {
                if (xhr.status >= 400) {
                    reject(new Error(`HTTP ${xhr.status}`));
                    return;
                }

                resolve(xhr.responseText || "");
            };
            xhr.onerror = () => reject(new Error("XHR network error"));
            xhr.send(spec.body ? JSON.stringify(spec.body) : null);
        });

        const stripped = String(text).replace(
            /"Feature"\s*:\s*"(?:\\.|[^"\\])*"/g,
            '"Feature":""'
        );
        let json = null;

        try {
            json = stripped ? JSON.parse(stripped) : null;
        }
        catch {
            json = null;
        }

        const data = json && json.data ? json.data : {};
        const raw = Array.isArray(data.SnapedFaceInfo) ? data.SnapedFaceInfo : [];
        const faces = raw.map((face) => {
            const copy = Object.assign({}, face);
            delete copy.Feature;
            return copy;
        });

        return {
            count: data.Count,
            total: data.Total
                || data.TotalCount
                || data.TotalNum
                || data.PageCount
                || null,
            keys: Object.keys(data),
            faces
        };
    }, spec);
}

async function clickMatching(page, pattern) {
    for (const frame of page.frames()) {
        const hit = await frame.evaluate((source) => {
            const re = new RegExp(source, "i");
            const nodes = Array.from(
                document.querySelectorAll(
                    "a, li, span, button, p, div, td, label, [title], [aria-label]"
                )
            );
            const el = nodes.find((node) => {
            const text = [
                node.innerText,
                node.getAttribute("title"),
                node.getAttribute("aria-label"),
                node.getAttribute("data-name")
            ].filter(Boolean).join(" ").trim().replace(/\s+/g, " ");
            return text.length > 0 && text.length < 80 && re.test(text);
            });

            if (!el) {
                return null;
            }

            el.click();
            return (el.innerText || el.getAttribute("title") || "").trim().slice(0, 48);
        }, pattern).catch(() => null);

        if (hit) {
            return hit;
        }
    }

    return null;
}

async function clickNextPage(page) {
    for (const frame of page.frames()) {
        let handle;

        try {
            handle = await frame.evaluateHandle(() => {
                const usable = (node) => node
                    && !node.disabled
                    && !node.classList.contains("disabled");

                const nextByClass = document.querySelector(
                    ".btn-next:not(.disabled):not([disabled]), " +
                    ".el-pagination .btn-next, " +
                    "[class*='page-next'], [class*='next-page'], " +
                    "em.page-next, .pageNext"
                );

                if (usable(nextByClass)) {
                    return nextByClass;
                }

                const walker = document.createTreeWalker(
                    document.body,
                    NodeFilter.SHOW_TEXT
                );
                let textNode;

                while ((textNode = walker.nextNode())) {
                    const text = textNode.textContent.replace(/\s+/g, " ").trim();

                    if (!/^\/\s*\d+$/.test(text)) {
                        continue;
                    }

                    let current = textNode.parentElement;

                    while (current) {
                        if (current.nextElementSibling) {
                            return current.nextElementSibling;
                        }

                        current = current.parentElement;
                    }
                }

                return Array.from(
                    document.querySelectorAll("button, a, span, div, em, i")
                ).find((node) => {
                    const text = (node.textContent || "").trim();
                    return text === ">"
                        || text === "›"
                        || text === ">>"
                        || text === ">|";
                }) || null;
            });

            const element = handle && handle.asElement && handle.asElement();

            if (element) {
                const box = await element.boundingBox();

                if (box) {
                    await page.mouse.click(
                        box.x + box.width / 2,
                        box.y + box.height / 2,
                        { delay: 40 }
                    );
                }
                else {
                    await element.click({ delay: 40 });
                }

                await handle.dispose();
                return "next-control";
            }

            if (handle) {
                await handle.dispose();
            }
        }
        catch {
            if (handle) {
                await handle.dispose().catch(() => {});
            }
        }

        const incremented = await frame.evaluate(() => {
            const walker = document.createTreeWalker(
                document.body,
                NodeFilter.SHOW_TEXT
            );
            let box = null;
            let textNode;

            while ((textNode = walker.nextNode())) {
                const text = textNode.textContent.replace(/\s+/g, " ").trim();

                if (/^\/\s*\d+$/.test(text)) {
                    box = textNode.parentElement
                        && textNode.parentElement.parentElement;
                    break;
                }
            }

            const scope = box || document;
            const pageInput = Array.from(scope.querySelectorAll("input")).find(
                (node) => {
                    const value = String(node.value || "").trim();
                    return /^\d+$/.test(value)
                        && Number(value) >= 1
                        && Number(value) <= 500;
                }
            );

            if (!pageInput) {
                return null;
            }

            const nextPage = String(Number(pageInput.value) + 1);
            const descriptor = Object.getOwnPropertyDescriptor(
                HTMLInputElement.prototype,
                "value"
            );

            if (descriptor && descriptor.set) {
                descriptor.set.call(pageInput, nextPage);
            }
            else {
                pageInput.value = nextPage;
            }

            pageInput.dispatchEvent(new Event("input", { bubbles: true }));
            pageInput.dispatchEvent(new Event("change", { bubbles: true }));
            pageInput.dispatchEvent(new KeyboardEvent("keydown", {
                key: "Enter",
                keyCode: 13,
                which: 13,
                bubbles: true
            }));
            pageInput.dispatchEvent(new KeyboardEvent("keyup", {
                key: "Enter",
                keyCode: 13,
                which: 13,
                bubbles: true
            }));
            return "input-inc";
        }).catch(() => null);

        if (incremented) {
            return incremented;
        }
    }

    try {
        await page.keyboard.press("ArrowRight");
        return "arrow";
    }
    catch {
        return null;
    }
}

function attachSnapedListener(page, captured) {
    const lastRequest = { current: null };

    const onRequest = (request) => {
        if (!/SnapedFaces/i.test(request.url())) {
            return;
        }

        lastRequest.current = {
            method: request.method(),
            url: request.url(),
            post: request.postData() || ""
        };
        console.log(
            `[Faces] REQ ${request.method()} ${request.url()}` +
            (lastRequest.current.post
                ? ` ${lastRequest.current.post.slice(0, 240)}`
                : "")
        );
    };

    const handler = async (response) => {
        try {
            if (!/SnapedFaces/i.test(response.url()) || !response.ok()) {
                return;
            }

            const text = await response.text();
            const parsed = parseSnapedText(text);

            if (!parsed.faces.length) {
                return;
            }

            const request = response.request();
            captured.push({
                faces: parsed.faces,
                method: request.method(),
                url: response.url(),
                post: request.postData()
                    || (lastRequest.current && lastRequest.current.post)
                    || ""
            });
        }
        catch (error) {
            console.log("[Faces] Ignored camera response:", error.message);
        }
    };

    page.on("request", onRequest);
    page.on("response", handler);
    return () => {
        page.off("request", onRequest);
        page.off("response", handler);
    };
}

async function waitForCaptured(captured, previousLength, timeoutMs) {
    const start = Date.now();

    while (Date.now() - start < timeoutMs) {
        if (captured.length > previousLength) {
            return captured[captured.length - 1];
        }

        await sleep(200);
    }

    return null;
}

async function replayCapturedPage(page, template, pageNo) {
    if (!template) {
        return null;
    }

    let url = template.url;
    const stamp = cameraTimestamp();

    if (/\?\d{4}-\d{2}-\d{2}@/.test(url)) {
        url = url.replace(/\?.*$/, `?${stamp}`);
    }
    else if (url.includes("GetById")) {
        url = `${url.split("?")[0]}?${stamp}`;
    }

    let body = template.post || null;

    if (body) {
        try {
            const json = JSON.parse(body);
            const data = json.data || json;

            if (data.PageNo !== undefined) {
                data.PageNo = pageNo;
            }

            if (data.pageNo !== undefined) {
                data.pageNo = pageNo;
            }

            if (data.Page !== undefined) {
                data.Page = pageNo;
            }

            if (data.Index !== undefined) {
                data.Index = (pageNo - 1) * PAGE_SIZE;
            }

            body = JSON.stringify(json.data ? json : { data });
        }
        catch {
            body = template.post;
        }
    }

    try {
        return await cameraFetchJson(page, {
            method: template.method || "POST",
            url,
            body: body ? JSON.parse(body) : undefined
        });
    }
    catch (error) {
        console.log(`[Faces] Replay page ${pageNo} failed: ${error.message}`);
        return null;
    }
}

async function walkCameraGallery(page, { ip, onPage }) {
    const captured = [];
    const stop = attachSnapedListener(page, captured);
    const savedPager = loadPagerTemplate();

    try {
        const alreadyOpen = String(page.url() || "").includes(ip);

        if (!alreadyOpen) {
            await page.goto(`https://${ip}/`, {
                waitUntil: "domcontentloaded",
                timeout: 60000
            });
            await sleep(2000);
        }

        await page.mouse.move(24, 280);
        await sleep(400);

        const menuClicks = [
            "intelligent|smart|\\bAI\\b|IVA|VCA|智能",
            "face|facial|人脸",
            "snapped|snap|picture search|search picture|search pic|search|抓拍",
            "query|retrieval|library"
        ];

        for (const pattern of menuClicks) {
            const hit = await clickMatching(page, pattern);

            if (hit) {
                console.log(`[Faces] Opened camera menu: ${hit}`);
                await sleep(1500);
            }
        }

        if (captured.length === 0) {
            const hashes = [
                "#/ai/snappedFaces",
                "#/AI/SnapedFaces",
                "#/ai/SnapedFaces",
                "#/ai/snapFace",
                "#/intelligent/face",
                "#/smart/face",
                "#/face/search",
                "#/SearchPic",
                "#/pictureSearch",
                "#/faceSearch"
            ];

            for (const hash of hashes) {
                await page.evaluate((value) => {
                    window.location.hash = value;
                }, hash);
                await sleep(1200);

                if (captured.length) {
                    break;
                }
            }
        }

        let item = await waitForCaptured(captured, 0, 8000);

        if (!item) {
            console.log("[Faces] Gallery XHR not seen yet, retrying AI / face menus");

            for (const pattern of menuClicks) {
                const hit = await clickMatching(page, pattern);

                if (hit) {
                    await sleep(1200);
                }
            }

            item = await waitForCaptured(captured, 0, 12000);
        }

        if (!item) {
            const labels = await page.evaluate(() => Array.from(
                document.querySelectorAll("a, li, span, button, p, div")
            )
                .map((node) => (node.innerText || node.getAttribute("title") || "")
                    .trim()
                    .replace(/\s+/g, " "))
                .filter((text) => text.length > 0 && text.length < 40)
                .filter((text, index, list) => list.indexOf(text) === index)
                .slice(0, 40));
            console.log(
                "[Faces] Gallery XHR still missing. Visible labels:",
                labels.join(" | ")
            );
            return 0;
        }

        lastError = null;

        const seen = new Set();
        const template = {
            method: item.method,
            url: item.url,
            post: item.post || (savedPager && savedPager.post) || ""
        };

        if (savedPager && savedPager.post && !template.post) {
            template.method = savedPager.method;
            template.url = savedPager.url;
            template.post = savedPager.post;
        }

        let pageNo = 0;
        let lastIndex = -1;

        const drainCaptured = async () => {
            let added = 0;

            for (let i = lastIndex + 1; i < captured.length; i++) {
                lastIndex = i;
                const extra = captured[i];
                const key = faceKeys(extra.faces);

                if (!key || seen.has(key)) {
                    continue;
                }

                seen.add(key);
                pageNo += 1;
                added += 1;

                if (extra.post) {
                    template.method = extra.method;
                    template.url = extra.url;
                    template.post = extra.post;
                    savePagerTemplate(extra);
                    console.log(
                        `[Faces] Gallery request ${extra.method} ${extra.url} ` +
                        extra.post.slice(0, 240)
                    );
                }

                if (onPage) {
                    await onPage(extra.faces, pageNo);
                }
            }

            return added;
        };

        await drainCaptured();

        let idleRounds = 0;
        const maxIdleRounds = 5;

        while (pageNo < MAX_PAGES && idleRounds < maxIdleRounds) {
            const previousLength = captured.length;
            const moved = await clickNextPage(page);

            if (moved) {
                console.log(`[Faces] Advanced pager via ${moved}`);
                syncProgress = {
                    ...(syncProgress || {}),
                    page: pageNo + 1,
                    pager: "camera-ui"
                };
            }

            await waitForCaptured(
                captured,
                previousLength,
                moved ? 8000 : 3500
            );

            const drained = await drainCaptured();

            if (drained > 0) {
                idleRounds = 0;
                await sleep(400);
                continue;
            }

            if (template.post) {
                const targetPage = pageNo + 1;
                syncProgress = {
                    ...(syncProgress || {}),
                    page: targetPage,
                    pager: "replay"
                };
                const replayed = await replayCapturedPage(
                    page,
                    template,
                    targetPage
                );

                if (replayed && replayed.faces && replayed.faces.length) {
                    const key = faceKeys(replayed.faces);

                    if (key && !seen.has(key)) {
                        seen.add(key);
                        pageNo = targetPage;
                        idleRounds = 0;

                        if (onPage) {
                            await onPage(replayed.faces, pageNo);
                        }

                        await sleep(PAGE_DELAY_MS);
                        continue;
                    }
                }
            }

            idleRounds += 1;
        }

        return pageNo;
    }
    finally {
        stop();
    }
}

function pageSpecs(ip, { pageNo, pageSize, endTime }) {
    const fullBody = {
        data: {
            PageNo: pageNo,
            PageSize: pageSize,
            Chn: 0,
            StartTime: 0,
            EndTime: endTime || 0,
            NeedFeature: 0
        }
    };
    const slimBody = {
        data: {
            PageNo: pageNo,
            PageSize: pageSize
        }
    };
    const dateBody = {
        data: {
            PageNo: pageNo,
            PageSize: pageSize,
            StartTime: "2000-01-01 00:00:00",
            EndTime: "2038-01-01 00:00:00",
            Chn: 0
        }
    };
    const stampUrl = getByIdUrl(ip, "");

    return [
        {
            kind: "get-post",
            name: `POST /Get PageNo=${pageNo}`,
            spec: {
                method: "POST",
                url: `https://${ip}/API/AI/SnapedFaces/Get?${cameraTimestamp()}`,
                body: slimBody
            }
        },
        {
            kind: "get-post-noid",
            name: `POST /Get noquery PageNo=${pageNo}`,
            spec: {
                method: "POST",
                url: `https://${ip}/API/AI/SnapedFaces/Get`,
                body: slimBody
            }
        },
        {
            kind: "pageNo-post-dates",
            name: `POST dates PageNo=${pageNo}`,
            spec: {
                method: "POST",
                url: stampUrl,
                body: dateBody
            }
        },
        {
            kind: "pageNo-post-slim",
            name: `POST slim PageNo=${pageNo}`,
            spec: {
                method: "POST",
                url: stampUrl,
                body: slimBody
            }
        },
        {
            kind: "index-post",
            name: `POST Index=${(pageNo - 1) * pageSize}`,
            spec: {
                method: "POST",
                url: stampUrl,
                body: {
                    data: {
                        Index: (pageNo - 1) * pageSize,
                        Count: pageSize
                    }
                }
            }
        },
        {
            kind: "pageNo-post",
            name: `POST PageNo=${pageNo}`,
            spec: {
                method: "POST",
                url: stampUrl,
                body: fullBody
            }
        },
        {
            kind: "pageNo-post-noquery",
            name: `POST no-query PageNo=${pageNo}`,
            spec: {
                method: "POST",
                url: `https://${ip}/API/AI/SnapedFaces/GetById`,
                body: slimBody
            }
        },
        endTime
            ? {
                kind: "endTime-post",
                name: `POST EndTime=${endTime}`,
                spec: {
                    method: "POST",
                    url: stampUrl,
                    body: {
                        data: {
                            PageNo: 1,
                            PageSize: pageSize,
                            StartTime: 0,
                            EndTime: endTime,
                            NeedFeature: 0
                        }
                    }
                }
            }
            : null,
        {
            kind: "pageNo-get",
            name: `GET PageNo=${pageNo}`,
            spec: {
                method: "GET",
                url: getByIdUrl(ip, `PageNo=${pageNo}&PageSize=${pageSize}`)
            }
        },
        {
            kind: "pageNo-get-0",
            name: `GET PageNo=${pageNo - 1} (0-based)`,
            spec: {
                method: "GET",
                url: getByIdUrl(ip, `PageNo=${pageNo - 1}&PageSize=${pageSize}`)
            }
        },
        {
            kind: "startIndex-get",
            name: `GET start=${(pageNo - 1) * pageSize}`,
            spec: {
                method: "GET",
                url: getByIdUrl(
                    ip,
                    `StartIndex=${(pageNo - 1) * pageSize}&Count=${pageSize}`
                )
            }
        },
        endTime
            ? {
                kind: "endTime-get",
                name: `GET EndTime=${endTime}`,
                spec: {
                    method: "GET",
                    url: getByIdUrl(ip, `StartTime=0&EndTime=${endTime}`)
                }
            }
            : null
    ].filter(Boolean);
}

function specForKind(ip, kind, { pageNo, previousFaces }) {
    const cursor = minStartTime(previousFaces);
    const match = pageSpecs(ip, {
        pageNo,
        pageSize: PAGE_SIZE,
        endTime: cursor > 0 ? cursor - 1 : 0
    }).find((item) => item.kind === kind);

    return match ? match.spec : null;
}

async function discoverPager(browserPage, ip, firstPage) {
    const firstKeys = faceKeys(firstPage.faces);
    const endTime = minStartTime(firstPage.faces);
    const probes = pageSpecs(ip, {
        pageNo: 2,
        pageSize: PAGE_SIZE,
        endTime: endTime > 0 ? endTime - 1 : 0
    });

    for (const candidate of probes) {
        try {
            const result = await cameraFetchJson(browserPage, candidate.spec);
            const nextKeys = faceKeys(result.faces);

            if (result.faces.length && nextKeys && nextKeys !== firstKeys) {
                console.log(`[Faces] Paging with ${candidate.name}`);
                return { kind: candidate.kind, faces: result.faces };
            }
        }
        catch (error) {
            console.log(
                `[Faces] Probe ${candidate.name} failed: ${error.message}`
            );
        }

        await sleep(400);
    }

    return null;
}

async function fetchPagesViaXhr(page, ip, onPage, full = true) {
    const seen = new Set();
    let pages = 0;
    let previousFaces = null;
    const captured = [];
    const stop = attachSnapedListener(page, captured);

    async function take(faces) {
        const key = faceKeys(faces);

        if (!key || seen.has(key)) {
            return false;
        }

        seen.add(key);
        pages += 1;

        if (onPage) {
            await onPage(faces, pages);
        }

        previousFaces = faces;
        return true;
    }

    async function takeCaptured() {
        let added = 0;

        for (const item of captured) {
            if (item.faces && item.faces.length && await take(item.faces)) {
                added += 1;
            }
        }

        return added;
    }

    try {
        try {
            await fireCameraXhr(page, {
                method: "GET",
                url: `/API/AI/SnapedFaces/GetById?${cameraTimestamp()}`
            });
        }
        catch (error) {
            console.log(`[Faces] In-session GetById failed: ${error.message}`);
        }

        await waitForCaptured(captured, 0, 20000);
        await takeCaptured();

        if (pages >= 1) {
            console.log(`[Faces] Page 1 via in-session GetById`);
        }
        else {
            try {
                const first = await cameraFetchJson(page, {
                    method: "GET",
                    url: `/API/AI/SnapedFaces/GetById?${cameraTimestamp()}`
                });

                if (first && first.faces && first.faces.length) {
                    await take(first.faces);
                    console.log(
                        `[Faces] Page 1 via in-session GetById ` +
                        `(${first.faces.length} faces)`
                    );
                }
                else {
                    console.log(
                        `[Faces] In-session GetById keys: ` +
                        `${(first && first.keys) || []}`
                    );
                }
            }
            catch (error) {
                console.log(`[Faces] In-session GetById parse failed: ${error.message}`);
            }
        }

        if (!full) {
            return pages;
        }

        const savedPager = loadPagerTemplate();

        if (savedPager && savedPager.post) {
            let consecutiveMiss = 0;

            while (pages < MAX_PAGES && consecutiveMiss < 2) {
                const before = captured.length;
                const replayed = await replayCapturedPage(
                    page,
                    savedPager,
                    pages + 1
                );

                if (
                    replayed
                    && replayed.faces
                    && replayed.faces.length
                    && await take(replayed.faces)
                ) {
                    consecutiveMiss = 0;
                    await sleep(PAGE_DELAY_MS);
                    continue;
                }

                await waitForCaptured(captured, before, 4000);

                if (captured.length > before && await takeCaptured()) {
                    consecutiveMiss = 0;
                    await sleep(PAGE_DELAY_MS);
                    continue;
                }

                consecutiveMiss += 1;
            }
        }

        if (pages >= 1 && previousFaces && pages < MAX_PAGES) {
            const pager = await discoverPager(page, ip, {
                faces: previousFaces
            });

            if (pager && pager.faces && await take(pager.faces)) {
                while (pages < MAX_PAGES) {
                    const spec = specForKind(ip, pager.kind, {
                        pageNo: pages + 1,
                        previousFaces
                    });

                    if (!spec) {
                        break;
                    }

                    try {
                        const result = await cameraFetchJson(page, spec);

                        if (!result || !result.faces || !result.faces.length) {
                            break;
                        }

                        if (!(await take(result.faces))) {
                            break;
                        }

                        previousFaces = result.faces;
                    }
                    catch (error) {
                        console.log(
                            `[Faces] Page ${pages + 1} failed: ${error.message}`
                        );
                        break;
                    }

                    await sleep(PAGE_DELAY_MS);
                }
            }
        }

        return pages;
    }
    finally {
        stop();
    }
}

async function fetchSnapedFacesViaHttps() {
    await ensureHttpsSession();
    return { pages: 0, via: "https" };
}

function toCameraPath(urlOrPath, ip) {
    return String(urlOrPath || "")
        .replace(`https://${ip}`, "")
        .replace(`http://${ip}`, "");
}

async function cameraRequestSpec(camera, ip, spec) {
    const path = toCameraPath(spec.url, ip);

    if ((spec.method || "GET") === "POST") {
        return camera.postSnapedFaces(path, spec.body);
    }

    return camera.getJson(path, {
        keepAlive: true,
        headers: {
            Origin: `https://${ip}`,
            Referer: `https://${ip}/`,
            "X-Requested-With": "XMLHttpRequest"
        }
    });
}

async function replayHttpsPage(camera, ip, template, pageNo) {
    let path = toCameraPath(template.url, ip);
    const stamp = cameraTimestamp();

    if (/\?\d{4}-\d{2}-\d{2}@/.test(path)) {
        path = path.replace(/\?.*$/, `?${stamp}`);
    }
    else if (path.includes("GetById") || path.includes("/Get")) {
        path = `${path.split("?")[0]}?${stamp}`;
    }

    let body = template.post || null;

    if (body) {
        try {
            const json = JSON.parse(body);
            const data = json.data || json;

            if (data.PageNo !== undefined) {
                data.PageNo = pageNo;
            }

            if (data.pageNo !== undefined) {
                data.pageNo = pageNo;
            }

            if (data.Page !== undefined) {
                data.Page = pageNo;
            }

            if (data.Index !== undefined) {
                data.Index = (pageNo - 1) * PAGE_SIZE;
            }

            body = json.data ? json : { data };
        }
        catch {
            return null;
        }
    }

    try {
        const json = await camera.postSnapedFaces(path, body);
        return parseSnapedPayload(json);
    }
    catch (error) {
        console.log(`[Faces] HTTPS replay page ${pageNo} failed: ${error.message}`);
        return null;
    }
}

async function discoverHttpsPager(camera, ip, firstPage) {
    const firstKeys = faceKeys(firstPage.faces);
    const endTime = minStartTime(firstPage.faces);
    const probes = pageSpecs(ip, {
        pageNo: 2,
        pageSize: PAGE_SIZE,
        endTime: endTime > 0 ? endTime - 1 : 0
    });

    for (const candidate of probes) {
        try {
            const json = await cameraRequestSpec(camera, ip, candidate.spec);
            const result = parseSnapedPayload(json);
            const nextKeys = faceKeys(result.faces);

            if (result.faces.length && nextKeys && nextKeys !== firstKeys) {
                console.log(`[Faces] HTTPS paging with ${candidate.name}`);
                return { kind: candidate.kind, faces: result.faces };
            }
        }
        catch (error) {
            console.log(`[Faces] HTTPS probe ${candidate.name} failed: ${error.message}`);
        }

        await sleep(400);
    }

    return null;
}

async function fetchSnapedFacesViaBrowser(options = {}) {
    const full = Boolean(options.full);
    const ip = process.env.CAMERA_IP;
    const page = await ensureCameraSession();
    const onPage = options.onPage;

    const xhrPages = await fetchPagesViaXhr(page, ip, onPage, full);

    if (xhrPages >= 1) {
        console.log(`[Faces] In-session XHR returned ${xhrPages} page(s)`);

        if (!full || xhrPages > 1) {
            return { pages: xhrPages };
        }
    }

    console.log("[Faces] Opening Snapped faces in the camera UI");
    const uiPages = await walkCameraGallery(page, { ip, onPage });
    const pages = Math.max(xhrPages, uiPages);

    if (pages >= 1) {
        console.log(`[Faces] Camera UI returned ${uiPages} page(s)`);
        return { pages };
    }

    throw new Error(
        "Logged in, but the Snapped faces gallery did not return pages"
    );
}

async function fetchSnapedFacePages(options = {}) {
    const full = Boolean(options.full);

    console.log(
        `[Faces] Logging in, then fetching snapped faces from Chrome` +
        (full ? " (all pages)" : " (latest page)")
    );

    await ensureHttpsSession();

    lastBrowserAttempt = Date.now();
    return fetchSnapedFacesViaBrowser({
        full,
        onPage: options.onPage
    });
}

function ingestSnapedFaces(faces) {
    fs.mkdirSync(snapsDir, { recursive: true });

    const list = Array.isArray(faces) ? faces : [];
    const index = loadIndex();
    const known = new Set(
        index.map((item) => item.uuid || String(item.snapId))
    );

    let saved = 0;
    let skipped = 0;

    for (const face of list) {
        const uuid = String(face.UUId || "");
        const snapId = face.SnapId;
        const key = uuid || String(snapId);

        if (!key || known.has(key)) {
            skipped += 1;
            continue;
        }

        const jpeg = decodeFaceJpeg(face.FaceImage);

        if (!jpeg) {
            skipped += 1;
            continue;
        }

        const filename = `snap-${safeName(snapId)}-${safeName(uuid)}.jpg`;
        const dest = path.join(snapsDir, filename);

        if (fs.existsSync(dest)) {
            skipped += 1;
            known.add(key);
            continue;
        }

        fs.writeFileSync(dest, jpeg);

        index.push({
            uuid,
            snapId,
            channel: face.StrChn || face.Chn,
            score: face.Score,
            gender: face.Gender,
            age: face.fAttrAge,
            startTime: face.StartTime,
            endTime: face.EndTime,
            file: filename,
            bytes: jpeg.length,
            savedAt: new Date().toISOString()
        });

        known.add(key);
        saved += 1;
    }

    saveIndex(index);
    lastSyncAt = new Date().toISOString();

    const result = {
        fetched: list.length,
        saved,
        skipped,
        ...listSavedFaces()
    };

    if (saved > 0) {
        console.log(
            `[Faces] Saved ${saved} new snap(s) to ${snapsDir}`
        );
    }

    return result;
}

async function syncSnappedFaces(options = {}) {
    const full = Boolean(options.full);

    if (syncing) {
        if (full) {
            pendingFull = true;
        }

        return {
            skipped: true,
            reason: "sync already running",
            ...listSavedFaces()
        };
    }

    syncing = true;
    syncProgress = {
        full,
        page: 0,
        saved: 0,
        fetched: 0
    };

    try {
        lastError = null;
        const fetched = await fetchSnapedFacePages({
            full,
            async onPage(faces, pageNo) {
                const ingested = ingestSnapedFaces(faces);
                syncProgress = {
                    full,
                    page: pageNo,
                    saved: (syncProgress.saved || 0) + ingested.saved,
                    fetched: (syncProgress.fetched || 0) + ingested.fetched
                };
                console.log(
                    `[Faces] Page ${pageNo}: ` +
                    `${ingested.saved} new, ${ingested.skipped} skipped`
                );
                return ingested;
            }
        });

        if (fetched && fetched.skipped) {
            return fetched;
        }

        return {
            ...listSavedFaces(),
            progress: syncProgress
        };
    }
    catch (error) {
        lastError = error.message;
        console.error("[Faces] Sync failed:", error.message);
        throw error;
    }
    finally {
        syncing = false;
        syncProgress = {
            ...(syncProgress || {}),
            done: true
        };

        if (pendingFull) {
            pendingFull = false;
            setImmediate(() => {
                syncSnappedFaces({ full: true }).catch(() => {});
            });
        }
    }
}

function startFaceSync() {
    fs.mkdirSync(snapsDir, { recursive: true });
    console.log("[Faces] Starting background camera login...");

    ensureHttpsSession()
        .then(() => {
            console.log("[Faces] Logged in. Fetching all snapped-face pages...");
            return syncSnappedFaces({ full: true });
        })
        .catch((error) => {
            lastError = error.message;
            console.error("[Faces] Background login failed:", error.message);
        });
}

async function stopFaceSync() {
    if (pollTimer) {
        clearInterval(pollTimer);
        pollTimer = null;
    }

    await closeCameraSession();
}

module.exports = {
    snapsDir,
    listSavedFaces,
    ingestSnapedFaces,
    syncSnappedFaces,
    startFaceSync,
    stopFaceSync
};

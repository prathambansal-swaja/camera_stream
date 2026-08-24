const crypto = require("crypto");
const https = require("https");
const http = require("http");
const zlib = require("zlib");

function md5(value) {
    return crypto.createHash("md5").update(value).digest("hex");
}

function parseDigestChallenge(header) {
    const result = {};
    const digest = String(header || "").replace(/^Digest\s+/i, "");
    const re = /(\w+)=(?:"([^"]*)"|([^\s,]+))/g;
    let match;

    while ((match = re.exec(digest))) {
        result[match[1]] = match[2] !== undefined ? match[2] : match[3];
    }

    return result;
}

function buildDigestHeader({
    username,
    password,
    method,
    path,
    challenge,
    nc,
    cnonce
}) {
    const realm = challenge.realm || "";
    const nonce = challenge.nonce || "";
    const qop = (challenge.qop || "").split(",")[0].trim();
    const opaque = challenge.opaque;
    const algorithm = challenge.algorithm || "MD5";
    const ha1 = md5(`${username}:${realm}:${password}`);
    const ha2 = md5(`${method}:${path}`);

    let header =
        `Digest username="${username}", realm="${realm}", ` +
        `nonce="${nonce}", uri="${path}"`;

    if (qop) {
        const ncStr = String(nc).padStart(8, "0");
        const response = md5(
            `${ha1}:${nonce}:${ncStr}:${cnonce}:${qop}:${ha2}`
        );

        header +=
            `, algorithm=${algorithm}, qop=${qop}, nc=${ncStr}, ` +
            `cnonce="${cnonce}", response="${response}"`;
    }
    else {
        const response = md5(`${ha1}:${nonce}:${ha2}`);
        header += `, response="${response}"`;
    }

    if (opaque) {
        header += `, opaque="${opaque}"`;
    }

    return header;
}

function cookieHeader(jar) {
    return Object.entries(jar)
        .map(([name, value]) => `${name}=${value}`)
        .join("; ");
}

function storeCookies(jar, setCookie) {
    const headers = Array.isArray(setCookie)
        ? setCookie
        : (setCookie ? [setCookie] : []);

    for (const header of headers) {
        const part = String(header).split(";")[0];
        const eq = part.indexOf("=");

        if (eq > 0) {
            jar[part.slice(0, eq).trim()] = part.slice(eq + 1).trim();
        }
    }
}

function decodeBody(headers, body) {
    const encoding = String(headers["content-encoding"] || "").toLowerCase();

    if (!body || !body.length) {
        return body;
    }

    try {
        if (encoding.includes("gzip")) {
            return zlib.gunzipSync(body);
        }

        if (encoding.includes("deflate")) {
            return zlib.inflateSync(body);
        }
    }
    catch {
        return body;
    }

    return body;
}

function basicHeader(username, password) {
    return `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;
}

function requestOnce({
    protocol,
    hostname,
    port,
    path,
    method,
    headers,
    body,
    agent,
    timeoutMs
}) {
    const lib = protocol === "http:" ? http : https;

    return new Promise((resolve, reject) => {
        const req = lib.request(
            {
                hostname,
                port,
                path,
                method,
                headers,
                agent,
                rejectUnauthorized: false,
                timeout: timeoutMs || 60000
            },
            (res) => {
                const chunks = [];

                res.on("data", (chunk) => chunks.push(chunk));
                res.on("end", () => {
                    resolve({
                        status: res.statusCode,
                        headers: res.headers,
                        body: decodeBody(res.headers, Buffer.concat(chunks))
                    });
                });
            }
        );

        req.on("error", reject);
        req.on("timeout", () => {
            req.destroy(new Error("Camera HTTPS request timed out"));
        });

        if (body) {
            req.write(body);
        }

        req.end();
    });
}

function tlsAgentOptions(keepAlive) {
    const options = {
        keepAlive,
        rejectUnauthorized: false,
        minVersion: "TLSv1.2",
        maxVersion: "TLSv1.2",
        ciphers: "DEFAULT:@SECLEVEL=0",
        ALPNProtocols: ["http/1.1"]
    };

    if (crypto.constants && crypto.constants.SSL_OP_LEGACY_SERVER_CONNECT) {
        options.secureOptions = crypto.constants.SSL_OP_LEGACY_SERVER_CONNECT;
    }

    return options;
}

function createCameraHttpsClient({
    ip,
    username,
    password,
    httpsPort = 443
}) {
    let keepAliveAgent = new https.Agent(tlsAgentOptions(true));
    const closeAgent = new https.Agent(tlsAgentOptions(false));

    const jar = {};
    let nc = 1;
    let loggedIn = false;

    function resetKeepAlive() {
        keepAliveAgent.destroy();
        keepAliveAgent = new https.Agent(tlsAgentOptions(true));
    }

    function cookieHeaderFromJar() {
        const out = { ...jar };

        if (out.session && !out.session_443) {
            out.session_443 = out.session;
        }

        if (out.session_443 && !out.session) {
            out.session = out.session_443;
        }

        return Object.entries(out)
            .map(([name, value]) => `${name}=${value}`)
            .join("; ");
    }

    function browserHeaders(extra = {}) {
        return {
            Accept: "*/*",
            "Accept-Encoding": "gzip, deflate",
            Origin: `https://${ip}`,
            Referer: `https://${ip}/`,
            "X-Requested-With": "XMLHttpRequest",
            ...extra
        };
    }

    async function request(path, options = {}) {
        const retries = options.retries ?? 2;
        let lastError;

        for (let attempt = 0; attempt <= retries; attempt++) {
            try {
                return await requestOnceWithAuth(path, options);
            }
            catch (error) {
                lastError = error;
                const reset = /ECONNRESET|socket hang up|timed out/i.test(
                    error.message || ""
                );

                if (!reset || attempt === retries) {
                    throw error;
                }

                await new Promise((resolve) => setTimeout(resolve, 400 * (attempt + 1)));
            }
        }

        throw lastError;
    }

    async function requestOnceWithAuth(path, options = {}) {
        const method = options.method || "GET";
        const extraHeaders = options.headers || {};
        const body = options.body;
        const agent = options.keepAlive === false ? closeAgent : keepAliveAgent;
        const headers = {
            Connection: options.keepAlive === false ? "close" : "keep-alive",
            Accept: "*/*",
            "User-Agent":
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
                "(KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36",
            ...extraHeaders
        };

        if (body) {
            headers["Content-Length"] = Buffer.byteLength(body);
        }

        const cookies = cookieHeaderFromJar();

        if (cookies) {
            headers.Cookie = cookies;
        }

        if (options.basic) {
            headers.Authorization = basicHeader(username, password);
        }

        let response = await requestOnce({
            protocol: "https:",
            hostname: ip,
            port: httpsPort,
            path,
            method,
            headers,
            body,
            agent,
            timeoutMs: options.timeoutMs
        });

        storeCookies(jar, response.headers["set-cookie"]);

        if (response.status === 401) {
            const wwwAuth = response.headers["www-authenticate"] || "";

            if (/digest/i.test(wwwAuth) && options.digest !== false) {
                const challenge = parseDigestChallenge(wwwAuth);
                const cnonce = crypto.randomBytes(8).toString("hex");
                const authHeaders = {
                    ...headers,
                    Authorization: buildDigestHeader({
                        username,
                        password,
                        method,
                        path,
                        challenge,
                        nc: nc++,
                        cnonce
                    })
                };

                const cookiesAfterChallenge = cookieHeaderFromJar();

                if (cookiesAfterChallenge) {
                    authHeaders.Cookie = cookiesAfterChallenge;
                }

                response = await requestOnce({
                    protocol: "https:",
                    hostname: ip,
                    port: httpsPort,
                    path,
                    method,
                    headers: authHeaders,
                    body,
                    agent,
                    timeoutMs: options.timeoutMs
                });

                storeCookies(jar, response.headers["set-cookie"]);
            }
            else if (/basic/i.test(wwwAuth) && !options.basic) {
                response = await requestOnceWithAuth(path, {
                    ...options,
                    basic: true
                });
            }
        }

        return response;
    }

    async function getJson(path, options = {}) {
        const response = await request(path, options);
        const text = response.body.toString("utf8");
        let json = null;

        try {
            json = text ? JSON.parse(text) : null;
        }
        catch {
            json = null;
        }

        if (response.status >= 400) {
            const err = new Error(
                `Camera API ${path} failed (${response.status})`
            );
            err.status = response.status;
            err.body = text.slice(0, 300);
            throw err;
        }

        return json;
    }

    async function login() {
        loggedIn = false;

        await request("/", {
            keepAlive: true,
            retries: 1,
            headers: browserHeaders()
        }).catch(() => {});

        const hashed = md5(password);
        const payloads = [
            JSON.stringify({
                data: {
                    UserName: username,
                    PassWord: password
                }
            }),
            JSON.stringify({
                data: {
                    UserName: username,
                    Password: password
                }
            }),
            JSON.stringify({
                data: {
                    UserName: username,
                    PassWord: password,
                    Type: 0
                }
            }),
            JSON.stringify({
                data: {
                    UserName: username,
                    PassWord: password,
                    EncryptType: 0
                }
            }),
            JSON.stringify({
                data: {
                    UserName: username,
                    PassWord: hashed,
                    EncryptType: 1
                }
            }),
            JSON.stringify({
                data: {
                    UserName: username,
                    PassWord: hashed
                }
            })
        ];

        const authModes = [true, false];
        let lastStatus = null;

        for (const body of payloads) {
            for (const basic of authModes) {
                try {
                    const response = await request("/API/Web/Login", {
                        method: "POST",
                        keepAlive: false,
                        retries: 1,
                        basic,
                        headers: browserHeaders({
                            "Content-Type": "application/json"
                        }),
                        body
                    });

                    lastStatus = response.status;
                    const text = response.body.toString("utf8");
                    let json = null;

                    try {
                        json = text ? JSON.parse(text) : null;
                    }
                    catch {
                        json = null;
                    }

                    const result = json && json.data ? json.data.Result : undefined;
                    const ok = response.status < 400 && result !== 1 && result !== false;

                    if (ok) {
                        loggedIn = true;
                        resetKeepAlive();
                        console.log(
                            `[Camera] Login OK (HTTP ${response.status}, ` +
                            `body ${Buffer.byteLength(body)} bytes, ` +
                            `basic=${basic}, cookies=${Object.keys(jar).join(",") || "none"})`
                        );
                        return true;
                    }
                }
                catch (error) {
                    lastStatus = error.message;
                }
            }
        }

        console.log(`[Camera] Login failed (${lastStatus || "no response"})`);
        return false;
    }

    async function getSnapedFaces(extraQuery) {
        const now = new Date();
        const pad = (value) => String(value).padStart(2, "0");
        const stamp =
            `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}` +
            `@${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
        const prefix = extraQuery ? `${extraQuery}&` : "";
        const path = `/API/AI/SnapedFaces/GetById?${prefix}${stamp}`;
        const options = {
            keepAlive: false,
            digest: false,
            retries: 1,
            timeoutMs: 20000,
            headers: browserHeaders()
        };

        await new Promise((resolve) => setTimeout(resolve, 300));

        return getJson(path, options);
    }

    async function postSnapedFaces(path, body) {
        const payload = typeof body === "string" ? body : JSON.stringify(body);

        return getJson(path, {
            method: "POST",
            keepAlive: false,
            digest: false,
            retries: 1,
            timeoutMs: 20000,
            headers: browserHeaders({
                "Content-Type": "application/json"
            }),
            body: payload
        });
    }

    function importCookies(cookies) {
        for (const cookie of cookies || []) {
            if (cookie && cookie.name) {
                jar[cookie.name] = cookie.value;
            }
        }
    }

    function getCookies() {
        const names = new Set(Object.keys(jar));

        if (jar.session) {
            names.add("session_443");
        }

        if (jar.session_443) {
            names.add("session");
        }

        return [...names].map((name) => ({
            name,
            value: jar[name] || jar.session_443 || jar.session,
            domain: ip,
            path: "/"
        }));
    }

    function isLoggedIn() {
        return loggedIn && Boolean(jar.session_443 || Object.keys(jar).length);
    }

    return {
        request,
        getJson,
        login,
        getSnapedFaces,
        postSnapedFaces,
        importCookies,
        getCookies,
        isLoggedIn
    };
}

module.exports = {
    createCameraHttpsClient
};

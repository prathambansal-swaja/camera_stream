const axios = require("axios");
const AxiosDigestAuth =
    require("@mhoc/axios-digest-auth").default;
const https = require("https");

const CAMERA_IP = "192.168.1.2";
const USERNAME = "admin";
const PASSWORD = "admin";
const BASE_URL = `https://${CAMERA_IP}`;

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
        timeout: 15000
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

    console.log("FDGroup response:", JSON.stringify(response, null, 2));

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

async function main() {
    try {
        await login();
        await getGroups();
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

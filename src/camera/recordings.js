const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const {
    getCamera,
    isOnvifReady
} = require("./onvifClient");

const CAMERA_IP = process.env.CAMERA_IP;
const CAMERA_RTSP_PORT = process.env.CAMERA_RTSP_PORT || 554;
const CAMERA_USERNAME = process.env.CAMERA_USERNAME;
const CAMERA_PASSWORD = process.env.CAMERA_PASSWORD;
const CAMERA_CHANNEL = process.env.CAMERA_CHANNEL || "01";

const recordingsDir = path.join(
    __dirname,
    "..",
    "..",
    "recordings"
);

fs.mkdirSync(recordingsDir, { recursive: true });

const downloads = new Map();


function asArray(value) {

    if (value === undefined || value === null) {
        return [];
    }

    return Array.isArray(value) ? value : [value];

}


function recordingTokenFrom(item) {

    return (
        item?.jobConfiguration?.recordingToken ||
        item?.recordingToken ||
        item?.configuration?.recordingToken ||
        item?.$?.token ||
        item?.token ||
        null
    );

}


function jobTokenFrom(item) {

    return (
        item?.$?.jobToken ||
        item?.jobToken ||
        item?.$?.token ||
        item?.token ||
        null
    );

}


function withRtspAuth(uri) {

    const parsed = new URL(uri);

    parsed.username = CAMERA_USERNAME || "";
    parsed.password = CAMERA_PASSWORD || "";

    return parsed.toString();

}


function redactUri(uri) {

    if (!uri) {
        return uri;
    }

    try {

        const parsed = new URL(uri);

        if (parsed.password) {
            parsed.password = "********";
        }

        return parsed.toString();

    }
    catch (_error) {
        return uri;
    }

}


function pad(value) {
    return String(value).padStart(2, "0");
}


function formatHoneywellTime(date) {

    const d = new Date(date);

    // Camera returns times like 2026-8-7T15:59:36Z with localtime=true
    return (
        `${d.getFullYear()}-` +
        `${d.getMonth() + 1}-` +
        `${d.getDate()}T` +
        `${pad(d.getHours())}:` +
        `${pad(d.getMinutes())}:` +
        `${pad(d.getSeconds())}Z`
    );

}


function parseHoneywellTime(value) {

    const match = String(value || "").match(
        /^(\d+)-(\d+)-(\d+)T(\d+):(\d+):(\d+)/
    );

    if (!match) {
        return null;
    }

    return new Date(
        Number(match[1]),
        Number(match[2]) - 1,
        Number(match[3]),
        Number(match[4]),
        Number(match[5]),
        Number(match[6])
    );

}


function formatFileStamp(date) {

    const d = new Date(date);

    return (
        `${d.getFullYear()}` +
        `${pad(d.getMonth() + 1)}` +
        `${pad(d.getDate())}_` +
        `${pad(d.getHours())}` +
        `${pad(d.getMinutes())}` +
        `${pad(d.getSeconds())}`
    );

}


function channelNumber() {
    return String(parseInt(CAMERA_CHANNEL, 10) || 1);
}


function playbackBase(baseUri) {

    let host = CAMERA_IP;
    let port = CAMERA_RTSP_PORT;
    let pathname = "/rtsp/playback";
    let channel = channelNumber();
    let user = CAMERA_USERNAME;
    let pass = CAMERA_PASSWORD;

    if (baseUri) {

        try {

            const parsed = new URL(baseUri);

            host = parsed.hostname || host;
            port = parsed.port || port;
            pathname = parsed.pathname || pathname;
            channel = parsed.searchParams.get("channel") || channel;
            user = parsed.username || user;
            pass = parsed.password || pass;

        }
        catch (_error) {
            // use defaults
        }

    }

    const auth =
        `rtsp://${encodeURIComponent(user)}:${encodeURIComponent(pass)}` +
        `@${host}:${port}`;

    return { auth, pathname, channel };

}


function honeywellPlaybackUri(start, end, baseUri) {

    const { auth, pathname, channel } = playbackBase(baseUri);

    return (
        `${auth}${pathname}?channel=${channel}` +
        `&starttime=${formatHoneywellTime(start)}` +
        `&endtime=${formatHoneywellTime(end)}` +
        `&localtime=true`
    );

}


function buildPlaybackUris(start, end, baseUri) {

    const native = honeywellPlaybackUri(start, end, baseUri);
    const encodedTimes = native
        .replace(/starttime=([^&]+)/, (_, value) =>
            `starttime=${value.replace(/:/g, "%3A")}`
        )
        .replace(/endtime=([^&]+)/, (_, value) =>
            `endtime=${value.replace(/:/g, "%3A")}`
        );

    return [...new Set([native, encodedTimes])];

}


function replayWindowFromUri(uri) {

    try {

        const parsed = new URL(uri);
        const startTime = parsed.searchParams.get("starttime");
        const endTime = parsed.searchParams.get("endtime");

        if (!startTime || !endTime) {
            return null;
        }

        return {
            startTime,
            endTime,
            filePath: parsed.pathname,
            type: "sd-card"
        };

    }
    catch (_error) {
        return null;
    }

}


async function safeCall(step, fn) {

    try {
        return {
            ok: true,
            step,
            value: await fn()
        };
    }
    catch (error) {
        return {
            ok: false,
            step,
            error: error.message || String(error)
        };
    }

}


async function getReplayUri(recordingToken) {

    const camera = getCamera();

    const uri = await camera.getReplayUri({
        recordingToken,
        stream: "RTP-Unicast",
        protocol: "RTSP"
    });

    return withRtspAuth(uri);

}


async function listRecordings() {

    if (!isOnvifReady()) {
        throw new Error("ONVIF is not connected yet");
    }

    const camera = getCamera();

    const result = {
        services: {
            recording: Boolean(camera.uri?.recording),
            replay: Boolean(camera.uri?.replay),
            search: Boolean(camera.uri?.search)
        },
        jobs: [],
        recordings: [],
        summary: null,
        replay: [],
        sdCardFiles: [],
        errors: []
    };

    const jobsResult = await safeCall(
        "GetRecordingJobs",
        () => camera.getRecordingJobs()
    );

    if (jobsResult.ok) {

        result.jobs = asArray(jobsResult.value).map((job) => ({
            jobToken: jobTokenFrom(job),
            recordingToken: recordingTokenFrom(job),
            mode: job?.jobConfiguration?.mode || job?.mode || null,
            raw: job
        }));

    }

    const recordingsResult = await safeCall(
        "GetRecordings",
        () => camera.getRecordings()
    );

    if (recordingsResult.ok) {

        result.recordings = asArray(recordingsResult.value).map((item) => ({
            recordingToken: recordingTokenFrom(item),
            content: item?.configuration?.content || null,
            raw: item
        }));

    }
    else {
        result.errors.push(recordingsResult);
    }

    const summaryResult = await safeCall(
        "GetRecordingSummary",
        () => camera.getRecordingSummary()
    );

    if (summaryResult.ok) {
        result.summary = summaryResult.value;
    }

    const tokens = [
        ...result.jobs.map((job) => job.recordingToken),
        ...result.recordings.map((item) => item.recordingToken)
    ].filter(Boolean);

    const uniqueTokens = [...new Set(tokens)];

    if (uniqueTokens.length === 0) {
        uniqueTokens.push("RecordingToken_1");
    }

    for (const recordingToken of uniqueTokens) {

        const replayResult = await safeCall(
            `GetReplayUri:${recordingToken}`,
            () => getReplayUri(recordingToken)
        );

        if (replayResult.ok) {

            const uri = replayResult.value;
            const window = replayWindowFromUri(uri);

            result.replay.push({
                recordingToken,
                uri,
                availableFrom: window?.startTime || null,
                availableUntil: window?.endTime || null
            });

            if (window) {

                const startDate = parseHoneywellTime(window.startTime);
                const endDate = parseHoneywellTime(window.endTime);

                result.sdCardFiles.push({
                    startTime: window.startTime,
                    endTime: window.endTime,
                    startIso: startDate ? startDate.toISOString() : null,
                    endIso: endDate ? endDate.toISOString() : null,
                    filePath: window.filePath,
                    recordingToken
                });

            }

        }
        else {
            result.errors.push(replayResult);
        }

    }

    return result;

}


function listLocalRecordings() {

    return fs.readdirSync(recordingsDir)
        .filter((name) => name.toLowerCase().endsWith(".mp4"))
        .map((name) => {

            const fullPath = path.join(recordingsDir, name);
            const stat = fs.statSync(fullPath);

            if (stat.size === 0) {
                return null;
            }

            return {
                name,
                url: `/recordings/${encodeURIComponent(name)}`,
                size: stat.size,
                modified: stat.mtime
            };

        })
        .filter(Boolean)
        .sort((a, b) => b.modified - a.modified);

}


function describeFfmpegError(stderr) {

    const text = String(stderr || "");

    if (
        /does not contain any stream/i.test(text) ||
        /matches no streams/i.test(text)
    ) {
        return (
            "Camera returned no video for this time range. " +
            "Check the same start/end in Honeywell camera software — " +
            "if nothing plays there, the SD card has a gap (motion/schedule). " +
            "If it does play there, tell me the playback URL shown in that software."
        );
    }

    if (/Error number -10054|Connection reset|Invalid data found/i.test(text)) {
        return (
            "Camera closed the playback connection. " +
            "This usually means no clip at that time, or a rejected URL. " +
            "Confirm in Honeywell software that this range actually plays."
        );
    }

    if (/pcm_alaw|codec not currently supported/i.test(text)) {
        return "Camera audio codec cannot be stored in MP4. Retrying without audio.";
    }

    const lines = text.split("\n").map((line) => line.trim()).filter(Boolean);
    return lines.slice(-6).join(" ");

}


function runFfmpeg(inputUri, outputFile, durationSeconds) {

    return new Promise((resolve) => {

        const args = [
            "-hide_banner",
            "-rtsp_transport",
            "tcp",
            "-analyzeduration",
            "20000000",
            "-probesize",
            "20000000",
            "-fflags",
            "+genpts",
            "-i",
            inputUri,
            "-map",
            "0:v:0",
            "-c:v",
            "copy",
            "-an",
            "-t",
            String(durationSeconds),
            "-movflags",
            "+faststart",
            "-y",
            outputFile
        ];

        const ffmpeg = spawn("ffmpeg", args);
        let stderr = "";

        ffmpeg.stderr.on("data", (data) => {
            stderr += data.toString();
            if (stderr.length > 12000) {
                stderr = stderr.slice(-6000);
            }
        });

        ffmpeg.on("error", (error) => {
            resolve({
                ok: false,
                stderr: error.message,
                size: 0
            });
        });

        ffmpeg.on("close", (code) => {

            const exists = fs.existsSync(outputFile);
            const size = exists ? fs.statSync(outputFile).size : 0;

            if (exists && size === 0) {
                try {
                    fs.unlinkSync(outputFile);
                }
                catch (_error) {
                    // ignore
                }
            }

            resolve({
                ok: code === 0 && size > 0,
                stderr,
                size
            });

        });

    });

}


function getDownload(id) {
    return downloads.get(id) || null;
}


function listDownloads() {
    return [...downloads.values()];
}


async function startDownload({ recordingToken, start, end }) {

    if (!start || !end) {
        throw new Error("start and end times are required");
    }

    const startDate = new Date(start);
    const endDate = new Date(end);

    if (Number.isNaN(startDate.getTime()) || Number.isNaN(endDate.getTime())) {
        throw new Error("Invalid start or end time");
    }

    if (endDate <= startDate) {
        throw new Error("end must be after start");
    }

    const durationSeconds = Math.max(
        1,
        Math.ceil((endDate.getTime() - startDate.getTime()) / 1000)
    );

    // Playback is realtime, so a 24h range takes about 24h to download
    // and becomes one huge file. Keep a single request to 2 hours.
    const maxSeconds = 2 * 60 * 60;

    if (durationSeconds > maxSeconds) {

        const hours = (durationSeconds / 3600).toFixed(1);

        throw new Error(
            `This range is ${hours} hours. The camera plays recordings ` +
            `at normal speed, so that would take about ${hours} hours to ` +
            `download into one file. Pick a window of 2 hours or less. ` +
            `For a full day, download several shorter ranges instead.`
        );

    }

    let token = recordingToken || null;
    let replayUri = null;

    if (isOnvifReady()) {

        const listed = await listRecordings();

        token =
            token ||
            listed.jobs[0]?.recordingToken ||
            listed.recordings[0]?.recordingToken ||
            listed.replay[0]?.recordingToken ||
            "RecordingToken_1";

        replayUri = listed.replay.find((item) =>
            !token || item.recordingToken === token
        )?.uri || listed.replay[0]?.uri || null;

    }

    if (token && !replayUri && isOnvifReady()) {
        try {
            replayUri = await getReplayUri(token);
        }
        catch (_error) {
            replayUri = null;
        }
    }

    const uris = buildPlaybackUris(startDate, endDate, replayUri);

    const fileName =
        `recording_${formatFileStamp(startDate)}_` +
        `${formatFileStamp(endDate)}.mp4`;

    const outputFile = path.join(recordingsDir, fileName);

    const id = String(Date.now());

    const job = {
        id,
        status: "running",
        file: fileName,
        url: `/recordings/${encodeURIComponent(fileName)}`,
        recordingToken: token,
        source: replayUri ? "onvif-replay" : "honeywell-playback",
        inputUri: redactUri(uris[0]),
        error: null
    };

    downloads.set(id, job);

    (async () => {

        let lastStderr = "";

        for (const uri of uris) {

            job.inputUri = redactUri(uri);
            job.status = "running";

            const result = await runFfmpeg(
                uri,
                outputFile,
                durationSeconds
            );

            if (result.ok) {
                job.status = "done";
                job.error = null;
                return;
            }

            lastStderr = result.stderr;

        }

        job.status = "error";
        job.error = describeFfmpegError(lastStderr);

    })().catch((error) => {
        job.status = "error";
        job.error = error.message;
    });

    return job;

}


module.exports = {
    listRecordings,
    listLocalRecordings,
    startDownload,
    getDownload,
    listDownloads,
    recordingsDir,
    redactUri
};

const express = require("express");
const path = require("path");
const fs = require("fs");
const { spawn, execSync } = require("child_process");
require("dotenv").config();

const nodeMajor = Number(process.versions.node.split(".")[0]);

if (nodeMajor < 20) {
    console.error(
        `This app needs Node.js 20 or newer. This machine has ${process.version}.`
    );
    process.exit(1);
}

try {
    execSync("ffmpeg -version", { stdio: "pipe" });
}
catch (_error) {
    console.error(
        "FFmpeg is missing or not on PATH. Install FFmpeg, then restart."
    );
    process.exit(1);
}

const {
    startONVIF
} = require("./camera/onvifClient");

const {
    listRecordings,
    listLocalRecordings,
    startDownload,
    getDownload,
    recordingsDir,
    redactUri,
    resolvePlayback,
    spawnPlaybackStream,
    stopPlaybackStream
} = require("./camera/recordings");

const {
    listSavedFaces,
    syncSnappedFaces,
    startFaceSync,
    stopFaceSync,
    snapsDir
} = require("./camera/snappedFaces");

const {
    listMatchedFaces,
    syncMatchedFaces,
    startMatchedFaceSync,
    stopMatchedFaceSync,
    matchedFacesDir
} = require("./faces");

const {
    listFaceThumbnails,
    getLiveFaceJpeg
} = require("./faces/faceThumbnails");

const {
    startFetchFacesLoop,
    stopFetchFacesLoop
} = require("./faces/fetchFaces");

const app = express();

app.use(express.json());

const PORT = process.env.SERVER_PORT || 3000;

const CAMERA_IP = process.env.CAMERA_IP;
const CAMERA_RTSP_PORT = process.env.CAMERA_RTSP_PORT || 554;
const CAMERA_USERNAME = process.env.CAMERA_USERNAME;
const CAMERA_PASSWORD = process.env.CAMERA_PASSWORD;
const CAMERA_CHANNEL = process.env.CAMERA_CHANNEL || "01";
const CAMERA_SUBTYPE = process.env.CAMERA_SUBTYPE || "0";

const CAMERA_2_IP = process.env.CAMERA_2_IP;
const CAMERA_2_RTSP_PORT = process.env.CAMERA_2_RTSP_PORT || 554;
const CAMERA_2_USERNAME =
    process.env.CAMERA_2_USERNAME || CAMERA_USERNAME;
const CAMERA_2_PASSWORD =
    process.env.CAMERA_2_PASSWORD || CAMERA_PASSWORD;
const CAMERA_2_CHANNEL = process.env.CAMERA_2_CHANNEL || "01";
const CAMERA_2_SUBTYPE = process.env.CAMERA_2_SUBTYPE || "0";

const publicDir = path.join(__dirname, "..", "public");
const streamsRoot = path.join(__dirname, "..", "streams");

let shuttingDown = false;
const mjpegProcesses = new Set();

function cameraRtspUrl({ ip, port, username, password, channel, subtype }) {
    return (
        `rtsp://${encodeURIComponent(username)}:` +
        `${encodeURIComponent(password)}@` +
        `${ip}:${port}` +
        `/rtsp/streaming?channel=${channel}&subtype=${subtype}`
    );
}

function logRtspUrl(label, { ip, port, username, channel, subtype }) {
    console.log(
        `${label}: rtsp://${username}:********@${ip}:${port}` +
        `/rtsp/streaming?channel=${channel}&subtype=${subtype}`
    );
}

const liveCameras = [
    {
        id: "camera1",
        label: "Camera 1",
        ip: CAMERA_IP,
        port: CAMERA_RTSP_PORT,
        username: CAMERA_USERNAME,
        password: CAMERA_PASSWORD,
        channel: CAMERA_CHANNEL,
        subtype: CAMERA_SUBTYPE,
        copyVideo: true
    },
    CAMERA_2_IP && {
        id: "camera2",
        label: "Camera 2",
        ip: CAMERA_2_IP,
        port: CAMERA_2_RTSP_PORT,
        username: CAMERA_2_USERNAME,
        password: CAMERA_2_PASSWORD,
        channel: CAMERA_2_CHANNEL,
        subtype: CAMERA_2_SUBTYPE,
        copyVideo: true
    }
].filter(Boolean);

for (const camera of liveCameras) {
    camera.streamDir = path.join(streamsRoot, camera.id);
    camera.hlsOutput = path.join(camera.streamDir, "index.m3u8");
    camera.hlsUrl = `/streams/${camera.id}/index.m3u8`;
    camera.rtspUrl = cameraRtspUrl(camera);
    fs.mkdirSync(camera.streamDir, { recursive: true });
    logRtspUrl(camera.label, camera);
}

function startFFmpeg(camera) {
    console.log(`Starting FFmpeg for ${camera.label}...`);

    const inputArgs = camera.copyVideo
        ? [
            "-rtsp_transport",
            "tcp",
            "-fflags",
            "nobuffer+genpts",
            "-flags",
            "low_delay",
            "-probesize",
            "32768",
            "-analyzeduration",
            "500000",
            "-i",
            camera.rtspUrl,
            "-c:v",
            "copy",
            "-an",
            "-muxdelay",
            "0",
            "-muxpreload",
            "0"
        ]
        : [
            "-rtsp_transport",
            "tcp",
            "-fflags",
            "nobuffer",
            "-flags",
            "low_delay",
            "-probesize",
            "32768",
            "-analyzeduration",
            "500000",
            "-i",
            camera.rtspUrl,
            "-c:v",
            "libx264",
            "-preset",
            "ultrafast",
            "-tune",
            "zerolatency",
            "-bf",
            "0",
            "-g",
            "25",
            "-keyint_min",
            "25",
            "-sc_threshold",
            "0",
            "-pix_fmt",
            "yuv420p",
            "-an"
        ];

    const hlsFlags = camera.copyVideo
        ? "delete_segments+omit_endlist+independent_segments+split_by_time"
        : "delete_segments+omit_endlist+independent_segments";

    const ffmpeg = spawn("ffmpeg", [
        ...inputArgs,
        "-f",
        "hls",
        "-hls_time",
        "1",
        "-hls_list_size",
        "3",
        "-hls_flags",
        hlsFlags,
        camera.hlsOutput
    ]);

    camera.process = ffmpeg;

    ffmpeg.stdout.on("data", (data) => {
        console.log(`[FFmpeg ${camera.id}] ${data}`);
    });

    ffmpeg.stderr.on("data", (data) => {
        console.log(`[FFmpeg ${camera.id}] ${data}`);
    });

    ffmpeg.on("error", (error) => {
        console.error(`Failed to start FFmpeg for ${camera.label}:`);
        console.error(error);
    });

    ffmpeg.on("close", (code) => {
        console.log(
            `FFmpeg for ${camera.label} exited with code ${code}`
        );

        if (shuttingDown) {
            return;
        }

        console.log(`Restarting ${camera.label} FFmpeg in 3 seconds...`);
        setTimeout(() => {
            startFFmpeg(camera);
        }, 3000);
    });

    return ffmpeg;
}

function startLiveStreams() {
    for (const camera of liveCameras) {
        startFFmpeg(camera);
    }
}

// --------------------------------------------------
// Serve frontend
// --------------------------------------------------

app.use(
    express.static(publicDir)
);

app.get("/api/cameras/:id/mjpeg", (req, res) => {
    const camera = liveCameras.find((item) => item.id === req.params.id);

    if (!camera) {
        res.status(404).json({ error: "Camera not found" });
        return;
    }

    res.status(200);
    res.setHeader(
        "Content-Type",
        "multipart/x-mixed-replace; boundary=ffmpeg"
    );
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Connection", "close");

    const ffmpeg = spawn("ffmpeg", [
        "-hide_banner",
        "-loglevel",
        "error",
        "-rtsp_transport",
        "tcp",
        "-i",
        camera.rtspUrl,
        "-an",
        "-vf",
        "fps=8,scale=1280:-2",
        "-q:v",
        "7",
        "-f",
        "mpjpeg",
        "pipe:1"
    ]);

    mjpegProcesses.add(ffmpeg);
    ffmpeg.stdout.pipe(res);

    const stop = () => {
        mjpegProcesses.delete(ffmpeg);
        try {
            ffmpeg.kill("SIGKILL");
        }
        catch (_error) {
            // ignore
        }
    };

    req.on("close", stop);
    res.on("close", stop);

    ffmpeg.on("error", (error) => {
        console.error(`MJPEG ${camera.label} failed:`, error.message);
        stop();
        if (!res.writableEnded) {
            res.end();
        }
    });

    ffmpeg.on("close", () => {
        mjpegProcesses.delete(ffmpeg);
        if (!res.writableEnded) {
            res.end();
        }
    });
});

// --------------------------------------------------
// Serve HLS stream
// --------------------------------------------------

app.use(
    "/streams",
    express.static(
        path.join(__dirname, "..", "streams"),
        {
            setHeaders: (res) => {
                res.setHeader(
                    "Cache-Control",
                    "no-cache, no-store, must-revalidate"
                );
            }
        }
    )
);

app.use(
    "/recordings",
    express.static(recordingsDir)
);

app.use(
    "/snaps",
    express.static(snapsDir)
);

app.use(
    "/matched-faces",
    express.static(matchedFacesDir)
);

// --------------------------------------------------
// Health endpoint
// --------------------------------------------------

app.get("/api/status", (req, res) => {

    res.json({
        cameras: liveCameras.map((camera) => ({
            id: camera.id,
            label: camera.label,
            ip: camera.ip,
            rtspPort: camera.port,
            channel: camera.channel,
            subtype: camera.subtype,
            hls: camera.hlsUrl
        }))
    });

});

// --------------------------------------------------
// SD card recordings (ONVIF Profile G)
// --------------------------------------------------

app.get("/api/recordings", async (req, res) => {

    try {

        const data = await listRecordings();

        res.json({
            ...data,
            replay: (data.replay || []).map((item) => ({
                ...item,
                uri: redactUri(item.uri)
            })),
            local: listLocalRecordings()
        });

    }
    catch (error) {

        const notReady = /not connected/i.test(error.message || "");

        res.status(notReady ? 503 : 500).json({
            error: error.message
        });

    }

});

app.get("/api/recordings/local", (req, res) => {

    res.json({
        local: listLocalRecordings()
    });

});

app.get("/api/recordings/downloads/:id", (req, res) => {

    const job = getDownload(req.params.id);

    if (!job) {
        res.status(404).json({ error: "Download not found" });
        return;
    }

    res.json(job);

});

app.post("/api/recordings/download", async (req, res) => {

    try {

        const job = await startDownload({
            recordingToken: req.body?.recordingToken,
            start: req.body?.start,
            end: req.body?.end
        });

        res.json(job);

    }
    catch (error) {

        res.status(400).json({
            error: error.message
        });

    }

});

// MPEG-TS playback from SD card — piped through FFmpeg, not saved to disk
app.get("/api/recordings/stream", async (req, res) => {

    let ffmpeg;

    try {

        const playback = await resolvePlayback({
            recordingToken: req.query.recordingToken,
            start: req.query.start,
            end: req.query.end
        });

        res.status(200);
        res.setHeader("Content-Type", "video/mp2t");
        res.setHeader("Cache-Control", "no-store");
        res.setHeader("Connection", "close");

        ffmpeg = spawnPlaybackStream(
            playback.uris[0],
            playback.durationSeconds
        );

        ffmpeg.stdout.pipe(res);

        ffmpeg.stderr.on("data", (data) => {
            console.log(`[Playback FFmpeg] ${data}`);
        });

        const stop = () => {
            stopPlaybackStream();
        };

        req.on("close", stop);
        res.on("close", stop);

        ffmpeg.on("error", (error) => {
            console.error("Playback FFmpeg failed:", error.message);
            if (!res.writableEnded) {
                res.end();
            }
        });

        ffmpeg.on("close", () => {
            if (!res.writableEnded) {
                res.end();
            }
        });

    }
    catch (error) {

        if (res.headersSent) {
            res.end();
            return;
        }

        res.status(400).json({
            error: error.message
        });

    }

});

// --------------------------------------------------
// Snapped face images
// --------------------------------------------------

app.get("/api/faces", (req, res) => {
    res.json(listSavedFaces());
});

app.post("/api/faces/sync", (req, res) => {
    const full = Boolean(req.body && req.body.full);
    const current = listSavedFaces();

    if (current.syncing) {
        res.json({
            started: false,
            skipped: true,
            reason: "sync already running",
            ...current
        });
        return;
    }

    syncSnappedFaces({ full }).catch(() => {});
    res.json({
        started: true,
        full,
        ...listSavedFaces()
    });
});

app.get("/api/matched-faces", (req, res) => {
    res.json(listMatchedFaces());
});

app.get("/api/face-thumbnails", (req, res) => {
    res.json(listFaceThumbnails());
});

app.get("/api/face-thumbnails/:uuid/image", (req, res) => {
    const jpeg = getLiveFaceJpeg(req.params.uuid);

    if (!jpeg) {
        res.status(404).json({ error: "Face image not in live gallery" });
        return;
    }

    res.setHeader("Content-Type", "image/jpeg");
    res.setHeader("Cache-Control", "no-store");
    res.end(jpeg);
});

app.post("/api/matched-faces/sync", (req, res) => {
    const current = listMatchedFaces();

    if (current.syncing) {
        res.json({
            started: false,
            skipped: true,
            reason: "sync already running",
            ...current
        });
        return;
    }

    syncMatchedFaces().catch(() => {});
    res.json({
        started: true,
        ...listMatchedFaces()
    });
});

// --------------------------------------------------
// Start server
// --------------------------------------------------

app.listen(PORT, async () => {

    console.log(
        `Node.js server running at http://localhost:${PORT}`
    );

    for (const camera of liveCameras) {
        console.log(
            `${camera.label} HLS: http://localhost:${PORT}${camera.hlsUrl}`
        );
    }

    startLiveStreams();

    await startONVIF();

    startFetchFacesLoop();
});

// --------------------------------------------------
// Graceful shutdown
// --------------------------------------------------

process.on("SIGINT", async () => {

    console.log("\nShutting down...");

    shuttingDown = true;

    for (const camera of liveCameras) {
        try {
            camera.process?.kill();
        }
        catch (_error) {
            // ignore
        }
    }

    for (const ffmpeg of mjpegProcesses) {
        try {
            ffmpeg.kill("SIGKILL");
        }
        catch (_error) {
            // ignore
        }
    }

    stopPlaybackStream();
    await stopFaceSync();
    stopMatchedFaceSync();
    stopFetchFacesLoop();

    process.exit(0);

});
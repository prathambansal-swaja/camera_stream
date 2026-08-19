const express = require("express");
const path = require("path");
const fs = require("fs");
const { spawn } = require("child_process");
require("dotenv").config();

const {
    startONVIF
} = require("./camera/onvifClient");

const app = express();

const PORT = process.env.SERVER_PORT || 3000;

const CAMERA_IP = process.env.CAMERA_IP;
const CAMERA_RTSP_PORT = process.env.CAMERA_RTSP_PORT || 554;
const CAMERA_USERNAME = process.env.CAMERA_USERNAME;
const CAMERA_PASSWORD = process.env.CAMERA_PASSWORD;
const CAMERA_CHANNEL = process.env.CAMERA_CHANNEL || "01";
const CAMERA_SUBTYPE = process.env.CAMERA_SUBTYPE || "1";

// --------------------------------------------------
// Paths
// --------------------------------------------------

const publicDir = path.join(__dirname, "..", "public");

const streamDir = path.join(
    __dirname,
    "..",
    "streams",
    "camera1"
);

// Create stream directory if it doesn't exist
fs.mkdirSync(streamDir, { recursive: true });

// --------------------------------------------------
// RTSP URL
// --------------------------------------------------

const rtspUrl =
    `rtsp://${encodeURIComponent(CAMERA_USERNAME)}:` +
    `${encodeURIComponent(CAMERA_PASSWORD)}@` +
    `${CAMERA_IP}:${CAMERA_RTSP_PORT}` +
    `/rtsp/streaming?channel=${CAMERA_CHANNEL}&subtype=${CAMERA_SUBTYPE}`;

console.log("RTSP URL:");
console.log(
    `rtsp://${CAMERA_USERNAME}:********@` +
    `${CAMERA_IP}:${CAMERA_RTSP_PORT}` +
    `/rtsp/streaming?channel=${CAMERA_CHANNEL}&subtype=${CAMERA_SUBTYPE}`
);

// --------------------------------------------------
// HLS output
// --------------------------------------------------

const hlsOutput = path.join(streamDir, "index.m3u8");

// --------------------------------------------------
// Start FFmpeg
// --------------------------------------------------

function startFFmpeg() {

    console.log("Starting FFmpeg...");

    const ffmpegArgs = [

        // RTSP over TCP
        "-rtsp_transport",
        "tcp",

        // Input
        "-i",
        rtspUrl,

        // Video
        "-c:v",
        "libx264",

        // Reduce latency
        "-preset",
        "veryfast",
        "-tune",
        "zerolatency",

        // Pixel format supported by browsers
        "-pix_fmt",
        "yuv420p",

        // No audio for now
        "-an",

        // HLS
        "-f",
        "hls",

        // Segment duration
        "-hls_time",
        "1",

        // Keep only a few segments
        "-hls_list_size",
        "3",

        // Remove old segments
        "-hls_flags",
        "delete_segments+append_list",

        // HLS output
        hlsOutput
    ];

    const ffmpeg = spawn("ffmpeg", ffmpegArgs);

    ffmpeg.stdout.on("data", (data) => {
        console.log(`[FFmpeg] ${data}`);
    });

    ffmpeg.stderr.on("data", (data) => {
        console.log(`[FFmpeg] ${data}`);
    });

    ffmpeg.on("error", (error) => {

        console.error("Failed to start FFmpeg:");

        console.error(error);

    });

    ffmpeg.on("close", (code) => {

        console.log(
            `FFmpeg process exited with code ${code}`
        );

        // Restart FFmpeg if camera stream is lost
        console.log("Restarting FFmpeg in 3 seconds...");

        setTimeout(() => {
            startFFmpeg();
        }, 3000);
    });

    return ffmpeg;
}

// --------------------------------------------------
// Serve frontend
// --------------------------------------------------

app.use(
    express.static(publicDir)
);

// --------------------------------------------------
// Serve HLS stream
// --------------------------------------------------

app.use(
    "/streams",
    express.static(
        path.join(__dirname, "..", "streams")
    )
);

// --------------------------------------------------
// Health endpoint
// --------------------------------------------------

app.get("/api/status", (req, res) => {

    res.json({
        camera: CAMERA_IP,
        rtspPort: CAMERA_RTSP_PORT,
        channel: CAMERA_CHANNEL,
        subtype: CAMERA_SUBTYPE,
        hls: "/streams/camera1/index.m3u8"
    });

});

// --------------------------------------------------
// Start server
// --------------------------------------------------

app.listen(PORT, async () => {

    console.log(
        `Node.js server running at http://localhost:${PORT}`
    );

    console.log(
        `HLS stream: http://localhost:${PORT}/streams/camera1/index.m3u8`
    );

    startFFmpeg();

    await startONVIF();
});

// --------------------------------------------------
// Graceful shutdown
// --------------------------------------------------

process.on("SIGINT", () => {

    console.log("\nShutting down...");

    process.exit(0);

});
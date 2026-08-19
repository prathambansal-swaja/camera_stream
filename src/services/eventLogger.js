const fs = require("fs");
const path = require("path");

const logDir = path.join(__dirname, "..", "..", "logs");

fs.mkdirSync(logDir, {
    recursive: true
});

const logFile = path.join(
    logDir,
    "camera-events.log"
);

async function logCameraEvent(event) {

    const logEntry = {
        receivedAt: new Date().toISOString(),
        ...event
    };

    const line =
        JSON.stringify(logEntry) + "\n";

    await fs.promises.appendFile(
        logFile,
        line
    );

    console.log(
        `[EVENT] ${event.rule} | ${event.event} = ${event.state}`
    );
}

module.exports = {
    logCameraEvent
};
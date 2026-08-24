const fs = require("fs");
const path = require("path");

const PAD_SECONDS = 5;
const faceImagesDir = path.join(__dirname, "face_images");

function parseFaceFilename(filename) {
    const base = String(filename || "").replace(/\.jpe?g$/i, "");

    const named = base.match(/^(.+)\+(\d{9,})(?:_.+)?$/);

    if (named) {
        return {
            group: named[1].trim() || "Unknown",
            unix: Number(named[2])
        };
    }

    const numbered = base.match(/^(\d{9,})_(.+)$/);

    if (numbered) {
        return {
            group: "Unknown",
            unix: Number(numbered[1])
        };
    }

    return null;
}

function cameraUnixToDate(unix) {
    const utc = new Date(Number(unix) * 1000);

    return new Date(
        utc.getUTCFullYear(),
        utc.getUTCMonth(),
        utc.getUTCDate(),
        utc.getUTCHours(),
        utc.getUTCMinutes(),
        utc.getUTCSeconds()
    );
}

function clipRangeFromUnix(unix) {
    const moment = cameraUnixToDate(unix);
    const startDate = new Date(moment.getTime() - (PAD_SECONDS * 1000));
    const endDate = new Date(moment.getTime() + (PAD_SECONDS * 1000));

    return {
        time: Number(unix),
        timeIso: moment.toISOString(),
        start: startDate.toISOString(),
        end: endDate.toISOString(),
        padSeconds: PAD_SECONDS
    };
}

function listFaceThumbnails() {
    if (!fs.existsSync(faceImagesDir)) {
        return {
            count: 0,
            files: [],
            folder: faceImagesDir
        };
    }

    const files = fs.readdirSync(faceImagesDir)
        .filter((name) => /\.jpe?g$/i.test(name))
        .map((name) => {
            const parsed = parseFaceFilename(name);

            if (!parsed) {
                return null;
            }

            const range = clipRangeFromUnix(parsed.unix);
            const fullPath = path.join(faceImagesDir, name);
            const stat = fs.statSync(fullPath);

            return {
                file: name,
                url: `/face-images/${encodeURIComponent(name)}`,
                group: parsed.group,
                ...range,
                mtimeMs: stat.mtimeMs
            };
        })
        .filter(Boolean)
        .sort((a, b) => b.time - a.time);

    return {
        count: files.length,
        files,
        folder: faceImagesDir
    };
}

module.exports = {
    PAD_SECONDS,
    faceImagesDir,
    parseFaceFilename,
    clipRangeFromUnix,
    listFaceThumbnails
};

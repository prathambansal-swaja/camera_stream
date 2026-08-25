const PAD_SECONDS = 5;

const {
    listLiveFaces,
    getLiveFaceJpeg
} = require("./fetchFaces");

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
    const files = listLiveFaces().map((item) => ({
        file: item.uuid,
        url: `/api/face-thumbnails/${encodeURIComponent(item.uuid)}/image`,
        group: item.group,
        ...clipRangeFromUnix(item.time),
        mtimeMs: item.fetchedAt
    }));

    return {
        count: files.length,
        files
    };
}

module.exports = {
    PAD_SECONDS,
    clipRangeFromUnix,
    listFaceThumbnails,
    getLiveFaceJpeg
};

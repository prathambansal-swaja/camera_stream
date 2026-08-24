const path = require("path");
const fs = require("fs");

const matchedFacesDir = path.join(__dirname, "..", "..", "matched-faces");

fs.mkdirSync(matchedFacesDir, { recursive: true });

function listMatchedFaces() {
    return {
        files: [],
        count: 0,
        syncing: false,
        loggedIn: false
    };
}

function syncMatchedFaces() {
    return Promise.resolve(listMatchedFaces());
}

function startMatchedFaceSync() {}

function stopMatchedFaceSync() {}

module.exports = {
    listMatchedFaces,
    syncMatchedFaces,
    startMatchedFaceSync,
    stopMatchedFaceSync,
    matchedFacesDir
};

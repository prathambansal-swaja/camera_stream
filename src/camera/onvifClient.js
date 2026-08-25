const onvif = require("onvif/promises");

const AsyncEventEmitter =
    require("../events/EventBus");

const {
    parseCameraEvent
} = require("../events/eventParser");

const {
    logCameraEvent
} = require("../services/eventLogger");


// --------------------------------------------------
// Event Bus
// --------------------------------------------------

const eventBus =
    new AsyncEventEmitter();


// --------------------------------------------------
// Event Listener / Handler
// --------------------------------------------------

eventBus.on(
    "cameraEvent",
    logCameraEvent
);


// --------------------------------------------------
// Camera
// --------------------------------------------------

let onvifReady = false;

const camera = new onvif.Cam({
    hostname: process.env.CAMERA_IP,
    username: process.env.CAMERA_USERNAME,
    password: process.env.CAMERA_PASSWORD,
    port: process.env.ONVIF_PORT || 80,
    preserveAddress: true
});


// --------------------------------------------------
// Start ONVIF
// --------------------------------------------------

async function startONVIF() {

    try {

        console.log(
            "Connecting to camera using ONVIF..."
        );

        await camera.connect();

        onvifReady = true;

        console.log(
            "ONVIF connected"
        );


        // ------------------------------------------
        // Receive camera events
        // ------------------------------------------

        camera.on(
            "event",
            async (rawEvent) => {

                try {

                    // Convert raw ONVIF event
                    // into our application format
                    const event =
                        parseCameraEvent(rawEvent);


                    // Send normalized event
                    // through our async event bus
                    await eventBus.emitAsync(
                        "cameraEvent",
                        event
                    );

                }
                catch (error) {

                    console.error(
                        "Error processing camera event:",
                        error.message || error
                    );

                }

            }
        );


        // ------------------------------------------
        // ONVIF errors
        // ------------------------------------------

        camera.on(
            "eventsError",
            (error) => {

                console.error(
                    "ONVIF event error:",
                    error
                );

            }
        );


        console.log(
            "ONVIF event listener started"
        );

    }
    catch (error) {

        console.error(
            "ONVIF connection failed:",
            error
        );

    }

}


// --------------------------------------------------
// Export
// --------------------------------------------------

function getCamera() {

    if (!onvifReady) {
        throw new Error("ONVIF is not connected yet");
    }

    return camera;

}

function isOnvifReady() {
    return onvifReady;
}


module.exports = {
    startONVIF,
    getCamera,
    isOnvifReady
};
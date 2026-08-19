require("dotenv").config();

const onvif = require("onvif/promises");

const camera = new onvif.Cam({
    hostname: process.env.CAMERA_IP,
    username: process.env.CAMERA_USERNAME,
    password: process.env.CAMERA_PASSWORD,
    port: process.env.ONVIF_PORT || 80
});

async function inspectMetadata() {

    try {

        console.log("Connecting to camera...");

        await camera.connect();

        console.log("ONVIF connected\n");


        // ==========================================
        // 1. MEDIA PROFILES
        // ==========================================

        console.log("========== MEDIA PROFILES ==========\n");

        const profiles =
            await camera.getProfiles();

        console.log(
            JSON.stringify(
                profiles,
                null,
                2
            )
        );


        // ==========================================
        // 2. METADATA CONFIGURATIONS
        // ==========================================

        console.log(
            "\n========== METADATA CONFIGURATIONS ==========\n"
        );

        const metadataConfigs =
            await camera.getMetadataConfigurations();

        console.log(
            JSON.stringify(
                metadataConfigs,
                null,
                2
            )
        );


        // ==========================================
        // 3. COMPATIBLE METADATA CONFIGURATIONS
        // ==========================================

        console.log(
            "\n========== COMPATIBLE METADATA CONFIGURATIONS ==========\n"
        );

        for (const profile of profiles) {

            const token =
                profile.$?.token ||
                profile.token;

            console.log(
                `\nProfile token: ${token}`
            );

            try {

                const compatible =
                    await camera.getCompatibleMetadataConfigurations({
                        ProfileToken: token
                    });

                console.log(
                    JSON.stringify(
                        compatible,
                        null,
                        2
                    )
                );

            }
            catch (error) {

                console.error(
                    "Could not get compatible metadata configurations:",
                    error.message
                );

            }

        }


        console.log(
            "\n========== INSPECTION COMPLETE ==========\n"
        );

    }
    catch (error) {

        console.error(
            "\nMetadata inspection failed:\n",
            error
        );

    }

}

inspectMetadata();
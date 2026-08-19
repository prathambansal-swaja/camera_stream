function parseCameraEvent(rawEvent) {

    const message = rawEvent.message.message;

    const timestamp =
        message?.$?.UtcTime;

    const operation =
        message?.$?.PropertyOperation;

    const sourceItems =
        message?.source?.simpleItem || [];

    const dataItem =
        message?.data?.simpleItem;

    const source = {};

    for (const item of sourceItems) {

        source[item.$.Name] =
            item.$.Value;
    }

    return {

        timestamp,

        operation,

        camera: "camera1",

        videoSource:
            source.VideoSource ||
            source.Source,

        analyticsConfiguration:
            source.AnalyticsConfiguration ||
            source.VideoAnalyticsConfigurationToken,

        rule:
            source.Rule,

        event:
            dataItem?.$?.Name,

        state:
            dataItem?.$?.Value === true ||
            dataItem?.$?.Value === "true",

        raw: rawEvent
    };
}

module.exports = {
    parseCameraEvent
};
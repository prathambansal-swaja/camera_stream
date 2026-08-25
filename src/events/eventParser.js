function asArray(value) {
    if (value == null) {
        return [];
    }

    return Array.isArray(value) ? value : [value];
}

function itemFields(item) {
    if (!item || typeof item !== "object") {
        return null;
    }

    const attrs = item.$ && typeof item.$ === "object" ? item.$ : item;
    const name = attrs.Name ?? attrs.name;
    const value = attrs.Value ?? attrs.value;

    if (!name) {
        return null;
    }

    return { name, value };
}

function parseCameraEvent(rawEvent) {
    const message =
        rawEvent?.message?.message ||
        rawEvent?.message ||
        rawEvent;

    const timestamp =
        message?.$?.UtcTime ||
        message?.UtcTime ||
        null;

    const operation =
        message?.$?.PropertyOperation ||
        message?.PropertyOperation ||
        null;

    const sourceItems = asArray(
        message?.source?.simpleItem ||
        message?.source?.SimpleItem ||
        message?.Source?.simpleItem
    );

    const dataItems = asArray(
        message?.data?.simpleItem ||
        message?.data?.SimpleItem ||
        message?.Data?.simpleItem
    );

    const source = {};

    for (const item of sourceItems) {
        const fields = itemFields(item);

        if (fields) {
            source[fields.name] = fields.value;
        }
    }

    const dataItem = dataItems[0] ? itemFields(dataItems[0]) : null;

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
        rule: source.Rule,
        event: dataItem?.name,
        state:
            dataItem?.value === true ||
            dataItem?.value === "true",
        raw: rawEvent
    };
}

module.exports = {
    parseCameraEvent
};

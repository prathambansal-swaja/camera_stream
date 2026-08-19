const EventEmitter = require("events");

class AsyncEventEmitter extends EventEmitter {

    async emitAsync(eventName, ...args) {

        const listeners = this.listeners(eventName);

        await Promise.all(
            listeners.map(listener =>
                listener(...args)
            )
        );
    }
}

module.exports = AsyncEventEmitter;
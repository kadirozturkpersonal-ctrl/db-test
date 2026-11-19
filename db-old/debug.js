/**
 * Debug message logger.
 * Shows some messages always, others only if isShow=true.
 */
const log = (msg, isShow=false) => {
    if (isShow) {
        console.log(msg);
    }
}

// Use CommonJS export instead of ES6 export
module.exports = { log };
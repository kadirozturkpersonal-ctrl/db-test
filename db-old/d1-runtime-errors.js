function isD1StopError(error) {
    return ['D1_QUOTA_EXCEEDED', 'D1_READ_FAILED', 'D1_WRITE_FAILED', 'D1_SQL_FAILED'].includes(error?.code)
        || /exceeded D1.*(daily|free tier)|daily row (read|write) limit/i.test(String(error?.message || error));
}

module.exports = { isD1StopError };

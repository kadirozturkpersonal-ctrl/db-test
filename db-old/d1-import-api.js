const crypto = require('crypto');
const { log } = require('./debug');

/**
 * Cloudflare D1 Import API Helper
 * Much faster than wrangler CLI for bulk imports
 */
class D1ImportAPI {
	constructor(accountId, databaseId, apiToken) {
		this.accountId = accountId;
		this.databaseId = databaseId;
		this.apiToken = apiToken;
		this.apiUrl = `https://api.cloudflare.com/client/v4/accounts/${accountId}/d1/database/${databaseId}/import`;
		this.headers = {
			'Content-Type': 'application/json',
			Authorization: `Bearer ${apiToken}`,
		};
	}

	async fetchWithRetry(url, options, label, maxAttempts = 3) {
		let lastError;

		for (let attempt = 1; attempt <= maxAttempts; attempt++) {
			const controller = new AbortController();
			const timeout = setTimeout(() => controller.abort(), 60_000);
			try {
				const response = await fetch(url, { ...options, signal: controller.signal });
				if (![408, 429, 500, 502, 503, 504].includes(response.status) || attempt === maxAttempts) {
					return response;
				}
				lastError = new Error(`${label} HTTP ${response.status}`);
			} catch (error) {
				lastError = error;
				if (attempt === maxAttempts) throw error;
			} finally {
				clearTimeout(timeout);
			}

			const delayMs = attempt * 1000;
			log(`   ⚠️  ${label} temporarily failed (${lastError.message}); retrying in ${delayMs}ms.`, true);
			await new Promise(resolve => setTimeout(resolve, delayMs));
		}

		throw lastError;
	}

	/**
	 * Poll import status until complete
	 */
	async pollImport(bookmark) {
		const payload = {
			action: 'poll',
			current_bookmark: bookmark,
		};

		while (true) {
			const pollResponse = await this.fetchWithRetry(this.apiUrl, {
				method: 'POST',
				headers: this.headers,
				body: JSON.stringify(payload),
			});

			const result = await pollResponse.json();
			const { success, error } = result.result;

			if (success || (!success && error === 'Not currently importing anything.')) {
				return true;
			}

			// Wait 1 second before polling again
			await new Promise((resolve) => setTimeout(resolve, 1000));
		}
	}

	/**
	 * Upload SQL to D1 using Import API
	 */
	async uploadSQL(sqlStatement) {
		try {
			// 1. Calculate MD5 hash
			const hashStr = crypto.createHash('md5').update(sqlStatement).digest('hex');

			log('   📤 Initiating D1 import...', true);

			// 2. Init upload
			const initResponse = await this.fetchWithRetry(this.apiUrl, {
				method: 'POST',
				headers: this.headers,
				body: JSON.stringify({
					action: 'init',
					etag: hashStr,
				}),
			});

			const uploadData = await initResponse.json();

			if (!uploadData.success) {
				throw new Error(`Init failed: ${JSON.stringify(uploadData.errors)}`);
			}

			const uploadUrl = uploadData.result.upload_url;
			const filename = uploadData.result.filename;

			// Cache hit: Cloudflare recognised this exact SQL (same etag) and
			// already imported it. No upload_url is returned in that case.
			// See: https://developers.cloudflare.com/d1/tutorials/import-to-d1-with-rest-api/
			if (!uploadUrl) {
				log('   ⚡ Cache hit — Cloudflare already imported this exact SQL.', true);
				log('   ✅ Import complete (from cache)!', true);
				return true;
			}

			log('   ☁️  Uploading to R2...', true);

			// 3. Upload to R2
			const r2Response = await this.fetchWithRetry(uploadUrl, {
				method: 'PUT',
				body: sqlStatement,
			});

			if (!r2Response.ok) {
				throw new Error(`R2 upload HTTP ${r2Response.status}`);
			}
			const r2Etag = r2Response.headers.get('ETag')?.replace(/"/g, '');

			// Verify etag
			if (r2Etag !== hashStr) {
				throw new Error('ETag mismatch - upload corrupted');
			}

			log('   💾 Starting ingestion...', true);

			// 4. Start ingestion
			const ingestResponse = await this.fetchWithRetry(this.apiUrl, {
				method: 'POST',
				headers: this.headers,
				body: JSON.stringify({
					action: 'ingest',
					etag: hashStr,
					filename,
				}),
			});

			const ingestData = await ingestResponse.json();

			if (!ingestData.success) {
				throw new Error(`Ingest failed: ${JSON.stringify(ingestData.errors)}`);
			}

			log('   ⏳ Waiting for import to complete...', true);

			// 5. Poll until complete
			await this.pollImport(ingestData.result.at_bookmark);

			log('   ✅ Import complete!', true);
			return true;
		} catch (error) {
			log(`   ❌ Import API error: ${error.message}`, true);
			throw error;
		}
	}
}

module.exports = { D1ImportAPI };

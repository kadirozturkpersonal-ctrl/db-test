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

	/**
	 * Poll import status until complete
	 */
	async pollImport(bookmark) {
		const payload = {
			action: 'poll',
			current_bookmark: bookmark,
		};

		while (true) {
			const pollResponse = await fetch(this.apiUrl, {
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
			const initResponse = await fetch(this.apiUrl, {
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
			const r2Response = await fetch(uploadUrl, {
				method: 'PUT',
				body: sqlStatement,
			});

			const r2Etag = r2Response.headers.get('ETag').replace(/"/g, '');

			// Verify etag
			if (r2Etag !== hashStr) {
				throw new Error('ETag mismatch - upload corrupted');
			}

			log('   💾 Starting ingestion...', true);

			// 4. Start ingestion
			const ingestResponse = await fetch(this.apiUrl, {
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
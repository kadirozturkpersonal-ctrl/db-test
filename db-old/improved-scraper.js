const { chromium: rawChromium } = require('playwright-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const { log } = require('./debug');

// Apply stealth plugin once when module loads
rawChromium.use(StealthPlugin());
const chromium = rawChromium;

const DEFAULT_MAX_RETRIES = 2;

class TemporaryScrapeError extends Error {
	constructor(message, cause) {
		super(message);
		this.name = 'TemporaryScrapeError';
		this.temporary = true;
		this.cause = cause;
	}
}

function isTemporaryScrapeError(error) {
	return Boolean(error && error.temporary === true);
}

function sleep(ms) {
	return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Create a reusable browser instance.
 * Caller is responsible for calling browser.close() when done.
 */
async function createBrowser() {
	log('🌐 Launching browser (will be reused for all cases)...', true);
	return await chromium.launch({
		headless: true,
		timeout: 30000
	});
}

/**
 * Scrapes a single ECHR application page using a shared browser.
 * Returns null if not found, otherwise returns complete data.
 *
 * @param {import('playwright').Browser} browser - Shared browser instance
 * @param {number|string} applicationNumber - Case number
 * @param {number|string} applicationYear - Case year (last 2 digits)
 */
async function scrapeECHRApplicationOnce(browser, applicationNumber, applicationYear) {
	const url = `https://app.echr.coe.int/SOP/en-GB/application?number=${applicationNumber}%2F${applicationYear}`;

	log(`🔍 Checking: ${applicationNumber}/${applicationYear}`, true);

	// Fresh context per case (isolates cookies/storage between cases)
	const context = await browser.newContext();
	const page = await context.newPage();

	try {
		// Navigate to the URL
		await page.goto(url, {
			waitUntil: 'domcontentloaded',
			timeout: 15000
		});

		// If the SOP result panel never appears, treat it as a real no-info result.
		const resultPanel = await page.waitForSelector('#ResultPanel', { timeout: 5000 })
			.catch(error => {
				if (error.name === 'TimeoutError') {
					return null;
				}

				throw error;
			});

		if (!resultPanel) {
			log(`   ❌ Not found`);
			return null;
		}

		// Extract ALL data from the page
		const data = await page.evaluate(() => {
			const getText = (selector) => {
				const element = document.querySelector(selector);
				return element ? element.textContent.trim() : null;
			};

			const applicationNumber = getText('#ApplicationNumber p');
			const applicationTitle = getText('#ApplicationTitle p');
			const dateIntroduction = getText('#DateIntroduction p');
			const representant = getText('#Representant p');

			const majorEventsList = [];
			const rows = document.querySelectorAll('#MajorEventsList tbody tr');

			rows.forEach(row => {
				const description = row.querySelector('td:nth-child(1)')?.textContent.trim();
				const eventDate = row.querySelector('td:nth-child(2)')?.textContent.trim();

				if (description && eventDate) {
					majorEventsList.push({
						description: description,
						eventDate: eventDate
					});
				}
			});

			let lastMajorEvent = null;
			let lastMajorEventDate = null;

			if (majorEventsList.length > 0) {
				const lastEvent = majorEventsList[majorEventsList.length - 1];
				lastMajorEvent = lastEvent.description;
				lastMajorEventDate = lastEvent.eventDate;
			}

			return {
				applicationNumber,
				applicationTitle,
				dateIntroduction,
				representant,
				lastMajorEvent,
				lastMajorEventDate,
				majorEventsList
			};
		});

		// Validate essential data
		if (!data.applicationNumber || !data.applicationTitle) {
			log(`   ⚠️  Page found but missing essential data`, true);
			return null;
		}

		// Pretty print the results
		log(`   ✅ Found: ${data.applicationTitle}`);
		log(`   👤 Representative: ${data.representant || 'N/A'}`);
		log(`   📅 Introduced: ${data.dateIntroduction || 'N/A'}`);
		log(`   📋 Events: ${data.majorEventsList.length}`);
		log(`   🔔 Last Event: ${data.lastMajorEvent || 'N/A'}`);
		log(`   📆 Last Event Date: ${data.lastMajorEventDate || 'N/A'}`);

		return data;

	} catch (error) {
		log(`   ❌ Error: ${error.message}`, true);
		throw new TemporaryScrapeError(error.message, error);
	} finally {
		// Only close the context (cheap), NOT the browser
		await context.close().catch(error => {
			log(`   ⚠️  Could not close browser context: ${error.message}`, true);
		});
	}
}

/**
 * Scrape an application, retrying only temporary technical failures.
 * Real no-info SOP results still return null without retry.
 */
async function scrapeECHRApplication(browser, applicationNumber, applicationYear, options = {}) {
	const maxRetries = options.maxRetries === undefined
		? DEFAULT_MAX_RETRIES
		: Math.max(0, parseInt(options.maxRetries, 10) || 0);
	const maxAttempts = maxRetries + 1;

	for (let attempt = 1; attempt <= maxAttempts; attempt++) {
		try {
			if (attempt > 1) {
				log(`   🔁 Retry ${attempt - 1}/${maxRetries} for ${applicationNumber}/${applicationYear}`, true);
			}

			return await scrapeECHRApplicationOnce(browser, applicationNumber, applicationYear);
		} catch (error) {
			if (!isTemporaryScrapeError(error) || attempt >= maxAttempts) {
				throw error;
			}

			const delayMs = Math.min(8000, 1000 * (2 ** attempt));
			log(`   ⏳ Temporary scrape error; waiting ${delayMs}ms before retry`, true);
			await sleep(delayMs);
		}
	}

	return null;
}

module.exports = {
	scrapeECHRApplication,
	createBrowser,
	isTemporaryScrapeError,
	TemporaryScrapeError
};

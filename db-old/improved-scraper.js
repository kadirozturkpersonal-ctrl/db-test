const { chromium: rawChromium } = require('playwright-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const { log } = require('./debug');

// Apply stealth plugin once when module loads
rawChromium.use(StealthPlugin());
const chromium = rawChromium;

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
async function scrapeECHRApplication(browser, applicationNumber, applicationYear) {
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

		// Check if ResultPanel exists (page loaded successfully)
		const resultPanelExists = await page.$('#ResultPanel');
		if (!resultPanelExists) {
			log(`   ❌ Not found`);
			return null;
		}

		// Wait for the result panel
		await page.waitForSelector('#ResultPanel', { timeout: 5000 });

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
		return null;
	} finally {
		// Only close the context (cheap), NOT the browser
		await context.close();
	}
}

module.exports = { scrapeECHRApplication, createBrowser };
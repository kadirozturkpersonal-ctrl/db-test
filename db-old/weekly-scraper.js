#!/usr/bin/env node

/**
 * Weekly ECHR Scraper - Quick Updates for Subscribed Cases
 * 
 * Purpose: Only scrapes cases that have active subscriptions
 * This is much faster than the monthly full scan
 * 
 * Expected runtime: 20-30 minutes for ~600 cases
 * vs 4-6 hours for monthly full scan of 50,000+ cases
 */

require('dotenv').config();
const { scrapeECHRApplication, createBrowser } = require('./improved-scraper');
const { D1Adapter } = require('./d1-adapter');
const { log } = require('./debug');

class WeeklyECHRScraper {
	constructor(databaseName = 'echr-db') {
		// NOTE: Weekly scraper uses Wrangler CLI (executeSQL), not Import API
		// Import API is only used in monthly scraper for batch operations
		this.d1 = new D1Adapter(databaseName);
		this.databaseName = databaseName;
		this.browser = null;

		// Stats
		this.stats = {
			total: 0,
			updated: 0,
			unchanged: 0,
			notFound: 0,
			errors: 0
		};
	}

	/**
	 * Get all subscribed case numbers from database
	 */
	async getSubscribedCases() {
		log('\n📋 Fetching subscribed cases from database...', true);

		// TESTING MODE: Only get 3 cases
		// Remove LIMIT when ready for full run
		const sql = `
			SELECT DISTINCT 
				s.case_id,
				s.application_number,
				a.last_major_event as current_event
			FROM subscriptions s
			INNER JOIN applications a ON s.case_id = a.id
			WHERE s.is_active = 1
			AND a.is_closed = 0
			ORDER BY s.application_number
		`;

		try {
			const result = this.d1.executeSQL(sql);

			// Parse the JSON result from wrangler
			const jsonMatch = result.match(/\[[\s\S]*\]/);
			if (!jsonMatch) {
				throw new Error('Could not parse database response');
			}

			const data = JSON.parse(jsonMatch[0]);
			const cases = data[0]?.results || [];

			log(`✅ Found ${cases.length} subscribed cases to check (TESTING MODE)\n`, true);
			return cases;

		} catch (error) {
			log(`❌ Error fetching subscribed cases: ${error.message}`, true);
			throw error;
		}
	}

	/**
	 * Main scraping loop
	 */
	async run() {
		log('\n🚀 Starting ECHR Weekly Scraper', true);
		log('='.repeat(60), true);
		log(`Database: ${this.databaseName}`, true);
		log('Purpose: Check subscribed cases for updates', true);
		log('='.repeat(60), true);

		// Get subscribed cases
		const subscribedCases = await this.getSubscribedCases();
		this.stats.total = subscribedCases.length;

		if (subscribedCases.length === 0) {
			log('\n⚠️  No subscribed cases found. Nothing to scrape.', true);
			return;
		}

		log(`\n📊 Processing ${subscribedCases.length} cases...`, true);
		log('-'.repeat(60), true);

		// Launch browser ONCE for the entire run
		this.browser = await createBrowser();

		try {
			// Process each case
			for (let i = 0; i < subscribedCases.length; i++) {
				const caseInfo = subscribedCases[i];
				const progress = `[${i + 1}/${subscribedCases.length}]`;

				log(`\n${progress} Checking: ${caseInfo.application_number}`, true);
				log(`   Current event: ${caseInfo.current_event || 'None'}`, true);

				try {
					// Parse application number (format: "12345/21")
					const [number, year] = caseInfo.application_number.split('/');

					// Scrape the case (reusing the shared browser)
					const data = await scrapeECHRApplication(this.browser, number, year);

					if (data) {
						// Check if event changed
						const newEvent = data.lastMajorEvent;
						const hasChanged = newEvent !== caseInfo.current_event;

						if (hasChanged) {
							log(`   🔔 EVENT CHANGED!`, true);
							log(`   Old: ${caseInfo.current_event}`, true);
							log(`   New: ${newEvent}`, true);
							this.stats.updated++;
						} else {
							log(`   ✓ No change`, true);
							this.stats.unchanged++;
						}

						// Save to database (always update last_checked_date)
						await this.d1.saveApplication(data);

					} else {
						// Case not found (maybe removed from ECHR website?)
						log(`   ⚠️  Not found on ECHR website`, true);
						this.stats.notFound++;

						// Mark as not found in database
						await this.d1.markAsNotFound(number, year);
					}

				} catch (error) {
					log(`   ❌ Error: ${error.message}`, true);
					this.stats.errors++;
				}

				// Rate limiting - be nice to ECHR servers
				// Wait 500ms between requests
				await this.sleep(300);
			}

			// Print final stats
			this.printStats();
		} finally {
			// Always close the browser, even if an error occurred
			if (this.browser) {
				log('\n🌐 Closing browser...', true);
				await this.browser.close();
			}
		}
	}

	/**
	 * Print final statistics
	 */
	printStats() {
		log(`\n${'='.repeat(60)}`, true);
		log('🎉 WEEKLY SCRAPING COMPLETE', true);
		log(`${'='.repeat(60)}`, true);
		log(`Total cases checked: ${this.stats.total}`, true);
		log(`✅ Updated (changed): ${this.stats.updated}`, true);
		log(`✓ Unchanged: ${this.stats.unchanged}`, true);
		log(`⚠️  Not found: ${this.stats.notFound}`, true);
		log(`❌ Errors: ${this.stats.errors}`, true);
		log(`${'='.repeat(60)}\n`, true);
	}

	/**
	 * Sleep helper
	 */
	sleep(ms) {
		return new Promise(resolve => setTimeout(resolve, ms));
	}
}

async function main() {
	// Use dev database for testing
	// Change to 'echr-db' when ready for production
	const databaseName = process.env.DATABASE_NAME || 'echr-db';

	console.log(`\n🗄️  Using database: ${databaseName}`);

	const scraper = new WeeklyECHRScraper(databaseName);
	await scraper.run();
}

// Run if called directly
if (require.main === module) {
	main().catch(error => {
		console.error('❌ Fatal error:', error);
		process.exit(1);
	});
}

module.exports = { WeeklyECHRScraper };
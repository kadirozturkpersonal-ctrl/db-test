const { scrapeECHRApplication } = require('./improved-scraper');
const { D1Adapter } = require('./d1-adapter');

/**
 * Test scraping and saving to D1
 */
async function testSaveToD1() {
	console.log('🧪 Testing Scraper + D1 Integration\n');
	console.log('='.repeat(60));

	const d1 = new D1Adapter('echr-db');

	// Test cases
	const testCases = [
		{ number: 152, year: 18 },   // Should exist
		{ number: 1, year: 18 },     // Should exist
	];

	for (const testCase of testCases) {
		console.log('\n' + '-'.repeat(60));
		
		// Scrape the data
		const data = await scrapeECHRApplication(testCase.number, testCase.year);
		
		if (data) {
			// Save to D1
			await d1.saveApplication(data);
		} else {
			// Mark as not found (if it exists in DB)
			await d1.markAsNotFound(testCase.number, testCase.year);
		}

		// Wait between requests
		await new Promise(resolve => setTimeout(resolve, 2000));
	}

	console.log('\n' + '='.repeat(60));
	console.log('✨ Test complete! Check your D1 database!\n');
}

// Run the test
testSaveToD1().catch(console.error);
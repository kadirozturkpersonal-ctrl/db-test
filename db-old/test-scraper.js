const { scrapeECHRApplication } = require('./improved-scraper');

/**
 * Test the scraper with known cases
 */
async function testScraper() {
	console.log('🧪 Testing ECHR Scraper\n');
	console.log('=' .repeat(60));

	// Test cases - mix of existing and non-existing
	const testCases = [
		{ number: 152, year: 18 },   // Should exist
		{ number: 1, year: 18 },     // Should exist  
		{ number: 99999, year: 99 }, // Should NOT exist
		{ number: 168, year: 18 },   // Should exist (from your logs)
	];

	const results = {
		found: [],
		notFound: []
	};

	for (const testCase of testCases) {
		console.log('');
		const data = await scrapeECHRApplication(testCase.number, testCase.year);
		
		if (data) {
			results.found.push({ ...testCase, data });
		} else {
			results.notFound.push(testCase);
		}

		// Wait a bit between requests to be nice to the server
		await new Promise(resolve => setTimeout(resolve, 2000));
	}

	// Print summary
	console.log('\n' + '='.repeat(60));
	console.log('📊 TEST SUMMARY');
	console.log('='.repeat(60));
	console.log(`✅ Found: ${results.found.length} cases`);
	console.log(`❌ Not found: ${results.notFound.length} cases\n`);

	if (results.found.length > 0) {
		console.log('✅ FOUND CASES:');
		results.found.forEach(item => {
			console.log(`   ${item.number}/${item.year}: ${item.data.applicationTitle}`);
		});
	}

	if (results.notFound.length > 0) {
		console.log('\n❌ NOT FOUND:');
		results.notFound.forEach(item => {
			console.log(`   ${item.number}/${item.year}`);
		});
	}

	console.log('\n✨ Test complete!\n');
}

// Run the test
testScraper().catch(console.error);
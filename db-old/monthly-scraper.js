require('dotenv').config();
const fs = require('fs');
const path = require('path');

const START_YEAR = 2016;
const DEFAULT_MAX_CONSECUTIVE_EMPTY = 500;
const DEFAULT_MAX_RUNTIME_MINUTES = 330;
const DEFAULT_SAFE_STOP_BUFFER_MINUTES = 5;
const DEFAULT_ADMINISTRATIVE_REJECTION_GRACE_DAYS = 365;
const STATE_VERSION = 1;

function parseNumber(value) {
	const parsed = Number(value);
	return Number.isFinite(parsed) ? parsed : undefined;
}

function readConfigFile() {
	try {
		const config = require('./scraper-config.js');
		console.log('📋 Loaded config from scraper-config.js');
		return config;
	} catch {
		console.log('📋 Using default/env config');
		return {};
	}
}

function readEnvConfig() {
	return Object.fromEntries(Object.entries({
		maxConsecutiveEmpty: parseNumber(process.env.MAX_CONSECUTIVE_EMPTY),
		maxConsecutiveSkips: parseNumber(process.env.MAX_CONSECUTIVE_SKIPS),
		maxRuntimeMinutes: parseNumber(process.env.MAX_RUNTIME_MINUTES),
		maxRuntimeMs: parseNumber(process.env.MAX_RUNTIME_MS),
		safeStopBufferMinutes: parseNumber(process.env.SAFE_STOP_BUFFER_MINUTES),
		administrativeRejectionGraceDays: parseNumber(process.env.ADMINISTRATIVE_REJECTION_GRACE_DAYS),
		stateFile: process.env.SCRAPER_STATE_FILE
	}).filter(([, value]) => value !== undefined && value !== ''));
}

const CONFIG = {
	...readConfigFile(),
	...readEnvConfig()
};

// ============================================================
// DO NOT EDIT BELOW THIS LINE
// ============================================================

const { scrapeECHRApplication, createBrowser } = require('./improved-scraper');
const { D1Adapter } = require('./d1-adapter');
const { log } = require('./debug');

/**
 * Monthly bulk scraper with year progression and skip logic
 */
class MonthlyECHRScraper {
	constructor(config = {}) {
		this.d1 = new D1Adapter('echr-db');
		this.browser = null;
		this.startYear = START_YEAR;
		this.cycleEndYear = this.getCycleEndYear();
		this.maxConsecutiveEmpty =
			config.maxConsecutiveEmpty ||
			config.maxConsecutiveSkips ||
			DEFAULT_MAX_CONSECUTIVE_EMPTY;
		this.stateFile = path.resolve(__dirname, config.stateFile || 'scraper-state.json');
		this.maxRuntimeMs = config.maxRuntimeMs ||
			(config.maxRuntimeMinutes || DEFAULT_MAX_RUNTIME_MINUTES) * 60 * 1000;
		this.safeStopBufferMs =
			(config.safeStopBufferMinutes || DEFAULT_SAFE_STOP_BUFFER_MINUTES) * 60 * 1000;
		this.startedAt = Date.now();
		this.stopNewAttemptsAt = this.startedAt + this.maxRuntimeMs - this.safeStopBufferMs;
		this.hardStopAt = this.startedAt + this.maxRuntimeMs;
		this.state = null;
		this.finalizedApplicationNumbers = new Set();
		this.knownApplicationNumbers = new Set();
		this.administrativelyRejectedApplicationNumbers = new Set();
		this.administrativeRejectionTrackingEnabled = false;
		this.administrativeRejectionGraceDays =
			config.administrativeRejectionGraceDays || DEFAULT_ADMINISTRATIVE_REJECTION_GRACE_DAYS;

		// Batch configuration
		this.BATCH_ATTEMPTS = 250; // Write after every 250 scrape attempts
		this.batchQueue = []; // Cases waiting to be written
		this.noInfoQueue = []; // Unknown cases that returned no SOP information
		this.attemptCounter = 0; // Count scrape attempts

		// Stats
		this.stats = {
			found: 0,
			notFound: 0,
			errors: 0,
			totalChecked: 0,
			skippedFinalized: 0,
			skippedAdministrativeRejected: 0,
			noInfoTracked: 0,
			noInfoKnownApplication: 0
		};
	}

	getCycleEndYear() {
		return new Date().getFullYear() + 1;
	}

	toECHRYear(fullYear) {
		return String(fullYear).slice(-2).padStart(2, '0');
	}

	normalizeYear(year) {
		const numericYear = Number(year);
		if (!Number.isFinite(numericYear)) {
			return START_YEAR;
		}

		if (numericYear < 100) {
			return 2000 + numericYear;
		}

		return numericYear;
	}

	createInitialState() {
		return {
			version: STATE_VERSION,
			currentYear: START_YEAR,
			currentNumber: 1,
			consecutiveEmpty: 0,
			cycleStartYear: START_YEAR,
			cycleEndYear: this.cycleEndYear,
			updatedAt: new Date().toISOString(),
			lastReason: 'initial'
		};
	}

	loadState() {
		let state = this.createInitialState();

		if (fs.existsSync(this.stateFile)) {
			try {
				const parsed = JSON.parse(fs.readFileSync(this.stateFile, 'utf8'));
				state = {
					...state,
					...parsed,
					currentYear: this.normalizeYear(parsed.currentYear),
					currentNumber: Math.max(1, parseInt(parsed.currentNumber, 10) || 1),
					consecutiveEmpty: Math.max(0, parseInt(parsed.consecutiveEmpty, 10) || 0),
					cycleStartYear: START_YEAR,
					cycleEndYear: this.cycleEndYear
				};
			} catch (error) {
				log(`   ⚠️  Could not read checkpoint state, starting fresh: ${error.message}`, true);
			}
		}

		if (state.currentYear < START_YEAR || state.currentYear > this.cycleEndYear) {
			log(`   ⚠️  State year ${state.currentYear} is outside active cycle, resetting to ${START_YEAR}`, true);
			state = this.createInitialState();
		}

		if (state.consecutiveEmpty >= this.maxConsecutiveEmpty) {
			state = this.advanceYearInMemory(state);
		}

		this.state = state;
		log(`   💾 Checkpoint: ${state.currentNumber}/${this.toECHRYear(state.currentYear)} (empty ${state.consecutiveEmpty}/${this.maxConsecutiveEmpty})`, true);
		return state;
	}

	saveState(reason) {
		if (!this.state) {
			return;
		}

		const nextState = {
			...this.state,
			version: STATE_VERSION,
			cycleStartYear: START_YEAR,
			cycleEndYear: this.cycleEndYear,
			maxConsecutiveEmpty: this.maxConsecutiveEmpty,
			updatedAt: new Date().toISOString(),
			lastReason: reason
		};

		fs.mkdirSync(path.dirname(this.stateFile), { recursive: true });
		const tempFile = `${this.stateFile}.tmp`;
		fs.writeFileSync(tempFile, `${JSON.stringify(nextState, null, 2)}\n`);
		fs.renameSync(tempFile, this.stateFile);
		this.state = nextState;
		log(`   💾 State saved (${reason}): ${this.state.currentNumber}/${this.toECHRYear(this.state.currentYear)} | empty ${this.state.consecutiveEmpty}`, true);
	}

	advanceYearInMemory(state) {
		const nextYear = state.currentYear >= this.cycleEndYear
			? START_YEAR
			: state.currentYear + 1;

		return {
			...state,
			currentYear: nextYear,
			currentNumber: 1,
			consecutiveEmpty: 0
		};
	}

	advanceYear(reason) {
		this.state = this.advanceYearInMemory(this.state);
		this.saveState(reason);
	}

	shouldStopBeforeNextAttempt() {
		return Date.now() >= this.stopNewAttemptsAt;
	}

	async loadFinalizedApplicationNumbers() {
		try {
			this.finalizedApplicationNumbers = await this.d1.loadFinalizedApplicationNumbers();
			log(`   🧭 Finalized applications loaded for skip: ${this.finalizedApplicationNumbers.size}`, true);
		} catch (error) {
			this.finalizedApplicationNumbers = new Set();
			log(`   ⚠️  Finalized skip list could not be loaded: ${error.message}`, true);
			log('   Continuing without finalized-case skips for this run.', true);
		}
	}

	isFinalizedApplication(applicationNumber) {
		return this.finalizedApplicationNumbers.has(applicationNumber);
	}

	async prepareAdministrativeRejectionTracking() {
		try {
			await this.d1.ensureSOPNoInfoTracking();
			await this.d1.reconcileSOPNoInfoTracking(this.administrativeRejectionGraceDays);

			this.knownApplicationNumbers = await this.d1.loadKnownApplicationNumbers();
			this.administrativelyRejectedApplicationNumbers =
				await this.d1.loadAdministrativelyRejectedApplicationNumbers();
			this.administrativeRejectionTrackingEnabled = true;

			log(`   🗂️  Known SOP applications loaded: ${this.knownApplicationNumbers.size}`, true);
			log(`   🚫 Administrative rejections loaded for skip: ${this.administrativelyRejectedApplicationNumbers.size}`, true);
			log(`   ⏳ Administrative rejection grace period: ${this.administrativeRejectionGraceDays} days`, true);
		} catch (error) {
			this.knownApplicationNumbers = new Set();
			this.administrativelyRejectedApplicationNumbers = new Set();
			this.administrativeRejectionTrackingEnabled = false;
			log(`   ⚠️  Administrative rejection tracking could not be prepared: ${error.message}`, true);
			log('   Continuing without administrative-rejection skips for this run.', true);
		}
	}

	isKnownApplication(applicationNumber) {
		return this.knownApplicationNumbers.has(applicationNumber);
	}

	isAdministrativelyRejectedApplication(applicationNumber) {
		return this.administrativelyRejectedApplicationNumbers.has(applicationNumber);
	}

	queueNoInfoIfEligible(applicationNumber) {
		if (!this.administrativeRejectionTrackingEnabled) {
			return;
		}

		if (this.isKnownApplication(applicationNumber)) {
			this.stats.noInfoKnownApplication++;
			log('   ℹ️  No SOP info now, but this application already exists in D1; not treating as administrative rejection candidate.', true);
			return;
		}

		this.noInfoQueue.push(applicationNumber);
		this.stats.noInfoTracked++;
		log(`   📝 No-info candidate queued (${this.noInfoQueue.length}/${this.BATCH_ATTEMPTS})`, true);
	}

	async flushNoInfoBatch() {
		if (!this.administrativeRejectionTrackingEnabled || this.noInfoQueue.length === 0) {
			return;
		}

		const applicationNumbers = [...new Set(this.noInfoQueue)];
		this.noInfoQueue = [];

		const result = await this.d1.saveSOPNoInfoBatch(
			applicationNumbers,
			this.administrativeRejectionGraceDays
		);

		if (result.failed > 0) {
			log(`   ⚠️  No-info tracking had ${result.failed} failed records`, true);
		}

		if (result.administrativeRejected && result.administrativeRejected.length > 0) {
			for (const applicationNumber of result.administrativeRejected) {
				this.administrativelyRejectedApplicationNumbers.add(applicationNumber);
			}
			log(`   🚫 Marked administrative rejection after no-info grace period: ${result.administrativeRejected.length}`, true);
		}
	}

	/**
	 * Write all queued cases to database using Import API
	 */
	async flushBatch() {
		if (this.batchQueue.length === 0 && this.noInfoQueue.length === 0) {
			log('\n   ℹ️  No cases to write in this batch', true);
			return;
		}

		log(`\n🚀 Writing batch to D1: ${this.batchQueue.length} cases, ${this.noInfoQueue.length} no-info candidates...`, true);
		log('='.repeat(60), true);

		if (this.batchQueue.length > 0) {
			const casesToSave = this.batchQueue;
			const result = await this.d1.saveBatch(casesToSave);
			log(`\n✅ Application batch complete: ${result.success} saved, ${result.failed} errors`, true);

			if (result.success === casesToSave.length) {
				for (const data of casesToSave) {
					if (data.applicationNumber) {
						this.knownApplicationNumbers.add(String(data.applicationNumber).trim());
					}
				}
			}
		}

		await this.flushNoInfoBatch();

		// Clear the queue and reset counter
		this.batchQueue = [];
		this.attemptCounter = 0;
		log('='.repeat(60), true);
	}

	/**
	 * Main scraping loop
	 */
	async run() {
		log('\n🚀 Starting ECHR Monthly Scraper', true);
		log('='.repeat(60), true);
		log(`Year cycle: ${this.startYear} to ${this.cycleEndYear}, then back to ${this.startYear}`, true);
		log(`Max consecutive empty results: ${this.maxConsecutiveEmpty}`, true);
		log(`Safe stop: no new attempts after ${new Date(this.stopNewAttemptsAt).toISOString()}`, true);
		log(`Hard runtime target: ${new Date(this.hardStopAt).toISOString()}`, true);
		log('='.repeat(60), true);
		this.loadState();
		this.saveState('run-start');
		await this.loadFinalizedApplicationNumbers();
		await this.prepareAdministrativeRejectionTracking();

		// Launch browser ONCE for the entire run
		this.browser = await createBrowser();

		try {
			let lastLoggedYear = null;
			let stopReason = null;

			while (!stopReason) {
				if (this.shouldStopBeforeNextAttempt()) {
					stopReason = 'runtime-limit';
					break;
				}

				if (lastLoggedYear !== this.state.currentYear) {
					lastLoggedYear = this.state.currentYear;
					log(`\n📅 Processing year: ${this.state.currentYear} (${this.toECHRYear(this.state.currentYear)})`, true);
					log(`   Starting from: ${this.state.currentNumber}/${this.toECHRYear(this.state.currentYear)}`, true);
					log(`   Consecutive empty: ${this.state.consecutiveEmpty}/${this.maxConsecutiveEmpty}`, true);
				}
				log('-'.repeat(60), true);

				while (this.state.consecutiveEmpty < this.maxConsecutiveEmpty) {
					if (this.shouldStopBeforeNextAttempt()) {
						stopReason = 'runtime-limit';
						break;
					}

					const currentYear = this.state.currentYear;
					const currentNumber = this.state.currentNumber;
					const echrYear = this.toECHRYear(currentYear);
					const applicationNumber = `${currentNumber}/${echrYear}`;

					if (this.isFinalizedApplication(applicationNumber)) {
						this.stats.skippedFinalized++;
						this.state.currentNumber = currentNumber + 1;
						log(`\n[Skip #${this.stats.skippedFinalized}] ${applicationNumber} is finalized; skipping SOP check`, true);

						if (this.stats.skippedFinalized % this.BATCH_ATTEMPTS === 0) {
							this.saveState('finalized-skip');
							this.printProgress();
						}

						continue;
					}

					if (this.isAdministrativelyRejectedApplication(applicationNumber)) {
						this.stats.skippedAdministrativeRejected++;
						this.state.currentNumber = currentNumber + 1;
						log(`\n[Admin reject skip #${this.stats.skippedAdministrativeRejected}] ${applicationNumber} had no SOP info for at least ${this.administrativeRejectionGraceDays} days`, true);

						if (this.stats.skippedAdministrativeRejected % this.BATCH_ATTEMPTS === 0) {
							this.saveState('administrative-rejection-skip');
							this.printProgress();
						}

						continue;
					}

					this.stats.totalChecked++;
					log(`\n[Check #${this.stats.totalChecked}] ${applicationNumber}`);

					try {
						// Increment attempt counter
						this.attemptCounter++;

						// Scrape the case (reusing the shared browser)
						const data = await scrapeECHRApplication(this.browser, currentNumber, echrYear);

						if (data) {
							// Found - add to batch queue
							this.batchQueue.push(data);
							this.stats.found++;
							this.state.consecutiveEmpty = 0;

							log(`   📦 Added to queue (${this.batchQueue.length} cases | ${this.attemptCounter}/250 attempts)`, true);
						} else {
							// Not found - increment empty counter
							this.state.consecutiveEmpty++;
							this.stats.notFound++;
							this.queueNoInfoIfEligible(applicationNumber);
							log(`   ⚠️  Empty: ${this.state.consecutiveEmpty}/${this.maxConsecutiveEmpty} | Attempts: ${this.attemptCounter}/250`, true);
						}

						this.state.currentNumber = currentNumber + 1;

						// Write batch after 250 attempts (regardless of success/failure)
						if (this.attemptCounter >= this.BATCH_ATTEMPTS) {
							await this.flushBatch();
							this.saveState('batch-flush');
						} else if (this.batchQueue.length === 0) {
							this.saveState(data ? 'found' : 'empty');
						}

					} catch (error) {
						log(`   ❌ Error: ${error.message}`, true);
						this.stats.errors++;
						this.state.consecutiveEmpty++;
						this.attemptCounter++;
						this.state.currentNumber = currentNumber + 1;

						// Still check if we need to flush
						if (this.attemptCounter >= this.BATCH_ATTEMPTS) {
							await this.flushBatch();
							this.saveState('batch-flush-after-error');
						} else if (this.batchQueue.length === 0) {
							this.saveState('error');
						}
					}

					// Rate limiting
					await this.sleep(250);

					// Progress update every 25 cases
					if (this.stats.totalChecked % 25 === 0) {
						this.printProgress();
					}
				}

				if (stopReason) {
					break;
				}

				await this.flushBatch();
				log(`\n⏭️  Max consecutive empty results reached for year ${this.state.currentYear}`, true);
				log(`   Moving to next year...\n`, true);
				this.advanceYear('year-advance');
			}

			if (stopReason === 'runtime-limit') {
				log('\n⏱️  Safe runtime limit reached. Flushing and saving checkpoint...', true);
			}

			await this.flushBatch();
			this.saveState(stopReason || 'run-complete');
			this.printFinalStats();
		} finally {
			// Always close the browser, even if an error occurred
			if (this.browser) {
				log('\n🌐 Closing browser...', true);
				await this.browser.close();
			}
		}
	}

	/**
	 * Print progress update
	 */
	printProgress() {
		log(`\n ${'='.repeat(60)}`, true);
		log('📊 PROGRESS UPDATE', true);
		log('='.repeat(60), true);
		log(`Total checked: ${this.stats.totalChecked}`, true);
		log(`✅ Found: ${this.stats.found}`, true);
		log(`❌ Not found: ${this.stats.notFound}`, true);
		log(`⏭️  Skipped finalized: ${this.stats.skippedFinalized}`, true);
		log(`🚫 Skipped administrative rejections: ${this.stats.skippedAdministrativeRejected}`, true);
		log(`📝 No-info candidates tracked: ${this.stats.noInfoTracked}`, true);
		log(`ℹ️  No-info known applications: ${this.stats.noInfoKnownApplication}`, true);
		log(`⚠️  Errors: ${this.stats.errors}`, true);
		log(`${'='.repeat(60) + '\n'}`, true);
	}

	/**
	 * Print final statistics
	 */
	printFinalStats() {
		const successRate = this.stats.totalChecked > 0
			? ((this.stats.found / this.stats.totalChecked) * 100).toFixed(2)
			: 0;

		log(`\n${'='.repeat(60)}`, true);
		log('🎉 SCRAPING COMPLETE', true);
		log(`${'='.repeat(60)}`, true);
		log(`Total checked: ${this.stats.totalChecked}`, true);
		log(`✅ Found: ${this.stats.found}`, true);
		log(`❌ Not found: ${this.stats.notFound}`, true);
		log(`⏭️  Skipped finalized: ${this.stats.skippedFinalized}`, true);
		log(`🚫 Skipped administrative rejections: ${this.stats.skippedAdministrativeRejected}`, true);
		log(`📝 No-info candidates tracked: ${this.stats.noInfoTracked}`, true);
		log(`ℹ️  No-info known applications: ${this.stats.noInfoKnownApplication}`, true);
		log(`⚠️  Errors: ${this.stats.errors}`, true);
		log(`📈 Success rate: ${successRate}%`, true);
		log(`${'='.repeat(60) + '\n'}`, true);
	}

	/**
	 * Sleep helper
	 */
	sleep(ms) {
		return new Promise(resolve => setTimeout(resolve, ms));
	}
}

async function main() {
	const cycleEndYear = new Date().getFullYear() + 1;
	log('\n📋 Configuration:', true);
	log(`   Year cycle: ${START_YEAR} to ${cycleEndYear}, then ${START_YEAR}`, true);
	log(`   Max consecutive empty: ${CONFIG.maxConsecutiveEmpty || CONFIG.maxConsecutiveSkips || DEFAULT_MAX_CONSECUTIVE_EMPTY}`, true);
	log(`   State file: ${CONFIG.stateFile || 'scraper-state.json'}`, true);
	log(`   Max runtime minutes: ${CONFIG.maxRuntimeMinutes || DEFAULT_MAX_RUNTIME_MINUTES}`, true);
	log('\n⚠️  Press Ctrl+C to stop at any time\n', true);

	// Wait 5 seconds so user can review config
	await new Promise(resolve => setTimeout(resolve, 5000));

	const scraper = new MonthlyECHRScraper(CONFIG);
	await scraper.run();
}

main().catch(console.error);

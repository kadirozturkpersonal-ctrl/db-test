require('dotenv').config();
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const START_YEAR = 2016;
const DEFAULT_MAX_CONSECUTIVE_EMPTY = 500;
const DEFAULT_MAX_RUNTIME_MINUTES = 330;
const DEFAULT_SAFE_STOP_BUFFER_MINUTES = 5;
const DEFAULT_ADMINISTRATIVE_REJECTION_GRACE_DAYS = 365;
const DEFAULT_MAX_SCRAPE_RETRIES = 2;
const DEFAULT_SCRAPE_ATTEMPT_TIMEOUT_MS = 45_000;
const DEFAULT_BROWSER_MAX_UPTIME_MINUTES = 90;
const BROWSER_CLOSE_TIMEOUT_MS = 10_000;
const STATE_VERSION = 1;
const CURRENT_SCAN_MAX_CONSECUTIVE_TECHNICAL_ERRORS = 50;
const CURRENT_YEAR_PRIORITY_OVERLAP_SIZE = 500;
const CURRENT_YEAR_PRIORITY_MAX_EMPTY = 500;
// Cloudflare D1's HTTP SQL endpoint has a lower bind-variable ceiling than
// SQLite itself. Keep IN-list lookups well below that ceiling, even when a
// scrape batch contains many found applications.
const EXISTING_APPLICATION_LOOKUP_CHUNK_SIZE = 50;

function parseNumber(value) {
	const parsed = Number(value);
	return Number.isFinite(parsed) ? parsed : undefined;
}

function parseBoolean(value) {
	return String(value || '').trim().toLowerCase() === 'true';
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
		scrapeAttemptTimeoutMs: parseNumber(process.env.SCRAPE_ATTEMPT_TIMEOUT_MS),
		browserMaxUptimeMinutes: parseNumber(process.env.BROWSER_MAX_UPTIME_MINUTES),
		administrativeRejectionGraceDays: parseNumber(process.env.ADMINISTRATIVE_REJECTION_GRACE_DAYS),
		maxScrapeRetries: parseNumber(process.env.MAX_SCRAPE_RETRIES),
		runCurrentYearPriorityScan: parseBoolean(process.env.RUN_CURRENT_YEAR_PRIORITY_SCAN),
		scheduleSlot: process.env.SCRAPER_SCHEDULE_SLOT || 'manual',
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

const { scrapeECHRApplication, createBrowser, isTemporaryScrapeError } = require('./improved-scraper');
const { D1Adapter } = require('./d1-adapter');
const { log } = require('./debug');

/**
 * Monthly bulk scraper with year progression and skip logic
 */
class MonthlyECHRScraper {
	constructor(config = {}) {
		this.d1 = config.d1 || new D1Adapter('echr-db');
		this.scrapeApplication = config.scrapeApplication || scrapeECHRApplication;
		this.createBrowser = config.createBrowser || createBrowser;
		this.runCurrentYearPriorityScan = config.runCurrentYearPriorityScan === true;
		this.scheduleSlot = String(config.scheduleSlot || 'manual');
		this.runId = config.runId || crypto.randomUUID();
		this.runStartedAt = new Date().toISOString();
		this.newApplicationsAdded = 0;
		this.smallestScannedApplicationNumber = null;
		this.largestScannedApplicationNumber = null;
		this.browser = null;
		this.browserStartedAt = null;
		this.scrapeAttemptTimeoutMs = config.scrapeAttemptTimeoutMs || DEFAULT_SCRAPE_ATTEMPT_TIMEOUT_MS;
		this.browserMaxUptimeMs =
			(config.browserMaxUptimeMinutes || DEFAULT_BROWSER_MAX_UPTIME_MINUTES) * 60 * 1000;
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
		this.maxScrapeRetries = config.maxScrapeRetries === undefined
			? DEFAULT_MAX_SCRAPE_RETRIES
			: Math.max(0, parseInt(config.maxScrapeRetries, 10) || 0);

		// Batch configuration
		this.BATCH_ATTEMPTS = 250;
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
			noInfoKnownApplication: 0,
			d1Saved: 0,
			d1Failed: 0,
			noInfoSaved: 0,
			noInfoFailed: 0,
			flushes: 0,
			totalD1WriteMs: 0
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

	async closeBrowserWithinDeadline(reason) {
		const browser = this.browser;
		this.browser = null;
		this.browserStartedAt = null;

		if (!browser) {
			return;
		}

		let timedOut = false;
		await Promise.race([
			Promise.resolve().then(() => browser.close()).catch((error) => {
				log(`   ⚠️  Browser could not close (${reason}): ${error.message}`, true);
			}),
			this.sleep(BROWSER_CLOSE_TIMEOUT_MS).then(() => {
				timedOut = true;
			})
		]);

		if (timedOut) {
			log(`   ⚠️  Browser close exceeded ${BROWSER_CLOSE_TIMEOUT_MS / 1000}s (${reason}); continuing safely.`, true);
		}
	}

	async ensureHealthyBrowser() {
		const isExpired = this.browserStartedAt &&
			Date.now() - this.browserStartedAt >= this.browserMaxUptimeMs;
		if (this.browser && !isExpired) {
			return;
		}

		if (isExpired) {
			log('   ♻️  Restarting Chromium before its safe uptime limit.', true);
			await this.closeBrowserWithinDeadline('scheduled restart');
		}

		this.browser = await this.createBrowser();
		this.browserStartedAt = Date.now();
	}

	async scrapeWithDeadline(applicationNumber, echrYear) {
		await this.ensureHealthyBrowser();
		let timedOut = false;
		let timeoutId;
		const scrapePromise = Promise.resolve().then(() => this.scrapeApplication(
			this.browser,
			applicationNumber,
			echrYear,
			{ maxRetries: this.maxScrapeRetries }
		));

		try {
			return await Promise.race([
				scrapePromise,
				new Promise((_, reject) => {
					timeoutId = setTimeout(() => {
						timedOut = true;
						const error = new Error(`SOP attempt exceeded ${this.scrapeAttemptTimeoutMs}ms`);
						error.temporary = true;
						reject(error);
					}, this.scrapeAttemptTimeoutMs);
				})
			]);
		} finally {
			clearTimeout(timeoutId);
			if (timedOut) {
				// Closing Chromium aborts the stalled Playwright operation. Keep its late
				// rejection handled, then create a fresh browser for the next attempt.
				scrapePromise.catch(() => {});
				log(`   ⚠️  ${applicationNumber}/${echrYear} exceeded its attempt budget; restarting Chromium.`, true);
				await this.closeBrowserWithinDeadline('stalled SOP attempt');
			}
		}
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
			return { success: 0, failed: 0, administrativeRejected: [] };
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

		this.stats.noInfoSaved += result.success || 0;
		this.stats.noInfoFailed += result.failed || 0;

		if (result.administrativeRejected && result.administrativeRejected.length > 0) {
			for (const applicationNumber of result.administrativeRejected) {
				this.administrativelyRejectedApplicationNumbers.add(applicationNumber);
			}
			log(`   🚫 Marked administrative rejection after no-info grace period: ${result.administrativeRejected.length}`, true);
		}

		return result;
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
		const flushStartedAt = Date.now();

		if (this.batchQueue.length > 0) {
			const casesToSave = this.batchQueue;
			const candidateNumbers = [...new Set(casesToSave.map((data) => String(data.applicationNumber || '').trim()).filter(Boolean))];
			const existingBefore = await this.loadExistingApplicationNumbers(candidateNumbers);
			const result = await this.d1.saveBatch(casesToSave);
			log(`\n✅ Application batch complete: ${result.success} saved, ${result.failed} errors`, true);
			this.stats.d1Saved += result.success || 0;
			this.stats.d1Failed += result.failed || 0;
			const absentBefore = candidateNumbers.filter((number) => !existingBefore.has(number));
			const presentAfter = await this.loadExistingApplicationNumbers(absentBefore);
			this.newApplicationsAdded += presentAfter.size;

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
		this.stats.flushes++;
		this.stats.totalD1WriteMs += Date.now() - flushStartedAt;
		log('='.repeat(60), true);
	}

	async processScheduledCurrentYearScan() {
		if (!this.runCurrentYearPriorityScan) {
			return { handled: false, stopRun: false };
		}

		const targetYear = new Date().getFullYear();
		const echrYear = this.toECHRYear(targetYear);
		const rows = await this.d1.querySQL(`
			SELECT COALESCE(MAX(
				CASE
					WHEN INSTR(application_number, '/') > 1
					THEN CAST(SUBSTR(application_number, 1, INSTR(application_number, '/') - 1) AS INTEGER)
					ELSE 0
				END
			), 0) AS max_number
			FROM applications
			WHERE TRIM(application_number) LIKE ?
		`, [`%/${echrYear}`]);
		const observedMax = Math.max(0, Number(rows[0]?.max_number || 0));
		const startNumber = Math.max(1, observedMax - CURRENT_YEAR_PRIORITY_OVERLAP_SIZE);
		log(`\n⚡ Scheduled current-year scan`, true);
		log(`   Forward range: ${startNumber}/${echrYear} (D1 max ${observedMax}/${echrYear}); no queue record is used.`, true);

		const forward = await this.scanScheduledYearDirection({
			year: targetYear,
			startNumber,
			direction: 1,
			phase: 'current-year-forward',
			stopAfterConsecutiveEmpty: CURRENT_YEAR_PRIORITY_MAX_EMPTY
		});
		if (forward.runtimeLimit) return { handled: true, stopRun: true };

		const nextYear = targetYear + 1;
		const nextYearCheck = await this.scanScheduledYearDirection({
			year: nextYear,
			startNumber: 1,
			direction: 1,
			phase: 'next-year-forward',
			stopAfterConsecutiveEmpty: CURRENT_YEAR_PRIORITY_MAX_EMPTY
		});
		if (nextYearCheck.runtimeLimit) return { handled: true, stopRun: true };

		const backwardStart = startNumber - 1;
		if (backwardStart < 1) {
			log('   ✅ Current-year reverse range is already at 1; scheduled scan complete.', true);
			return { handled: true, completed: true, stopRun: true };
		}

		const backward = await this.scanScheduledYearDirection({
			year: targetYear,
			startNumber: backwardStart,
			direction: -1,
			phase: 'current-year-backward'
		});
		if (backward.runtimeLimit) return { handled: true, stopRun: true };

		log('   ✅ Scheduled current-year forward, next-year, and reverse scan complete.', true);
		return { handled: true, completed: true, stopRun: true };
	}

	async loadExistingApplicationNumbers(applicationNumbers) {
		if (!applicationNumbers.length) return new Set();
		const existing = new Set();
		const distinctNumbers = [...new Set(applicationNumbers.map((number) => String(number || '').trim()).filter(Boolean))];
		for (let offset = 0; offset < distinctNumbers.length; offset += EXISTING_APPLICATION_LOOKUP_CHUNK_SIZE) {
			const chunk = distinctNumbers.slice(offset, offset + EXISTING_APPLICATION_LOOKUP_CHUNK_SIZE);
			const rows = await this.d1.querySQL(
				`SELECT application_number FROM applications WHERE application_number IN (${chunk.map(() => '?').join(', ')})`,
				chunk,
			);
			for (const row of rows) {
				const number = String(row.application_number || '').trim();
				if (number) existing.add(number);
			}
		}
		return existing;
	}

	async startScrapeRun() {
		await this.d1.querySQL(`
			CREATE TABLE IF NOT EXISTS echr_scraper_runs (
				id TEXT PRIMARY KEY,
				schedule_slot TEXT NOT NULL,
				run_mode TEXT NOT NULL,
				status TEXT NOT NULL,
				started_at TEXT NOT NULL,
				completed_at TEXT,
				new_applications_added INTEGER NOT NULL DEFAULT 0,
				applications_saved INTEGER NOT NULL DEFAULT 0,
				error_count INTEGER NOT NULL DEFAULT 0,
				error_message TEXT
			)
		`);
		await this.d1.querySQL(
			`CREATE TABLE IF NOT EXISTS echr_scraper_run_ranges (
				run_id TEXT PRIMARY KEY,
				smallest_application_number TEXT,
				largest_application_number TEXT
			)`,
		);
		await this.d1.querySQL(
			`INSERT INTO echr_scraper_runs (id, schedule_slot, run_mode, status, started_at) VALUES (?, ?, ?, 'running', ?)`,
			[this.runId, this.scheduleSlot, this.runCurrentYearPriorityScan ? 'current-year' : 'historical-cycle', this.runStartedAt],
		);
	}

	async finishScrapeRun(error = null) {
		const message = error ? String(error.message || error).slice(0, 2000) : null;
		await this.d1.querySQL(
			`UPDATE echr_scraper_runs
			 SET status = ?, completed_at = ?, new_applications_added = ?, applications_saved = ?, error_count = ?, error_message = ?
			 WHERE id = ?`,
			[
				message ? 'failed' : 'completed',
				new Date().toISOString(),
				this.newApplicationsAdded,
				this.stats.d1Saved,
				this.stats.errors,
				message,
				this.runId,
			],
		);
		await this.d1.querySQL(
			`INSERT INTO echr_scraper_run_ranges (run_id, smallest_application_number, largest_application_number)
			 VALUES (?, ?, ?)
			 ON CONFLICT(run_id) DO UPDATE SET
				smallest_application_number = excluded.smallest_application_number,
				largest_application_number = excluded.largest_application_number`,
			[this.runId, this.smallestScannedApplicationNumber, this.largestScannedApplicationNumber],
		);
	}

	recordScannedApplication(applicationNumber) {
		const value = String(applicationNumber || '').trim();
		if (!value) return;
		if (!this.smallestScannedApplicationNumber || this.compareApplicationNumbers(value, this.smallestScannedApplicationNumber) < 0) {
			this.smallestScannedApplicationNumber = value;
		}
		if (!this.largestScannedApplicationNumber || this.compareApplicationNumbers(value, this.largestScannedApplicationNumber) > 0) {
			this.largestScannedApplicationNumber = value;
		}
	}

	compareApplicationNumbers(left, right) {
		const parse = (value) => {
			const match = /^(\d+)\/(\d{2})$/.exec(String(value));
			return match ? { number: Number(match[1]), year: 2000 + Number(match[2]) } : { number: 0, year: 0 };
		};
		const a = parse(left);
		const b = parse(right);
		return a.year - b.year || a.number - b.number;
	}

	async scanScheduledYearDirection({ year, startNumber, direction, phase, stopAfterConsecutiveEmpty = null }) {
		const echrYear = this.toECHRYear(year);
		let currentNumber = startNumber;
		let consecutiveEmpty = 0;
		let technicalErrorCount = 0;
		log(`   ↳ ${phase}: ${currentNumber}/${echrYear} ${direction > 0 ? '→' : '←'}`, true);

		while (!this.shouldStopBeforeNextAttempt()) {
			if (currentNumber < 1) {
				await this.flushBatch();
				return { completed: true, runtimeLimit: false };
			}

			const applicationNumber = `${currentNumber}/${echrYear}`;
			this.attemptCounter++;
			this.stats.totalChecked++;
			this.recordScannedApplication(applicationNumber);

			try {
				const data = await this.scrapeWithDeadline(currentNumber, echrYear);
				technicalErrorCount = 0;
				if (data) {
					this.batchQueue.push(data);
					consecutiveEmpty = 0;
					this.stats.found++;
				} else {
					consecutiveEmpty++;
					this.stats.notFound++;
					this.queueNoInfoIfEligible(applicationNumber);
				}
				currentNumber += direction;
			} catch (error) {
				technicalErrorCount++;
				this.stats.errors++;
				const message = String(error.message || error).slice(0, 2000);
				log(`   ❌ ${phase} error at ${applicationNumber}: ${message}`, true);
				if (technicalErrorCount >= CURRENT_SCAN_MAX_CONSECUTIVE_TECHNICAL_ERRORS) {
					await this.flushBatch();
					throw new Error(`${CURRENT_SCAN_MAX_CONSECUTIVE_TECHNICAL_ERRORS} consecutive ${phase} errors: ${message}`);
				}
			}

			if (this.attemptCounter >= this.BATCH_ATTEMPTS) {
				await this.flushBatch();
			}

			if (stopAfterConsecutiveEmpty && consecutiveEmpty >= stopAfterConsecutiveEmpty) {
				await this.flushBatch();
				log(`   ✓ ${phase}: ${stopAfterConsecutiveEmpty} consecutive empty results reached.`, true);
				return { completed: true, runtimeLimit: false };
			}

			await this.sleep(250);
		}

		await this.flushBatch();
		log(`   ⏱️ ${phase} reached the safe runtime limit at ${currentNumber}/${echrYear}.`, true);
		return { completed: false, runtimeLimit: true };
	}

	/**
	 * Main scraping loop
	 */
	async run() {
		log('\n🚀 Starting ECHR Monthly Scraper', true);
		log('='.repeat(60), true);
		log(`Year cycle: ${this.startYear} to ${this.cycleEndYear}, then back to ${this.startYear}`, true);
		log(`Max consecutive empty results: ${this.maxConsecutiveEmpty}`, true);
		log(`Temporary scrape retries: ${this.maxScrapeRetries}`, true);
		log(`Safe stop: no new attempts after ${new Date(this.stopNewAttemptsAt).toISOString()}`, true);
		log(`Hard runtime target: ${new Date(this.hardStopAt).toISOString()}`, true);
		log('='.repeat(60), true);
		await this.startScrapeRun();
		this.loadState();
		this.saveState('run-start');
		await this.loadFinalizedApplicationNumbers();
		await this.prepareAdministrativeRejectionTracking();

		// The browser is created lazily and restarted when it becomes unhealthy or
		// reaches its bounded uptime. A stuck Chromium close must never consume the
		// rest of a GitHub Actions slot.

		let runError = null;
		try {
			let lastLoggedYear = null;
			let stopReason = null;
			const startupPriority = await this.processScheduledCurrentYearScan();
			if (startupPriority.stopRun) {
				stopReason = 'scheduled-current-year-scan';
			}

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
					this.recordScannedApplication(applicationNumber);
					log(`\n[Check #${this.stats.totalChecked}] ${applicationNumber}`);

					try {
						// Increment attempt counter
						this.attemptCounter++;

						// Scrape the case (reusing the shared browser)
						const data = await this.scrapeWithDeadline(currentNumber, echrYear);

						if (data) {
							// Found - add to batch queue
							this.batchQueue.push(data);
							this.stats.found++;
							this.state.consecutiveEmpty = 0;

							log(`   📦 Added to queue (${this.batchQueue.length} cases | ${this.attemptCounter}/${this.BATCH_ATTEMPTS} attempts)`, true);
						} else {
							// Not found - increment empty counter
							this.state.consecutiveEmpty++;
							this.stats.notFound++;
							this.queueNoInfoIfEligible(applicationNumber);
							log(`   ⚠️  Empty: ${this.state.consecutiveEmpty}/${this.maxConsecutiveEmpty} | Attempts: ${this.attemptCounter}/${this.BATCH_ATTEMPTS}`, true);
						}

						this.state.currentNumber = currentNumber + 1;

						// Write batch after the configured attempt limit (regardless of success/failure)
						if (this.attemptCounter >= this.BATCH_ATTEMPTS) {
							await this.flushBatch();
							this.saveState('batch-flush');
						} else if (this.batchQueue.length === 0) {
							this.saveState(data ? 'found' : 'empty');
						}

					} catch (error) {
						log(`   ❌ Error: ${error.message}`, true);
						this.stats.errors++;
						this.state.currentNumber = currentNumber + 1;

						if (isTemporaryScrapeError(error)) {
							log('   ℹ️  Temporary scrape error exhausted retries; not counted as empty SOP result.', true);
						} else {
							this.state.consecutiveEmpty++;
						}

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
		} catch (error) {
			runError = error;
			throw error;
		} finally {
			// Always close the browser, even if an error occurred
			if (this.browser) {
				log('\n🌐 Closing browser...', true);
				await this.closeBrowserWithinDeadline('run cleanup');
			}
			await this.finishScrapeRun(runError).catch((historyError) => {
				log(`   ⚠️ Could not save scraper run history: ${historyError.message}`, true);
			});
		}
	}

	/**
	 * Print progress update
	 */
	printProgress() {
		const metrics = this.getRuntimeMetrics();
		const checkpoint = this.state
			? `${this.state.currentNumber}/${this.toECHRYear(this.state.currentYear)}`
			: 'n/a';

		log(`\n ${'='.repeat(60)}`, true);
		log('📊 PROGRESS UPDATE', true);
		log('='.repeat(60), true);
		log(`Elapsed: ${metrics.elapsed} | Safe time left: ${metrics.safeTimeLeft}`, true);
		log(`Checkpoint: ${checkpoint} | Processed incl. skips: ${metrics.processed}`, true);
		log(`Speed: ${metrics.checkedPerMinute} checked/min | ${metrics.processedPerMinute} processed/min`, true);
		log(`Total checked: ${this.stats.totalChecked}`, true);
		log(`✅ Found: ${this.stats.found}`, true);
		log(`❌ Not found: ${this.stats.notFound}`, true);
		log(`⏭️  Skipped finalized: ${this.stats.skippedFinalized}`, true);
		log(`🚫 Skipped administrative rejections: ${this.stats.skippedAdministrativeRejected}`, true);
		log(`📝 No-info candidates tracked: ${this.stats.noInfoTracked}`, true);
		log(`ℹ️  No-info known applications: ${this.stats.noInfoKnownApplication}`, true);
		log(`⚠️  Errors: ${this.stats.errors} (${metrics.errorRate}%)`, true);
		log(`D1: ${this.stats.d1Saved} app saved, ${this.stats.d1Failed} app failed, ${this.stats.noInfoSaved} no-info saved, ${this.stats.noInfoFailed} no-info failed`, true);
		log(`Flushes: ${this.stats.flushes} | Avg D1 write: ${metrics.avgD1WriteMs}ms | Queue: ${this.batchQueue.length} apps/${this.noInfoQueue.length} no-info`, true);
		log(`${'='.repeat(60) + '\n'}`, true);
	}

	/**
	 * Print final statistics
	 */
	printFinalStats() {
		const metrics = this.getRuntimeMetrics();
		const checkpoint = this.state
			? `${this.state.currentNumber}/${this.toECHRYear(this.state.currentYear)}`
			: 'n/a';
		const successRate = this.stats.totalChecked > 0
			? ((this.stats.found / this.stats.totalChecked) * 100).toFixed(2)
			: 0;

		log(`\n${'='.repeat(60)}`, true);
		log('🎉 SCRAPING COMPLETE', true);
		log(`${'='.repeat(60)}`, true);
		log(`Elapsed: ${metrics.elapsed} | Final checkpoint: ${checkpoint}`, true);
		log(`Processed incl. skips: ${metrics.processed}`, true);
		log(`Speed: ${metrics.checkedPerMinute} checked/min | ${metrics.processedPerMinute} processed/min`, true);
		log(`Total checked: ${this.stats.totalChecked}`, true);
		log(`✅ Found: ${this.stats.found}`, true);
		log(`❌ Not found: ${this.stats.notFound}`, true);
		log(`⏭️  Skipped finalized: ${this.stats.skippedFinalized}`, true);
		log(`🚫 Skipped administrative rejections: ${this.stats.skippedAdministrativeRejected}`, true);
		log(`📝 No-info candidates tracked: ${this.stats.noInfoTracked}`, true);
		log(`ℹ️  No-info known applications: ${this.stats.noInfoKnownApplication}`, true);
		log(`⚠️  Errors: ${this.stats.errors} (${metrics.errorRate}%)`, true);
		log(`📈 Success rate: ${successRate}%`, true);
		log(`D1: ${this.stats.d1Saved} app saved, ${this.stats.d1Failed} app failed, ${this.stats.noInfoSaved} no-info saved, ${this.stats.noInfoFailed} no-info failed`, true);
		log(`Flushes: ${this.stats.flushes} | Avg D1 write: ${metrics.avgD1WriteMs}ms`, true);
		log(`${'='.repeat(60) + '\n'}`, true);
	}

	/**
	 * Sleep helper
	 */
	sleep(ms) {
		return new Promise(resolve => setTimeout(resolve, ms));
	}

	formatDuration(ms) {
		const totalSeconds = Math.max(0, Math.floor(ms / 1000));
		const hours = Math.floor(totalSeconds / 3600);
		const minutes = Math.floor((totalSeconds % 3600) / 60);
		const seconds = totalSeconds % 60;

		if (hours > 0) {
			return `${hours}h ${minutes}m ${seconds}s`;
		}

		if (minutes > 0) {
			return `${minutes}m ${seconds}s`;
		}

		return `${seconds}s`;
	}

	getRuntimeMetrics() {
		const elapsedMs = Date.now() - this.startedAt;
		const elapsedMinutes = Math.max(elapsedMs / 60000, 1 / 60);
		const processed = this.stats.totalChecked
			+ this.stats.skippedFinalized
			+ this.stats.skippedAdministrativeRejected;
		const errorRate = this.stats.totalChecked > 0
			? (this.stats.errors / this.stats.totalChecked) * 100
			: 0;

		return {
			elapsed: this.formatDuration(elapsedMs),
			safeTimeLeft: this.formatDuration(this.stopNewAttemptsAt - Date.now()),
			processed,
			checkedPerMinute: (this.stats.totalChecked / elapsedMinutes).toFixed(2),
			processedPerMinute: (processed / elapsedMinutes).toFixed(2),
			errorRate: errorRate.toFixed(2),
			avgD1WriteMs: this.stats.flushes > 0
				? Math.round(this.stats.totalD1WriteMs / this.stats.flushes)
				: 0
		};
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

if (require.main === module) {
	main().catch(error => {
		console.error(error);
		process.exitCode = 1;
	});
}

module.exports = { MonthlyECHRScraper };

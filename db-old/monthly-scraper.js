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
// A measured, source-friendly cadence: with the typical SOP response time this
// produces roughly 27–30 requests per minute instead of the former ~55.
const DEFAULT_REQUEST_DELAY_MS = 1350;
const BROWSER_CLOSE_TIMEOUT_MS = 10_000;
const STATE_VERSION = 1;
// A missing SOP panel is a source/connection health signal, not an absent
// application. Stop early and retry the same number in the next slot.
const CURRENT_SCAN_MAX_CONSECUTIVE_TECHNICAL_ERRORS = 5;
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
		requestDelayMs: parseNumber(process.env.SCRAPER_REQUEST_DELAY_MS),
		administrativeRejectionGraceDays: parseNumber(process.env.ADMINISTRATIVE_REJECTION_GRACE_DAYS),
		maxScrapeRetries: parseNumber(process.env.MAX_SCRAPE_RETRIES),
		runCurrentYearPriorityScan: parseBoolean(process.env.RUN_CURRENT_YEAR_PRIORITY_SCAN),
		currentYearPriorityEndHour: parseNumber(process.env.CURRENT_YEAR_PRIORITY_END_HOUR),
		scheduleSlot: process.env.SCRAPER_SCHEDULE_SLOT || 'manual',
		stateFile: process.env.SCRAPER_STATE_FILE,
		runSource: process.env.SCRAPER_RUN_SOURCE,
		runSourceReference: process.env.SCRAPER_RUN_SOURCE_REFERENCE,
		logicalCycleId: process.env.SCRAPER_LOGICAL_CYCLE_ID,
		activityFile: process.env.SCRAPER_ACTIVITY_FILE
	}).filter(([, value]) => value !== undefined && value !== ''));
}

const CONFIG = {
	...readConfigFile(),
	...readEnvConfig()
};

// ============================================================
// DO NOT EDIT BELOW THIS LINE
// ============================================================

const {
	scrapeECHRApplication,
	createBrowser,
	isTemporaryScrapeError,
	TemporaryScrapeError
} = require('./improved-scraper');
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
		this.currentYearPriorityEndHour = config.currentYearPriorityEndHour;
		this.scheduleSlot = String(config.scheduleSlot || 'manual');
		this.runSource = String(config.runSource || 'unspecified').trim() || 'unspecified';
		this.runSourceReference = String(config.runSourceReference || '').trim() || null;
		this.logicalCycleId = String(config.logicalCycleId || '').trim() || null;
		this.activityFile = String(config.activityFile || '').trim() || null;
		this.runId = config.runId || crypto.randomUUID();
		this.runStartedAt = new Date().toISOString();
		this.newApplicationsAdded = 0;
		this.smallestScannedApplicationNumber = null;
		this.largestScannedApplicationNumber = null;
		this.browser = null;
		this.browserStartedAt = null;
		this.currentApplicationNumber = null;
		this.firstScannedApplicationNumber = null;
		this.currentPhase = this.runCurrentYearPriorityScan ? 'current-year-priority' : 'historical-cycle';
		this.phaseTelemetry = new Map();
		this.progressUpdatePromise = Promise.resolve();
		this.scrapeAttemptTimeoutMs = config.scrapeAttemptTimeoutMs || DEFAULT_SCRAPE_ATTEMPT_TIMEOUT_MS;
		this.browserMaxUptimeMs =
			(config.browserMaxUptimeMinutes || DEFAULT_BROWSER_MAX_UPTIME_MINUTES) * 60 * 1000;
		this.requestDelayMs = Math.max(0, config.requestDelayMs ?? DEFAULT_REQUEST_DELAY_MS);
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
		this.portfolioStageChanges = [];
		this.knownApplicationNumbers = new Set();
		this.administrativelyRejectedApplicationNumbers = new Set();
		this.administrativeRejectionTrackingEnabled = false;
		this.administrativeRejectionGraceDays =
			config.administrativeRejectionGraceDays || DEFAULT_ADMINISTRATIVE_REJECTION_GRACE_DAYS;
		this.maxScrapeRetries = config.maxScrapeRetries === undefined
			? DEFAULT_MAX_SCRAPE_RETRIES
			: Math.max(0, parseInt(config.maxScrapeRetries, 10) || 0);

		// Batch configuration
		// Publish to D1 in the same small, recoverable 25-attempt batches used
		// by the former hosted workflow.  A batch may contain fewer than 25
		// applications because empty/known application numbers are checkpoints too.
		this.BATCH_ATTEMPTS = 25;
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
		try {
			await this.ensureHealthyBrowser();
		} catch (error) {
			throw new TemporaryScrapeError(`Could not launch Chromium: ${error.message}`, error);
		}
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
		const savedBefore = this.stats.d1Saved;
		const failedBefore = this.stats.d1Failed;
		const noInfoSavedBefore = this.stats.noInfoSaved;
		const noInfoFailedBefore = this.stats.noInfoFailed;
		this.recordActivity('d1_batch_started', {
			caseCount: this.batchQueue.length,
			noInfoCandidateCount: this.noInfoQueue.length,
			message: 'D1 yazım paketi başlatıldı.',
		});

		if (this.batchQueue.length > 0) {
			const casesToSave = this.batchQueue;
			const candidateNumbers = [...new Set(casesToSave.map((data) => String(data.applicationNumber || '').trim()).filter(Boolean))];
			const existingBefore = await this.loadExistingApplicationNumbers(candidateNumbers);
			const stagesBefore = await this.loadExistingStageDetails(candidateNumbers);
			const result = await this.d1.saveBatch(casesToSave);
			log(`\n✅ Application batch complete: ${result.success} saved, ${result.failed} errors`, true);
			this.stats.d1Saved += result.success || 0;
			this.stats.d1Failed += result.failed || 0;
			const absentBefore = candidateNumbers.filter((number) => !existingBefore.has(number));
			const presentAfter = await this.loadExistingApplicationNumbers(absentBefore);
			this.newApplicationsAdded += presentAfter.size;
			for (const data of casesToSave) {
				const previous = stagesBefore.get(String(data.applicationNumber || '').trim());
				if (!previous || this.isSameStage(previous, data)) continue;
				this.portfolioStageChanges.push({
					applicationNumber: String(data.applicationNumber || '').trim(),
					applicationTitle: String(data.applicationTitle || '').trim(),
					previousEvent: previous.last_major_event || '',
					previousEventDate: previous.last_major_event_date || '',
					currentEvent: String(data.lastMajorEvent || '').trim(),
					currentEventDate: String(data.lastMajorEventDate || '').trim()
				});
			}

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
		this.requestPublishedSnapshotRefresh();
		this.recordActivity('d1_batch_completed', {
			casesSaved: this.stats.d1Saved - savedBefore,
			caseWriteErrors: this.stats.d1Failed - failedBefore,
			noInfoSaved: this.stats.noInfoSaved - noInfoSavedBefore,
			noInfoWriteErrors: this.stats.noInfoFailed - noInfoFailedBefore,
			message: 'D1 yazım paketi tamamlandı.',
		});
		log('='.repeat(60), true);
	}

	requestPublishedSnapshotRefresh() {
		const url = String(process.env.ECHR_PUBLISHED_SNAPSHOT_REFRESH_URL || '').trim();
		if (!url || typeof fetch !== 'function') return;
		void fetch(url, { method: 'POST' }).catch((error) => {
			log(`   ⚠️ Published panel summary refresh could not start: ${error.message}`, true);
		});
	}

	async processScheduledCurrentYearScan() {
		if (!this.runCurrentYearPriorityScan) {
			return { handled: false, stopRun: false };
		}
		const priorityDeadline = new Date();
		priorityDeadline.setHours(this.currentYearPriorityEndHour ?? 10, 0, 0, 0);
		if (Date.now() >= priorityDeadline.getTime()) {
			log('   ℹ️ Current-year priority window has ended; continuing from the historical checkpoint.', true);
			return { handled: false, stopRun: false };
		}
		const normalStopAt = this.stopNewAttemptsAt;
		this.stopNewAttemptsAt = Math.min(normalStopAt, priorityDeadline.getTime());
		const priorityWindowStopped = () => this.stopNewAttemptsAt < normalStopAt;
		try {

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
		if (forward.runtimeLimit) return { handled: true, stopRun: !priorityWindowStopped() };
		if (forward.deferred) return { handled: true, stopRun: true, deferred: true };

		const nextYear = targetYear + 1;
		const nextYearCheck = await this.scanScheduledYearDirection({
			year: nextYear,
			startNumber: 1,
			direction: 1,
			phase: 'next-year-forward',
			stopAfterConsecutiveEmpty: CURRENT_YEAR_PRIORITY_MAX_EMPTY
		});
		if (nextYearCheck.runtimeLimit) return { handled: true, stopRun: !priorityWindowStopped() };
		if (nextYearCheck.deferred) return { handled: true, stopRun: true, deferred: true };

		const backwardStart = startNumber - 1;
		if (backwardStart < 1) {
			log('   ✅ Current-year reverse range is already at 1; scheduled scan complete.', true);
			return { handled: true, completed: true, stopRun: false };
		}

		const backward = await this.scanScheduledYearDirection({
			year: targetYear,
			startNumber: backwardStart,
			direction: -1,
			phase: 'current-year-backward'
		});
		if (backward.runtimeLimit) return { handled: true, stopRun: !priorityWindowStopped() };
		if (backward.deferred) return { handled: true, stopRun: true, deferred: true };

		log('   ✅ Scheduled current-year forward, next-year, and reverse scan complete.', true);
		return { handled: true, completed: true, stopRun: false };
		} finally {
			this.stopNewAttemptsAt = normalStopAt;
		}
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

	async loadExistingStageDetails(applicationNumbers) {
		const result = new Map();
		const distinctNumbers = [...new Set(applicationNumbers.map((number) => String(number || '').trim()).filter(Boolean))];
		for (let offset = 0; offset < distinctNumbers.length; offset += EXISTING_APPLICATION_LOOKUP_CHUNK_SIZE) {
			const chunk = distinctNumbers.slice(offset, offset + EXISTING_APPLICATION_LOOKUP_CHUNK_SIZE);
			const rows = await this.d1.querySQL(
				`SELECT application_number, last_major_event, last_major_event_date FROM applications WHERE application_number IN (${chunk.map(() => '?').join(', ')})`,
				chunk,
			);
			for (const row of rows) result.set(String(row.application_number || '').trim(), row);
		}
		return result;
	}

	isSameStage(previous, current) {
		return String(previous.last_major_event || '').trim() === String(current.lastMajorEvent || '').trim()
			&& String(previous.last_major_event_date || '').trim() === String(current.lastMajorEventDate || '').trim();
	}

	persistPortfolioStageChanges() {
		const outputPath = process.env.PORTFOLIO_STAGE_CHANGES_FILE || path.resolve(__dirname, 'portfolio-stage-changes.json');
		const unique = Array.from(new Map(this.portfolioStageChanges
			.filter((item) => item.applicationNumber && item.currentEvent)
			.map((item) => [item.applicationNumber, item])).values());
		fs.writeFileSync(outputPath, `${JSON.stringify({ runId: this.runId, scheduleSlot: this.scheduleSlot, changes: unique }, null, 2)}\n`);
		log(`   📬 Portfolio stage changes saved: ${unique.length}`, true);
	}

	async startScrapeRun() {
		await this.d1.querySQL(`
			CREATE TABLE IF NOT EXISTS echr_scraper_runs (
				id TEXT PRIMARY KEY,
				schedule_slot TEXT NOT NULL,
				run_mode TEXT NOT NULL,
				run_source TEXT NOT NULL DEFAULT 'unspecified',
				run_source_reference TEXT,
				logical_cycle_id TEXT,
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
			`CREATE TABLE IF NOT EXISTS echr_scraper_cycle_phase_metrics (
				cycle_id TEXT NOT NULL,
				run_id TEXT NOT NULL,
				run_source TEXT NOT NULL,
				phase TEXT NOT NULL,
				started_at TEXT NOT NULL,
				completed_at TEXT,
				last_updated_at TEXT NOT NULL,
				first_application_number TEXT,
				current_application_number TEXT,
				processed_count INTEGER NOT NULL DEFAULT 0,
				checked_count INTEGER NOT NULL DEFAULT 0,
				elapsed_minutes REAL NOT NULL DEFAULT 0,
				new_applications_added INTEGER NOT NULL DEFAULT 0,
				applications_saved INTEGER NOT NULL DEFAULT 0,
				error_count INTEGER NOT NULL DEFAULT 0,
				PRIMARY KEY (cycle_id, run_id, phase)
			)`,
		);
		await this.d1.querySQL(
			`CREATE TABLE IF NOT EXISTS echr_scraper_run_ranges (
				run_id TEXT PRIMARY KEY,
				smallest_application_number TEXT,
				largest_application_number TEXT
			)`,
		);
		await this.d1.querySQL(
			`CREATE TABLE IF NOT EXISTS echr_scraper_phase_summaries (
				run_id TEXT NOT NULL,
				phase TEXT NOT NULL,
				started_at TEXT NOT NULL,
				completed_at TEXT NOT NULL,
				first_application_number TEXT,
				last_application_number TEXT,
				processed_count INTEGER NOT NULL DEFAULT 0,
				checked_per_minute REAL NOT NULL DEFAULT 0,
				new_applications_added INTEGER NOT NULL DEFAULT 0,
				applications_saved INTEGER NOT NULL DEFAULT 0,
				error_count INTEGER NOT NULL DEFAULT 0,
				PRIMARY KEY (run_id, phase)
			)`,
		);
		for (const column of [
			'run_source TEXT NOT NULL DEFAULT \'unspecified\'',
			'run_source_reference TEXT',
			'logical_cycle_id TEXT',
			'current_application_number TEXT',
			'first_application_number TEXT',
			'current_phase TEXT',
			'processed_count INTEGER NOT NULL DEFAULT 0',
			'checked_per_minute REAL',
			'last_heartbeat_at TEXT'
		]) {
			try {
				await this.d1.querySQL(`ALTER TABLE echr_scraper_runs ADD COLUMN ${column}`);
			} catch (error) {
				// Existing installations already have these columns after the first
				// local run. Any other schema failure must remain visible.
				if (!/duplicate column name/i.test(String(error?.message || error))) throw error;
			}
		}
		await this.d1.querySQL(
			`INSERT INTO echr_scraper_runs (
				id, schedule_slot, run_mode, run_source, run_source_reference, logical_cycle_id, status, started_at
			) VALUES (?, ?, ?, ?, ?, ?, 'running', ?)`,
			[
				this.runId,
				this.scheduleSlot,
				this.runCurrentYearPriorityScan ? 'current-year' : 'historical-cycle',
				this.runSource,
				this.runSourceReference,
				this.logicalCycleId,
				this.runStartedAt,
			],
		);
		this.beginPhaseTelemetry(this.currentPhase);
		await this.queueProgressUpdate();
	}

	beginPhaseTelemetry(phase, resetRange = false) {
		if (this.phaseTelemetry.has(phase)) return;
		const metrics = this.getRuntimeMetrics();
		this.phaseTelemetry.set(phase, {
			startedAt: new Date().toISOString(),
			// A phase change (not initial run setup) owns a fresh range. The
			// 10:00 historical cycle must not inherit the last 06:00–10:00
			// priority number before it makes its first request.
			firstApplicationNumber: resetRange ? null : this.firstScannedApplicationNumber,
			currentApplicationNumber: resetRange ? null : this.currentApplicationNumber,
			baselineProcessed: metrics.processed,
			baselineChecked: this.stats.totalChecked,
			baselineNewApplications: this.newApplicationsAdded,
			baselineApplicationsSaved: this.stats.d1Saved,
			baselineErrors: this.stats.errors,
			completedAt: null,
		});
	}

	getPhaseTelemetry(phase = this.currentPhase) {
		this.beginPhaseTelemetry(phase);
		const telemetry = this.phaseTelemetry.get(phase);
		const elapsedMinutes = Math.max((Date.now() - Date.parse(telemetry.startedAt)) / 60000, 1 / 60);
		const metrics = this.getRuntimeMetrics();
		const processed = Math.max(0, metrics.processed - telemetry.baselineProcessed);
		const checked = Math.max(0, this.stats.totalChecked - telemetry.baselineChecked);
		return {
			...telemetry,
			processed,
			elapsedMinutes,
			checked,
			checkedPerMinute: Number((checked / elapsedMinutes).toFixed(2)),
			newApplicationsAdded: Math.max(0, this.newApplicationsAdded - telemetry.baselineNewApplications),
			applicationsSaved: Math.max(0, this.stats.d1Saved - telemetry.baselineApplicationsSaved),
			errorCount: Math.max(0, this.stats.errors - telemetry.baselineErrors),
		};
	}

	initializeActivityFeed() {
		if (!this.activityFile) return;
		try {
			fs.mkdirSync(path.dirname(this.activityFile), { recursive: true });
			const firstLine = fs.existsSync(this.activityFile)
				? fs.readFileSync(this.activityFile, 'utf8').split(/\r?\n/, 1)[0]
				: '';
			const firstEvent = firstLine ? JSON.parse(firstLine) : null;
			if (!firstEvent || firstEvent.cycleId !== this.logicalCycleId) fs.writeFileSync(this.activityFile, '');
			this.recordActivity('run_started', { message: 'Yerel tarama başlatıldı.' });
		} catch (error) {
			log(`   ⚠️  Canlı akış kaydı başlatılamadı: ${error.message}`, true);
			this.activityFile = null;
		}
	}

	recordActivity(type, details = {}) {
		if (!this.activityFile) return;
		try {
			fs.appendFileSync(this.activityFile, `${JSON.stringify({ at: new Date().toISOString(), runId: this.runId, cycleId: this.logicalCycleId, phase: this.currentPhase, type, ...details })}\n`, 'utf8');
		} catch (error) {
			log(`   ⚠️  Canlı akış kaydı yazılamadı: ${error.message}`, true);
		}
	}

	async completePhaseTelemetry(phase = this.currentPhase) {
		const telemetry = this.phaseTelemetry.get(phase);
		if (!telemetry || telemetry.completedAt) return;
		const completedAt = new Date().toISOString();
		telemetry.completedAt = completedAt;
		const summary = this.getPhaseTelemetry(phase);
		await this.d1.querySQL(
			`INSERT INTO echr_scraper_phase_summaries (
				run_id, phase, started_at, completed_at, first_application_number, last_application_number,
				processed_count, checked_per_minute, new_applications_added, applications_saved, error_count
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
			ON CONFLICT(run_id, phase) DO UPDATE SET
				completed_at = excluded.completed_at,
				first_application_number = excluded.first_application_number,
				last_application_number = excluded.last_application_number,
				processed_count = excluded.processed_count,
				checked_per_minute = excluded.checked_per_minute,
				new_applications_added = excluded.new_applications_added,
				applications_saved = excluded.applications_saved,
				error_count = excluded.error_count`,
			[
				this.runId, phase, summary.startedAt, completedAt,
				summary.firstApplicationNumber, summary.currentApplicationNumber,
				summary.processed, summary.checkedPerMinute, summary.newApplicationsAdded,
				summary.applicationsSaved, summary.errorCount,
			],
		);
		await this.upsertCyclePhaseMetric(phase, summary, completedAt);
	}

	async upsertCyclePhaseMetric(phase, metrics, completedAt = null) {
		if (!this.logicalCycleId) return;
		const updatedAt = completedAt || new Date().toISOString();
		await this.d1.querySQL(
			`INSERT INTO echr_scraper_cycle_phase_metrics (
				cycle_id, run_id, run_source, phase, started_at, completed_at, last_updated_at,
				first_application_number, current_application_number, processed_count, checked_count,
				elapsed_minutes, new_applications_added, applications_saved, error_count
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
			ON CONFLICT(cycle_id, run_id, phase) DO UPDATE SET
				completed_at = COALESCE(excluded.completed_at, echr_scraper_cycle_phase_metrics.completed_at),
				last_updated_at = excluded.last_updated_at,
				first_application_number = COALESCE(echr_scraper_cycle_phase_metrics.first_application_number, excluded.first_application_number),
				current_application_number = excluded.current_application_number,
				processed_count = excluded.processed_count,
				checked_count = excluded.checked_count,
				elapsed_minutes = excluded.elapsed_minutes,
				new_applications_added = excluded.new_applications_added,
				applications_saved = excluded.applications_saved,
				error_count = excluded.error_count`,
			[
				this.logicalCycleId, this.runId, this.runSource, phase, metrics.startedAt,
				completedAt, updatedAt, metrics.firstApplicationNumber, metrics.currentApplicationNumber,
				metrics.processed, metrics.checked, metrics.elapsedMinutes,
				metrics.newApplicationsAdded, metrics.applicationsSaved, metrics.errorCount,
			],
		);
	}

	queueProgressUpdate() {
		const metrics = this.getPhaseTelemetry();
		const now = new Date().toISOString();
		this.progressUpdatePromise = this.progressUpdatePromise
			.catch(() => undefined)
			.then(() => this.d1.querySQL(
				`UPDATE echr_scraper_runs
					 SET current_application_number = ?, first_application_number = ?, current_phase = ?, processed_count = ?, checked_per_minute = ?,
					 new_applications_added = ?, applications_saved = ?, error_count = ?, last_heartbeat_at = ?
				 WHERE id = ?`,
				[
					metrics.currentApplicationNumber,
					metrics.firstApplicationNumber,
					this.currentPhase,
					metrics.processed,
					metrics.checkedPerMinute,
					metrics.newApplicationsAdded,
					metrics.applicationsSaved,
					metrics.errorCount,
					now,
					this.runId,
				],
			))
			.then(() => this.upsertCyclePhaseMetric(this.currentPhase, metrics))
			.catch((error) => {
				log(`   ⚠️ Could not persist live scraper progress: ${error.message}`, true);
			});
		return this.progressUpdatePromise;
	}

	async finishScrapeRun(error = null) {
		const message = error ? String(error.message || error).slice(0, 2000) : null;
		await this.progressUpdatePromise;
		await this.completePhaseTelemetry();
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
		this.currentApplicationNumber = value;
		if (!this.firstScannedApplicationNumber) this.firstScannedApplicationNumber = value;
		const phaseTelemetry = this.phaseTelemetry.get(this.currentPhase);
		if (phaseTelemetry) {
			phaseTelemetry.currentApplicationNumber = value;
			if (!phaseTelemetry.firstApplicationNumber) phaseTelemetry.firstApplicationNumber = value;
		}
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
					this.recordActivity('found', {
						applicationNumber,
						title: data.applicationTitle || null,
						representative: data.representant || null,
						lastEvent: data.lastMajorEvent || null,
						lastEventDate: data.lastMajorEventDate || null,
						eventCount: Array.isArray(data.majorEventsList) ? data.majorEventsList.length : 0,
					});
				} else {
					consecutiveEmpty++;
					this.stats.notFound++;
					this.queueNoInfoIfEligible(applicationNumber);
					this.recordActivity('no_info', {
						applicationNumber,
						knownInD1: this.isKnownApplication(applicationNumber),
						message: 'SOP bilgi döndürmedi.',
					});
				}
				currentNumber += direction;
			} catch (error) {
				technicalErrorCount++;
				this.stats.errors++;
				const message = String(error.message || error).slice(0, 2000);
				log(`   ❌ ${phase} error at ${applicationNumber}: ${message}`, true);
				this.recordActivity('technical_error', { applicationNumber, message });
				if (technicalErrorCount >= CURRENT_SCAN_MAX_CONSECUTIVE_TECHNICAL_ERRORS) {
					await this.flushBatch();
					log(`   ⚠️  ${CURRENT_SCAN_MAX_CONSECUTIVE_TECHNICAL_ERRORS} consecutive ${phase} technical errors; deferring this scan to the next scheduled run.`, true);
					return { completed: false, runtimeLimit: false, deferred: true };
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

			// The 06:00 priority scan uses this separate loop, so it must publish
			// its heartbeat here as well as the historical-cycle loop below.
			void this.queueProgressUpdate();
			await this.sleep(this.requestDelayMs);
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
		this.initializeActivityFeed();
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
			if (this.runCurrentYearPriorityScan) {
				await this.completePhaseTelemetry('current-year-priority');
			}
			if (startupPriority.stopRun) {
				stopReason = 'scheduled-current-year-scan';
			}
			if (!stopReason && this.runCurrentYearPriorityScan) {
				this.currentPhase = 'historical-cycle';
				this.beginPhaseTelemetry(this.currentPhase, true);
				await this.queueProgressUpdate();
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
						this.recordActivity('finalized_skip', { applicationNumber, message: 'Kesinleşmiş kayıt; SOP sorgusu atlandı.' });

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
						this.recordActivity('administrative_skip', { applicationNumber, message: 'İdari ret kaydı; SOP sorgusu atlandı.' });

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
							this.recordActivity('found', {
								applicationNumber,
								title: data.applicationTitle || null,
								representative: data.representant || null,
								lastEvent: data.lastMajorEvent || null,
								lastEventDate: data.lastMajorEventDate || null,
								eventCount: Array.isArray(data.majorEventsList) ? data.majorEventsList.length : 0,
							});
						} else {
							// Not found - increment empty counter
							this.state.consecutiveEmpty++;
							this.stats.notFound++;
							this.queueNoInfoIfEligible(applicationNumber);
							log(`   ⚠️  Empty: ${this.state.consecutiveEmpty}/${this.maxConsecutiveEmpty} | Attempts: ${this.attemptCounter}/${this.BATCH_ATTEMPTS}`, true);
							this.recordActivity('no_info', {
								applicationNumber,
								knownInD1: this.isKnownApplication(applicationNumber),
								message: 'SOP bilgi döndürmedi.',
							});
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
						this.recordActivity('technical_error', { applicationNumber, message: String(error.message || error) });

						if (isTemporaryScrapeError(error)) {
							// Do not advance the checkpoint. This request was not answered by SOP,
							// so advancing would silently postpone it until the next full cycle.
							await this.flushBatch();
							this.saveState('temporary-source-error');
							log('   ⏱️  Temporary SOP error exhausted retries; checkpoint retained and run deferred to the next scheduled slot.', true);
							stopReason = 'temporary-source-error';
							break;
						} else {
							this.state.currentNumber = currentNumber + 1;
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
					if (stopReason) break;
					await this.sleep(this.requestDelayMs);

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
			} else if (stopReason === 'temporary-source-error') {
				log('\n⏱️  SOP is temporarily unavailable. State is preserved for the next scheduled run.', true);
			}

			await this.flushBatch();
			this.saveState(stopReason || 'run-complete');
			this.printFinalStats();
		} catch (error) {
			runError = error;
			try {
				await this.flushBatch();
			} catch (flushError) {
				log(`   ⚠️  Could not flush after fatal error: ${flushError.message}`, true);
			}
			try {
				this.saveState('fatal-error');
			} catch (stateError) {
				log(`   ⚠️  Could not save checkpoint after fatal error: ${stateError.message}`, true);
			}
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
			this.persistPortfolioStageChanges();
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
		void this.queueProgressUpdate();
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

async function main(onScraperCreated) {
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
	if (onScraperCreated) onScraperCreated(scraper);
	await scraper.run();
}

function writeFailureReport(error, scraper) {
	const reportPath = path.resolve(
		__dirname,
		process.env.SCRAPER_FAILURE_REPORT_FILE || 'scraper-failure.json'
	);
	const report = {
		failedAt: new Date().toISOString(),
		message: String(error?.message || error),
		stack: error?.stack || null,
		runId: scraper?.runId || null,
		checkpoint: scraper?.state || null,
		stats: scraper?.stats || null
	};

	try {
		fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
		console.error(`Scraper failure report saved: ${reportPath}`);
	} catch (reportError) {
		console.error(`Could not save scraper failure report: ${reportError.message}`);
	}
}

if (require.main === module) {
	let scraper;
	main((createdScraper) => {
		scraper = createdScraper;
	}).catch(error => {
		writeFailureReport(error, scraper);
		console.error(error);
		process.exitCode = 1;
	});
}

module.exports = { MonthlyECHRScraper };

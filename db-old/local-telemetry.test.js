const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { MonthlyECHRScraper } = require('./monthly-scraper');

test('local telemetry survives D1 failure and preserves terminal status through phase completion', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'echr-telemetry-'));
  try {
    const scraper = new MonthlyECHRScraper({ d1: { querySQL: async () => { throw Error('D1 quota'); } }, runSource: 'local-windows-task', activityFile: path.join(root,'events.jsonl'), runId:'one' });
    scraper.beginPhaseTelemetry('historical-cycle');
    scraper.recordScannedApplication('14211/20'); scraper.stats.totalChecked=86; scraper.stats.d1Saved=1;
    await scraper.queueProgressUpdate();
    let data=JSON.parse(fs.readFileSync(path.join(root,'echr-scraper-runs.json'),'utf8'));
    assert.equal(data.runs[0].processedCount,86);
    assert.equal(data.runs[0].currentApplicationNumber,'14211/20');
    await assert.rejects(scraper.finishScrapeRun(Error('D1 quota')));
    data=JSON.parse(fs.readFileSync(path.join(root,'echr-scraper-runs.json'),'utf8'));
    assert.equal(data.runs[0].status,'failed');
    assert.equal(data.runs[0].phaseSummaries['historical-cycle'].applicationsSaved,1);
  } finally { fs.rmSync(root,{recursive:true,force:true}); }
});
test('per-batch callbacks request at most one full summary per day and no empty refresh', () => {
  const oldFetch=global.fetch, oldUrl=process.env.ECHR_PUBLISHED_SNAPSHOT_REFRESH_URL;
  let calls=0; global.fetch=async()=>{calls++;return {ok:true};};
  process.env.ECHR_PUBLISHED_SNAPSHOT_REFRESH_URL='http://localhost/test-only';
  try {
    const scraper=new MonthlyECHRScraper({d1:{}});
    scraper.requestPublishedSnapshotRefresh(); assert.equal(calls,0);
    scraper.stats.d1Saved=1;
    for(let i=0;i<100;i++) scraper.requestPublishedSnapshotRefresh();
    assert.equal(calls,1);
  } finally { global.fetch=oldFetch; if(oldUrl===undefined) delete process.env.ECHR_PUBLISHED_SNAPSHOT_REFRESH_URL;else process.env.ECHR_PUBLISHED_SNAPSHOT_REFRESH_URL=oldUrl; }
});
test('GitHub cannot start scraping or notification jobs', () => {
  for(const name of ['scrape-echr.yml','human-rights-daily-update.yml']) {
    const source=fs.readFileSync(path.resolve(__dirname,'../.github/workflows',name),'utf8');
    assert.doesNotMatch(source,/^\s+schedule:/m);
    assert.match(source,/if: \$\{\{ false \}\}/);
  }
});

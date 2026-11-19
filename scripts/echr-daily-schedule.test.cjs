const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('daily task starts at Istanbul midnight and disables the former 00:07 task', () => {
    const source = fs.readFileSync(path.join(__dirname, 'install-echr-daily-sop-task.ps1'), 'utf8');
    assert.match(source, /BaseUtcOffset.TotalHours -ne 3/);
    assert.match(source, /\/TN 'ECHR Daily SOP Check - 0000'.*\/ST '00:00'.*\/RI 10/);
    assert.match(source, /Disable-ScheduledTask -TaskName 'ECHR Daily SOP Check - 0007'/);
    assert.match(source, /-RestartCount 3/);
    assert.match(source, /-RestartInterval \(New-TimeSpan -Minutes 5\)/);
    assert.match(source, /\/DU 03:57/);
    assert.match(source, /-ExecutionTimeLimit \(New-TimeSpan -Hours 3 -Minutes 50\)/);
});

test('daytime recovery is explicit, date-bounded and does not force system Chrome', () => {
    const source = fs.readFileSync(path.join(__dirname, 'run-echr-local-daily-sop.ps1'), 'utf8');
    assert.match(source, /\[switch\]\$RecoverToday/);
    assert.match(source, /Turkey Standard Time/);
    assert.match(source, /if \(\$RecoverToday\)/);
    assert.match(source, /\$deadline -gt \$nextMidnight/);
    assert.doesNotMatch(source, /\$env:ECHR_BROWSER_EXECUTABLE_PATH\s*=/);
    assert.match(source, /AddHours\(3\).AddMinutes\(57\)/);
});

test('new scraper runs are labelled 00:00 without rewriting historical records', () => {
    const source = fs.readFileSync(path.join(__dirname, '../db-old/weekly-scraper.js'), 'utf8');
    assert.match(source, /VALUES \(\?, '00:00', 'daily-subscription-sop'/);
    assert.doesNotMatch(source, /SET schedule_slot/);
});

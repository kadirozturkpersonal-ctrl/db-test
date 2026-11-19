-- Prepared migration: execute against production only after explicit approval.
-- No case/event rows are deleted or rewritten by this migration.
CREATE INDEX IF NOT EXISTS idx_events_application ON events(application_id);
CREATE INDEX IF NOT EXISTS idx_applications_representative ON applications(representative_id);
CREATE INDEX IF NOT EXISTS idx_sop_no_info_status_date_number
    ON sop_no_info_tracking(status, first_not_found_date, application_number);

-- The old AFTER UPDATE trigger counted every case belonging to the lawyer
-- even when only last_checked_date or an event label changed.
DROP TRIGGER IF EXISTS update_representative_counts_update;
CREATE TRIGGER update_representative_counts_update
AFTER UPDATE OF representative_id ON applications
WHEN OLD.representative_id IS NOT NEW.representative_id
BEGIN
    UPDATE representatives
    SET total_cases = (SELECT COUNT(*) FROM applications WHERE representative_id = OLD.representative_id),
        updated_at = CURRENT_TIMESTAMP
    WHERE id = OLD.representative_id;
    UPDATE representatives
    SET total_cases = (SELECT COUNT(*) FROM applications WHERE representative_id = NEW.representative_id),
        updated_at = CURRENT_TIMESTAMP
    WHERE id = NEW.representative_id;
END;

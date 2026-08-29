-- migrate-add-lane.sql
ALTER TABLE tasks ADD COLUMN lane TEXT NOT NULL DEFAULT 'architect';
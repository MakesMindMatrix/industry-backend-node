'use strict';

const fs = require('fs');
const path = require('path');

const CSV_PATH = path.join(__dirname, '..', '..', 'temp', 'student.csv');
const MAX_IDS = 20;

/**
 * Load up to MAX_IDS valid documentIds from temp/student.csv.
 * Skips empty and NOT_FOUND. Returns array of strings.
 */
function loadDocumentIdsFromCsv() {
  try {
    const fullPath = path.resolve(CSV_PATH);
    if (!fs.existsSync(fullPath)) return [];
    const content = fs.readFileSync(fullPath, 'utf8');
    const lines = content.split(/\r?\n/).filter((line) => line.trim());
    if (lines.length < 2) return [];
    const header = lines[0].toLowerCase();
    const cols = header.split(',').map((c) => c.trim().toLowerCase());
    let docIdIdx = cols.indexOf('documentid');
    if (docIdIdx === -1) return [];
    const ids = [];
    for (let i = 1; i < lines.length && ids.length < MAX_IDS; i++) {
      const line = lines[i];
      let val;
      if (docIdIdx === cols.length - 1) {
        val = line.includes(',') ? line.slice(line.lastIndexOf(',') + 1).trim() : line.trim();
      } else {
        const row = line.split(',');
        val = (row[docIdIdx] || '').trim();
      }
      if (val && val !== 'NOT_FOUND') ids.push(val);
    }
    return ids;
  } catch (err) {
    console.warn('studentCsv.loadDocumentIdsFromCsv', err?.message);
    return [];
  }
}

module.exports = { loadDocumentIdsFromCsv, CSV_PATH, MAX_IDS };

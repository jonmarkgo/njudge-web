
require('dotenv').config();
const express = require('express');
const path = require('path');
const { execFile, spawn } = require('child_process');
const session = require('express-session');
const fs = require('fs');
const fsPromises = require('fs').promises;
const sqlite3 = require('sqlite3').verbose();
const expressLayouts = require('express-ejs-layouts');
const SQLiteStore = require('connect-sqlite3')(session);
const cookieParser = require('cookie-parser');

// --- Map Info Parsing Cache ---
const provinceDataCache = {}; // Key: lowerVariant, Value: { 'CANONICAL_ABR': { name, abbr, x (labelX), y (labelY), scX, scY, unitX, unitY, labelX, labelY } }
const nameToAbbrCache = {};   // Key: lowerVariant, Value: { 'some_name_lc': 'CANONICAL_ABR' }

// --- Environment Setup ---
const dipBinaryPath = process.env.DIP_BINARY_PATH || '/home/judge/dip';
const dipBinaryArgs = (process.env.DIP_BINARY_ARGS || '-C /home/judge -w').split(' ').filter(arg => arg);
const dipBinaryRootPath = path.dirname(dipBinaryPath);
const judgeEmail = process.env.DIP_JUDGE_EMAIL || 'judge@example.com';
const dipMasterPath = process.env.DIP_MASTER_PATH || path.join(dipBinaryRootPath, 'dip.master');

const mapDataDir = process.env.MAP_DATA_PATH || '/home/judge/flocscripts/mapit/maps';
const gameDataDir = process.env.GAME_DATA_PATH || '/home/judge/data';
const staticMapDir = path.join(__dirname, 'public', 'generated_maps');
const ghostscriptPath = process.env.GHOSTSCRIPT_PATH || 'gs';

// --- Database Setup ---
const db = new sqlite3.Database('./game_states.db');
const sessionDb = new sqlite3.Database('./sessions.db');
const userDb = new sqlite3.Database('./users.db');

db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS game_states (
        name TEXT PRIMARY KEY, status TEXT DEFAULT 'Unknown', variant TEXT DEFAULT 'Standard',
        options TEXT DEFAULT '[]', currentPhase TEXT DEFAULT 'Unknown', nextDeadline TEXT,
        masters TEXT DEFAULT '[]', players TEXT DEFAULT '[]', observers TEXT DEFAULT '[]',
        settings TEXT DEFAULT '{}', lastUpdated INTEGER, rawListOutput TEXT
    )`, (err) => {
        if (err) console.error("Error creating game_states table:", err);
        else {
             const columnsToAdd = [
                { name: 'status', type: 'TEXT DEFAULT \'Unknown\'' }, { name: 'variant', type: 'TEXT DEFAULT \'Standard\'' },
                { name: 'options', type: 'TEXT DEFAULT \'[]\'' }, { name: 'currentPhase', type: 'TEXT DEFAULT \'Unknown\'' },
                { name: 'nextDeadline', type: 'TEXT' }, { name: 'masters', type: 'TEXT DEFAULT \'[]\'' },
                { name: 'players', type: 'TEXT DEFAULT \'[]\'' }, { name: 'observers', type: 'TEXT DEFAULT \'[]\'' },
                { name: 'settings', type: 'TEXT DEFAULT \'{}\'' }, { name: 'lastUpdated', type: 'INTEGER' },
                { name: 'rawListOutput', type: 'TEXT' }
            ];
             db.all("PRAGMA table_info(game_states)", (pragmaErr, existingColumns) => {
                 if (pragmaErr) return console.error("Error checking game_states columns:", pragmaErr);
                 const existingColumnNames = existingColumns.map(col => col.name);
                 columnsToAdd.forEach(col => {
                     if (!existingColumnNames.includes(col.name)) {
                         db.run(`ALTER TABLE game_states ADD COLUMN ${col.name} ${col.type}`, (addErr) => {
                             if (addErr) console.error(`Error adding column ${col.name} to game_states:`, addErr);
                             else console.log(`Added column ${col.name} to game_states table.`);
                         });
                     }
                 });
             });
        }
    });
    db.run(`CREATE TABLE IF NOT EXISTS user_preferences (
        user_id TEXT NOT NULL, preference_key TEXT NOT NULL, preference_value TEXT,
        PRIMARY KEY (user_id, preference_key)
    )`, (err) => { if (err) console.error("Error creating user_preferences table:", err); else console.log("User preferences table ensured."); });
    db.run(`CREATE TABLE IF NOT EXISTS saved_searches (
        user_id TEXT NOT NULL, bookmark_name TEXT NOT NULL, search_params TEXT,
        PRIMARY KEY (user_id, bookmark_name)
    )`, (err) => { if (err) console.error("Error creating saved_searches table:", err); else console.log("Saved searches table ensured."); });
    db.run(`CREATE TABLE IF NOT EXISTS news_items (
        id INTEGER PRIMARY KEY AUTOINCREMENT, timestamp DATETIME DEFAULT CURRENT_TIMESTAMP, content TEXT NOT NULL
    )`, (err) => { if (err) console.error("Error creating news_items table:", err); else console.log("News items table ensured."); });
});
userDb.serialize(() => {
    userDb.run(`CREATE TABLE IF NOT EXISTS users (
        email TEXT PRIMARY KEY, is_judge_registered INTEGER DEFAULT 0, last_login INTEGER
    )`, (err) => { if (err) console.error("Error creating users table:", err); });
});

// --- Database Helper Functions ---
const getUserRegistrationStatus = (email) => {
    return new Promise((resolve, reject) => {
        userDb.get("SELECT is_judge_registered FROM users WHERE email = ?", [email], (err, row) => {
            if (err) reject(err);
            else resolve(row ? row.is_judge_registered : null);
        });
    });
};
const setUserRegistered = (email) => {
    return new Promise((resolve, reject) => {
        userDb.run("UPDATE users SET is_judge_registered = 1 WHERE email = ?", [email], function(err) {
            if (err) reject(err);
            else resolve(this.changes > 0);
        });
    });
};
const ensureUserExists = (email) => {
     return new Promise((resolve, reject) => {
         const now = Math.floor(Date.now() / 1000);
         userDb.run(
             "INSERT OR IGNORE INTO users (email, last_login) VALUES (?, ?)",
             [email, now],
             (err) => {
                 if (err) return reject(err);
                 userDb.run("UPDATE users SET last_login = ? WHERE email = ?", [now, email], (updateErr) => {
                     if (updateErr) reject(updateErr);
                     else resolve();
                 });
             }
         );
     });
};
const saveGameState = (gameName, gameState) => {
    return new Promise((resolve, reject) => {
        if (!gameName || typeof gameName !== 'string' || gameName.length === 0) {
            console.error('[DB Error] Attempted to save game state with invalid name:', gameName);
            return reject(new Error('Invalid game name provided for saving state.'));
        }
        const now = Math.floor(Date.now() / 1000);
        const mastersStr = JSON.stringify(gameState.masters || []);
        const validPlayers = (gameState.players || []).filter(p => p && typeof p === 'object' && p.power).map(p => ({
             power: p.power, email: p.email || null, status: p.status || 'Unknown',
             name: p.name || null, units: p.units || [], supplyCenters: p.supplyCenters || []
        }));
        const playersStr = JSON.stringify(validPlayers);
        const observersStr = JSON.stringify(gameState.observers || []);
        const optionsStr = JSON.stringify(gameState.options || []);
        const settingsStr = JSON.stringify(gameState.settings || {});
        db.run(
            `INSERT OR REPLACE INTO game_states
             (name, status, variant, options, currentPhase, nextDeadline, masters, players, observers, settings, lastUpdated, rawListOutput)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
                gameName, gameState.status || 'Unknown', gameState.variant || 'Standard', optionsStr,
                gameState.currentPhase || 'Unknown', gameState.nextDeadline || null, mastersStr, playersStr,
                observersStr, settingsStr, gameState.lastUpdated || now, gameState.rawListOutput || null
            ],
            (err) => {
                if (err) { console.error(`[DB Error] Failed to save state for game ${gameName}:`, err); reject(err); }
                else { /* console.log(`[DB Success] Saved state for game ${gameName}`); */ resolve(); }
            }
        );
    });
};
const getGameState = (gameName) => {
    return new Promise((resolve, reject) => {
        if (!gameName) return resolve(null);
        db.get("SELECT * FROM game_states WHERE name = ?", [gameName], (err, row) => {
            if (err) { console.error(`[DB Error] Failed to read state for game ${gameName}:`, err); reject(err); }
            else if (row) {
                try {
                    row.masters = JSON.parse(row.masters || '[]');
                    row.players = JSON.parse(row.players || '[]');
                    row.observers = JSON.parse(row.observers || '[]');
                    row.options = JSON.parse(row.options || '[]');
                    row.settings = JSON.parse(row.settings || '{}');
                    resolve(row);
                } catch (parseError) {
                    console.error(`[DB Error] Failed to parse JSON state for game ${gameName}:`, parseError, 'Raw data:', row);
                    row.masters = []; row.players = []; row.observers = []; row.options = []; row.settings = {}; // Defaults
                    resolve(row);
                }
            } else { resolve(null); }
        });
    });
};
const getAllGameStates = () => {
    return new Promise((resolve, reject) => {
        db.all("SELECT * FROM game_states ORDER BY name ASC", [], (err, rows) => {
            if (err) { console.error("[DB Error] Failed to read all game states:", err); reject(err); }
            else {
                const states = {};
                rows.forEach(row => {
                    try {
                        row.masters = JSON.parse(row.masters || '[]'); row.players = JSON.parse(row.players || '[]');
                        row.observers = JSON.parse(row.observers || '[]'); row.options = JSON.parse(row.options || '[]');
                        row.settings = JSON.parse(row.settings || '{}');
                        states[row.name] = row;
                    } catch (parseError) {
                        console.error(`[DB Error] Failed to parse JSON state for game ${row.name} in getAllGameStates:`, parseError);
                        row.masters = []; row.players = []; row.observers = []; row.options = []; row.settings = {};
                        states[row.name] = row;
                    }
                }); resolve(states);
            }
        });
    });
};
const getFilteredGameStates = (filters = {}) => {
    return new Promise((resolve, reject) => {
        let query = "SELECT * FROM game_states";
        const whereClauses = []; const params = [];
        if (filters.status) { whereClauses.push("status = ?"); params.push(filters.status); }
        if (filters.variant) { whereClauses.push("variant = ?"); params.push(filters.variant); }
        if (filters.phase) { whereClauses.push("currentPhase = ?"); params.push(filters.phase); }
        if (filters.player) { whereClauses.push("players LIKE ?"); params.push(`%${filters.player}%`); }
        if (whereClauses.length > 0) query += " WHERE " + whereClauses.join(" AND ");
        query += " ORDER BY name ASC";
        db.all(query, params, (err, rows) => {
            if (err) { console.error("[DB Error] Failed to read filtered game states:", err, "Query:", query, "Params:", params); reject(err); }
            else {
                const states = {};
                rows.forEach(row => {
                    try {
                        row.masters = JSON.parse(row.masters || '[]'); row.players = JSON.parse(row.players || '[]');
                        row.observers = JSON.parse(row.observers || '[]'); row.options = JSON.parse(row.options || '[]');
                        row.settings = JSON.parse(row.settings || '{}');
                        states[row.name] = row;
                    } catch (parseError) {
                        console.error(`[DB Error] Failed to parse JSON state for game ${row.name} in getFilteredGameStates:`, parseError);
                        row.masters = []; row.players = []; row.observers = []; row.options = []; row.settings = {};
                        states[row.name] = row;
                    }
                }); resolve(states);
            }
        });
    });
};
const getGameCountsByStatus = () => {
    return new Promise((resolve, reject) => {
        db.all("SELECT status, COUNT(*) as count FROM game_states GROUP BY status ORDER BY status", [], (err, rows) => {
            if (err) { console.error("[DB Error] Failed to get game counts by status:", err); reject(err); }
            else { resolve(rows.map(row => ({ status: row.status, count: Number(row.count) }))); }
        });
    });
};
const getUserPreferences = (userId) => {
    return new Promise((resolve, reject) => {
        db.all("SELECT preference_key, preference_value FROM user_preferences WHERE user_id = ?", [userId], (err, rows) => {
            if (err) { console.error(`[DB Error] Failed to get preferences for user ${userId}:`, err); reject(err); }
            else {
                const preferences = {};
                rows.forEach(row => {
                    try {
                        if ((row.preference_value?.startsWith('{') && row.preference_value?.endsWith('}')) || (row.preference_value?.startsWith('[') && row.preference_value?.endsWith(']'))) {
                            preferences[row.preference_key] = JSON.parse(row.preference_value);
                        } else { preferences[row.preference_key] = row.preference_value; }
                    } catch (parseError) {
                        console.warn(`[DB Warn] Failed to parse preference '${row.preference_key}' for user ${userId}. Returning raw value. Error:`, parseError);
                        preferences[row.preference_key] = row.preference_value;
                    }
                }); resolve(preferences);
            }
        });
    });
};
const setUserPreference = (userId, key, value) => {
    return new Promise((resolve, reject) => {
        const valueToStore = (typeof value === 'string' || value === null || value === undefined) ? value : JSON.stringify(value);
        db.run("INSERT OR REPLACE INTO user_preferences (user_id, preference_key, preference_value) VALUES (?, ?, ?)",
            [userId, key, valueToStore], (err) => {
                if (err) { console.error(`[DB Error] Failed to set preference '${key}' for user ${userId}:`, err); reject(err); }
                else { resolve(); }
            });
    });
};
const deleteUserPreference = (userId, key) => {
    return new Promise((resolve, reject) => {
        db.run("DELETE FROM user_preferences WHERE user_id = ? AND preference_key = ?", [userId, key], function(err) {
            if (err) { console.error(`[DB Error] Failed to delete preference '${key}' for user ${userId}:`, err); reject(err); }
            else { resolve(this.changes > 0); }
        });
    });
};
const deleteAllUserPreferences = (userId) => {
    return new Promise((resolve, reject) => {
        db.run("DELETE FROM user_preferences WHERE user_id = ?", [userId], function(err) {
            if (err) { console.error(`[DB Error] Failed to delete all preferences for user ${userId}:`, err); reject(err); }
            else { resolve(this.changes); }
        });
    });
};
const getSavedSearches = (userId) => {
    return new Promise((resolve, reject) => {
        db.all("SELECT bookmark_name, search_params FROM saved_searches WHERE user_id = ? ORDER BY bookmark_name ASC", [userId], (err, rows) => {
            if (err) { console.error(`[DB Error] Failed to get saved searches for user ${userId}:`, err); reject(err); }
            else { resolve(rows.map(row => ({ name: row.bookmark_name, params: JSON.parse(row.search_params || '{}') }))); }
        });
    });
};
const saveSavedSearch = (userId, bookmarkName, searchParams) => {
    return new Promise((resolve, reject) => {
        const paramsString = JSON.stringify(searchParams || {});
        db.run("INSERT OR REPLACE INTO saved_searches (user_id, bookmark_name, search_params) VALUES (?, ?, ?)",
            [userId, bookmarkName, paramsString], (err) => {
                if (err) { console.error(`[DB Error] Failed to save search bookmark '${bookmarkName}' for user ${userId}:`, err); reject(err); }
                else { console.log(`[DB Success] Saved search bookmark '${bookmarkName}' for user ${userId}`); resolve(); }
            });
    });
};
const deleteSavedSearch = (userId, bookmarkName) => {
    return new Promise((resolve, reject) => {
        db.run("DELETE FROM saved_searches WHERE user_id = ? AND bookmark_name = ?", [userId, bookmarkName], function(err) {
            if (err) { console.error(`[DB Error] Failed to delete search bookmark '${bookmarkName}' for user ${userId}:`, err); reject(err); }
            else { console.log(`[DB Success] Deleted search bookmark '${bookmarkName}' for user ${userId} (if existed)`); resolve(this.changes > 0); }
        });
    });
};
const getAllNewsItems = () => {
    return new Promise((resolve, reject) => {
        db.all("SELECT id, timestamp, content FROM news_items ORDER BY timestamp DESC", [], (err, rows) => {
            if (err) { console.error("[DB Error] Failed to get news items:", err); reject(err); }
            else { resolve(rows.map(row => ({ ...row, _id: row.id }))); }
        });
    });
};
const addNewsItem = (content) => {
    return new Promise((resolve, reject) => {
        if (!content || typeof content !== 'string' || content.trim().length === 0) return reject(new Error('News content cannot be empty.'));
        db.run("INSERT INTO news_items (content) VALUES (?)", [content.trim()], function(err) {
            if (err) { console.error("[DB Error] Failed to add news item:", err); reject(err); }
            else { console.log(`[DB Success] Added news item with ID: ${this.lastID}`); resolve(this.lastID); }
        });
    });
};
const deleteNewsItem = (id) => {
    return new Promise((resolve, reject) => {
        db.run("DELETE FROM news_items WHERE id = ?", [id], function(err) {
            if (err) { console.error(`[DB Error] Failed to delete news item with ID ${id}:`, err); reject(err); }
            else {
                if (this.changes > 0) { console.log(`[DB Success] Deleted news item with ID: ${id}`); resolve(true); }
                else { console.log(`[DB Info] No news item found with ID: ${id} to delete.`); resolve(false); }
            }
        });
    });
};

// --- Map Data Parsing and Caching ---
const ensureMapDataParsed = async (variantName) => {
    const lowerVariant = variantName.toLowerCase().replace(/[^a-z0-9_-]/g, '');
    if (provinceDataCache[lowerVariant] && nameToAbbrCache[lowerVariant]) {
        return {
            provinceLookup: provinceDataCache[lowerVariant],
            nameToAbbr: nameToAbbrCache[lowerVariant]
        };
    }

    console.log(`[Map Parse] Ensuring map data for variant: ${variantName}`);
    const localProvinceData = {}; // Stores { ABR: { name, abbr, x (labelX), y (labelY), scX, scY, unitX, unitY, labelX, labelY } }
    const localNameToAbbr = {};   // Stores { name_lc: ABR, alias_lc: ABR }

    // Step 1: Parse the <variantName>.info file (from flocscripts/mapit/maps)
    // for coordinates and canonical names/abbreviations
    let infoFileContent;
    let infoFilePath = path.join(mapDataDir, `${variantName}.info`);
    let usedInfoPath = '';

    try {
        infoFileContent = await fsPromises.readFile(infoFilePath, 'utf-8');
        usedInfoPath = infoFilePath;
    } catch (errorOriginal) {
        if (errorOriginal.code === 'ENOENT') {
            infoFilePath = path.join(mapDataDir, `${lowerVariant}.info`);
            try {
                infoFileContent = await fsPromises.readFile(infoFilePath, 'utf-8');
                usedInfoPath = infoFilePath;
            } catch (errorLower) {
                const errMsg = `Failed to read .info file for variant ${variantName}. Tried: ${variantName}.info and ${lowerVariant}.info. Orig: ${errorOriginal.message}, Lower: ${errorLower.message}`;
                console.error(`[Map Parse Error] ${errMsg}`);
                throw new Error(errMsg);
            }
        } else {
            console.error(`[Map Parse Error] Could not read .info file ${infoFilePath}:`, errorOriginal);
            throw errorOriginal;
        }
    }
    // console.log(`[Map Parse] Using .info file: ${usedInfoPath}`);

    const infoLines = infoFileContent.split(/\r?\n/);
    let parsingSection = 'powers'; // Default, but some .info files might skip this or start with aliases

    // Regex for coordinate lines: X Y |ABR|---|FullName|OptionalSCX SCY|OptionalTrailingAlias|
    // Group 1: X (Label X), Group 2: Y (Label Y), Group 3: Abbr, Group 4: FullName,
    // Group 5: SCX (opt), Group 6: SCY (opt), Group 7: Trailing Alias (opt)
    const coordLineRegex = /^\s*(\d+)\s+(\d+)\s*\|([^|]+)\|\s*---\s*\|([^|]+?)\|(?:(\d+)\s+(\d+)\s*\|)?(?:([^|]*)\|)?\s*$/;


    for (const line of infoLines) {
        const trimmedLine = line.trim();
        if (!trimmedLine || trimmedLine.startsWith('#')) continue;

        if (trimmedLine === '-1') {
            parsingSection = (parsingSection === 'powers' || parsingSection === 'initial_aliases') ? 'coordinates' : 'finished_info_coord_parsing';
            continue;
        }

        if (parsingSection === 'coordinates') {
            const coordMatch = trimmedLine.match(coordLineRegex);
            if (coordMatch) {
                const [, xStr, yStr, abbrField, fullNameField, scxStr, scyStr, trailingAliasField] = coordMatch;
                const canonicalAbbr = abbrField.trim().toUpperCase();
                const fullNameFromCoords = fullNameField.trim();

                const labelX = parseInt(xStr, 10);
                const labelY = parseInt(yStr, 10);
                const scX = scxStr ? parseInt(scxStr, 10) : undefined;
                const scY = scyStr ? parseInt(scyStr, 10) : undefined;

                if (isNaN(labelX) || isNaN(labelY)) {
                    console.warn(`[Map Parse Warn] Invalid label coordinates for ${canonicalAbbr} ('${fullNameFromCoords}') in ${variantName} from ${usedInfoPath}: X='${xStr}', Y='${yStr}'. Skipping.`);
                    continue;
                }

                // Determine unit coordinates: prefer SC, fallback to label
                const unitX = (scX !== undefined && !isNaN(scX)) ? scX : labelX;
                const unitY = (scY !== undefined && !isNaN(scY)) ? scY : labelY;

                localProvinceData[canonicalAbbr] = {
                    name: fullNameFromCoords,
                    abbr: canonicalAbbr,
                    x: labelX, y: labelY, // Retain original x,y as labelX, labelY for clarity
                    unitX: unitX, unitY: unitY,
                    scX: (scX !== undefined && !isNaN(scX)) ? scX : undefined,
                    scY: (scY !== undefined && !isNaN(scY)) ? scY : undefined,
                    labelX: labelX, labelY: labelY
                };

                localNameToAbbr[fullNameFromCoords.toLowerCase()] = canonicalAbbr;
                localNameToAbbr[canonicalAbbr.toLowerCase()] = canonicalAbbr;

                if (trailingAliasField) {
                    const trailingAlias = trailingAliasField.trim();
                    if (trailingAlias && !localNameToAbbr[trailingAlias.toLowerCase()]) {
                        localNameToAbbr[trailingAlias.toLowerCase()] = canonicalAbbr;
                    }
                }
                const baseAbbr = canonicalAbbr.split('/')[0];
                if (baseAbbr !== canonicalAbbr && !localNameToAbbr[baseAbbr.toLowerCase()]) {
                     localNameToAbbr[baseAbbr.toLowerCase()] = baseAbbr;
                }
            } else {
                 console.warn(`[Map Parse Warn] Unrecognized line format in .info coordinate section of ${variantName} from ${usedInfoPath}: ${trimmedLine}`);
            }
        }
    }

    // Step 2: Parse map.<variant> (from gameDataDir) for additional aliases
    let mapVariantFilePath = path.join(gameDataDir, `map.${variantName}`);
    let usedMapVariantPath = '';
    let mapVariantFileContent;

    try {
        mapVariantFileContent = await fsPromises.readFile(mapVariantFilePath, 'utf-8');
        usedMapVariantPath = mapVariantFilePath;
    } catch (errorOriginal) {
        if (errorOriginal.code === 'ENOENT') {
            mapVariantFilePath = path.join(gameDataDir, `map.${lowerVariant}`);
            try {
                mapVariantFileContent = await fsPromises.readFile(mapVariantFilePath, 'utf-8');
                usedMapVariantPath = mapVariantFilePath;
            } catch (errorLower) {
                mapVariantFileContent = null;
            }
        } else {
            mapVariantFileContent = null;
        }
    }

    if (mapVariantFileContent) {
        const mapVariantLines = mapVariantFileContent.split(/\r?\n/);
        const aliasLineRegex = /^\s*([^,]+?)\s*,\s*[^.]*\.\s*(.*)$/;
        let inAliasSection = true;

        for (const line of mapVariantLines) {
            const trimmedLine = line.trim();
            if (!trimmedLine || trimmedLine.startsWith('#')) continue;
            if (trimmedLine === '-1') {
                inAliasSection = false;
                break;
            }
            if (inAliasSection) {
                const aliasMatch = trimmedLine.match(aliasLineRegex);
                if (aliasMatch) {
                    const fullNameFromAliasFile = aliasMatch[1].trim();
                    const aliasesStr = aliasMatch[2].trim();
                    const aliases = aliasesStr.split(/\s+/).filter(a => a);
                    const canonicalAbbrForFullName = localNameToAbbr[fullNameFromAliasFile.toLowerCase()];

                    if (canonicalAbbrForFullName) {
                        aliases.forEach(alias => {
                            const aliasLc = alias.toLowerCase();
                            if (!localNameToAbbr[aliasLc] ||
                                (localNameToAbbr[aliasLc].length < canonicalAbbrForFullName.length && !localNameToAbbr[aliasLc].includes('/')) ||
                                (localNameToAbbr[aliasLc] === aliasLc.toUpperCase() && aliasLc.toUpperCase() !== canonicalAbbrForFullName)
                                ) {
                                localNameToAbbr[aliasLc] = canonicalAbbrForFullName;
                            }
                        });
                    } else {
                        // console.warn(`[Map Parse Warn] Full name '${fullNameFromAliasFile}' from map.${variantName} (alias file) not found in canonical names derived from .info file. Aliases for it might be incomplete.`);
                    }
                }
            }
        }
    }

    if (Object.keys(localProvinceData).length === 0) {
        const errMsg = `No provinces parsed from coordinate section of ${usedInfoPath} for variant ${variantName}. Check .info file format and content.`;
        console.error(`[Map Parse Error] ${errMsg}`);
        throw new Error(errMsg);
    }

    provinceDataCache[lowerVariant] = localProvinceData;
    nameToAbbrCache[lowerVariant] = localNameToAbbr;
    console.log(`[Map Parse Success] Parsed and cached info for variant: ${variantName} (cached as ${lowerVariant}). Provinces: ${Object.keys(localProvinceData).length}. Name/Alias map: ${Object.keys(localNameToAbbr).length}.`);
    return {
        provinceLookup: localProvinceData,
        nameToAbbr: localNameToAbbr
    };
};


// --- Parsing Helper Functions ---
const parseListOutput = (gameName, output, nameToAbbr) => {
    // console.log(`[Parser LIST] Attempting to parse LIST output for ${gameName}`);
    const gameState = {
        name: gameName, status: 'Unknown', variant: 'Standard', options: [],
        currentPhase: 'Unknown', nextDeadline: null, players: [], masters: [],
        observers: [], settings: {}, rawListOutput: output,
        lastUpdated: Math.floor(Date.now() / 1000),
        units: [], supplyCenters: [] // Ensure these are initialized
    };
    const lines = output.split('\n');
    let currentSection = 'header';
    let currentPowerForUnits = null;
    let currentPowerForSCs = null;

    const explicitDeadlineRegex = /::\s*Deadline:\s*([SFUW]\d{4}[MRBAX]?)\s+(.*)/i;
    const activeStatusLineRegex = /Status of the (\w+) phase for (Spring|Summer|Fall|Winter) of (\d{4})\./i;
    const variantRegex = /Variant:\s*(\S+)\s*(.*)/i;
    const playerLineRegex = /^\s*([a-zA-Z]+)\s+\S+\s+\S+\s+\S+\s+([\w.-]+@[\w.-]+\.\w+).*$/i;
    const masterLineRegex = /^\s*(?:Master|Moderator)\s+\d+\s+([\w.-]+@[\w.-]+\.\w+).*$/i;
    const observerLineRegex = /^\s*Observer\s*:\s*([\w.-]+@[\w.-]+\.\w+).*$/i;
    const statusRegex = /Game status:\s*(.*)/i;
    const settingsHeaderRegex = /The parameters for .*? are as follows:|Game settings:|flags:/i; // Added "flags:"
    const pressSettingRegex = /Press:\s*(.*?)(?:,|\s*$)/i;
    const diasSettingRegex = /\b(NoDIAS|DIAS)\b/i;
    const nmrSettingRegex = /\b(NMR|NoNMR)\b/i;
    const concessionSettingRegex = /\b(Concessions|No Concessions)\b/i;
    const emailRegex = /[\w.-]+@[\w.-]+\.\w+/;
    // Updated unitHeaderRegex and unitLineRegex to include G and W
    const unitHeaderRegex = /^\s*(Austria|England|France|Germany|Italy|Russia|Turkey|Milan|Florence|Naples|Papacy|Venice|Autonomous):\s*$/i;
    const unitLineRegex = /^\s+(A|F|W|G|R)\s+([A-Z]{3}(?:\/[NESW]C)?)\s*(?:\(([^)]+)\))?/i; // Added G, W, R
    const scHeaderRegex = /^\s*(Austria|England|France|Germany|Italy|Russia|Turkey|Milan|Florence|Naples|Papacy|Venice|Autonomous)\s+\(\d+\):\s*$/i;
    const directUnitLineRegex = /^\s*(Austria|England|France|Germany|Italy|Russia|Turkey|Milan|Florence|Naples|Papacy|Venice|Autonomous):\s+(Army|Fleet|Garrison|Wing|Artillery)\s+(.+)\.\s*$/i;
    const citiesControlledHeaderRegex = /^Cities Controlled:/i;
    const playerListHeader = "The following players are signed up for game";
    const flagsLineRegex = /^flags:\s*(.*)/i; // For Machiavelli flags

    lines.forEach(line => {
        const trimmedLine = line.trim();
        let match;

        if (trimmedLine.startsWith(playerListHeader)) { currentSection = 'players'; return; }
        if (settingsHeaderRegex.test(trimmedLine)) { currentSection = 'settings'; } // Don't return, process flags line
        match = trimmedLine.match(unitHeaderRegex); if (match) { currentSection = 'units'; currentPowerForUnits = match[1]; return; }
        match = trimmedLine.match(scHeaderRegex); if (match) { currentSection = 'scs'; currentPowerForSCs = match[1]; return; }
        if (citiesControlledHeaderRegex.test(trimmedLine)) { currentSection = 'cities_controlled'; return; }
        if (!trimmedLine) { if (currentSection === 'units') currentPowerForUnits = null; if (currentSection === 'scs') currentPowerForSCs = null; }

        match = trimmedLine.match(directUnitLineRegex);
        if (match) {
            const power = match[1]; const unitTypeFull = match[2];
            let unitTypeChar = unitTypeFull.charAt(0).toUpperCase();
            if (unitTypeFull.toUpperCase() === 'ARTILLERY') unitTypeChar = 'R';
            else if (unitTypeFull.toUpperCase() === 'GARRISON') unitTypeChar = 'G';
            else if (unitTypeFull.toUpperCase() === 'WING') unitTypeChar = 'W';


            const locationName = match[3].trim();
            let locationAbbr = locationName.toUpperCase().substring(0,3); // Default fallback
            if (nameToAbbr) {
                const resolvedAbbr = nameToAbbr[locationName.toLowerCase()];
                if (resolvedAbbr) {
                    locationAbbr = resolvedAbbr;
                } else {
                    console.warn(`[Parser LIST ${gameName}] Direct Unit: Could not find abbr for location '${locationName}' (using '${locationAbbr}' as fallback) for power ${power}`);
                }
            }

            gameState.units.push({ power: power, type: unitTypeChar, location: locationAbbr, status: null });
            const player = gameState.players.find(p => p.power === power);
            if (player) { if (!player.units) player.units = []; player.units.push({ type: unitTypeChar, location: locationAbbr, status: null }); }
            return;
        }

        switch (currentSection) {
            case 'header': case 'unknown':
                match = line.match(explicitDeadlineRegex); if (match) { gameState.currentPhase = match[1].trim().toUpperCase(); gameState.nextDeadline = match[2].trim(); if (gameState.status === 'Unknown' || gameState.status === 'Forming') gameState.status = 'Active'; break; }
                match = line.match(activeStatusLineRegex); if (match) { const [, phaseTypeStr, seasonStr, year] = match; let seasonCode = 'S'; if (seasonStr.toLowerCase() === 'fall') seasonCode = 'F'; else if (seasonStr.toLowerCase() === 'winter') seasonCode = 'W'; else if (seasonStr.toLowerCase() === 'summer') seasonCode = 'U'; let phaseCode = 'M'; if (phaseTypeStr.toLowerCase() === 'retreat') phaseCode = 'R'; else if (phaseTypeStr.toLowerCase() === 'adjustment' || phaseTypeStr.toLowerCase() === 'builds') phaseCode = 'A'; gameState.currentPhase = `${seasonCode}${year}${phaseCode}`; gameState.status = 'Active'; break; }
                match = line.match(statusRegex); if (match) { const explicitStatus = match[1].trim(); if (explicitStatus !== 'Active' || gameState.status === 'Unknown') gameState.status = explicitStatus; break; }
                match = line.match(variantRegex); if (match) { gameState.variant = match[1].trim(); const optionsStr = match[2].replace(/,/g, ' ').trim(); gameState.options = optionsStr.split(/\s+/).filter(opt => opt && opt !== 'Variant:'); if (gameState.options.includes('Gunboat')) gameState.settings.gunboat = true; if (gameState.options.includes('NMR')) gameState.settings.nmr = true; else gameState.settings.nmr = false; if (gameState.options.includes('Chaos')) gameState.settings.chaos = true; if (gameState.variant.toLowerCase().includes('machiavelli')) gameState.settings.isMachiavelli = true; break; }
                break;
            case 'players':
                const playerMatch = line.match(playerLineRegex); const masterMatch = line.match(masterLineRegex); const observerMatch = line.match(observerLineRegex);
                if (playerMatch) { const power = playerMatch[1]; const email = playerMatch[2]; let playerStatus = 'Playing'; const statusMatch = line.match(/\(([^)]+)\)/); if (statusMatch) playerStatus = statusMatch[1]; gameState.players.push({ power: power, email: email || null, status: playerStatus, name: null, units: [], supplyCenters: [] }); }
                else if (masterMatch) { const email = masterMatch[1]; if (email && !gameState.masters.includes(email)) gameState.masters.push(email); }
                else if (observerMatch) { const email = observerMatch[1].trim().match(emailRegex)?.[0]; if (email && !gameState.observers.includes(email)) gameState.observers.push(email); }
                break;
            case 'settings':
                match = line.match(pressSettingRegex); if (match) gameState.settings.press = match[1].trim();
                match = line.match(diasSettingRegex); if (match) gameState.settings.dias = (match[1].toUpperCase() === 'DIAS');
                match = line.match(nmrSettingRegex); if (match) gameState.settings.nmr = (match[1].toUpperCase() === 'NMR');
                match = line.match(concessionSettingRegex); if (match) gameState.settings.concessions = (match[1].toLowerCase() === 'concessions');
                if (line.toLowerCase().includes('gunboat')) gameState.settings.gunboat = true; if (line.toLowerCase().includes('chaos')) gameState.settings.chaos = true;
                if (line.toLowerCase().includes('partial allowed')) gameState.settings.partialPress = true; if (line.toLowerCase().includes('no partial')) gameState.settings.partialPress = false;
                if (line.toLowerCase().includes('observer any')) gameState.settings.observerPress = 'any'; if (line.toLowerCase().includes('observer white')) gameState.settings.observerPress = 'white'; if (line.toLowerCase().includes('observer none')) gameState.settings.observerPress = 'none';
                if (line.toLowerCase().includes('strict convoy')) gameState.settings.strictConvoy = true; if (line.toLowerCase().includes('strict wait')) gameState.settings.strictWait = true; if (line.toLowerCase().includes('strict grace')) gameState.settings.strictGrace = true;

                // Parse Machiavelli flags
                const flagsMatch = trimmedLine.match(flagsLineRegex);
                if (flagsMatch) {
                    const flagsStringInput = flagsMatch[1];
                    let processedFlagsString = flagsStringInput;
                    const settings = gameState.settings; // Shortcut for brevity

                    // Handle multi-word "coastal convoys" variants first and remove them from the string.
                    // Regexes are case-insensitive and global (for replace all, though one occurrence is typical).
                    const noCoastalConvoysRegex = /\bnocoastal convoys\b/gi;
                    const coastalConvoysRegex = /\bcoastal convoys\b/gi;

                    if (noCoastalConvoysRegex.test(processedFlagsString)) {
                        settings.coastalConvoys = false;
                        processedFlagsString = processedFlagsString.replace(noCoastalConvoysRegex, '');
                    } else if (coastalConvoysRegex.test(processedFlagsString)) {
                        settings.coastalConvoys = true;
                        processedFlagsString = processedFlagsString.replace(coastalConvoysRegex, '');
                    }

                    // Trim whitespace that might be left after replacement, then split remaining flags.
                    // Filter out any empty strings resulting from multiple spaces or trailing spaces.
                    const flagsArray = processedFlagsString.trim().split(/\s+/).filter(f => f.length > 0);

                    flagsArray.forEach(originalFlag => {
                        let flag = originalFlag; // Use a mutable variable for the potentially normalized flag name
                        const lowerFlag = flag.toLowerCase();

                        // Normalize aliases to their canonical names or 'noCanonical' forms
                        // This allows the generic logic below to work with canonical names.
                        if (lowerFlag === 'bank' || lowerFlag === 'bankers') {
                            flag = 'loans'; // Positive alias
                        } else if (lowerFlag === 'nobank' || lowerFlag === 'nobankers') {
                            flag = 'noloans'; // Negative alias
                        } else if (lowerFlag === 'forts') {
                            flag = 'fortresses'; // Positive alias
                        } else if (lowerFlag === 'noforts') {
                            flag = 'nofortresses'; // Negative alias
                        } else if (lowerFlag === 'nocoastalconvoy') { // Single-word negative variant for coastal convoys
                            flag = 'nocoastalConvoys'; // Normalize to a form that startsWith('no') can process to 'coastalConvoys'
                        }
                        // Add normalization for a positive 'coastalconvoy' if it were a possibility:
                        // else if (lowerFlag === 'coastalconvoy') { flag = 'coastalConvoys'; }


                        if (flag.startsWith('no')) {
                            // Extracts the base flag name, e.g., "nomoney" -> "money", "noloans" -> "loans", "nocoastalConvoys" -> "coastalConvoys"
                            const baseFlag = flag.substring(2);
                            settings[baseFlag] = false;
                        } else if (flag.includes(':')) {
                            const [key, ...values] = flag.split(':');
                            // Ensure 'transform' key check is case-insensitive and initialize object if needed.
                            if (key.toLowerCase() === 'transform') {
                                settings.transform = settings.transform || {}; // Initialize if multiple transform parts or not yet existing
                                values.join(':').split(',').forEach(tvPair => {
                                    const [transformAction, transformValue] = tvPair.split(':');
                                    if (transformAction && transformValue) {
                                        settings.transform[transformAction.toLowerCase()] = transformValue;
                                    } else if (transformAction) { // Handles cases like "SET TRANSFORM MOVE" which implies a default value
                                        settings.transform[transformAction.toLowerCase()] = 'HOMECENTRE'; // Default for simple transform actions
                                    }
                                });
                            } else {
                                // For other colon-separated flags, store as key-value string.
                                settings[key] = values.join(':');
                            }
                        } else {
                            // For simple positive flags (either original or normalized aliases like 'loans' from 'bank').
                            settings[flag] = true;
                        }
                    });
                    if (gameState.settings.mach2 === undefined && (gameState.variant?.toLowerCase().includes('machiavelli') || gameState.settings.isMachiavelli)) {
                         // If it's a Machiavelli game and mach2 flag isn't explicitly set, assume Mach1 (mach2=false)
                         if (gameState.settings.mach2 !== false) gameState.settings.mach2 = false;
                    }
                }
                break;
            case 'units':
                if (!currentPowerForUnits) break;
                match = line.match(unitLineRegex);
                if (match) {
                    const unitType = match[1].toUpperCase();
                    const locationAbbrFromList = match[2].toUpperCase();
                    const unitStatus = match[3] ? match[3].trim() : null;
                    gameState.units.push({ power: currentPowerForUnits, type: unitType, location: locationAbbrFromList, status: unitStatus });
                    const player = gameState.players.find(p => p.power === currentPowerForUnits);
                    if (player) player.units.push({ type: unitType, location: locationAbbrFromList, status: unitStatus });
                } else if (trimmedLine && !trimmedLine.startsWith('-')) { currentPowerForUnits = null; currentSection = 'unknown'; }
                break;
            case 'cities_controlled':
                const cityLineRegex = /^\s*(Austria|England|France|Germany|Italy|Russia|Turkey|Milan|Florence|Naples|Papacy|Venice|Autonomous):\s+(.*)\.?\s*$/i;
                match = trimmedLine.match(cityLineRegex);
                if (match) {
                    const power = match[1]; const citiesStr = match[2];
                    const cityEntries = citiesStr.split(',');
                    cityEntries.forEach(entry => {
                        const nameMatch = entry.trim().match(/^([^(*]+)/);
                        if (nameMatch) {
                            const cityName = nameMatch[1].trim();
                            let provinceAbbr = cityName.toUpperCase().substring(0,3); // Default fallback
                            if (nameToAbbr) {
                                const resolvedAbbr = nameToAbbr[cityName.toLowerCase()];
                                if (resolvedAbbr) {
                                    provinceAbbr = resolvedAbbr;
                                } else {
                                    console.warn(`[Parser LIST ${gameName}] SC: Could not find abbr for SC name '${cityName}' for power ${power} (using '${provinceAbbr}' as fallback). Original entry: '${entry.trim()}'`);
                                }
                            }
                            gameState.supplyCenters.push({ owner: power, location: provinceAbbr });
                            const playerForSc = gameState.players.find(p => p.power === power);
                            if (playerForSc) {
                                 if (!playerForSc.supplyCenters) playerForSc.supplyCenters = [];
                                 if (!playerForSc.supplyCenters.includes(provinceAbbr)) playerForSc.supplyCenters.push(provinceAbbr);
                            }
                        } else {
                            console.warn(`[Parser LIST ${gameName}] Could not parse SC entry '${entry.trim()}' for power ${power}.`);
                        }
                    });
                } else if (trimmedLine === 'Unowned:') { /* Ignore */ }
                else if (trimmedLine && !trimmedLine.startsWith(' ') && !trimmedLine.startsWith('Unowned:') && !trimmedLine.startsWith('*')) {
                    currentSection = 'unknown';
                }
                break;
            case 'scs':
                if (!currentPowerForSCs) break;
                const scLineRegex = /^\s+([A-Z]{3}(?:\/[NESW]C)?)\s*/i;
                match = line.match(scLineRegex);
                if (match) {
                    const locationAbbrFromList = match[1].toUpperCase();
                    gameState.supplyCenters.push({ owner: currentPowerForSCs, location: locationAbbrFromList });
                    const player = gameState.players.find(p => p.power === currentPowerForSCs);
                    if (player) { if (!player.supplyCenters) player.supplyCenters = []; if (!player.supplyCenters.includes(locationAbbrFromList)) player.supplyCenters.push(locationAbbrFromList); }
                } else if (trimmedLine && !trimmedLine.startsWith('-')) { currentPowerForSCs = null; currentSection = 'unknown'; }
                break;
        }
    });

    if (gameState.status === 'Unknown' && gameState.currentPhase && gameState.currentPhase !== 'Unknown') {
        if (gameState.currentPhase.toUpperCase() === 'FORMING') gameState.status = 'Forming';
        else gameState.status = 'Active';
    }
    // Default settings if not found in flags
    if (gameState.settings.nmr === undefined) gameState.settings.nmr = false;
    if (gameState.settings.dias === undefined) gameState.settings.dias = true;
    if (gameState.settings.concessions === undefined) gameState.settings.concessions = true;
    if (gameState.settings.gunboat === undefined) gameState.settings.gunboat = false;
    if (gameState.settings.press === undefined) gameState.settings.press = 'White';
    if (gameState.settings.partialPress === undefined) gameState.settings.partialPress = true;
    if (gameState.settings.observerPress === undefined) gameState.settings.observerPress = 'any';
    if (gameState.variant?.toLowerCase().includes('machiavelli') && gameState.settings.isMachiavelli === undefined) {
        gameState.settings.isMachiavelli = true;
    }
    if (gameState.settings.isMachiavelli && gameState.settings.mach2 === undefined) {
        gameState.settings.mach2 = false; // Default to Mach1 if Machiavelli variant
    }


    return gameState;
};

// --- Command Recommendation Logic ---
const getRecommendedCommands = (gameState, userEmail) => {
    // console.log(`[getRecommendedCommands] Generating for user: ${userEmail}, Game State:`, gameState ? { name: gameState.name, status: gameState.status, phase: gameState.currentPhase, masters: gameState.masters, settings: gameState.settings } : null);

    const recommendations = { recommended: [], playerActions: [], settings: [], gameInfo: [], master: [], general: [], machiavelli: [] };
    const generalCmds = ['GET', 'HELP', 'VERSION', 'WHOIS', 'LIST', 'HISTORY', 'SUMMARY', 'WHOGAME', 'MAP', 'GET DEDICATION', 'INFO PLAYER', 'MANUAL'];
    const playerAccountCmds = ['REGISTER', 'I AM ALSO', 'SET PASSWORD', 'SET ADDRESS'];
    const joiningCmds = ['CREATE ?', 'SIGN ON ?', 'SIGN ON ?game', 'SIGN ON power', 'OBSERVE', 'WATCH'];
    const playerActionCmds = ['ORDERS', 'PRESS', 'BROADCAST', 'POSTAL PRESS', 'DIARY', 'RESIGN', 'WITHDRAW'];
    const playerSettingCmds = [
        'SET WAIT', 'SET NOWAIT', 'SET ABSENCE', 'SET NOABSENCE', 'SET HOLIDAY', 'SET VACATION',
        'SET DRAW', 'SET NODRAW', 'SET CONCEDE', 'SET NOCONCEDE', 'SET PREFERENCE', 'PHASE', 'IF', 'CLEAR'
    ];
    const masterCmds = [
        'BECOME MASTER', 'SET MODERATE', 'SET UNMODERATE', 'BECOME', 'EJECT', 'FORCE BEGIN', 'PAUSE', 'PREDICT',
        'PROMOTE', 'PROCESS', 'ROLLBACK', 'TERMINATE', 'RESUME', 'UNSTART', 'SET',
        'SET DEADLINE', 'SET GRACE', 'SET START', 'SET COMMENT', 'SET COMMENT BEGIN', 'SET CD', 'SET NMR',
        'SET CONCESSIONS', 'SET DIAS', 'SET LIST', 'SET PUBLIC', 'SET PRIVATE', 'SET AUTO PROCESS', 'SET MANUAL PROCESS',
        'SET AUTO START', 'SET MANUAL START', 'SET RATED', 'SET UNRATED', 'SET MAX ABSENCE', 'SET LATE COUNT',
        'SET STRICT GRACE', 'SET STRICT WAIT', 'SET MOVE', 'SET RETREAT', 'SET ADJUST', 'SET ALL PRESS', 'SET NORMAL PRESS',
        'SET QUIET', 'SET NO QUIET', 'SET WATCH ALL PRESS', 'SET NO WATCH ALL PRESS', 'SET ACCESS', 'SET ALLOW PLAYER',
        'SET DENY PLAYER', 'SET LEVEL', 'SET DEDICATION', 'SET ONTIMERAT', 'SET RESRAT', 'SET APPROVAL', 'SET APPROVE',
        'SET NOT APPROVE', 'SET BLANK PRESS', 'SET BROADCAST', 'SET NORMAL BROADCAST', 'SET NO FAKE', 'SET GREY',
        'SET NO WHITE', 'SET GREY/WHITE', 'SET LATE PRESS', 'SET MINOR PRESS', 'SET MUST ORDER', 'SET NO PRESS',
        'SET NONE', 'SET OBSERVER', 'SET PARTIAL', 'SET PARTIAL FAKES BROADCAST', 'SET PARTIAL MAY', 'SET POSTAL PRESS',
        'SET WHITE', 'SET WHITE/GREY', 'SET VARIANT', 'SET NOT VARIANT',
        // Machiavelli specific SET commands (for master)
        'SET MACH2', 'SET SUMMER', 'SET MONEY', 'SET DICE', 'SET LOANS', 'SET BANK', 'SET BANKERS',
        'SET FAMINE', 'SET PLAGUE', 'SET STORM', 'SET ASSASSINS', 'SET ASSASSINATION', 'SET GARRISONS',
        'SET SPECIAL', 'SET FORTRESSES', 'SET FORTS', 'SET ADJACENCY', 'SET ADJACENT',
        'SET COASTAL CONVOYS', 'SET DISBAND', 'SET TRANSFORM', 'SET ATTACKTRANSFORM'
    ];
    const machiavelliPlayerCmds = ['BORROW', 'GIVE', 'PAY', 'ALLY', 'EXPENSE'];


    recommendations.general = [...generalCmds, ...playerAccountCmds];
    recommendations.gameInfo = [...joiningCmds];
    recommendations.playerActions = [...playerActionCmds];
    recommendations.settings = [...playerSettingCmds];
    recommendations.master = [...masterCmds];
    recommendations.machiavelli = []; // Will be populated based on game settings

    if (!gameState || !userEmail) {
        recommendations.recommended = ['SIGN ON ?', 'SIGN ON ?game', 'SIGN ON power', 'OBSERVE', 'LIST', 'CREATE ?'];
    } else {
        const userIsMaster = Array.isArray(gameState.masters) && gameState.masters.includes(userEmail);
        const myPlayerInfo = Array.isArray(gameState.players) ? gameState.players.find(p => p.email === userEmail) : null;
        const userIsPlayer = !!myPlayerInfo;
        const userIsObserver = Array.isArray(gameState.observers) && gameState.observers.includes(userEmail) && !userIsPlayer && !userIsMaster;
        const phase = gameState.currentPhase?.toUpperCase() || 'UNKNOWN';
        const status = gameState.status?.toUpperCase() || 'UNKNOWN';
        const playerStatus = myPlayerInfo?.status?.toUpperCase() || 'UNKNOWN';
        const isActivePlayer = userIsPlayer && !['CD', 'RESIGNED', 'ABANDONED', 'ELIMINATED'].includes(playerStatus);

        // Machiavelli specific recommendations
        if (gameState.settings?.isMachiavelli || gameState.variant?.toLowerCase().includes('machiavelli')) {
            if (gameState.settings?.money) { // Check if money is enabled
                recommendations.machiavelli.push(...machiavelliPlayerCmds);
            }
            // Add other Machiavelli commands to playerActions or settings if they fit better
            // e.g., 'MAINTAIN' could be part of 'ORDERS' during adjustment.
            // 'CONVERT', 'BESIEGE', 'LIFT SIEGE' are also part of 'ORDERS'.
        }


        if (status === 'FORMING') {
            if (userIsPlayer) recommendations.recommended.push('SET PREFERENCE');
            else if (!userIsMaster && !userIsObserver) recommendations.recommended.push('SIGN ON ?game');
            if (userIsMaster) recommendations.recommended.push('FORCE BEGIN', 'SET');
            recommendations.recommended.push('LIST', 'WHOGAME');
        } else if (status === 'ACTIVE') {
            if (isActivePlayer) {
                if (phase.endsWith('M') || phase.endsWith('R') || phase.endsWith('B') || phase.endsWith('A')) recommendations.recommended.push('ORDERS');
                if (gameState.settings?.press !== 'None') recommendations.recommended.push('PRESS', 'BROADCAST');
                if (gameState.settings?.wait !== false) recommendations.recommended.push('SET WAIT'); // Standard
                if (gameState.settings?.dias !== false || gameState.settings?.dias === undefined) recommendations.recommended.push('SET DRAW');
                if (gameState.settings?.concessions !== false) recommendations.recommended.push('SET CONCEDE');
                recommendations.recommended.push('DIARY');

                // Add Machiavelli active phase commands to recommended
                if (recommendations.machiavelli.length > 0) {
                    recommendations.recommended.push(...recommendations.machiavelli.filter(cmd => ['BORROW', 'GIVE', 'PAY', 'ALLY', 'EXPENSE'].includes(cmd)));
                }

            } else if (userIsObserver && gameState.settings?.observerPress !== 'none' && gameState.settings?.press !== 'None') {
                 recommendations.recommended.push('PRESS', 'BROADCAST');
            } else if (!userIsPlayer && !userIsMaster && !userIsObserver) {
                 recommendations.recommended.push('SIGN ON power', 'OBSERVE');
            }
            if (userIsMaster) recommendations.recommended.push('PROCESS', 'SET DEADLINE', 'PAUSE', 'EJECT', 'BECOME');
            recommendations.recommended.push('LIST', 'HISTORY', 'SUMMARY', 'WHOGAME');
        } else if (status === 'PAUSED') {
             if (userIsMaster) recommendations.recommended.push('RESUME', 'TERMINATE');
             if (gameState.settings?.press !== 'None' && (isActivePlayer || (userIsObserver && gameState.settings?.observerPress !== 'none'))) {
                 recommendations.recommended.push('PRESS', 'BROADCAST');
             }
             recommendations.recommended.push('LIST', 'HISTORY', 'SUMMARY', 'WHOGAME');
        } else if (status === 'FINISHED' || status === 'TERMINATED') {
             recommendations.recommended = ['HISTORY', 'SUMMARY', 'LIST'];
             if (userIsMaster) recommendations.recommended.push('ROLLBACK', 'UNSTART');
        } else {
             recommendations.recommended = ['LIST', 'HISTORY', 'SUMMARY', 'WHOGAME'];
             if (!userIsPlayer && !userIsMaster && !userIsObserver) recommendations.recommended.push('SIGN ON power', 'OBSERVE');
        }
        if (userIsPlayer || userIsMaster || userIsObserver) recommendations.gameInfo = recommendations.gameInfo.filter(cmd => !joiningCmds.includes(cmd));
        recommendations.gameInfo.push('LIST', 'HISTORY', 'SUMMARY', 'WHOGAME');
        if (!userIsMaster) recommendations.master = [];
        if (!userIsPlayer && !userIsObserver && !userIsMaster) { recommendations.playerActions = []; recommendations.settings = []; recommendations.machiavelli = []; }
        else if (userIsObserver && !userIsMaster) { recommendations.playerActions = recommendations.playerActions.filter(cmd => ['RESIGN', 'WITHDRAW', 'PRESS', 'BROADCAST'].includes(cmd)); recommendations.settings = []; recommendations.machiavelli = []; }
    }
    if (!new Set([...recommendations.recommended, ...recommendations.playerActions, ...recommendations.settings, ...recommendations.gameInfo, ...recommendations.master, ...recommendations.general, ...recommendations.machiavelli]).has('MANUAL')) {
        recommendations.general.push('MANUAL');
    }
    const uniqueCommands = new Set();
    const filterUniqueAndSort = (arr) => arr.filter(cmd => { if (uniqueCommands.has(cmd) || cmd === 'REGISTER' || cmd === 'SIGN OFF') return false; uniqueCommands.add(cmd); return true; }).sort();
    const finalRecommendations = {};
    for (const key in recommendations) finalRecommendations[key] = filterUniqueAndSort(recommendations[key]);
    // console.log(`[getRecommendedCommands] Final Recommendations:`, finalRecommendations);
    return finalRecommendations;
};

// --- Dip Execution Function ---
const executeDipCommand = (email, command, targetGame = null, targetPassword = null, targetVariant = null) => {
    return new Promise(async (resolve, reject) => {
        const now = new Date();
        let fullCommand = command.trim();
        const commandParts = fullCommand.split(/\s+/);
        const commandVerb = commandParts[0].toUpperCase();
        const noContextCommands = [
            'REGISTER', 'WHOIS', 'INFO', 'GET', 'VERSION', 'HELP', 'LIST',
            'CREATE', 'SET PASSWORD', 'SET ADDRESS', 'MANUAL',
            'I AM ALSO', 'GET DEDICATION', 'INFO PLAYER', 'SEND', 'MAP'
        ];
        const gameNameOptionalCommands = ['LIST', 'HISTORY', 'SUMMARY', 'WHOGAME', 'OBSERVE', 'WATCH'];
        let requiresSignOn = false;

        if (commandVerb === 'SIGN' && command.toUpperCase().includes(' ON ')) {
            requiresSignOn = false;
        } else if (noContextCommands.includes(commandVerb)) {
            requiresSignOn = false;
        } else if (gameNameOptionalCommands.includes(commandVerb) && commandParts.length > 1) {
            const potentialGameName = commandParts[1];
            const keywords = ['FULL', 'FROM', 'TO', 'LINES', 'EXCLSTART', 'EXCLEND', 'BROAD'];
            if (/^[a-zA-Z0-9]{1,8}$/.test(potentialGameName) && !keywords.includes(potentialGameName.toUpperCase())) {
                 requiresSignOn = false;
                 if (targetGame && targetGame !== potentialGameName) targetGame = potentialGameName;
                 else if (!targetGame) targetGame = potentialGameName;
            } else {
                 requiresSignOn = !!targetGame;
            }
        } else {
            requiresSignOn = !!targetGame;
        }
        
        let signOnPrefix = null;
        if (requiresSignOn) {
            if (!targetGame || !targetPassword) return reject({ success: false, output: `Error: Command "${commandVerb}" requires a target game and password.` });

            let determinedUserPowerInitial = null;
            let gameStateForSignOn = null;

            // Attempt to get game state and player's power initial first
            try {
                gameStateForSignOn = await getGameState(targetGame);
                if (gameStateForSignOn) {
                    const myPlayerInfo = gameStateForSignOn.players?.find(p => p.email === email);
                    if (myPlayerInfo && myPlayerInfo.power) {
                        determinedUserPowerInitial = myPlayerInfo.power.charAt(0).toUpperCase();
                    }
                }
            } catch (dbErr) {
                console.error(`[Execute SignOn] DB error fetching gameState for ${targetGame} to determine power initial: ${dbErr.message}. Proceeding with fallback logic.`);
                // Do not reject here; allow fallback to '?', Master, or Observer roles.
            }

            const variant = targetVariant; // from req.body

            if (determinedUserPowerInitial) {
                // Player's power initial is found; use it. This is prioritized for in-game actions.
                signOnPrefix = `SIGN ON ${determinedUserPowerInitial}${targetGame} ${targetPassword}`;
            } else {
                // No specific player power initial found.
                // This could be because the user is not a player, not in this game,
                // the game state couldn't be fetched, or the player has no power assigned yet.
                if (variant && variant.trim() !== '') {
                    // A variant is specified, typically for creating a new game or an explicit join attempt with variant.
                    signOnPrefix = `SIGN ON ?${targetGame} ${targetPassword} ${variant.trim()}`;
                } else if (gameStateForSignOn) {
                    // No variant specified, but game state was fetched.
                    // Check for Master or Observer roles since player power wasn't found.
                    const userIsMaster = gameStateForSignOn.masters?.includes(email);
                    const isRegisteredObserver = gameStateForSignOn.observers?.includes(email);
                    const myPlayerInfo = gameStateForSignOn.players?.find(p => p.email === email); // Re-check for context
                    const isPlayerContext = !!myPlayerInfo; // True if user is listed as a player, even if power was missing

                    if (userIsMaster) {
                        signOnPrefix = `SIGN ON M${targetGame} ${targetPassword}`;
                    } else if (isRegisteredObserver && !isPlayerContext && !userIsMaster) {
                        // User is an observer, not currently a player in context, and not a master.
                        signOnPrefix = `SIGN ON O${targetGame} ${targetPassword}`;
                    } else {
                        // Game exists, but user is not a player with power, not master, not clearly an observer.
                        // Default to '?' for joining or if role is ambiguous.
                        signOnPrefix = `SIGN ON ?${targetGame} ${targetPassword}`;
                    }
                } else {
                    // No determined player power, no variant, and no game state (game likely new or unlisted).
                    // This is a clear case for '?' (e.g., initial SIGN ON to a game not yet in DB).
                    signOnPrefix = `SIGN ON ?${targetGame} ${targetPassword}`;
                }
            }
            if (signOnPrefix) fullCommand = `${signOnPrefix}\n${fullCommand}`;
        }
        if (!fullCommand.toUpperCase().endsWith('SIGN OFF')) fullCommand += '\nSIGN OFF';
        const dipInput = `FROM: ${email}\nTO: ${judgeEmail}\nSubject: njudge-web via ${email}\nDate: ${now.toUTCString()}\n\n${fullCommand}\n`;
        // console.log(`[Execute] User ${email} executing: Command=${dipBinaryPath}, Args=${[...dipBinaryArgs].join(' ')}, Input=${dipInput.substring(0, 200).replace(/\n/g, '\\n')}...`);
        let stdoutData = ''; let stderrData = ''; let processError = null;
        const dipProcess = spawn(dipBinaryPath, dipBinaryArgs, { timeout: 30000, cwd: dipBinaryRootPath });
        dipProcess.stdout.on('data', (data) => { stdoutData += data.toString(); });
        dipProcess.stderr.on('data', (data) => { stderrData += data.toString(); console.error(`Stderr chunk for ${email} (${commandVerb}): ${data}`); });
        dipProcess.on('error', (err) => { console.error(`[Execute Error] Spawn Error for ${email}: ${err.message}`); processError = err; if (!dipProcess.killed) dipProcess.kill(); });
        dipProcess.on('close', (code, signal) => {
            // console.log(`[Execute] Dip process for ${email} closed with code ${code}, signal ${signal}`);
            const output = `--- stdout ---\n${stdoutData}\n--- stderr ---\n${stderrData}`;
            const executionSuccess = code === 0 && signal === null;
            if (processError) return reject({ success: false, output: `Spawn failed: ${processError.message}\n\n${output}` });
            if (!executionSuccess) {
                 let errorMsg = `Execution failed: Exit code ${code}, Signal ${signal}`;
                 if (stderrData.includes('command not found') || stderrData.includes('No such file')) errorMsg += `\n\nPossible cause: dip binary path incorrect or binary not executable.`;
                 else if (stderrData.includes('timeout')) errorMsg += `\n\nPossible cause: Command took too long to execute.`;
                 errorMsg += `\n\n${output}`;
                 return reject({ success: false, output: errorMsg });
            }
            resolve({ success: true, output: output, stdout: stdoutData, stderr: stderrData });
        });
        try { dipProcess.stdin.write(dipInput); dipProcess.stdin.end(); }
        catch (stdinError) { if (!dipProcess.killed) dipProcess.kill(); reject({ success: false, output: `Error communicating with adjudicator process: ${stdinError.message}` }); }
    });
};

// --- PNG Generation Function (using Ghostscript) ---
async function generateMapPng(postscriptContent, outputPngPath) {
    return new Promise((resolve, reject) => {
        const gsArgs = [
            '-dNOPAUSE', '-dBATCH', '-sDEVICE=png16m', '-r150',
            '-dTextAlphaBits=4', '-dGraphicsAlphaBits=4',
            `-sOutputFile=${outputPngPath}`, '-'
        ];
        // console.log(`[generateMapPng] Running ${ghostscriptPath} with args: ${gsArgs.slice(0, -1).join(' ')} -sOutputFile=${outputPngPath} -`);
        const gsProcess = spawn(ghostscriptPath, gsArgs);
        let stdoutData = ''; let stderrData = ''; let processError = null;
        gsProcess.stdout.on('data', (data) => { stdoutData += data.toString(); });
        gsProcess.stderr.on('data', (data) => { stderrData += data.toString(); });
        gsProcess.on('error', (err) => {
            console.error(`[generateMapPng] Spawn Error: ${err.message}`);
            processError = (err.code === 'ENOENT') ? new Error(`Ghostscript command ('${ghostscriptPath}') not found.`) : err;
            if (!gsProcess.killed) gsProcess.kill();
        });
        gsProcess.on('close', (code, signal) => {
            // console.log(`[generateMapPng] Ghostscript process closed with code ${code}, signal ${signal}`);
            if (processError) return reject(new Error(`Ghostscript spawn failed: ${processError.message}\nStderr: ${stderrData}`));
            if (code !== 0) {
                 console.error(`[generateMapPng] Ghostscript failed: Exit code ${code}, Signal ${signal}\nStderr:\n${stderrData}\nStdout:\n${stdoutData}`);
                return reject(new Error(`Ghostscript execution failed with code ${code}.\nStderr: ${stderrData}`));
            }
            fs.access(outputPngPath, fs.constants.F_OK, (errAccess) => {
                if (errAccess) return reject(new Error(`Ghostscript finished successfully but output file ${outputPngPath} was not created.`));
                // console.log(`[generateMapPng] Successfully generated ${outputPngPath}`);
                resolve();
            });
        });
        try { gsProcess.stdin.write(postscriptContent); gsProcess.stdin.end(); }
        catch (stdinError) { if (!gsProcess.killed) gsProcess.kill(); reject(new Error(`Error communicating with Ghostscript process: ${stdinError.message}`)); }
    });
}

// --- Map Data API Endpoint ---
async function getMapData(gameName, phase) {
    console.log(`[getMapData PNG] Entering with gameName: ${gameName}, phase: ${phase}`);
    try {
        const basicGameState = await getGameState(gameName);
        if (!basicGameState) {
            console.error(`[getMapData PNG Error] Game not found in DB: ${gameName}`);
            return null;
        }
        const variantName = basicGameState.variant || 'Standard';
        const lowerVariant = variantName.toLowerCase().replace(/[^a-z0-9_-]/g, '');

        const { nameToAbbr, provinceLookup } = await ensureMapDataParsed(variantName);
        if (!provinceLookup || Object.keys(provinceLookup).length === 0) {
             throw new Error(`Map data (province names/abbreviations/coordinates) could not be loaded for variant ${variantName}. Cannot generate map.`);
        }

        const listResult = await executeDipCommand(judgeEmail, `LIST ${gameName}`, gameName);
        if (!listResult.success) {
            console.error(`[getMapData PNG Error] Failed to fetch LIST data for ${gameName}:`, listResult.output);
            return null;
        }
        const currentGameState = parseListOutput(gameName, listResult.stdout, nameToAbbr);
        if (!currentGameState) {
            console.error(`[getMapData PNG Error] Failed to parse LIST output for ${gameName}`);
            return null;
        }

        let targetPhase = phase || currentGameState.currentPhase || 'UnknownPhase';
        if (targetPhase === 'Unknown') targetPhase = 'UnknownPhase';

        const cmapPathOriginal = path.join(mapDataDir, `${variantName}.cmap.ps`);
        const cmapPathLower = path.join(mapDataDir, `${lowerVariant}.cmap.ps`);
        const mapPathOriginal = path.join(mapDataDir, `${variantName}.map.ps`);
        const mapPathLower = path.join(mapDataDir, `${lowerVariant}.map.ps`);
        let basePsContent = ''; let isColored = false; let usedTemplatePath = '';

        try { basePsContent = await fsPromises.readFile(cmapPathOriginal, 'utf-8'); isColored = true; usedTemplatePath = cmapPathOriginal; }
        catch (errCmapOrig) { if (errCmapOrig.code === 'ENOENT') {
            try { basePsContent = await fsPromises.readFile(cmapPathLower, 'utf-8'); isColored = true; usedTemplatePath = cmapPathLower; }
            catch (errCmapLower) { if (errCmapLower.code === 'ENOENT') {
                try { basePsContent = await fsPromises.readFile(mapPathOriginal, 'utf-8'); isColored = false; usedTemplatePath = mapPathOriginal; }
                catch (errMapOrig) { if (errMapOrig.code === 'ENOENT') {
                    try { basePsContent = await fsPromises.readFile(mapPathLower, 'utf-8'); isColored = false; usedTemplatePath = mapPathLower; }
                    catch (errMapLower) { console.error(`[getMapData PNG Error] Could not read any map template for variant ${variantName}. Tried ${cmapPathOriginal}, ${cmapPathLower}, ${mapPathOriginal}, ${mapPathLower}`); return null; }
                } else { console.error(`[getMapData PNG Error] Error reading map template ${mapPathOriginal}:`, errMapOrig); return null; }}
            } else { console.error(`[getMapData PNG Error] Error reading map template ${cmapPathLower}:`, errCmapLower); return null; }}
        } else { console.error(`[getMapData PNG Error] Error reading map template ${cmapPathOriginal}:`, errCmapOrig); return null; }}
        console.log(`[getMapData PNG] Using PS template: ${usedTemplatePath}`);

        let unitPsCommands = [];
        const psDrawFunctions = { "A": "DrawArmySymbol", "F": "DrawFleetSymbol", "W": "DrawWingSymbol", "R": "DrawArtillerySymbol", "G": "DrawGarrisonSymbol" };

        let powerToIndexMap = {};
        if (lowerVariant === 'machiavelli') {
            powerToIndexMap = {
                'AUSTRIA': 1, 'FRANCE': 2, 'MILAN': 3, 'FLORENCE': 4,
                'NAPLES': 5, 'PAPACY': 6, 'TURKEY': 7, 'VENICE': 8, 'AUTONOMOUS': 9
            };
        } else { // Default to Standard Diplomacy (or other variants if added)
            powerToIndexMap = {
                'AUSTRIA': 1, 'ENGLAND':2, 'FRANCE': 3, 'GERMANY':4,
                'ITALY':5, 'RUSSIA':6, 'TURKEY': 7
            };
        }

        const allUnits = currentGameState.units || [];
        let coordinateError = false;

        allUnits.forEach(unit => {
            let unitLocationAbbr = unit.location; // Already an abbreviation from parseListOutput
            if (!provinceLookup[unitLocationAbbr] && unit.location && nameToAbbr) {
                const resolved = nameToAbbr[unit.location.toLowerCase().trim()];
                if (resolved) unitLocationAbbr = resolved;
            }

            if (!unitLocationAbbr || !provinceLookup[unitLocationAbbr]) {
                console.warn(`[getMapData PNG] Skipping unit, unresolvable or missing coordinate data for location: '${unit.location}' (resolved to '${unitLocationAbbr}') for power ${unit.power}`);
                return;
            }

            const provinceData = provinceLookup[unitLocationAbbr];

            if (provinceData.unitX === undefined || provinceData.unitY === undefined || isNaN(provinceData.unitX) || isNaN(provinceData.unitY)) {
                console.error(`[getMapData PNG Error] Unit coordinate data missing or invalid for province '${unitLocationAbbr}' (Unit: ${unit.type} ${unit.location} by ${unit.power}). UnitX: ${provinceData.unitX}, UnitY: ${provinceData.unitY}. Label coords: ${provinceData.labelX},${provinceData.labelY}. SC coords: ${provinceData.scX},${provinceData.scY}`);
                coordinateError = true; return;
            }
            const drawFunc = psDrawFunctions[unit.type.toUpperCase()] || 'DrawArmySymbol'; // Ensure unit.type is uppercase
            const x = provinceData.unitX;
            const y = provinceData.unitY;
            const powerIndex = powerToIndexMap[unit.power.toUpperCase()];

            if (powerIndex === undefined) {
                console.warn(`[getMapData PNG] Unknown power '${unit.power}' for unit in ${unitLocationAbbr}. Skipping unit. Check POWER_TO_INDEX for variant ${variantName}.`);
                return;
            }
            // *** MODIFIED LINE FOR UNIT DRAWING ***
            unitPsCommands.push(`gsave ${x} ${y} translate ${powerIndex} ${drawFunc} grestore`);
        });

        let scPsCommands = [];
        if (isColored) {
            const scsByOwner = {};
            (currentGameState.supplyCenters || []).forEach(sc => {
                if (!sc.location || !sc.owner || sc.owner.toUpperCase() === 'UNOWNED') {
                    return;
                }
                const ownerKey = sc.owner.toUpperCase();
                if (!scsByOwner[ownerKey]) {
                    scsByOwner[ownerKey] = [];
                }
                const scAbbr = sc.location.toUpperCase(); // Should be an abbreviation
                if (provinceLookup[scAbbr]) {
                    scsByOwner[ownerKey].push(scAbbr);
                } else {
                    console.warn(`[getMapData PNG] SC: Province data for '${scAbbr}' (owner ${ownerKey}) not found in provinceLookup. This SC might not be drawn correctly if its PS drawing procedure (e.g., /${scAbbr}) is missing or if the abbreviation is incorrect.`);
                }
            });

            const sortedOwners = Object.keys(scsByOwner).sort();
            for (const owner of sortedOwners) {
                if (scsByOwner[owner].length > 0) {
                    scPsCommands.push(`${owner}CENTER`);
                    scsByOwner[owner].sort().forEach(abbr => {
                        scPsCommands.push(abbr);
                    });
                }
            }

            if (scPsCommands.length > 0) {
                scPsCommands.push("closepath newpath");
                scPsCommands.push("Black");
            }
        }

        if (coordinateError) throw new Error(`Map generation failed for ${gameName} (${variantName}): Coordinate data missing or invalid for one or more provinces. Check .info file and parsing logic.`);

        let dynamicPsDefs = [
            `/DrawDynamicUnits {`, ...unitPsCommands, `} def`,
            `/DrawDynamicSCs {`, ...scPsCommands, `} def`
        ];
        const title = `${gameName}, ${targetPhase}`;
        let setupPsCommands = [`(${title}) DrawTitle`];
        const combinedPsContent = `${basePsContent}\n${dynamicPsDefs.join("\n")}\n${setupPsCommands.join("\n")}\nDrawMap\nShowPage\n`;

        const safeGameName = gameName.replace(/[^a-zA-Z0-9_-]/g, '_');
        const safePhase = targetPhase.replace(/[^a-zA-Z0-9_-]/g, '_');
        // const debugPsPath = path.join(staticMapDir, `${safeGameName}_${safePhase}_debug.ps`);
        // try { await fsPromises.writeFile(debugPsPath, combinedPsContent); console.log(`[getMapData PNG Debug] Saved combined PostScript to ${debugPsPath}`); }
        // catch (writeErr) { console.error(`[getMapData PNG Debug] Failed to write debug PS file:`, writeErr); }

        const outputPngFilename = `${safeGameName}_${safePhase}.png`;
        const outputPngPath = path.join(staticMapDir, outputPngFilename);
        await generateMapPng(combinedPsContent, outputPngPath);
        const mapUrl = `/generated_maps/${outputPngFilename}`;
        console.log(`[getMapData PNG] Successfully generated map. URL: ${mapUrl}`);
        return { success: true, mapUrl: mapUrl };

    } catch (error) {
        console.error(`[getMapData PNG Fatal Error] Unexpected error for ${gameName} / ${phase || 'latest'}:`, error);
        if (error.message.includes("Coordinate data missing")) throw error;
        if (error.message.includes("Failed to read map info file") || error.message.includes("Failed to read .info file")) throw error;
        return null;
    }
}


// --- API Endpoints ---
const app = express();
const port = process.env.PORT || 3000;
const sessionSecret = process.env.SESSION_SECRET;
if (!sessionSecret || sessionSecret === 'your-very-secret-key') console.warn('\n!!! WARNING: SESSION_SECRET is not set or is using the default value in .env !!!\n');
app.set('view engine', 'ejs'); app.set('views', path.join(__dirname, 'views'));
app.use(expressLayouts); app.set('layout', 'layout'); app.set("layout extractScripts", true); app.set("layout extractStyles", true);
app.use(cookieParser()); app.use(express.json()); app.use(express.urlencoded({ extended: true }));
app.use(session({ store: new SQLiteStore({ db: 'sessions.db', dir: __dirname, table: 'sessions', concurrentDB: true }), secret: sessionSecret || 'fallback-secret-change-me', resave: false, saveUninitialized: false, cookie: { secure: process.env.NODE_ENV === 'production', httpOnly: true, maxAge: 1000 * 60 * 60 * 24 * 7 } }));
app.use((req, res, next) => { /* console.log(`[Request Logger] Path: ${req.path}, Method: ${req.method}, User: ${req.session?.email}`); */ next(); });
function requireEmail(req, res, next) { if (!req.session.email) { res.clearCookie('targetGame'); Object.keys(req.cookies).forEach(cookieName => { if (cookieName.startsWith('targetPassword_') || cookieName.startsWith('targetVariant_')) res.clearCookie(cookieName); }); if (req.path === '/') return next(); if (req.xhr || req.headers.accept.indexOf('json') > -1) return res.status(401).json({ success: false, output: 'Session expired or invalid. Please reload.' }); return res.redirect('/'); } res.locals.user = req.session.email; next(); }
function requireAuth(req, res, next) { if (req.session && req.session.email) { req.userId = req.session.email; next(); } else { res.status(401).json({ success: false, message: 'Authentication required.' }); } }
try { if (!fs.existsSync(staticMapDir)) { fs.mkdirSync(staticMapDir, { recursive: true }); console.log(`Created static map directory: ${staticMapDir}`); } } catch (err) { console.error(`Error creating static map directory ${staticMapDir}:`, err); }
app.use('/generated_maps', express.static(staticMapDir));
console.log(`Serving static maps from ${staticMapDir} at /generated_maps`);

app.get('/', (req, res) => { if (req.session.email) return res.redirect('/dashboard'); res.render('index', { layout: false }); });
app.post('/start', async (req, res) => { const email = req.body.email; if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.render('index', { layout: false, error: 'Please enter a valid email address.' }); try { await ensureUserExists(email); req.session.email = email; res.clearCookie('targetGame'); Object.keys(req.cookies).forEach(cookieName => { if (cookieName.startsWith('targetPassword_') || cookieName.startsWith('targetVariant_')) res.clearCookie(cookieName); }); req.session.save(err => { if (err) { console.error("Session save error on /start:", err); return res.render('index', { layout: false, error: 'Session error. Please try again.' }); } res.redirect('/dashboard'); }); } catch (err) { console.error("Error ensuring user exists:", err); res.render('index', { layout: false, error: 'Database error. Please try again.' }); } });
app.get('/register', requireEmail, (req, res) => { res.render('register', { email: req.session.email, error: null, formData: {} }); });
app.post('/register', requireEmail, async (req, res) => { const email = req.session.email; const { name, address, phone, country, level, site } = req.body; if (!name || !address || !phone || !country || !level || !site) return res.render('register', { email: email, error: 'All fields are required.', formData: req.body }); const registerCommand = `REGISTER\nname: ${name}\naddress: ${address}\nphone: ${phone}\ncountry: ${country}\nlevel: ${level}\ne-mail: ${email}\nsite: ${site}\npackage: yes\nEND`; try { const result = await executeDipCommand(email, registerCommand); const outputLower = result.stdout.trim().toLowerCase(); if (outputLower.includes("registration accepted") || outputLower.includes("updated registration") || outputLower.includes("already registered") || outputLower.includes("this is an update to an existing registration")) { await setUserRegistered(email); console.log(`[Register Success] User ${email} registered with judge.`); req.session.save(err => { if (err) console.error("Session save error after registration:", err); res.redirect('/dashboard'); }); } else { console.error(`[Register Fail] Judge rejected registration for ${email}. Output:\n${result.output}`); res.render('register', { email: email, error: `Judge rejected registration. Please check the output below and correct your details.`, judgeOutput: result.output, formData: req.body }); } } catch (error) { console.error(`[Register Error] Failed to execute REGISTER command for ${email}:`, error); res.render('register', { email: email, error: `Error communicating with the judge: ${error.output || error.message}`, judgeOutput: error.output, formData: req.body }); } });
app.post('/signoff', (req, res) => { const email = req.session.email; console.log(`[Auth] User ${email} signing off.`); req.session.destroy((err) => { res.clearCookie('connect.sid'); res.clearCookie('targetGame'); Object.keys(req.cookies).forEach(cookieName => { if (cookieName.startsWith('targetPassword_') || cookieName.startsWith('targetVariant_')) res.clearCookie(cookieName); }); if (err) console.error("Session destruction error:", err); res.redirect('/'); }); });
app.get('/api/games', requireEmail, async (req, res) => { try { const filters = { status: req.query.status, variant: req.query.variant, phase: req.query.phase, player: req.query.player }; Object.keys(filters).forEach(key => filters[key] === undefined && delete filters[key]); const gameStates = await getFilteredGameStates(filters); const gameList = Object.values(gameStates).map(g => ({ name: g.name, status: g.status, variant: g.variant, phase: g.currentPhase, players: g.players.map(p => p.email), masters: g.masters, nextDeadline: g.nextDeadline })); res.json({ success: true, games: gameList }); } catch (err) { console.error("[API Error] /api/games:", err); res.status(500).json({ success: false, message: "Failed to retrieve game list." }); } });
app.get('/api/game/:gameName', requireEmail, async (req, res) => {
    const gameName = req.params.gameName;
    const userEmail = req.session.email;

    if (!gameName) return res.status(400).json({ success: false, message: "Game name is required." });

    try {
        let refreshedGameState = null;
        let recommendedCommands = {};
        let errorOccurred = null;
        let warningMessage = null;

        // Attempt to fetch and parse fresh LIST data
        try {
            // We need targetPassword and targetVariant for executeDipCommand if it does SIGN ON.
            // For a simple LIST, these might not be strictly necessary.
            // Pass null, executeDipCommand will use judgeEmail if no specific role context.
            const listResult = await executeDipCommand(userEmail, `LIST ${gameName}`, gameName, null, null);

            if (listResult.success) {
                // Determine variant for parsing. Fallback to 'Standard' if game not in DB yet or variant unknown.
                const preliminaryGameState = await getGameState(gameName);
                const variantForParsing = preliminaryGameState?.variant || 'Standard';
                const { nameToAbbr } = await ensureMapDataParsed(variantForParsing);

                refreshedGameState = parseListOutput(gameName, listResult.stdout, nameToAbbr);

                if (refreshedGameState) {
                    await saveGameState(gameName, refreshedGameState); // Save the fresh state
                    recommendedCommands = getRecommendedCommands(refreshedGameState, userEmail);
                } else {
                    errorOccurred = `LIST command for '${gameName}' succeeded but parsing the output failed.`;
                    console.error(`[API Error] /api/game/${gameName}: ${errorOccurred}`);
                }
            } else {
                errorOccurred = `LIST command execution failed for '${gameName}'. Output: ${listResult.output}`;
                console.error(`[API Error] /api/game/${gameName}: ${errorOccurred}`);
            }
        } catch (listRefreshError) {
            errorOccurred = `Error during LIST refresh for '${gameName}': ${listRefreshError.message}`;
            console.error(`[API Error] /api/game/${gameName} (LIST Refresh Catch):`, listRefreshError);
        }

        // If refresh failed, try to use stored data as a fallback
        if (errorOccurred || !refreshedGameState) {
            warningMessage = errorOccurred || "Could not obtain fresh game state.";
            console.warn(`[API Warning] /api/game/${gameName}: ${warningMessage}. Attempting to use stored data.`);
            const dbGameState = await getGameState(gameName);
            if (dbGameState) {
                refreshedGameState = dbGameState; // Use DB state
                recommendedCommands = getRecommendedCommands(refreshedGameState, userEmail);
            } else {
                // If DB state also doesn't exist (e.g., game truly not found)
                return res.status(404).json({ success: false, message: `Game '${gameName}' not found and live refresh failed. ${warningMessage}` });
            }
        }

        res.json({ success: true, gameState: refreshedGameState, recommendedCommands, warning: warningMessage });

    } catch (outerErr) {
        console.error(`[API Error] /api/game/${gameName} (Outer Catch):`, outerErr);
        res.status(500).json({ success: false, message: `Critical error retrieving game state for ${gameName}: ${outerErr.message}` });
    }
});
app.get('/api/user/search-bookmarks', requireAuth, async (req, res) => { try { const bookmarks = await getSavedSearches(req.session.email); res.json({ success: true, bookmarks }); } catch (err) { res.status(500).json({ success: false, message: "Failed to retrieve saved searches." }); } });
app.post('/api/user/search-bookmarks', requireAuth, async (req, res) => { const { name, params } = req.body; if (!name || typeof name !== 'string' || name.trim().length === 0) return res.status(400).json({ success: false, message: "Bookmark name is required." }); if (!params || typeof params !== 'object') return res.status(400).json({ success: false, message: "Search parameters (params) object is required." }); try { await saveSavedSearch(req.session.email, name.trim(), params); res.json({ success: true, message: `Bookmark '${name.trim()}' saved successfully.` }); } catch (err) { res.status(500).json({ success: false, message: "Failed to save bookmark." }); } });
app.delete('/api/user/search-bookmarks/:name', requireAuth, async (req, res) => { const bookmarkName = decodeURIComponent(req.params.name); if (!bookmarkName) return res.status(400).json({ success: false, message: "Bookmark name parameter is required." }); try { const deleted = await deleteSavedSearch(req.session.email, bookmarkName); if (deleted) res.json({ success: true, message: `Bookmark '${bookmarkName}' deleted successfully.` }); else res.status(404).json({ success: false, message: `Bookmark '${bookmarkName}' not found.` }); } catch (err) { res.status(500).json({ success: false, message: "Failed to delete bookmark." }); } });
app.get('/api/news', async (req, res) => { try { const newsItems = await getAllNewsItems(); res.json({ success: true, news: newsItems }); } catch (err) { res.status(500).json({ success: false, message: "Failed to retrieve news items." }); } });
app.post('/api/news', requireAuth, async (req, res) => { const { content } = req.body; if (!content) return res.status(400).json({ success: false, message: "Missing 'content' in request body." }); try { const newNewsId = await addNewsItem(content); res.status(201).json({ success: true, message: "News item added successfully.", newsId: newNewsId }); } catch (err) { res.status(500).json({ success: false, message: err.message || "Failed to add news item." }); } });
app.delete('/api/news/:id', requireAuth, async (req, res) => { const newsId = parseInt(req.params.id, 10); if (isNaN(newsId)) return res.status(400).json({ success: false, message: "Invalid news item ID." }); try { const deleted = await deleteNewsItem(newsId); if (deleted) res.json({ success: true, message: `News item ${newsId} deleted successfully.` }); else res.status(404).json({ success: false, message: `News item ${newsId} not found.` }); } catch (err) { res.status(500).json({ success: false, message: "Failed to delete news item." }); } });
app.get('/dashboard', requireEmail, async (req, res) => { const email = req.session.email; let errorMessage = req.session.errorMessage || null; req.session.errorMessage = null; let registrationStatus = null; try { registrationStatus = await getUserRegistrationStatus(email); if (registrationStatus === null) { await ensureUserExists(email); registrationStatus = 0; } if (registrationStatus === 0) return res.redirect('/register'); const syncResult = await syncDipMaster(); if (syncResult.syncError && !errorMessage) errorMessage = syncResult.syncError; const allGameStates = await getAllGameStates(); const gameList = Object.values(allGameStates).map(g => ({ name: g.name, status: g.status })); const initialTargetGameName = req.cookies.targetGame; let initialGameState = null; let initialRecommendedCommands = {}; if (initialTargetGameName) { initialGameState = allGameStates[initialTargetGameName]; if (initialGameState) initialRecommendedCommands = getRecommendedCommands(initialGameState, email); else { res.clearCookie('targetGame'); res.clearCookie(`targetPassword_${initialTargetGameName}`); res.clearCookie(`targetVariant_${initialTargetGameName}`); } } if (!initialGameState) initialRecommendedCommands = getRecommendedCommands(null, email); res.render('dashboard', { email: email, allGames: gameList, initialTargetGame: initialGameState, initialRecommendedCommands: initialRecommendedCommands, error: errorMessage, layout: 'layout' }); } catch (err) { console.error(`[Dashboard Error] Failed to load dashboard data for ${email}:`, err); res.render('dashboard', { email: email, allGames: [], initialTargetGame: null, initialRecommendedCommands: getRecommendedCommands(null, email), error: `Error loading dashboard: ${err.message}`, layout: 'layout' }); } });
app.post('/execute-dip', requireEmail, async (req, res) => { const { command, targetGame, targetPassword, targetVariant } = req.body; const email = req.session.email; if (!command) return res.status(400).json({ success: false, output: 'Error: Missing command.' }); const commandVerb = command.trim().split(/\s+/)[0].toUpperCase(); let actualTargetGame = targetGame; const commandParts = command.trim().split(/\s+/); const gameNameCommands = ['LIST', 'HISTORY', 'SUMMARY', 'WHOGAME', 'OBSERVE', 'WATCH', 'SIGN', 'CREATE', 'EJECT']; if (gameNameCommands.includes(commandVerb) && commandParts.length > 1) { let potentialGameName = commandParts[1]; if (commandVerb === 'SIGN' && command.toUpperCase().includes(' ON ') && !potentialGameName.startsWith('?')) { if (potentialGameName.length > 1 && /^[A-Z]$/i.test(potentialGameName[0])) potentialGameName = potentialGameName.substring(1); } else if ((commandVerb === 'SIGN' || commandVerb === 'CREATE') && potentialGameName.startsWith('?')) potentialGameName = potentialGameName.substring(1); else if (commandVerb === 'EJECT' && potentialGameName.includes('@')) potentialGameName = null; const keywords = ['FULL', 'FROM', 'TO', 'LINES', 'EXCLSTART', 'EXCLEND', 'BROAD', 'ON', '?', 'MASTER']; if (potentialGameName && /^[a-zA-Z0-9]{1,8}$/.test(potentialGameName) && !keywords.includes(potentialGameName.toUpperCase())) actualTargetGame = potentialGameName; } try { const result = await executeDipCommand(email, command, actualTargetGame, targetPassword, targetVariant); const stdoutData = result.stdout; let requiresGameRefresh = false; let isSignOnOrObserveSuccess = false; let newGameCreated = false; let signedOnGame = null; const signOnSuccessPattern = /signed on as (?:\w+)\s*(?:in game)?\s*'(\w+)'/i; const observeSuccessPattern = /(?:Observing|Watching) game '(\w+)'/i; const createSuccessPattern = /Game '(\w+)' created/i; let match; if ((match = stdoutData.match(signOnSuccessPattern)) && (commandVerb === 'SIGN' && command.toUpperCase().includes(' ON '))) { signedOnGame = match[1]; isSignOnOrObserveSuccess = true; } else if ((match = stdoutData.match(observeSuccessPattern)) && (commandVerb === 'OBSERVE' || commandVerb === 'WATCH')) { signedOnGame = match[1]; isSignOnOrObserveSuccess = true; } else if ((match = stdoutData.match(createSuccessPattern)) && commandVerb === 'CREATE') { signedOnGame = match[1]; isSignOnOrObserveSuccess = true; newGameCreated = true; syncDipMaster().catch(syncErr => console.error("Error during post-create sync:", syncErr)); } if (isSignOnOrObserveSuccess && signedOnGame) { actualTargetGame = signedOnGame; requiresGameRefresh = true; } const stateChangingCommands = ['PROCESS', 'SET', 'RESIGN', 'WITHDRAW', 'EJECT', 'TERMINATE', 'ROLLBACK', 'FORCE BEGIN', 'UNSTART', 'PROMOTE', 'PAUSE', 'RESUME', 'BECOME MASTER', 'SET MODERATE', 'SET UNMODERATE', 'CLEAR', 'BORROW', 'GIVE', 'PAY', 'ALLY', 'EXPENSE', 'ORDERS']; if (stateChangingCommands.includes(commandVerb) && result.success && actualTargetGame) { const outputLower = stdoutData.toLowerCase(); if (outputLower.includes('processed') || outputLower.includes('terminated') || outputLower.includes('resigned') || outputLower.includes('ejected') || outputLower.includes('rolled back') || outputLower.includes('set') || outputLower.includes('promoted') || outputLower.includes('paused') || outputLower.includes('resumed') || outputLower.includes('cleared') || outputLower.includes('moderated') || outputLower.includes('unmoderated') || outputLower.includes('accepted') || outputLower.includes('order received') || outputLower.includes('borrowed') || outputLower.includes('paid') || outputLower.includes('loaned') || outputLower.includes('allied') || outputLower.includes('expense recorded')) requiresGameRefresh = true; } if (commandVerb === 'LIST' && result.success && actualTargetGame) requiresGameRefresh = true; let refreshedGameState = null; let updatedRecommendedCommands = null; if (requiresGameRefresh && actualTargetGame) { try { const { nameToAbbr } = await ensureMapDataParsed( (await getGameState(actualTargetGame))?.variant || 'Standard' ); const listResult = await executeDipCommand(email, `LIST ${actualTargetGame}`, actualTargetGame, targetPassword, targetVariant); if (listResult.success) { refreshedGameState = parseListOutput(actualTargetGame, listResult.stdout, nameToAbbr); await saveGameState(actualTargetGame, refreshedGameState); updatedRecommendedCommands = getRecommendedCommands(refreshedGameState, email); } } catch (refreshError) { console.error(`[Execute Refresh] Error during state refresh for ${actualTargetGame}:`, refreshError); } } res.json({ success: result.success, output: result.output, isSignOnOrObserveSuccess: isSignOnOrObserveSuccess, createdGameName: newGameCreated ? signedOnGame : null, refreshedGameState: refreshedGameState, updatedRecommendedCommands: updatedRecommendedCommands }); } catch (error) { console.error(`[Execute Error] Command "${commandVerb}" for ${email} failed:`, error); res.status(error.output?.includes('Spawn failed') ? 503 : 500).json({ success: false, output: error.output || 'Unknown execution error', isSignOnOrObserveSuccess: false }); } });
app.post('/api/games', requireAuth, async (req, res) => {
    const { gameName, variant, password } = req.body;
    const userEmail = req.session.email;

    if (!gameName || !variant) {
        return res.status(400).json({ success: false, message: 'Missing required parameters: gameName, variant' });
    }
    if (!password) { // Password might be optional for 'CREATE' command itself, but this API requires it.
        return res.status(400).json({ success: false, message: 'Password is required for game creation via this API.' });
    }

    let commandParts = ['CREATE', `?${gameName}`, password, variant];
    const command = commandParts.join(' ');

    console.log(`[API /api/games POST] User: ${userEmail}, Attempting to create game: '${gameName}', Variant: '${variant}', Password: '${password ? "Provided" : "Not Provided"}'`);
    console.log(`[API /api/games POST] Executing DIP command: ${command}`);

    try {
        const result = await executeDipCommand(userEmail, command);
        // Log the full result from executeDipCommand
        console.log(`[API /api/games POST] DIP command result for game '${gameName}':`, JSON.stringify(result, null, 2));

        const createSuccessPattern = /Game '(\w+)' created/i;
        const match = result.stdout.match(createSuccessPattern);
        // Log the outcome of the regex match
        console.log(`[API /api/games POST] DIP stdout match for game '${gameName}':`, match);

        if (result.success && match && match[1] === gameName) {
            await syncDipMaster(); // Ensure dip.master is updated
            res.status(201).json({ success: true, message: `Game '${gameName}' created successfully.`, output: result.stdout });
        } else {
            let userMessage = `Failed to create game '${gameName}'. Judge response might indicate the issue.`;
            let httpStatusCode = 500; // Default to internal server error

            if (result.success && result.stdout) {
                // Dip command ran successfully but didn't confirm game creation.
                // Extract a more meaningful message from stdout.
                const lines = result.stdout.split('\\n');
                let meaningfulResponse = "";
                for (const line of lines) {
                    if (line.trim().startsWith("---- Original message follows:")) {
                        break;
                    }
                    if (line.trim()) { // Add non-empty lines
                        meaningfulResponse += line.trim() + " ";
                    }
                }
                userMessage = meaningfulResponse.trim() || `Game '${gameName}' not created. Judge output: ${result.stdout.trim()}`;

                // Set a more specific HTTP status code based on known judge responses
                if (userMessage.toLowerCase().includes("minimum dedication")) {
                    httpStatusCode = 403; // Forbidden
                } else if (userMessage.toLowerCase().includes("already exists")) {
                    httpStatusCode = 409; // Conflict
                } else if (userMessage.toLowerCase().includes("invalid variant") || userMessage.toLowerCase().includes("invalid game name")) {
                    httpStatusCode = 400; // Bad Request
                } else {
                    // If it's a successful dip execution but unknown non-creation reason
                    httpStatusCode = 400; // Treat as a general bad request/rejection from the judge
                }
            }

            console.error(`[API /api/games POST Error] Game creation failed for '${gameName}'. DIP Success: ${result.success}, Stdout Match: ${match ? `found '${match[1]}'` : 'no match'}, Expected Name: '${gameName}'. User Message: "${userMessage}". Full DIP output: ${result.output}`);
            res.status(httpStatusCode).json({ success: false, message: userMessage, output: result.output });
        }
    } catch (error) { // This catch handles network errors or if the fetch itself fails (e.g., DNS resolution)
        // Log the caught error object
        console.error(`[API /api/games POST Exception] Error during game creation for '${gameName}':`, JSON.stringify(error, null, 2));
        // Determine status code based on the nature of the error from executeDipCommand
        let exceptionStatusCode = 500;
        if (error.output?.includes('Spawn failed')) {
            exceptionStatusCode = 503; // Service Unavailable (dip binary issue)
        } else if (error.output?.includes('already exists')) {
            exceptionStatusCode = 409; // Conflict (though ideally caught by the block above)
        }
        res.status(exceptionStatusCode).json({ success: false, message: `Failed to add game '${gameName}'.`, output: error.output || error.message || 'Unknown error' });
    }
});
app.delete('/api/games/:gameName', requireAuth, async (req, res) => { const { gameName } = req.params; const { password } = req.body; const userEmail = req.session.email; if (!gameName) return res.status(400).json({ success: false, message: 'Missing gameName in path parameter.' }); const command = `TERMINATE`; try { const result = await executeDipCommand(userEmail, command, gameName, password); const terminateSuccessPattern = /Game terminated/i; if (result.success && terminateSuccessPattern.test(result.stdout)) { const currentState = await getGameState(gameName); if (currentState) { currentState.status = 'Terminated'; currentState.lastUpdated = Math.floor(Date.now() / 1000); await saveGameState(gameName, currentState); } await syncDipMaster(); res.status(200).json({ success: true, message: `Game '${gameName}' terminated successfully.`, output: result.stdout }); } else { res.status(500).json({ success: false, message: `Failed to terminate game '${gameName}'. Judge response might indicate the issue.`, output: result.output }); } } catch (error) { const statusCode = error.output?.includes('Spawn failed') ? 503 : error.output?.includes('No such game') ? 404 : error.output?.includes('incorrect password') ? 401 : error.output?.includes('only be issued by a Master') ? 403 : 500; res.status(statusCode).json({ success: false, message: `Failed to terminate game '${gameName}'.`, output: error.output || error.message || 'Unknown error' }); } });

console.log(`[Route Definition Check] Defining GET /api/map/:gameName/:phase?`);
app.get('/api/map/:gameName/:phase?', requireAuth, async (req, res) => {
    const { gameName, phase } = req.params;
    if (!gameName) return res.status(400).json({ success: false, message: 'Game name is required.' });
    try {
        const mapResult = await getMapData(gameName, phase);
        if (mapResult && mapResult.success) res.json({ success: true, mapUrl: mapResult.mapUrl });
        else {
            const gameExists = await getGameState(gameName);
            if (!gameExists) return res.status(404).json({ success: false, message: `Game '${gameName}' not found.` });
            else return res.status(500).json({ success: false, message: `Could not generate map image for game '${gameName}' phase '${phase || 'latest'}'. Check server logs.` });
        }
    } catch (error) {
        console.error(`[Map API Request PNG Fatal Error] Failed to get map URL for ${gameName} / ${phase || 'latest'}:`, error);
        if (error.message.includes("Coordinate data missing")) res.status(500).json({ success: false, message: `Map generation failed: ${error.message}. The map data file (.info) for this variant seems incomplete or incorrectly parsed.` });
        else if (error.message.includes("Failed to read map info file") || error.message.includes("Failed to read .info file")) {
             const variantMatch = error.message.match(/variant ([^.]+)/);
             const variantName = variantMatch ? variantMatch[1] : 'unknown';
             res.status(500).json({ success: false, message: `Map generation failed: ${error.message}. Check if the .info file exists for variant '${variantName}' (or its lowercase version) in '${mapDataDir}'.` });
        } else res.status(500).json({ success: false, message: 'An internal server error occurred while generating the map image.' });
    }
});
console.log(`[Route Definition Check] Defining GET /api/user/preferences`);
app.get('/api/user/preferences', requireAuth, async (req, res) => { try { const preferences = await getUserPreferences(req.userId); if (Object.keys(preferences).length === 0) res.status(200).json({ success: true, preferences: {} }); else res.json({ success: true, preferences }); } catch (error) { res.status(500).json({ success: false, message: 'Failed to retrieve preferences.' }); } });
console.log(`[Route Definition Check] Defining PUT /api/user/preferences`);
app.put('/api/user/preferences', requireAuth, async (req, res) => { const preferencesToSet = req.body; if (typeof preferencesToSet !== 'object' || preferencesToSet === null) return res.status(400).json({ success: false, message: 'Invalid request body. Expected a JSON object of preferences.' }); const promises = []; for (const key in preferencesToSet) if (Object.hasOwnProperty.call(preferencesToSet, key)) promises.push(setUserPreference(req.userId, key, preferencesToSet[key])); try { await Promise.all(promises); res.json({ success: true, message: 'Preferences updated successfully.' }); } catch (error) { res.status(500).json({ success: false, message: 'Failed to update preferences.' }); } });
console.log(`[Route Definition Check] Defining DELETE /api/user/preferences/:key`);
app.delete('/api/user/preferences/:key', requireAuth, async (req, res) => { const keyToDelete = req.params.key; if (!keyToDelete) return res.status(400).json({ success: false, message: 'Preference key parameter is required.' }); try { const deleted = await deleteUserPreference(req.userId, keyToDelete); if (deleted) res.json({ success: true, message: `Preference '${keyToDelete}' deleted.` }); else res.status(404).json({ success: false, message: `Preference '${keyToDelete}' not found.` }); } catch (error) { res.status(500).json({ success: false, message: 'Failed to delete preference.' }); } });
console.log(`[Route Definition Check] Defining POST /api/user/preferences/reset`);
app.post('/api/user/preferences/reset', requireAuth, async (req, res) => { try { const count = await deleteAllUserPreferences(req.userId); res.json({ success: true, message: `Reset ${count} preferences.` }); } catch (error) { res.status(500).json({ success: false, message: 'Failed to reset preferences.' }); } });
app.get('/api/stats/game-status', async (req, res) => { try { const gameCounts = await getGameCountsByStatus(); res.json({ success: true, stats: gameCounts }); } catch (error) { res.status(500).json({ success: false, message: "Failed to retrieve game status statistics." }); } });
app.get('/api/game/:gameName/history', requireEmail, async (req, res) => { const gameName = req.params.gameName; const userEmail = req.session.email; if (!gameName) return res.status(400).json({ success: false, message: 'Game name is required.' }); try { const historyResult = await executeDipCommand(userEmail, `HISTORY ${gameName}`, gameName); if (!historyResult.success) { const statusCode = historyResult.output.includes('No such game') ? 404 : 500; return res.status(statusCode).json({ success: false, message: historyResult.output.trim() }); } const { nameToAbbr } = await ensureMapDataParsed( (await getGameState(gameName))?.variant || 'Standard' ); const parsedHistory = parseHistoryOutput(gameName, historyResult.stdout, nameToAbbr); res.json({ success: true, history: parsedHistory }); } catch (error) { const statusCode = error.output?.includes('Spawn failed') ? 503 : (error.message?.includes('No such game') ? 404 : 500); const errorMessage = error.message || 'Failed to retrieve game history.'; res.status(statusCode).json({ success: false, message: errorMessage, details: error.output || null }); } });

// --- Start Server ---
app.use(express.static(path.join(__dirname, 'public')));
app.listen(port, () => {
    console.log(`Dip Web App listening at http://localhost:${port}`);
    console.log(`Using dip binary: ${dipBinaryPath}`);
    if (dipBinaryArgs.length > 0) console.log(`Using dip binary args: ${dipBinaryArgs.join(' ')}`);
    console.log(`Using dip binary root path: ${dipBinaryRootPath}`);
    console.log(`Expecting dip.master at: ${dipMasterPath}`);
    console.log(`Expecting map data files (.info) in: ${mapDataDir}`);
    console.log(`Expecting map alias files (map.<variant>) in: ${gameDataDir}`);
    console.log(`Expecting map template files (.ps) in: ${mapDataDir}`);
    console.log(`Storing generated maps in: ${staticMapDir}`);

    const resolvedDipCommand = path.resolve(dipBinaryRootPath, path.basename(dipBinaryPath));
    if (!fs.existsSync(resolvedDipCommand)) console.warn(`\n!!! WARNING: Dip binary not found at '${resolvedDipCommand}'. Check DIP_BINARY_PATH in .env. !!!\n`);
    else { try { fs.accessSync(resolvedDipCommand, fs.constants.X_OK); console.log(`Dip binary found at '${resolvedDipCommand}' and appears executable.`); } catch (err) { console.warn(`\n!!! WARNING: Dip binary found at '${resolvedDipCommand}' but might not be executable. Error: ${err.message}. Try: chmod +x ${resolvedDipCommand} !!!\n`); } }
    if (!fs.existsSync(dipMasterPath)) console.warn(`\n!!! WARNING: dip.master file not found at '${dipMasterPath}'. Game list sync might fail. !!!\n`);
    else { console.log(`Found dip.master at '${dipMasterPath}'. Performing initial sync...`); syncDipMaster().catch(err => console.error("[Startup Sync Error]", err)); }

    function print (path, layer) { if (layer.route) { layer.route.stack.forEach(print.bind(null, path.concat(split(layer.route.path)))) } else if (layer.name === 'router' && layer.handle.stack) { layer.handle.stack.forEach(print.bind(null, path.concat(split(layer.regexp)))) } else if (layer.method) { console.log('%s /%s', layer.method.toUpperCase(), path.concat(split(layer.regexp)).filter(Boolean).join('/'))}}
    function split (thing) { if (typeof thing === 'string') return thing.split('/'); else if (thing.fast_slash) return ''; else { var match = thing.toString().replace('\\/?', '').replace('(?=\\/|$)', '$').match(/^\/\^((?:\\[.*+?^${}()|[\]\\\/]|[^.*+?^${}()|[\]\\\/])*)\$\//); return match ? match[1].replace(/\\(.)/g, '$1').split('/') : '<complex:' + thing.toString() + '>' }}
    console.log("Defined Routes:"); app._router.stack.forEach(print.bind(null, [])); console.log("----------------");
});
process.on('SIGINT', () => { console.log('SIGINT signal received: closing databases...'); let closedCount = 0; const totalDbs = 3; const tryExit = () => { closedCount++; if (closedCount === totalDbs) { console.log('All databases closed gracefully.'); process.exit(0); } }; db.close((err) => { if (err) console.error('Error closing game_states DB:', err.message); else console.log('Game states DB closed.'); tryExit(); }); sessionDb.close((err) => { if (err) console.error('Error closing sessions DB:', err.message); else console.log('Sessions DB closed.'); tryExit(); }); userDb.close((err) => { if (err) console.error('Error closing users DB:', err.message); else console.log('Users DB closed.'); tryExit(); }); setTimeout(() => { console.error("Databases did not close gracefully within 5s, forcing exit."); process.exit(1); }, 5000); });

// --- Sync dip.master with DB ---
async function syncDipMaster() {
    // console.log('[Sync] Starting sync from dip.master...');
    let gamesFromMaster = {}; let syncError = null;
    try {
        if (!fs.existsSync(dipMasterPath)) throw new Error(`File not found: ${dipMasterPath}.`);
        const masterContent = fs.readFileSync(dipMasterPath, 'utf8');
        const gameBlocks = masterContent.split(/^\s*-\s*$/m);
        const gameLineRegex = /^([a-zA-Z0-9]{1,8})\s+(\S+)\s+([SFUW]\d{4}[MRBAX]|Forming|Paused|Finished|Terminated)/i;
        gameBlocks.forEach((block) => {
            const blockTrimmed = block.trim(); if (!blockTrimmed) return;
            const blockLines = blockTrimmed.split('\n');
            if (blockLines.length > 0) {
                const firstLine = blockLines[0].trim();
                const match = firstLine.match(gameLineRegex);
                if (match) {
                    const gameName = match[1]; const phaseOrStatus = match[3];
                    if (gameName && gameName !== 'control' && !gamesFromMaster[gameName]) {
                        gamesFromMaster[gameName] = { name: gameName, status: 'Unknown', currentPhase: 'Unknown' };
                        if (/^[SFUW]\d{4}[MRBAX]$/i.test(phaseOrStatus)) { gamesFromMaster[gameName].currentPhase = phaseOrStatus.toUpperCase(); gamesFromMaster[gameName].status = 'Active'; }
                        else { const statusLower = phaseOrStatus.toLowerCase(); if (statusLower === 'forming') gamesFromMaster[gameName].status = 'Forming'; else if (statusLower === 'paused') gamesFromMaster[gameName].status = 'Paused'; else if (statusLower === 'finished') gamesFromMaster[gameName].status = 'Finished'; else if (statusLower === 'terminated') gamesFromMaster[gameName].status = 'Terminated'; else gamesFromMaster[gameName].status = 'Unknown'; }
                    }
                }
            }
        });
        // console.log(`[Sync] Found ${Object.keys(gamesFromMaster).length} potential games in ${dipMasterPath}`);
        const existingStates = await getAllGameStates();
        for (const gameName in gamesFromMaster) {
            const masterInfo = gamesFromMaster[gameName]; let currentState = existingStates[gameName]; let needsSave = false;
            if (!currentState) { currentState = { name: gameName, status: masterInfo.status, variant: 'Standard', options: [], currentPhase: masterInfo.currentPhase, nextDeadline: null, masters: [], players: [], observers: [], settings: {} }; needsSave = true; }
            else {
                if (masterInfo.currentPhase !== 'Unknown' && currentState.currentPhase !== masterInfo.currentPhase) { currentState.currentPhase = masterInfo.currentPhase; needsSave = true; }
                if (masterInfo.status !== 'Unknown' && currentState.status !== masterInfo.status) { currentState.status = masterInfo.status; needsSave = true; }
                if ((currentState.status === 'Unknown' || currentState.status === 'Forming') && masterInfo.status === 'Active') { currentState.status = 'Active'; needsSave = true; }
            }
            if (needsSave) { currentState.lastUpdated = Math.floor(Date.now() / 1000); await saveGameState(gameName, currentState); }
        }
        // console.log(`[Sync DB] Finished DB update from dip.master.`);
    } catch (err) { console.error(`[Sync Error] Error reading or processing ${dipMasterPath}:`, err); syncError = `Failed to load/sync game list from ${dipMasterPath}. Error: ${err.code || err.message}`; }
    return { gamesFromMaster, syncError };
}

// --- Helper function to parse HISTORY output (if needed for map generation, though LIST is primary) ---
const parseHistoryOutput = (gameName, output, nameToAbbr) => {
    // Placeholder - Implement if detailed history parsing is needed for map or other features
    // Ensure it uses nameToAbbr for province name resolution if it deals with full names
    return { gameName, variant: null, phases: {} };
};
require('dotenv').config();
const express = require('express');
const path = require('path');
const { spawn } = require('child_process');
const session = require('express-session');
const fs = require('fs');
const fsPromises = require('fs').promises;
const sqlite3 = require('sqlite3').verbose();
const expressLayouts = require('express-ejs-layouts');
const SQLiteStore = require('connect-sqlite3')(session);
const cookieParser = require('cookie-parser'); // Added


// --- Map Info Parsing Cache ---
const mapInfoCache = {};

// --- Environment Setup ---
const dipBinaryPath = process.env.DIP_BINARY_PATH || './dip';
const dipBinaryArgs = (process.env.DIP_BINARY_ARGS || '').split(' ').filter(arg => arg);
const dipBinaryRootPath = path.dirname(dipBinaryPath);
const judgeEmail = process.env.DIP_JUDGE_EMAIL || 'judge@example.com';
const dipMasterPath = process.env.DIP_MASTER_PATH || path.join(dipBinaryRootPath, 'dip.master'); // Default relative to binary

// --- Database Setup ---
const db = new sqlite3.Database('./game_states.db'); // Game state database
const sessionDb = new sqlite3.Database('./sessions.db'); // Session database
const userDb = new sqlite3.Database('./users.db'); // User registration tracking DB

// Initialize Game States DB
db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS game_states (
        name TEXT PRIMARY KEY,
        status TEXT DEFAULT 'Unknown',
        variant TEXT DEFAULT 'Standard',
        options TEXT DEFAULT '[]', -- JSON array of variant options like 'Gunboat', 'Chaos'
        currentPhase TEXT DEFAULT 'Unknown',
        nextDeadline TEXT,
        masters TEXT DEFAULT '[]', -- JSON array of master emails
        players TEXT DEFAULT '[]', -- JSON array of player objects {power, email, status, name}
        observers TEXT DEFAULT '[]', -- JSON array of observer emails
        settings TEXT DEFAULT '{}', -- JSON object of game settings {press, dias, nmr, etc.}
        lastUpdated INTEGER,
        rawListOutput TEXT
    )`, (err) => {
        if (err) console.error("Error creating game_states table:", err);
        else {
            // Add columns if they don't exist (for upgrades) - Check if all needed columns exist
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

    // Create user_preferences table
    db.run(`CREATE TABLE IF NOT EXISTS user_preferences (
        user_id TEXT NOT NULL,      -- User's email address
        preference_key TEXT NOT NULL, -- e.g., 'column_visibility', 'sort_order'
        preference_value TEXT,      -- JSON string or simple value
        PRIMARY KEY (user_id, preference_key)
    )`, (err) => {
        if (err) console.error("Error creating user_preferences table:", err);
        else console.log("User preferences table ensured.");
    });
});

    // Create saved_searches table
    db.run(`CREATE TABLE IF NOT EXISTS saved_searches (
        user_id TEXT NOT NULL,      -- User's email address
        bookmark_name TEXT NOT NULL, -- User-defined name for the search
        search_params TEXT,         -- JSON string containing filter criteria
        PRIMARY KEY (user_id, bookmark_name)
    )`, (err) => {
        if (err) console.error("Error creating saved_searches table:", err);
        else console.log("Saved searches table ensured.");
    });


    // Create news_items table
    db.run(`CREATE TABLE IF NOT EXISTS news_items (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
        content TEXT NOT NULL
    )`, (err) => {
        if (err) console.error("Error creating news_items table:", err);
        else console.log("News items table ensured.");
    });


// Initialize User Tracking DB
userDb.serialize(() => {
    userDb.run(`CREATE TABLE IF NOT EXISTS users (
        email TEXT PRIMARY KEY,
        is_judge_registered INTEGER DEFAULT 0, -- 0 = no, 1 = yes
        last_login INTEGER
    )`, (err) => {
        if (err) console.error("Error creating users table:", err);
    });
});


// --- Database Helper Functions ---

// User DB Helpers
const getUserRegistrationStatus = (email) => {
    return new Promise((resolve, reject) => {
        userDb.get("SELECT is_judge_registered FROM users WHERE email = ?", [email], (err, row) => {
            if (err) reject(err);
            else resolve(row ? row.is_judge_registered : null); // null if user not found
        });
    });
};

const setUserRegistered = (email) => {
    return new Promise((resolve, reject) => {
        userDb.run("UPDATE users SET is_judge_registered = 1 WHERE email = ?", [email], function(err) {
            if (err) reject(err);
            else resolve(this.changes > 0); // True if updated, false if not found
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
                 // Update last_login even if user already exists
                 userDb.run("UPDATE users SET last_login = ? WHERE email = ?", [now, email], (updateErr) => {
                     if (updateErr) reject(updateErr);
                     else resolve();
                 });
             }
         );
     });
};


// Game State DB Helpers
const saveGameState = (gameName, gameState) => {
    return new Promise((resolve, reject) => {
        if (!gameName || typeof gameName !== 'string' || gameName.length === 0) {
            console.error('[DB Error] Attempted to save game state with invalid name:', gameName);
            return reject(new Error('Invalid game name provided for saving state.'));
        }
        const now = Math.floor(Date.now() / 1000);
        const mastersStr = JSON.stringify(gameState.masters || []);
        // Ensure player objects are valid and contain expected fields
        const validPlayers = (gameState.players || []).filter(p => p && typeof p === 'object' && p.power).map(p => ({
             power: p.power,
             email: p.email || null,
             status: p.status || 'Unknown',
             name: p.name || null // Add name if parsed
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
                else { console.log(`[DB Success] Saved state for game ${gameName}`); resolve(); }
            }
        );
    });
};

const getGameState = (gameName) => {
    return new Promise((resolve, reject) => {
        if (!gameName) return resolve(null); // Handle null/undefined gameName gracefully
        db.get("SELECT * FROM game_states WHERE name = ?", [gameName], (err, row) => {
            if (err) { console.error(`[DB Error] Failed to read state for game ${gameName}:`, err); reject(err); }
            else if (row) {
                try {
                    // Safely parse JSON fields, providing defaults on error
                    row.masters = JSON.parse(row.masters || '[]');
                    row.players = JSON.parse(row.players || '[]');
                    row.observers = JSON.parse(row.observers || '[]');
                    row.options = JSON.parse(row.options || '[]');
                    row.settings = JSON.parse(row.settings || '{}');
                    resolve(row);
                } catch (parseError) {
                    console.error(`[DB Error] Failed to parse JSON state for game ${gameName}:`, parseError, 'Raw data:', row);
                    // Attempt to recover with defaults
                    row.masters = row.masters && typeof row.masters === 'string' ? JSON.parse(row.masters || '[]') : [];
                    row.players = row.players && typeof row.players === 'string' ? JSON.parse(row.players || '[]') : [];
                    row.observers = row.observers && typeof row.observers === 'string' ? JSON.parse(row.observers || '[]') : [];
                    row.options = row.options && typeof row.options === 'string' ? JSON.parse(row.options || '[]') : [];
                    row.settings = row.settings && typeof row.settings === 'string' ? JSON.parse(row.settings || '{}') : {};
                    resolve(row); // Return row with potentially unparsed fields or default empty arrays/objects
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
                        // Safely parse JSON fields
                        row.masters = JSON.parse(row.masters || '[]');
                        row.players = JSON.parse(row.players || '[]');
                        row.observers = JSON.parse(row.observers || '[]');
                        row.options = JSON.parse(row.options || '[]');
                        row.settings = JSON.parse(row.settings || '{}');
                        states[row.name] = row;
                    } catch (parseError) {
                        console.error(`[DB Error] Failed to parse JSON state for game ${row.name} in getAllGameStates:`, parseError);
                        // Assign defaults on parse error
                        row.masters = []; row.players = []; row.observers = []; row.options = []; row.settings = {};
                        states[row.name] = row;
                    }
                }); resolve(states);
            }
        });
    });
};


// Get filtered game states based on criteria
const getFilteredGameStates = (filters = {}) => {
    return new Promise((resolve, reject) => {
        let query = "SELECT * FROM game_states";
        const whereClauses = [];
        const params = [];

        if (filters.status) {
            whereClauses.push("status = ?");
            params.push(filters.status);
        }
        if (filters.variant) {
            whereClauses.push("variant = ?");
            params.push(filters.variant);
        }
        if (filters.phase) {
            whereClauses.push("currentPhase = ?");
            params.push(filters.phase);
        }
        if (filters.player) {
            // Check if the player's email exists within the 'players' JSON array
            // Requires SQLite 3.9.0+ for JSON functions
            whereClauses.push("EXISTS (SELECT 1 FROM json_each(players) WHERE json_extract(value, '$.email') = ?)");
            params.push(filters.player);
        }
        // Add more filters here if needed (e.g., master, observer)

        if (whereClauses.length > 0) {
            query += " WHERE " + whereClauses.join(" AND ");
        }

        query += " ORDER BY name ASC";

        db.all(query, params, (err, rows) => {
            if (err) {
                console.error("[DB Error] Failed to read filtered game states:", err, "Query:", query, "Params:", params);
                reject(err);
            } else {
                const states = {};
                rows.forEach(row => {
                    try {
                        // Safely parse JSON fields
                        row.masters = JSON.parse(row.masters || '[]');
                        row.players = JSON.parse(row.players || '[]');
                        row.observers = JSON.parse(row.observers || '[]');
                        row.options = JSON.parse(row.options || '[]');
                        row.settings = JSON.parse(row.settings || '{}');
                        states[row.name] = row;
                    } catch (parseError) {
                        console.error(`[DB Error] Failed to parse JSON state for game ${row.name} in getFilteredGameStates:`, parseError);
                        // Assign defaults on parse error
                        row.masters = []; row.players = []; row.observers = []; row.options = []; row.settings = {};
                        states[row.name] = row;
                    }
                });
                resolve(states);
            }
        });
    });
};


// Get game counts grouped by status
const getGameCountsByStatus = () => {
    return new Promise((resolve, reject) => {
        db.all("SELECT status, COUNT(*) as count FROM game_states GROUP BY status ORDER BY status", [], (err, rows) => {
            if (err) {
                console.error("[DB Error] Failed to get game counts by status:", err);
                reject(err);
            } else {
                // Ensure 'count' is a number
                const results = rows.map(row => ({ status: row.status, count: Number(row.count) }));
                resolve(results);
            }
        });
    });
};


// --- User Preference DB Helpers ---

// Get all preferences for a user
const getUserPreferences = (userId) => {
    return new Promise((resolve, reject) => {
        db.all("SELECT preference_key, preference_value FROM user_preferences WHERE user_id = ?", [userId], (err, rows) => {
            if (err) {
                console.error(`[DB Error] Failed to get preferences for user ${userId}:`, err);
                reject(err);
            } else {
                const preferences = {};
                rows.forEach(row => {
                    try {
                        // Attempt to parse if it looks like JSON, otherwise return as string
                        if ((row.preference_value?.startsWith('{') && row.preference_value?.endsWith('}')) || (row.preference_value?.startsWith('[') && row.preference_value?.endsWith(']'))) {
                            preferences[row.preference_key] = JSON.parse(row.preference_value);
                        } else {
                            preferences[row.preference_key] = row.preference_value;
                        }
                    } catch (parseError) {
                        console.warn(`[DB Warn] Failed to parse preference '${row.preference_key}' for user ${userId}. Returning raw value. Error:`, parseError);
                        preferences[row.preference_key] = row.preference_value; // Return raw value on parse error
                    }
                });
                resolve(preferences);
            }
        });
    });
};

// Set or update a specific preference for a user
const setUserPreference = (userId, key, value) => {
    return new Promise((resolve, reject) => {
        // Convert non-string values (like objects/arrays) to JSON strings for storage
        const valueToStore = (typeof value === 'string' || value === null || value === undefined) ? value : JSON.stringify(value);
        db.run("INSERT OR REPLACE INTO user_preferences (user_id, preference_key, preference_value) VALUES (?, ?, ?)",
            [userId, key, valueToStore],
            (err) => {
                if (err) {
                    console.error(`[DB Error] Failed to set preference '${key}' for user ${userId}:`, err);
                    reject(err);
                } else {
                    resolve();
                }
            }
        );
    });
};

// Delete a specific preference for a user
const deleteUserPreference = (userId, key) => {
    return new Promise((resolve, reject) => {
        db.run("DELETE FROM user_preferences WHERE user_id = ? AND preference_key = ?", [userId, key], function(err) {
            if (err) {
                console.error(`[DB Error] Failed to delete preference '${key}' for user ${userId}:`, err);
                reject(err);
            } else {
                resolve(this.changes > 0); // Returns true if a row was deleted
            }
        });
    });
};

// Delete all preferences for a user
const deleteAllUserPreferences = (userId) => {
    return new Promise((resolve, reject) => {
        db.run("DELETE FROM user_preferences WHERE user_id = ?", [userId], function(err) {
            if (err) {
                console.error(`[DB Error] Failed to delete all preferences for user ${userId}:`, err);
                reject(err);
            } else {
                resolve(this.changes); // Returns the number of rows deleted
            }
        });
    });
};


// --- Saved Search Bookmark DB Helpers ---

// Get all saved searches for a user
const getSavedSearches = (userId) => {
    return new Promise((resolve, reject) => {
        db.all("SELECT bookmark_name, search_params FROM saved_searches WHERE user_id = ? ORDER BY bookmark_name ASC", [userId], (err, rows) => {
            if (err) {
                console.error(`[DB Error] Failed to get saved searches for user ${userId}:`, err);
                reject(err);
            } else {
                const bookmarks = rows.map(row => ({
                    name: row.bookmark_name,
                    params: JSON.parse(row.search_params || '{}') // Parse JSON params
                }));
                resolve(bookmarks);
            }
        });
    });
};

// Save or update a specific saved search for a user
const saveSavedSearch = (userId, bookmarkName, searchParams) => {
    return new Promise((resolve, reject) => {
        const paramsString = JSON.stringify(searchParams || {});
        db.run("INSERT OR REPLACE INTO saved_searches (user_id, bookmark_name, search_params) VALUES (?, ?, ?)",
            [userId, bookmarkName, paramsString],
            (err) => {
                if (err) {
                    console.error(`[DB Error] Failed to save search bookmark '${bookmarkName}' for user ${userId}:`, err);
                    reject(err);
                } else {
                    console.log(`[DB Success] Saved search bookmark '${bookmarkName}' for user ${userId}`);
                    resolve();
                }
            }
        );
    });
};

// Delete a specific saved search for a user
const deleteSavedSearch = (userId, bookmarkName) => {
    return new Promise((resolve, reject) => {
        db.run("DELETE FROM saved_searches WHERE user_id = ? AND bookmark_name = ?", [userId, bookmarkName], function(err) {
            if (err) {
                console.error(`[DB Error] Failed to delete search bookmark '${bookmarkName}' for user ${userId}:`, err);
                reject(err);
            } else {
                console.log(`[DB Success] Deleted search bookmark '${bookmarkName}' for user ${userId} (if existed)`);
                resolve(this.changes > 0); // Returns true if a row was deleted
            }
        });
    });
};


// --- News DB Helpers ---

// Get all news items, ordered by timestamp descending
const getAllNewsItems = () => {
    return new Promise((resolve, reject) => {
        db.all("SELECT id, timestamp, content FROM news_items ORDER BY timestamp DESC", [], (err, rows) => {
            if (err) {
                console.error("[DB Error] Failed to get news items:", err);
                reject(err);
            } else {
                resolve(rows);
            }
        });
    });
};

// Add a new news item
const addNewsItem = (content) => {
    return new Promise((resolve, reject) => {
        if (!content || typeof content !== 'string' || content.trim().length === 0) {
            return reject(new Error('News content cannot be empty.'));
        }
        db.run("INSERT INTO news_items (content) VALUES (?)", [content.trim()], function(err) {
            if (err) {
                console.error("[DB Error] Failed to add news item:", err);
                reject(err);
            } else {
                console.log(`[DB Success] Added news item with ID: ${this.lastID}`);
                resolve(this.lastID); // Return the ID of the newly inserted item
            }
        });
    });
};

// Delete a news item by ID
const deleteNewsItem = (id) => {
    return new Promise((resolve, reject) => {
        db.run("DELETE FROM news_items WHERE id = ?", [id], function(err) {
            if (err) {
                console.error(`[DB Error] Failed to delete news item with ID ${id}:`, err);
                reject(err);
            } else {
                if (this.changes > 0) {
                    console.log(`[DB Success] Deleted news item with ID: ${id}`);
                    resolve(true); // Indicate success
                } else {
                    console.log(`[DB Info] No news item found with ID: ${id} to delete.`);
                    resolve(false); // Indicate item not found
                }
            }
        });
    });
};

// --- Parsing Helper Functions ---
const parseListOutput = (gameName, output) => {
    console.log(`[Parser LIST] Attempting to parse LIST output for ${gameName}`);
    const gameState = {
        name: gameName, status: 'Unknown', variant: 'Standard', options: [],
        currentPhase: 'Unknown', nextDeadline: null, players: [], masters: [],
        observers: [], settings: {}, rawListOutput: output,
        lastUpdated: Math.floor(Date.now() / 1000)
    };
    const lines = output.split('\n');
    let readingPlayers = false; // Flag to indicate if we are in the player/master list section
    let readingSettings = false; // Flag for settings section

    // --- Regex Definitions ---
    const explicitDeadlineRegex = /::\s*Deadline:\s*([SFUW]\d{4}[MRB][X]?)\s+(.*)/i;
    const activeStatusLineRegex = /Status of the (\w+) phase for (Spring|Summer|Fall|Winter) of (\d{4})\./i;
    const variantRegex = /Variant:\s*(\S+)\s*(.*)/i;
    // Player Regex: Start, Power Name, whitespace, number, whitespace, capture email, rest of line
    const playerLineRegex = /^\s*(Austria|England|France|Germany|Italy|Russia|Turkey|Milan|Florence|Naples|Papacy|Venice)\s+\d+\s+([\w.-]+@[\w.-]+\.\w+).*$/i;
    // Master Regex: Start, Master/Moderator, whitespace, number, whitespace, capture email, rest of line
    const masterLineRegex = /^\s*(?:Master|Moderator)\s+\d+\s+([\w.-]+@[\w.-]+\.\w+).*$/i;
    // Observer Regex: Assuming format "Observer : email@domain.com" - adjust if needed
    const observerLineRegex = /^\s*Observer\s*:\s*([\w.-]+@[\w.-]+\.\w+).*$/i;
    const statusRegex = /Game status:\s*(.*)/i;
    const settingsHeaderRegex = /The parameters for .*? are as follows:|Game settings:/i; // Match both possible headers
    const pressSettingRegex = /Press:\s*(.*?)(?:,|\s*$)/i;
    const diasSettingRegex = /\b(NoDIAS|DIAS)\b/i;
    const nmrSettingRegex = /\b(NMR|NoNMR)\b/i;
    const concessionSettingRegex = /\b(Concessions|No Concessions)\b/i;
    const emailRegex = /[\w.-]+@[\w.-]+\.\w+/; // General email regex for observer line if needed

    // --- Parsing Loop ---
    lines.forEach(line => {
        const trimmedLine = line.trim();
        let match;

        // 1. Check for Explicit Deadline Line
        match = line.match(explicitDeadlineRegex);
        if (match) {
            gameState.currentPhase = match[1].trim();
            gameState.nextDeadline = match[2].trim();
            if (gameState.status === 'Unknown' || gameState.status === 'Forming') {
                 gameState.status = 'Active';
                 console.log(`[Parser LIST ${gameName}] Set status to Active based on explicit deadline line.`);
            }
            // Continue parsing other lines
        }

        // 2. Check for Active Status Line
        match = line.match(activeStatusLineRegex);
        if (match) {
            const phaseTypeStr = match[1].toLowerCase();
            const seasonStr = match[2].toLowerCase();
            const year = match[3];
            let seasonCode = 'S';
            if (seasonStr === 'fall') seasonCode = 'F';
            else if (seasonStr === 'winter') seasonCode = 'W';
            else if (seasonStr === 'summer') seasonCode = 'U';
            let phaseCode = 'M';
            if (phaseTypeStr === 'retreat') phaseCode = 'R';
            else if (phaseTypeStr === 'adjustment' || phaseTypeStr === 'builds') phaseCode = 'A';
            gameState.currentPhase = `${seasonCode}${year}${phaseCode}`;
            gameState.status = 'Active';
            console.log(`[Parser LIST ${gameName}] Parsed active phase info: ${gameState.currentPhase} from line: ${trimmedLine}`);
            // Continue parsing other lines
        }

        // 3. Check for Explicit Status Line
        match = line.match(statusRegex);
        if (match) {
            const explicitStatus = match[1].trim();
            if (explicitStatus !== 'Active' || gameState.status === 'Unknown') {
                 gameState.status = explicitStatus;
                 console.log(`[Parser LIST ${gameName}] Parsed explicit status: ${gameState.status}`);
            }
        }

        // 4. Parse Variant Line
        match = line.match(variantRegex);
        if (match) {
            gameState.variant = match[1].trim();
            const optionsStr = match[2].replace(/,/g, ' ').trim();
            gameState.options = optionsStr.split(/\s+/).filter(opt => opt && opt !== 'Variant:');
            if (gameState.options.includes('Gunboat')) gameState.settings.gunboat = true;
            if (gameState.options.includes('NMR')) gameState.settings.nmr = true; else gameState.settings.nmr = false;
            if (gameState.options.includes('Chaos')) gameState.settings.chaos = true;
            console.log(`[Parser LIST ${gameName}] Parsed variant: ${gameState.variant}, Options: ${gameState.options.join(', ')}`);
        }

        // 5. Check for Player/Master/Observer List Header
        if (trimmedLine.startsWith("The following players are signed up for game")) {
            readingPlayers = true;
            readingSettings = false; // Ensure we stop reading settings if we hit this header again
            console.log(`[Parser LIST ${gameName}] Started reading player/master/observer block.`);
            return; // Move to the next line
        }

        // 6. Parse Player/Master/Observer Lines (only if flag is set)
        if (readingPlayers) {
            const playerMatch = line.match(playerLineRegex);
            const masterMatch = line.match(masterLineRegex);
            const observerMatch = line.match(observerLineRegex);

            if (playerMatch) {
                const power = playerMatch[1];
                const email = playerMatch[2];
                gameState.players.push({ power: power, email: email || null, status: 'Playing', name: null });
                console.log(`[Parser LIST ${gameName}] Parsed Player: ${power} - ${email}`);
            } else if (masterMatch) {
                const email = masterMatch[1];
                if (email && !gameState.masters.includes(email)) {
                    gameState.masters.push(email);
                    console.log(`[Parser LIST ${gameName}] Parsed Master: ${email}`);
                }
            } else if (observerMatch) {
                // Observer regex might need adjustment based on actual output format
                const email = observerMatch[1].trim().match(emailRegex)?.[0];
                if (email && !gameState.observers.includes(email)) {
                    gameState.observers.push(email);
                    console.log(`[Parser LIST ${gameName}] Parsed Observer: ${email}`);
                }
            } else if (!trimmedLine || settingsHeaderRegex.test(line) || activeStatusLineRegex.test(line) || explicitDeadlineRegex.test(line) || line.startsWith("Status of the")) {
                // Stop reading players if we hit settings, status, deadline, blank line, or the "Status of the..." line
                if (readingPlayers) console.log(`[Parser LIST ${gameName}] Stopped reading player/master/observer block on line: "${line}"`);
                readingPlayers = false;
            }
            // If it's none of the above but readingPlayers is true, just ignore the line (could be spacing or sub-headers)
        }

        // 7. Parse Settings Lines
        if (!readingSettings && settingsHeaderRegex.test(trimmedLine)) {
            readingSettings = true;
            readingPlayers = false; // Ensure player reading stops
            console.log(`[Parser LIST ${gameName}] Started reading settings block.`);
            return; // Move to the next line after the header
        }

        if (readingSettings) {
            // Stop reading settings if we encounter a blank line or a line indicating the start of the player list or status
            if (!trimmedLine || trimmedLine.startsWith("The following players are signed up for game") || activeStatusLineRegex.test(line)) {
                 if (readingSettings) console.log(`[Parser LIST ${gameName}] Stopped reading settings block on line: "${line}"`);
                 readingSettings = false;
            } else {
                // Parse specific settings within the block
                match = line.match(pressSettingRegex); if (match) gameState.settings.press = match[1].trim();
                match = line.match(diasSettingRegex); if (match) gameState.settings.dias = (match[1].toUpperCase() === 'DIAS');
                match = line.match(nmrSettingRegex); if (match) gameState.settings.nmr = (match[1].toUpperCase() === 'NMR');
                match = line.match(concessionSettingRegex); if (match) gameState.settings.concessions = (match[1].toLowerCase() === 'concessions');
                // Use includes for flags that might be part of a larger line (like Flags: NoNMR, NoList...)
                if (line.toLowerCase().includes('gunboat')) gameState.settings.gunboat = true;
                if (line.toLowerCase().includes('chaos')) gameState.settings.chaos = true;
                if (line.toLowerCase().includes('partial allowed')) gameState.settings.partialPress = true;
                if (line.toLowerCase().includes('no partial')) gameState.settings.partialPress = false;
                if (line.toLowerCase().includes('observer any')) gameState.settings.observerPress = 'any';
                if (line.toLowerCase().includes('observer white')) gameState.settings.observerPress = 'white';
                if (line.toLowerCase().includes('observer none')) gameState.settings.observerPress = 'none';
                if (line.toLowerCase().includes('strict convoy')) gameState.settings.strictConvoy = true;
                if (line.toLowerCase().includes('strict wait')) gameState.settings.strictWait = true;
                if (line.toLowerCase().includes('strict grace')) gameState.settings.strictGrace = true;
                // Add more settings parsing here
            }
        }
    }); // End lines.forEach

    // --- Final Status Check & Defaults ---
    if (gameState.status === 'Unknown' && gameState.currentPhase && gameState.currentPhase !== 'Unknown') {
        if (gameState.currentPhase.toUpperCase() === 'FORMING') {
            gameState.status = 'Forming';
        } else {
            gameState.status = 'Active';
        }
         console.log(`[Parser LIST ${gameName}] Inferred status '${gameState.status}' from phase '${gameState.currentPhase}'.`);
    }

    // Set defaults for settings if not found
    if (gameState.settings.nmr === undefined) gameState.settings.nmr = false;
    if (gameState.settings.dias === undefined) gameState.settings.dias = true;
    if (gameState.settings.concessions === undefined) gameState.settings.concessions = true;
    if (gameState.settings.gunboat === undefined) gameState.settings.gunboat = false;
    if (gameState.settings.press === undefined) gameState.settings.press = 'White';
    if (gameState.settings.partialPress === undefined) gameState.settings.partialPress = true;
    if (gameState.settings.observerPress === undefined) gameState.settings.observerPress = 'any';

    console.log(`[Parser LIST ${gameName}] Final Parsed State: Status=${gameState.status}, Phase=${gameState.currentPhase}, Variant=${gameState.variant}, Masters=${JSON.stringify(gameState.masters)}, Players=${gameState.players.length}, Settings=`, gameState.settings);
    return gameState;
};

// Simplified WHOGAME parser - LIST output is usually more comprehensive now
const parseWhogameOutput = (gameName, output) => {
    console.log(`[Parser WHOGAME] Attempting to parse WHOGAME output for ${gameName}`);
    const players = []; const masters = []; const observers = [];
    const lines = output.split('\n'); const emailRegex = /[\w.-]+@[\w.-]+\.\w+/;
    lines.forEach(line => {
        const trimmedLine = line.trim(); if (!trimmedLine) return;
        const masterMatch = trimmedLine.match(/^(?:Master|Moderator)\s*:\s*(.*)/i);
        const observerMatch = trimmedLine.match(/^(?:Observer|Watcher)\s*:\s*(.*)/i);
        // Adjusted regex to handle Machiavelli powers
        const powerMatch = trimmedLine.match(/^(Austria|England|France|Germany|Italy|Russia|Turkey|Milan|Florence|Naples|Papacy|Venice)\s*:\s*(.*)/i);
        if (masterMatch) {
            const detail = masterMatch[1].trim(); const email = detail.match(emailRegex)?.[0];
            if (email && !masters.includes(email)) masters.push(email);
        } else if (observerMatch) {
            const detail = observerMatch[1].trim(); const email = detail.match(emailRegex)?.[0];
            if (email && !observers.includes(email)) observers.push(email);
        } else if (powerMatch) {
            const power = powerMatch[1]; const detail = powerMatch[2].trim();
            const email = detail.match(emailRegex)?.[0];
            const name = email ? detail.replace(email, '').replace(/[()]/g, '').trim() : detail;
            players.push({ power: power, email: email || null, name: name || null, status: 'Unknown' }); // Status needs update from LIST
        }
    });
    console.log(`[Parser WHOGAME ${gameName}] Parsed ${players.length} players, ${masters.length} masters, ${observers.length} observers`);
    return { players, masters, observers };
};


// NEW FUNCTION START
// Helper to convert phase string like "Spring 1901 Movement" to "S1901M"
function getPhaseCode(phaseStr, year) {
    if (!phaseStr || !year) return 'Unknown';
    const lowerPhase = phaseStr.toLowerCase();
    let seasonCode = 'S'; // Default Spring
    if (lowerPhase.includes('fall')) seasonCode = 'F';
    else if (lowerPhase.includes('winter')) seasonCode = 'W';
    else if (lowerPhase.includes('summer')) seasonCode = 'U'; // Less common

    let phaseTypeCode = 'M'; // Default Movement
    if (lowerPhase.includes('retreat')) phaseTypeCode = 'R';
    else if (lowerPhase.includes('adjustment') || lowerPhase.includes('build')) phaseTypeCode = 'A';

    // Handle cases where only year/season might be present (e.g., pre-game)
    if (!phaseTypeCode && (seasonCode === 'S' || seasonCode === 'F' || seasonCode === 'W' || seasonCode === 'U')) {
         // If it looks like a phase start but no type, assume Movement for S/F, Build for W
         phaseTypeCode = (seasonCode === 'W') ? 'A' : 'M';
    } else if (!phaseTypeCode) {
        // Fallback if completely unparsable
        return `${year || '?'}${seasonCode || '?'}${phaseTypeCode || '?'}`;
    }


    return `${seasonCode}${year}${phaseTypeCode}`;
}


const parseHistoryOutput = (gameName, output) => {
    console.log(`[Parser HISTORY] Attempting to parse HISTORY output for ${gameName}`);
    const history = {
        gameName: gameName,
        variant: null,
        statusTimestamp: null,
        phases: [],
    };
    const lines = output.split('\n');
    let currentPhaseData = null;
    let readingPress = false;
    let currentPress = null;

    // --- Regex Definitions ---
    const gameHeaderRegex = /^History of (.*) \((.*)\)$/; // 1: gameName, 2: variant
    const statusTimestampRegex = /^Status of the game .* as of (.*)$/; // 1: timestamp
    const deadlineRegex = /^Deadline for (.*), (\d{4}) is (.*)$/; // 1: phaseStr, 2: year, 3: deadlineStr
    const supplyCenterRegex = /^([A-Z][a-z]+): +(\d+) supply centers/; // 1: power, 2: count
    const eliminationRegex = /^([A-Z][a-z]+) has been eliminated\.$/; // 1: power
    const unitRegex = /^([A-Z][a-z]+): +(A|F) +([A-Z][a-z ]+)$/; // 1: power, 2: unitType, 3: location
    const orderResultRegex = /^\*+(.*)\*+$/; // 1: result description
    const pressHeaderRegex = /^Press from (.*) to (.*):$/; // 1: fromPower, 2: toPowerOrAll

    // Order Regex (simplified examples, more robust parsing might be needed)
    const holdOrderRegex = /^([A-Z][a-z]+): +(A|F) +([A-Z][a-z ]+) H(?:old)?$/i; // 1: power, 2: unitType, 3: unitLocation
    const moveOrderRegex = /^([A-Z][a-z]+): +(A|F) +([A-Z][a-z ]+) - ([A-Z][a-z ]+)$/i; // 1: power, 2: unitType, 3: unitLocation, 4: destination
    const supportHoldOrderRegex = /^([A-Z][a-z]+): +(A|F) +([A-Z][a-z ]+) S +(?:A|F) +([A-Z][a-z ]+)$/i; // 1: power, 2: unitType, 3: unitLocation, 4: supportedUnitLocation
    const supportMoveOrderRegex = /^([A-Z][a-z]+): +(A|F) +([A-Z][a-z ]+) S +(?:A|F) +([A-Z][a-z ]+) - ([A-Z][a-z ]+)$/i; // 1: power, 2: unitType, 3: unitLocation, 4: supportedUnitLocation, 5: supportedUnitDestination
    const convoyOrderRegex = /^([A-Z][a-z]+): +(F) +([A-Z][a-z ]+) C +(A) +([A-Z][a-z ]+) - ([A-Z][a-z ]+)$/i; // 1: power, 2: unitType(F), 3: unitLocation, 4: convoyedUnitType(A), 5: convoyedUnitLocation, 6: convoyedUnitDestination
    const retreatOrderRegex = /^([A-Z][a-z]+): +(A|F) +([A-Z][a-z ]+) R +([A-Z][a-z ]+)$/i; // 1: power, 2: unitType, 3: unitLocation, 4: destination
    const disbandOrderRegex = /^([A-Z][a-z]+): +(A|F) +([A-Z][a-z ]+) D(?:isband)?$/i; // 1: power, 2: unitType, 3: unitLocation
    const buildOrderRegex = /^([A-Z][a-z]+): +Build (A|F) +([A-Z][a-z ]+)$/i; // 1: power, 2: unitType, 3: location
    const waiveBuildOrderRegex = /^([A-Z][a-z]+): +Waive Build$/i; // 1: power
    const removeOrderRegex = /^([A-Z][a-z]+): +Remove (A|F) +([A-Z][a-z ]+)$/i; // 1: power, 2: unitType, 3: location
    const waiveRemovalOrderRegex = /^([A-Z][a-z]+): +Waive Removal$/i; // 1: power

    // Function to initialize a phase data object
    const createPhaseData = (phaseCode, deadline) => ({
        phase: phaseCode,
        deadline: deadline,
        supplyCenters: {},
        eliminations: [],
        units: {},
        orders: {},
        results: [], // Store results as simple strings for now
        press: [],
    });

    // --- Parsing Loop ---
    lines.forEach((line, index) => {
        const trimmedLine = line.trim();
        let match;

        // Stop reading press if we hit a non-press line
        if (readingPress && !pressHeaderRegex.test(trimmedLine) && !trimmedLine.startsWith(" ") && trimmedLine !== "") {
             if (currentPress && currentPhaseData) {
                 currentPress.message = currentPress.message.trim();
                 // Only add if message is not empty
                 if (currentPress.message) {
                    currentPhaseData.press.push(currentPress);
                 }
                 console.log(`[Parser HISTORY ${gameName}] Finished reading press from ${currentPress.from} to ${currentPress.to}.`);
             }
             readingPress = false;
             currentPress = null;
        }


        // 1. Game Header
        match = trimmedLine.match(gameHeaderRegex);
        if (match) {
            history.gameName = match[1].trim(); // Update game name if different
            history.variant = match[2].trim();
            console.log(`[Parser HISTORY ${gameName}] Parsed Header: Name=${history.gameName}, Variant=${history.variant}`);
            return; // Continue to next line
        }

        // 2. Status Timestamp
        match = trimmedLine.match(statusTimestampRegex);
        if (match) {
            history.statusTimestamp = match[1].trim();
            console.log(`[Parser HISTORY ${gameName}] Parsed Status Timestamp: ${history.statusTimestamp}`);
            return; // Continue to next line
        }

        // 3. Deadline (Indicates start of a new phase)
        match = trimmedLine.match(deadlineRegex);
        if (match) {
            // Push previous phase data if it exists
            if (currentPhaseData) {
                history.phases.push(currentPhaseData);
                console.log(`[Parser HISTORY ${gameName}] Finished parsing phase: ${currentPhaseData.phase}`);
            }
            readingPress = false; // Ensure press reading stops at phase boundary
            currentPress = null;

            const phaseStr = match[1].trim();
            const year = match[2].trim();
            const deadlineStr = match[3].trim();
            const phaseCode = getPhaseCode(phaseStr, year);
            currentPhaseData = createPhaseData(phaseCode, deadlineStr);
            console.log(`[Parser HISTORY ${gameName}] Started parsing phase: ${phaseCode}, Deadline: ${deadlineStr}`);
            return; // Continue to next line
        }

        // Ensure we have a phase context before parsing phase-specific data
        if (!currentPhaseData) {
            // Skip lines before the first deadline if they aren't global headers
            // console.log(`[Parser HISTORY ${gameName}] Skipping line outside phase context: ${trimmedLine}`);
            return;
        }

        // 4. Supply Centers
        match = trimmedLine.match(supplyCenterRegex);
        if (match) {
            const power = match[1];
            const count = parseInt(match[2], 10);
            currentPhaseData.supplyCenters[power] = count;
            return;
        }

        // 5. Eliminations
        match = trimmedLine.match(eliminationRegex);
        if (match) {
            const power = match[1];
            currentPhaseData.eliminations.push(power);
            return;
        }

        // 6. Unit Positions (typically listed before orders)
        match = trimmedLine.match(unitRegex);
        if (match) {
            const power = match[1];
            const unitType = match[2].toUpperCase();
            const location = match[3].trim();
            if (!currentPhaseData.units[power]) {
                currentPhaseData.units[power] = [];
            }
            // Avoid duplicates if units listed multiple times
            if (!currentPhaseData.units[power].some(u => u.type === unitType && u.location === location)) {
                 currentPhaseData.units[power].push({ type: unitType, location: location });
            }
            return;
        }

        // 7. Order Results
        match = trimmedLine.match(orderResultRegex);
        if (match) {
            currentPhaseData.results.push(match[1].trim());
            return;
        }

        // 8. Press Header
        match = trimmedLine.match(pressHeaderRegex);
        if (match) {
             // Finalize previous press message if one was being read
             if (readingPress && currentPress && currentPhaseData) {
                 currentPress.message = currentPress.message.trim();
                 if (currentPress.message) { // Only add if not empty
                     currentPhaseData.press.push(currentPress);
                 }
             }

            readingPress = true;
            currentPress = {
                from: match[1].trim(),
                to: match[2].trim(),
                message: ''
            };
            console.log(`[Parser HISTORY ${gameName}] Started reading press from ${currentPress.from} to ${currentPress.to}.`);
            return;
        }

        // 9. Press Content
        if (readingPress && currentPress) {
            // Append line to current press message, preserving leading spaces for formatting
            currentPress.message += line + '\n'; // Keep original line ending for multi-line
            return;
        }

        // 10. Orders (Check various types) - Store raw order string for now
        // More detailed parsing could create structured order objects
        const parseOrder = (regex, orderType) => {
             match = trimmedLine.match(regex);
             if (match) {
                 const power = match[1];
                 if (!currentPhaseData.orders[power]) {
                     currentPhaseData.orders[power] = [];
                 }
                 // Store the raw line as the order for simplicity, could parse details later
                 currentPhaseData.orders[power].push({ raw: trimmedLine, type: orderType });
                 return true; // Indicate match found
             }
             return false;
        };

        if (parseOrder(holdOrderRegex, 'Hold')) return;
        if (parseOrder(moveOrderRegex, 'Move')) return;
        if (parseOrder(supportHoldOrderRegex, 'Support Hold')) return;
        if (parseOrder(supportMoveOrderRegex, 'Support Move')) return;
        if (parseOrder(convoyOrderRegex, 'Convoy')) return;
        if (parseOrder(retreatOrderRegex, 'Retreat')) return;
        if (parseOrder(disbandOrderRegex, 'Disband')) return;
        if (parseOrder(buildOrderRegex, 'Build')) return;
        if (parseOrder(waiveBuildOrderRegex, 'Waive Build')) return;
        if (parseOrder(removeOrderRegex, 'Remove')) return;
        if (parseOrder(waiveRemovalOrderRegex, 'Waive Removal')) return;

        // If line didn't match anything known, log it (optional)
        // if (trimmedLine) {
        //     console.log(`[Parser HISTORY ${gameName}] Unmatched line in phase ${currentPhaseData?.phase}: ${trimmedLine}`);
        // }

    }); // End lines.forEach

    // Push the last phase's data if it exists
    if (currentPhaseData) {
         // Finalize any pending press message
         if (readingPress && currentPress) {
             currentPress.message = currentPress.message.trim();
             if (currentPress.message) { // Only add if not empty
                 currentPhaseData.press.push(currentPress);
             }
         }
        history.phases.push(currentPhaseData);
        console.log(`[Parser HISTORY ${gameName}] Finished parsing final phase: ${currentPhaseData.phase}`);
    }

    console.log(`[Parser HISTORY ${gameName}] Final Parsed Object:`, history); // Log the full object for debugging
    return history;
};


// --- Map Info Parsing Function ---
const parseMapInfoFile = async (variantName) => {
    if (!variantName || typeof variantName !== 'string') {
        console.error('[Map Parse Error] Invalid variant name provided:', variantName);
        throw new Error('Invalid variant name provided.');
    }

    // Check cache first
    if (mapInfoCache[variantName]) {
        console.log(`[Map Parse Cache] Returning cached info for variant: ${variantName}`);
        return mapInfoCache[variantName];
    }

    console.log(`[Map Parse] Parsing info file for variant: ${variantName}`);
    const filePath = path.join(__dirname, 'scripts', 'mapit', 'maps', `${variantName}.info`);
    let fileContent;

    try {
        fileContent = await fs.promises.readFile(filePath, 'utf-8');
    } catch (error) {
        console.error(`[Map Parse Error] Could not read file ${filePath}:`, error);
        // Decide how to handle: throw error, return null, return default structure?
        // For now, let's throw, as the caller likely needs this data.
        throw new Error(`Failed to read map info file for variant ${variantName}.`);
    }

    const lines = fileContent.split(/\r?\n/);
    const mapData = {
        powers: [],
        provinces: {}
    };
    let parsingSection = 'powers'; // Start by parsing powers

    // Regex to capture province data: X Y |ABR|---|FullName|...
    // Handles optional spaces around delimiters and captures relevant parts.
    // Group 1: X, Group 2: Y, Group 3: ABR, Group 4: FullName
    const provinceRegex = /^\s*(\d+)\s+(\d+)\s*\|([A-Z]{3})\|(?:[^|]*?\|){1}([^|]+)\|/;

    for (const line of lines) {
        const trimmedLine = line.trim();

        // Skip empty lines and comments
        if (!trimmedLine || trimmedLine.startsWith('#')) {
            continue;
        }

        if (parsingSection === 'powers') {
            if (trimmedLine === '-1') {
                parsingSection = 'provinces'; // Switch to parsing provinces
            } else {
                // Assuming power names don't contain special characters needing complex parsing
                mapData.powers.push(trimmedLine);
            }
        } else if (parsingSection === 'provinces') {
            const match = trimmedLine.match(provinceRegex);
            if (match) {
                const [, x, y, abbr, name] = match;
                const provinceName = name.trim(); // Trim whitespace from name
                if (abbr && provinceName) {
                     mapData.provinces[abbr] = {
                         name: provinceName,
                         abbr: abbr,
                         x: parseInt(x, 10),
                         y: parseInt(y, 10)
                     };
                } else {
                    console.warn(`[Map Parse Warn] Skipping province line with missing data in ${variantName}: ${line}`);
                }
            } else {
                // Log lines that don't match the expected province format (and aren't comments/empty)
                console.warn(`[Map Parse Warn] Unrecognized line format in province section of ${variantName}: ${line}`);
            }
        }
    }

     if (mapData.powers.length === 0 && Object.keys(mapData.provinces).length === 0) {
         console.warn(`[Map Parse Warn] No powers or provinces found for variant ${variantName}. Check file format.`);
         // Optionally throw an error or return a specific indicator of failure/empty data
     }

    // Cache the result before returning
    mapInfoCache[variantName] = mapData;
    console.log(`[Map Parse Success] Parsed and cached info for variant: ${variantName}`);
    return mapData;
};
// NEW FUNCTION END

// --- Command Recommendation Logic ---
const getRecommendedCommands = (gameState, userEmail) => {
    console.log(`[getRecommendedCommands] Generating for user: ${userEmail}, Game State:`, gameState ? { name: gameState.name, status: gameState.status, phase: gameState.currentPhase, masters: gameState.masters } : null); // Log input

    const recommendations = {
        recommended: [], playerActions: [], settings: [],
        gameInfo: [], master: [], general: [],
    };

    // Define all possible commands (keep this list comprehensive)
    const allCommands = [ /* ... Keep the full list from previous version ... */ ];
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
        'SET WHITE', 'SET WHITE/GREY', 'SET VARIANT', 'SET NOT VARIANT', 'SET ANY CENTER', 'SET ANY DISBAND',
        'SET ATTACK TRANSFORM', 'SET AUTO DISBAND', 'SET BCENTERS', 'SET BLANK BOARD', 'SET EMPTY BOARD', 'SET CENTERS',
        'SET COASTAL CONVOYS', 'SET DISBAND', 'SET DUALITY', 'SET GATEWAYS', 'SET HOME CENTER', 'SET HONG KONG',
        'SET NORMAL DISBAND', 'SET ONE CENTER', 'SET PLAYERS', 'SET PORTAGE', 'SET POWERS', 'SET PROXY', 'SET RAILWAYS',
        'SET REVEAL', 'SET SECRET', 'SET SHOW', 'SET SUMMER', 'SET TOUCH PRESS', 'SET TRANSFORM', 'SET TRAFO',
        'SET ADJACENT', 'SET ADJACENCY', 'SET ASSASSINS', 'SET ASSASSINATION', 'SET BANK', 'SET BANKERS', 'SET LOANS',
        'SET DICE', 'SET FAMINE', 'SET FORT', 'SET FORTRESS', 'SET GARRISON', 'SET MACH2', 'SET MONEY', 'SET PLAGUE',
        'SET SPECIAL', 'SET STORM'
    ];

    // Assign all commands to basic categories first
    recommendations.general = [...generalCmds, ...playerAccountCmds];
    recommendations.gameInfo = [...joiningCmds];
    recommendations.playerActions = [...playerActionCmds];
    recommendations.settings = [...playerSettingCmds];
    recommendations.master = [...masterCmds];

    // Refine based on context
    if (!gameState || !userEmail) { // No game context or user email
        console.log("[getRecommendedCommands] No game state or user email provided.");
        recommendations.recommended = ['SIGN ON ?', 'SIGN ON ?game', 'SIGN ON power', 'OBSERVE', 'LIST', 'CREATE ?'];
    } else {
        // Determine user's role
        // Ensure masters array exists and is an array before checking includes
        const userIsMaster = Array.isArray(gameState.masters) && gameState.masters.includes(userEmail);
        const myPlayerInfo = Array.isArray(gameState.players) ? gameState.players.find(p => p.email === userEmail) : null;
        const userIsPlayer = !!myPlayerInfo;
        const userIsObserver = Array.isArray(gameState.observers) && gameState.observers.includes(userEmail) && !userIsPlayer && !userIsMaster;

        const phase = gameState.currentPhase?.toUpperCase() || 'UNKNOWN';
        // Ensure status check is case-insensitive and handles potential null/undefined
        const status = gameState.status?.toUpperCase() || 'UNKNOWN';
        const playerStatus = myPlayerInfo?.status?.toUpperCase() || 'UNKNOWN';
        const isActivePlayer = userIsPlayer && !['CD', 'RESIGNED', 'ABANDONED', 'ELIMINATED'].includes(playerStatus);

        console.log(`[getRecommendedCommands] Role Check: Master=${userIsMaster}, Player=${userIsPlayer}, Observer=${userIsObserver}, ActivePlayer=${isActivePlayer}`);
        console.log(`[getRecommendedCommands] Game Status: ${status}, Phase: ${phase}`);

        // --- Recommendations based on Status ---
        if (status === 'FORMING') {
            console.log("[getRecommendedCommands] Status: FORMING");
            if (userIsPlayer) recommendations.recommended.push('SET PREFERENCE');
            else if (!userIsMaster && !userIsObserver) recommendations.recommended.push('SIGN ON ?game');
            if (userIsMaster) recommendations.recommended.push('FORCE BEGIN', 'SET');
            recommendations.recommended.push('LIST', 'WHOGAME');
        } else if (status === 'ACTIVE') {
            console.log("[getRecommendedCommands] Status: ACTIVE");
            // Player recommendations
            if (isActivePlayer) {
                console.log("[getRecommendedCommands] User is Active Player.");
                // Check phase for ORDERS (Movement, Retreat, Build/Adjust)
                if (phase.endsWith('M') || phase.endsWith('R') || phase.endsWith('B') || phase.endsWith('A')) {
                    recommendations.recommended.push('ORDERS');
                }
                if (gameState.settings?.press !== 'None') {
                    recommendations.recommended.push('PRESS', 'BROADCAST');
                }
                if (gameState.settings?.wait !== false) recommendations.recommended.push('SET WAIT');
                if (gameState.settings?.dias !== false || gameState.settings?.dias === undefined) {
                    recommendations.recommended.push('SET DRAW');
                }
                if (gameState.settings?.concessions !== false) {
                    recommendations.recommended.push('SET CONCEDE');
                }
                recommendations.recommended.push('DIARY');
            }
            // Observer recommendations
            else if (userIsObserver && gameState.settings?.observerPress !== 'none' && gameState.settings?.press !== 'None') {
                console.log("[getRecommendedCommands] User is Observer with Press rights.");
                 recommendations.recommended.push('PRESS', 'BROADCAST');
            }
            // Uninvolved user recommendations
            else if (!userIsPlayer && !userIsMaster && !userIsObserver) {
                console.log("[getRecommendedCommands] User is not involved.");
                 recommendations.recommended.push('SIGN ON power', 'OBSERVE');
            }
            // Master recommendations
            if (userIsMaster) {
                console.log("[getRecommendedCommands] User is Master.");
                 recommendations.recommended.push('PROCESS', 'SET DEADLINE', 'PAUSE', 'EJECT', 'BECOME');
                 // Add more common master actions if desired
            }
            // General recommendations for active games
            recommendations.recommended.push('LIST', 'HISTORY', 'SUMMARY', 'WHOGAME');

        } else if (status === 'PAUSED') {
            console.log("[getRecommendedCommands] Status: PAUSED");
             if (userIsMaster) recommendations.recommended.push('RESUME', 'TERMINATE');
             if (gameState.settings?.press !== 'None' && (isActivePlayer || (userIsObserver && gameState.settings?.observerPress !== 'none'))) {
                 recommendations.recommended.push('PRESS', 'BROADCAST');
             }
             recommendations.recommended.push('LIST', 'HISTORY', 'SUMMARY', 'WHOGAME');
        } else if (status === 'FINISHED' || status === 'TERMINATED') {
            console.log("[getRecommendedCommands] Status: FINISHED/TERMINATED");
             recommendations.recommended = ['HISTORY', 'SUMMARY', 'LIST'];
             if (userIsMaster) recommendations.recommended.push('ROLLBACK', 'UNSTART');
        } else { // Unknown status
            console.log("[getRecommendedCommands] Status: UNKNOWN");
             recommendations.recommended = ['LIST', 'HISTORY', 'SUMMARY', 'WHOGAME'];
             if (!userIsPlayer && !userIsMaster && !userIsObserver) recommendations.recommended.push('SIGN ON power', 'OBSERVE');
        }

        // --- Adjust Categories ---
        if (userIsPlayer || userIsMaster || userIsObserver) {
            recommendations.gameInfo = recommendations.gameInfo.filter(cmd => !joiningCmds.includes(cmd));
        }
        recommendations.gameInfo.push('LIST', 'HISTORY', 'SUMMARY', 'WHOGAME');

        if (!userIsMaster) {
            recommendations.master = [];
        }
        if (!userIsPlayer && !userIsObserver && !userIsMaster) {
            recommendations.playerActions = [];
            recommendations.settings = [];
        } else if (userIsObserver && !userIsMaster) {
            recommendations.playerActions = recommendations.playerActions.filter(cmd => ['RESIGN', 'WITHDRAW', 'PRESS', 'BROADCAST'].includes(cmd));
            recommendations.settings = [];
        }
    }

    // --- Final Cleanup ---
    const allListedCmds = new Set([
        ...recommendations.recommended, ...recommendations.playerActions, ...recommendations.settings,
        ...recommendations.gameInfo, ...recommendations.master, ...recommendations.general
    ]);
    if (!allListedCmds.has('MANUAL')) {
        recommendations.general.push('MANUAL');
    }

    const uniqueCommands = new Set();
    const filterUniqueAndSort = (arr) => arr.filter(cmd => {
        if (uniqueCommands.has(cmd) || cmd === 'REGISTER' || cmd === 'SIGN OFF') return false;
        uniqueCommands.add(cmd);
        return true;
    }).sort();

    const finalRecommendations = {};
    for (const key in recommendations) {
        finalRecommendations[key] = filterUniqueAndSort(recommendations[key]);
    }

    console.log(`[getRecommendedCommands] Final Recommendations:`, finalRecommendations); // Log final output
    return finalRecommendations;
};
// --- Dip Execution Function ---
// Takes email, command, and optional game context (name, password, variant)
const executeDipCommand = (email, command, targetGame = null, targetPassword = null, targetVariant = null) => {
    return new Promise(async (resolve, reject) => { // Make async to await getGameState
        const now = new Date();
        let fullCommand = command.trim();
        const commandParts = fullCommand.split(/\s+/);
        const commandVerb = commandParts[0].toUpperCase();

        // Commands that *don't* need game context prepended (SIGN ON handled separately)
        const noContextCommands = [
            'REGISTER', 'WHOIS', 'INFO', 'GET', 'VERSION', 'HELP', 'LIST', // Global info
            'CREATE', // Initiating game interaction
            'SET PASSWORD', 'SET ADDRESS', // User account settings
            'MANUAL', // User explicitly handles everything
            'I AM ALSO', 'GET DEDICATION', 'INFO PLAYER', 'SEND', 'MAP' // More info/account commands
        ];

        // Commands that *might* take a game name but don't require SIGN ON if provided
        const gameNameOptionalCommands = ['LIST', 'HISTORY', 'SUMMARY', 'WHOGAME', 'OBSERVE', 'WATCH'];

        let requiresSignOn = false;

        if (commandVerb === 'SIGN' && command.toUpperCase().includes(' ON ')) {
            // SIGN ON itself doesn't need a prefix, it *is* the prefix/context setter
            requiresSignOn = false;
        } else if (noContextCommands.includes(commandVerb)) {
            requiresSignOn = false;
        } else if (gameNameOptionalCommands.includes(commandVerb) && commandParts.length > 1) {
            // Check if the second part looks like a game name and not a keyword
            const potentialGameName = commandParts[1];
            const keywords = ['FULL', 'FROM', 'TO', 'LINES', 'EXCLSTART', 'EXCLEND', 'BROAD'];
            if (/^[a-zA-Z0-9]{1,8}$/.test(potentialGameName) && !keywords.includes(potentialGameName.toUpperCase())) {
                 // Command provides its own game context, no SIGN ON needed
                 requiresSignOn = false;
                 // Update targetGame if specified differently
                 if (targetGame && targetGame !== potentialGameName) {
                     console.log(`[Execute Prep] Command ${commandVerb} specifies game '${potentialGameName}', using it instead of context '${targetGame}' for this execution.`);
                     targetGame = potentialGameName; // Use the command's game for this specific execution
                 } else if (!targetGame) {
                     targetGame = potentialGameName;
                 }
            } else {
                 // Doesn't look like a game name, assume it needs context if targetGame is set
                 requiresSignOn = !!targetGame;
            }
        } else {
            // Default: Assume context is needed if a target game is selected
            requiresSignOn = !!targetGame;
        }


        let signOnPrefix = null;
        if (requiresSignOn) {
            if (!targetGame || !targetPassword) {
                return reject({ success: false, output: `Error: Command "${commandVerb}" requires a target game and password, but none were provided or inferred.` });
            }

            // Determine the correct SIGN ON prefix (Variant > Role > Default)
            const variant = targetVariant; // Use the passed-in variant

            if (variant && variant.trim() !== '') {
                // Variant logic: Use the specific format requested, overriding role-based prefix
                const cleanVariant = variant.trim();
                // Use SIGN ON ?game password variant format
                signOnPrefix = `SIGN ON ?${targetGame} ${targetPassword} ${cleanVariant}`;
                console.log(`[Execute Prep] Using variant sign-on for ${email} on game ${targetGame} with variant ${cleanVariant}`);
            } else {
                // No variant: Use role-based logic
                try {
                    const gameState = await getGameState(targetGame);
                    if (!gameState) {
                         console.warn(`[Execute Prep] Game ${targetGame} not in DB. Assuming join/observe sign-on ('?') for command ${commandVerb}.`);
                         signOnPrefix = `SIGN ON ?${targetGame} ${targetPassword}`;
                    } else {
                        const userIsMaster = gameState.masters?.includes(email);
                        const myPlayerInfo = gameState.players?.find(p => p.email === email);
                        const userIsPlayer = !!myPlayerInfo;
                        const userPowerInitial = userIsPlayer ? myPlayerInfo.power?.charAt(0).toUpperCase() : null;
                        const userIsObserver = gameState.observers?.includes(email) && !userIsPlayer && !userIsMaster;

                        if (userIsPlayer && userPowerInitial) {
                            signOnPrefix = `SIGN ON ${userPowerInitial}${targetGame} ${targetPassword}`;
                        } else if (userIsMaster) {
                            // Masters sign on with 'M' initial (convention, might vary)
                            signOnPrefix = `SIGN ON M${targetGame} ${targetPassword}`;
                        } else if (userIsObserver) {
                             // Observers sign on with 'O' initial (convention, might vary)
                            signOnPrefix = `SIGN ON O${targetGame} ${targetPassword}`;
                        } else {
                             console.warn(`[Execute Prep] User ${email} not found as player/master/observer in ${targetGame}. Assuming join/observe sign-on ('?') for command ${commandVerb}.`);
                             signOnPrefix = `SIGN ON ?${targetGame} ${targetPassword}`;
                        }
                    }
                } catch (dbErr) {
                    console.error(`[Execute Prep] DB Error checking user role for ${email} in ${targetGame}:`, dbErr);
                    return reject({ success: false, output: `Database error checking user role for game ${targetGame}.` });
                }
            }

            // Apply the determined prefix
            if (signOnPrefix) {
                fullCommand = `${signOnPrefix}\n${fullCommand}`;
                console.log(`[Execute Prep] Prepended "${signOnPrefix.split(' ')[0]}..." for user ${email} on game ${targetGame} for command ${commandVerb}`);
            } else { // Should only happen if requiresSignOn was true but no prefix could be determined (e.g., DB error handled above)
                 console.error(`[Execute Prep] Could not determine SIGN ON prefix for user ${email} on game ${targetGame} for command ${commandVerb}. Proceeding without prefix.`);
            }
        }

        // Ensure SIGN OFF is present, avoid duplicates if user typed it
        if (!fullCommand.toUpperCase().endsWith('SIGN OFF')) {
            fullCommand += '\nSIGN OFF';
        }
        const dipInput = `FROM: ${email}\nTO: ${judgeEmail}\nSubject: njudge-web via ${email}\nDate: ${now.toUTCString()}\n\n${fullCommand}\n`;

        console.log(`[Execute] User ${email} executing: Command=${dipBinaryPath}, Args=${[...dipBinaryArgs].join(' ')}, Input=${dipInput.substring(0, 200).replace(/\n/g, '\\n')}...`);

        let stdoutData = '';
        let stderrData = '';
        let processError = null;

        const dipProcess = spawn(dipBinaryPath, dipBinaryArgs, { timeout: 30000, cwd: dipBinaryRootPath }); // Increased timeout

        dipProcess.stdout.on('data', (data) => { stdoutData += data.toString(); });
        dipProcess.stderr.on('data', (data) => { stderrData += data.toString(); console.error(`Stderr chunk for ${email} (${commandVerb}): ${data}`); });
        dipProcess.on('error', (err) => { console.error(`[Execute Error] Spawn Error for ${email}: ${err.message}`); processError = err; if (!dipProcess.killed) dipProcess.kill(); });

        dipProcess.on('close', (code, signal) => {
            console.log(`[Execute] Dip process for ${email} closed with code ${code}, signal ${signal}`);
            const output = `--- stdout ---\n${stdoutData}\n--- stderr ---\n${stderrData}`;
            const executionSuccess = code === 0 && signal === null;

            if (processError) {
                return reject({ success: false, output: `Spawn failed: ${processError.message}\n\n${output}` });
            }
            if (!executionSuccess) {
                 console.error(`[Execute Error] Execution Failed for ${email}: Exit code ${code}, Signal ${signal}`);
                 let errorMsg = `Execution failed: Exit code ${code}, Signal ${signal}`;
                 if (stderrData.includes('command not found') || stderrData.includes('No such file')) {
                     errorMsg += `\n\nPossible cause: dip binary path incorrect or binary not executable. Check DIP_BINARY_PATH in .env and permissions.`;
                 } else if (stderrData.includes('timeout')) {
                      errorMsg += `\n\nPossible cause: Command took too long to execute.`;
                 }
                 // Include judge output in the error message if available
                 errorMsg += `\n\n${output}`;
                 return reject({ success: false, output: errorMsg });
            }

            // Resolve with success and output
            resolve({ success: true, output: output, stdout: stdoutData, stderr: stderrData });
        });

        try {
            dipProcess.stdin.write(dipInput);
            dipProcess.stdin.end();
        } catch (stdinError) {
            console.error(`[Execute Error] Error writing to dip process stdin for ${email}: ${stdinError.message}`);
            if (!dipProcess.killed) dipProcess.kill();
            reject({ success: false, output: `Error communicating with adjudicator process: ${stdinError.message}` });
        }
    });
};



// --- Map Data Helper ---

/**
 * Fetches and combines map data (geometry, metadata, game state) for a specific game phase.
 * @param {string} gameName - The name of the game.
 * @param {string} [phase] - The specific phase (e.g., 'S1901M'). If omitted, fetches the latest phase.
 * @returns {Promise<object|null>} - Combined map data or null if essential data is missing.
 */
async function getMapData(gameName, phase, res) { // Added res parameter
    console.log(`[getMapData] Entering with gameName: ${gameName}, phase: ${phase}`); // Roo Debug Log
    console.log(`[Map Data] Fetching map data for game: ${gameName}, phase: ${phase || 'latest'}`);
    try {
        // 1. Get basic game info (like variant) and potentially latest phase if needed
        const basicGameState = await getGameState(gameName);
        console.error(`[getMapData Error] Game not found: ${gameName}`); // Roo Debug Log
        if (!basicGameState) {
            console.error(`[Map Data Error] Game not found: ${gameName}`);
        console.log(`[getMapData] Fetched gameState:`, gameState ? gameState.name : 'Not Found'); // Roo Debug Log
            return null;
        }
        const variantName = basicGameState.variant || 'Standard'; // Default to Standard if not set

        console.error(`[getMapData Error] Variant not found for game: ${gameName}`); // Roo Debug Log
        // 2. Fetch full game history
        // Use judgeEmail or a system identity for fetching public data
    console.log(`[getMapData] Determined variant: ${variant}`); // Roo Debug Log
        const historyOutput = await executeDipCommand(judgeEmail, 'HISTORY', gameName);
        if (!historyOutput || historyOutput.error) {
            console.error(`[Map Data Error] Failed to fetch history for ${gameName}:`, historyOutput?.error || 'No output');
            return null;
        console.log(`[getMapData] Phase not provided, determining latest phase...`); // Roo Debug Log
        }

        // 3. Parse history
        const parsedHistory = parseHistoryOutput(gameName, historyOutput.output);
        if (!parsedHistory || Object.keys(parsedHistory.phases).length === 0) {
            console.error(`[Map Data Error] Failed to parse history or no phases found for ${gameName}`);
            // Return basic info if history parsing fails but we have variant/map info?
            // For now, let's return null as state is crucial.
            console.log(`[getMapData] Parsed history output for latest phase:`, historyData ? 'Success' : 'Failure'); // Roo Debug Log
            return null;
        }

        // 4. Determine the target phase code
        let targetPhaseCode = phase;
        if (!targetPhaseCode) {
            console.error(`[getMapData Error] Failed to parse history to find latest phase for game: ${gameName}`); // Roo Debug Log
            // Find the latest phase from parsed history keys
            const phaseKeys = Object.keys(parsedHistory.phases).sort(); // Simple sort often works for standard phases
            // TODO: Implement more robust phase sorting if needed (e.g., considering year and season)
            targetPhaseCode = phaseKeys[phaseKeys.length - 1];
            console.log(`[Map Data] No phase specified, using latest: ${targetPhaseCode}`);
        }

        const phaseData = parsedHistory.phases[targetPhaseCode];
    console.log(`[getMapData] Target phase determined as: ${targetPhase}`); // Roo Debug Log
        if (!phaseData) {
            console.error(`[Map Data Error] Target phase ${targetPhaseCode} not found in history for ${gameName}`);
            return null; // Phase not found
        }

        console.error(`[getMapData Error] Latest phase could not be determined for game: ${gameName}`); // Roo Debug Log
        // 5. Get province metadata from .info file (using cache)
        const provinceMetadata = await parseMapInfoFile(variantName);
        if (!provinceMetadata) {
            console.error(`[Map Data Error] Failed to parse map info file for variant: ${variantName}`);
            // Proceed without province metadata? Or fail? Let's proceed for now.
        }
        console.log(`[getMapData] Parsed map info file result:`, mapInfo ? 'Success' : 'Failure/Cached'); // Roo Debug Log

        // 6. Construct SVG path and read SVG file content
        const svgPath = path.join('scripts', 'mapit', 'maps', `${variantName}.svg`);
        console.error(`[getMapData Error] Failed to parse map info file for variant: ${variant}`); // Roo Debug Log
        let svgContent = null;
        try {
            svgContent = await fsPromises.readFile(svgPath, 'utf-8');
            console.log(`[Map Data] Successfully read SVG file: ${svgPath}`);
        } catch (err) {
            if (err.code === 'ENOENT') {
    console.log(`[getMapData] Constructed SVG path: ${svgPath}`); // Roo Debug Log
                console.warn(`[Map Data] SVG file not found, expected at: ${svgPath}. Proceeding without SVG content.`);
            } else {
                console.error(`[Map Data Error] Error reading SVG file ${svgPath}:`, err);
        console.warn(`[getMapData Warn] SVG file not found at path: ${svgPath}`); // Roo Debug Log
            }
        console.log(`[getMapData] Attempting to read SVG file...`); // Roo Debug Log
            // Proceed without SVG content if not found or error reading
        }
        console.log(`[getMapData] SVG file read successfully.`); // Roo Debug Log

        // 7. Combine data
        const mapData = {
            gameName: gameName,
            phase: targetPhaseCode,
            variant: variantName,
            units: phaseData.units || [], // Ensure arrays exist
            supplyCenters: phaseData.supplyCenters || [], // Ensure arrays exist
            provinces: provinceMetadata ? provinceMetadata.provinces : {},
            provinceNameToAbbr: provinceMetadata ? provinceMetadata.provinceNameToAbbr : {},
            abbrToProvinceName: provinceMetadata ? provinceMetadata.abbrToProvinceName : {},
            svgContent: svgContent,
            // Include deadline if available in phaseData?
            deadline: phaseData.deadline || null
        };

        console.log(`[Map Data] Successfully assembled map data for ${gameName} / ${targetPhaseCode}`);
    console.log(`[getMapData] Returning success with SVG content.`); // Roo Debug Log
        return mapData;

    } catch (error) {
        console.error(`[Map Data Fatal Error] Unexpected error fetching map data for ${gameName} / ${phase || 'latest'}:`, error);
        // Send 500 response directly if headers haven't been sent
        if (res && !res.headersSent) {
             res.status(500).json({
                 error: "Failed to generate map data.",
                 details: error.message || 'An unexpected error occurred.'
             });
        }
        // Do not return null here; response is handled. Let the function return undefined implicitly.
    }
    // Removed redundant console.error log from outside the catch block
}


// --- API Endpoints ---

// --- Express App Setup ---
const app = express();
const port = process.env.PORT || 3000;
const sessionSecret = process.env.SESSION_SECRET;

if (!sessionSecret || sessionSecret === 'your-very-secret-key') {
    console.warn('\n!!! WARNING: SESSION_SECRET is not set or is using the default value in .env !!!');
    console.warn('!!! Please set a strong, random secret for session management in production. !!!\n');
}

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(expressLayouts);
app.set('layout', 'layout');
app.set("layout extractScripts", true);
app.set("layout extractStyles", true);

app.use(cookieParser()); // Added cookie parser

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use(session({
    store: new SQLiteStore({ db: 'sessions.db', dir: __dirname, table: 'sessions', concurrentDB: true }),
    secret: sessionSecret || 'fallback-secret-change-me',
    resave: false,
    saveUninitialized: false,
    cookie: { secure: process.env.NODE_ENV === 'production', httpOnly: true, maxAge: 1000 * 60 * 60 * 24 * 7 } // 1 week
}));

// Roo Debug: Log all requests after session middleware
app.use((req, res, next) => {
  console.log(`[Request Logger] Path: ${req.path}, Method: ${req.method}, User: ${req.session?.email}`);
  next();
});

// Middleware to ensure email is in session
function requireEmail(req, res, next) {
    if (!req.session.email) {
        // Clear any potentially stale game cookies if session is lost
        res.clearCookie('targetGame');
        // Clear all game-specific password/variant cookies (more robust)
        Object.keys(req.cookies).forEach(cookieName => {
             if (cookieName.startsWith('targetPassword_') || cookieName.startsWith('targetVariant_')) {
                 res.clearCookie(cookieName);
             }
        });
        if (req.path === '/') return next(); // Allow access to root
        if (req.xhr || req.headers.accept.indexOf('json') > -1) {
             return res.status(401).json({ success: false, output: 'Session expired or invalid. Please reload.' });
        }
        return res.redirect('/');
    }
    res.locals.user = req.session.email; // Make email available in all views
    next();
}

// Middleware to require authentication for API routes
function requireAuth(req, res, next) {
    console.log(`[Auth Check] Middleware entered for path: ${req.path}, User: ${req.session?.email}`); // Roo Debug Log
    if (req.session && req.session.email) {
        // Attach userId (email) to the request object for convenience in route handlers
        req.userId = req.session.email;
        next(); // User is authenticated, proceed
    } else {
        res.status(401).json({ success: false, message: 'Authentication required.' });
    }
}

// --- Routes ---

app.get('/', (req, res) => {
    if (req.session.email) {
        return res.redirect('/dashboard');
    }
    res.render('index', { layout: false });
});

app.post('/start', async (req, res) => {
    const email = req.body.email;
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { // Basic email format check
        return res.render('index', { layout: false, error: 'Please enter a valid email address.' });
    }
    try {
        await ensureUserExists(email); // Add/update user in our tracking DB
        req.session.email = email;
        // Clear any old game context on new login
        res.clearCookie('targetGame');
        Object.keys(req.cookies).forEach(cookieName => {
             if (cookieName.startsWith('targetPassword_') || cookieName.startsWith('targetVariant_')) {
                 res.clearCookie(cookieName);
             }
        });
        req.session.save(err => {
            if (err) { console.error("Session save error on /start:", err); return res.render('index', { layout: false, error: 'Session error. Please try again.' }); }
            res.redirect('/dashboard');
        });
    } catch (err) {
         console.error("Error ensuring user exists:", err);
         res.render('index', { layout: false, error: 'Database error. Please try again.' });
    }
});

// Display registration form
app.get('/register', requireEmail, (req, res) => {
     res.render('register', { email: req.session.email, error: null, formData: {} });
});

// Handle registration submission
app.post('/register', requireEmail, async (req, res) => {
    const email = req.session.email;
    const { name, address, phone, country, level, site } = req.body;

    // Basic validation
    if (!name || !address || !phone || !country || !level || !site) {
        return res.render('register', { email: email, error: 'All fields are required.', formData: req.body });
    }

    // Construct REGISTER command carefully, ensuring newlines
    const registerCommand = `REGISTER
name: ${name}
address: ${address}
phone: ${phone}
country: ${country}
level: ${level}
e-mail: ${email}
site: ${site}
package: yes
END`;

    try {
        // Registration doesn't need game context
        const result = await executeDipCommand(email, registerCommand);

        const outputLower = result.stdout.trim().toLowerCase();
        // Check for various success messages
        if (outputLower.includes("registration accepted") ||
            outputLower.includes("updated registration") ||
            outputLower.includes("already registered") ||
            outputLower.includes("this is an update to an existing registration")) {
            await setUserRegistered(email); // Mark as registered in our DB
            console.log(`[Register Success] User ${email} registered with judge.`);
            req.session.save(err => {
                 if (err) console.error("Session save error after registration:", err);
                 res.redirect('/dashboard'); // Redirect to dashboard on success
            });
        } else {
            console.error(`[Register Fail] Judge rejected registration for ${email}. Output:\n${result.output}`);
            res.render('register', {
                email: email,
                error: `Judge rejected registration. Please check the output below and correct your details.`,
                judgeOutput: result.output,
                formData: req.body
            });
        }
    } catch (error) {
        console.error(`[Register Error] Failed to execute REGISTER command for ${email}:`, error);
        res.render('register', {
            email: email,
            error: `Error communicating with the judge: ${error.output || error.message}`,
            judgeOutput: error.output,
            formData: req.body
        });
    }
});


// Function to sync dip.master with DB
async function syncDipMaster() {
    console.log('[Sync] Starting sync from dip.master...');
    let gamesFromMaster = {};
    let syncError = null;

    try {
        if (!fs.existsSync(dipMasterPath)) {
            throw new Error(`File not found: ${dipMasterPath}. Set DIP_MASTER_PATH in .env or ensure it's relative to DIP_BINARY_PATH.`);
        }
        const masterContent = fs.readFileSync(dipMasterPath, 'utf8');
        const lines = masterContent.split('\n');
        // Regex to capture game name (alphanumeric, 1-8 chars) and phase/status
        const gameLineRegex = /^([a-zA-Z0-9]{1,8})\s+\S+\s+([SFUW]\d{4}[MRB][X]?|Forming|Paused|Finished|Terminated)\b/i;

        lines.forEach((line) => {
            const trimmedLine = line.trim();
            if (trimmedLine.length > 0 && !trimmedLine.startsWith('#')) {
                const match = trimmedLine.match(gameLineRegex);
                if (match) {
                    const gameName = match[1];
                    const phaseOrStatus = match[2];
                    if (gameName && gameName !== 'control' && !gamesFromMaster[gameName]) {
                        gamesFromMaster[gameName] = { name: gameName, status: 'Unknown', currentPhase: 'Unknown' };
                        // Distinguish phase from status
                        if (/^[SFUW]\d{4}[MRB][X]?$/i.test(phaseOrStatus)) {
                            gamesFromMaster[gameName].currentPhase = phaseOrStatus;
                            gamesFromMaster[gameName].status = 'Active'; // Assume active if phase looks valid
                        } else {
                            // Use Forming, Paused etc. as status, ensure proper casing
                            const statusLower = phaseOrStatus.toLowerCase();
                            if (statusLower === 'forming') gamesFromMaster[gameName].status = 'Forming';
                            else if (statusLower === 'paused') gamesFromMaster[gameName].status = 'Paused';
                            else if (statusLower === 'finished') gamesFromMaster[gameName].status = 'Finished';
                            else if (statusLower === 'terminated') gamesFromMaster[gameName].status = 'Terminated';
                            else gamesFromMaster[gameName].status = 'Unknown'; // Fallback
                        }
                        console.log(`[Sync] Found game: ${gameName}, Status/Phase: ${phaseOrStatus} in ${dipMasterPath}`);
                    }
                }
            }
        });
        console.log(`[Sync] Found ${Object.keys(gamesFromMaster).length} potential games in ${dipMasterPath}`);

        // Update DB based on dip.master findings
        const existingStates = await getAllGameStates();
        for (const gameName in gamesFromMaster) {
            const masterInfo = gamesFromMaster[gameName];
            let currentState = existingStates[gameName];
            let needsSave = false;

            if (!currentState) {
                console.log(`[Sync DB] Game '${gameName}' not in DB. Adding basic state from dip.master.`);
                // Create a minimal state based on dip.master info
                currentState = { name: gameName, status: masterInfo.status, variant: 'Standard', options: [], currentPhase: masterInfo.currentPhase, nextDeadline: null, masters: [], players: [], observers: [], settings: {} };
                needsSave = true;
            } else {
                // Update phase/status if different from dip.master AND dip.master has a meaningful value
                if (masterInfo.currentPhase !== 'Unknown' && currentState.currentPhase !== masterInfo.currentPhase) {
                    console.log(`[Sync DB] Updating phase for game '${gameName}' from ${currentState.currentPhase} to ${masterInfo.currentPhase}`);
                    currentState.currentPhase = masterInfo.currentPhase;
                    needsSave = true;
                }
                 if (masterInfo.status !== 'Unknown' && currentState.status !== masterInfo.status) {
                    // Allow dip.master status (like Paused, Finished) to override DB if different
                    console.log(`[Sync DB] Updating status for game '${gameName}' from ${currentState.status} to ${masterInfo.status}`);
                    currentState.status = masterInfo.status;
                    needsSave = true;
                }
                // If status is still Forming/Unknown in DB, but dip.master indicates Active phase, update status
                if ((currentState.status === 'Unknown' || currentState.status === 'Forming') && masterInfo.status === 'Active') {
                     console.log(`[Sync DB] Inferred status 'Active' for game '${gameName}' based on phase ${masterInfo.currentPhase}`);
                     currentState.status = 'Active';
                     needsSave = true;
                }
            }

            if (needsSave) {
                currentState.lastUpdated = Math.floor(Date.now() / 1000);
                await saveGameState(gameName, currentState);
            }
        }
        console.log(`[Sync DB] Finished DB update from dip.master.`);

    } catch (err) {
        console.error(`[Sync Error] Error reading or processing ${dipMasterPath}:`, err);
        syncError = `Failed to load/sync game list from ${dipMasterPath}. Error: ${err.code || err.message}`;
    }
    return { gamesFromMaster, syncError };
}

// API endpoint to get game list, optionally filtered
app.get('/api/games', requireEmail, async (req, res) => {
    try {
        // Extract filter parameters from query string
        const filters = {
            status: req.query.status,
            variant: req.query.variant,
            phase: req.query.phase,
            player: req.query.player // e.g., ?player=user@example.com
            // Add other potential filters here
        };

        // Remove undefined filters
        Object.keys(filters).forEach(key => filters[key] === undefined && delete filters[key]);

        // Sync before getting list (optional, depending on desired freshness vs performance)
        // Consider if sync is needed every time for filtered lists
        // await syncDipMaster();

        // Fetch games using the filter function
        const gameStates = await getFilteredGameStates(filters);

        // Return essential info (or full state if needed by frontend)
        const gameList = Object.values(gameStates).map(g => ({
            name: g.name,
            status: g.status,
            variant: g.variant,
            phase: g.currentPhase,
            players: g.players.map(p => p.email), // Example: return player emails
            masters: g.masters,
            nextDeadline: g.nextDeadline
            // Add other fields as needed by the frontend display
        }));
        res.json({ success: true, games: gameList });
    } catch (err) {
        console.error("[API Error] /api/games:", err);
        res.status(500).json({ success: false, message: "Failed to retrieve game list." });
    }
});

// API endpoint to get detailed state for a specific game
app.get('/api/game/:gameName', requireEmail, async (req, res) => {
    const gameName = req.params.gameName;
    if (!gameName) {
        return res.status(400).json({ success: false, message: "Game name is required." });
    }
    try {
        let gameState = await getGameState(gameName);
        if (!gameState) {
            // If not in DB, maybe it exists in dip.master but hasn't been LISTed yet?
            // Trigger a sync and try again.
            console.log(`[API /api/game] Game ${gameName} not in DB, attempting sync and re-fetch.`);
            await syncDipMaster();
            gameState = await getGameState(gameName);

            if (!gameState) {
                 // Still not found after sync, return 404
                 return res.status(404).json({ success: false, message: `Game '${gameName}' not found.` });
            }
        }
        // Generate recommendations based on this specific game state
        const recommendedCommands = getRecommendedCommands(gameState, req.session.email);
        res.json({ success: true, gameState, recommendedCommands });
    } catch (err) {
        console.error(`[API Error] /api/game/${gameName}:`, err);


// --- Saved Search Bookmark API Endpoints ---

// GET all saved search bookmarks for the logged-in user
app.get('/api/user/search-bookmarks', requireAuth, async (req, res) => {
    const userId = req.session.email;
    try {
        const bookmarks = await getSavedSearches(userId);
        res.json({ success: true, bookmarks });
    } catch (err) {
        console.error(`[API Error] /api/user/search-bookmarks GET for ${userId}:`, err);
        res.status(500).json({ success: false, message: "Failed to retrieve saved searches." });
    }
});

// POST to save/update a search bookmark for the logged-in user
app.post('/api/user/search-bookmarks', requireAuth, async (req, res) => {
    const userId = req.session.email;
    const { name, params } = req.body;

    if (!name || typeof name !== 'string' || name.trim().length === 0) {
        return res.status(400).json({ success: false, message: "Bookmark name is required." });
    }
    if (!params || typeof params !== 'object') {
        return res.status(400).json({ success: false, message: "Search parameters (params) object is required." });
    }

    try {
        await saveSavedSearch(userId, name.trim(), params);
        res.json({ success: true, message: `Bookmark '${name.trim()}' saved successfully.` });
    } catch (err) {
        console.error(`[API Error] /api/user/search-bookmarks POST for ${userId}:`, err);
        res.status(500).json({ success: false, message: "Failed to save bookmark." });
    }
});

// DELETE a specific search bookmark for the logged-in user
app.delete('/api/user/search-bookmarks/:name', requireAuth, async (req, res) => {
    const userId = req.session.email;
    // Decode the name from the URL parameter
    const bookmarkName = decodeURIComponent(req.params.name);

    if (!bookmarkName) {
         return res.status(400).json({ success: false, message: "Bookmark name parameter is required." });
    }

    try {
        const deleted = await deleteSavedSearch(userId, bookmarkName);
        if (deleted) {
            res.json({ success: true, message: `Bookmark '${bookmarkName}' deleted successfully.` });
        } else {
            res.status(404).json({ success: false, message: `Bookmark '${bookmarkName}' not found.` });
        }
    } catch (err) {
        console.error(`[API Error] /api/user/search-bookmarks DELETE for ${userId}:`, err);
        res.status(500).json({ success: false, message: "Failed to delete bookmark." });
    }
});

        res.status(500).json({ success: false, message: `Failed to retrieve game state for ${gameName}.` });
    }
});


// --- Saved Search Bookmark API Endpoints ---

// GET all saved search bookmarks for the logged-in user
app.get('/api/user/search-bookmarks', requireAuth, async (req, res) => {
    const userId = req.session.email;
    try {
        const bookmarks = await getSavedSearches(userId);
        res.json({ success: true, bookmarks });
    } catch (err) {
        console.error(`[API Error] /api/user/search-bookmarks GET for ${userId}:`, err);
        res.status(500).json({ success: false, message: "Failed to retrieve saved searches." });
    }
});

// POST to save/update a search bookmark for the logged-in user
app.post('/api/user/search-bookmarks', requireAuth, async (req, res) => {
    const userId = req.session.email;
    const { name, params } = req.body;

    if (!name || typeof name !== 'string' || name.trim().length === 0) {
        return res.status(400).json({ success: false, message: "Bookmark name is required." });
    }
    if (!params || typeof params !== 'object') {
        return res.status(400).json({ success: false, message: "Search parameters (params) object is required." });
    }

    try {
        await saveSavedSearch(userId, name.trim(), params);
        res.json({ success: true, message: `Bookmark '${name.trim()}' saved successfully.` });
    } catch (err) {
        console.error(`[API Error] /api/user/search-bookmarks POST for ${userId}:`, err);
        res.status(500).json({ success: false, message: "Failed to save bookmark." });
    }
});

// DELETE a specific search bookmark for the logged-in user
app.delete('/api/user/search-bookmarks/:name', requireAuth, async (req, res) => {
    const userId = req.session.email;
    // Decode the name from the URL parameter
    const bookmarkName = decodeURIComponent(req.params.name);

    if (!bookmarkName) {
         return res.status(400).json({ success: false, message: "Bookmark name parameter is required." });
    }

    try {
        const deleted = await deleteSavedSearch(userId, bookmarkName);
        if (deleted) {
            res.json({ success: true, message: `Bookmark '${bookmarkName}' deleted successfully.` });
        } else {
            res.status(404).json({ success: false, message: `Bookmark '${bookmarkName}' not found.` });
        }
    } catch (err) {
        console.error(`[API Error] /api/user/search-bookmarks DELETE for ${userId}:`, err);
        res.status(500).json({ success: false, message: "Failed to delete bookmark." });
    }
});


// Main dashboard route

// --- News API Endpoints ---

// GET all news items (public)
app.get('/api/news', async (req, res) => {
    try {
        const newsItems = await getAllNewsItems();
        res.json({ success: true, news: newsItems });
    } catch (err) {
        console.error("[API Error] /api/news GET:", err);
        res.status(500).json({ success: false, message: "Failed to retrieve news items." });
    }
});

// POST a new news item (protected)
// Make sure express.json() middleware is used globally or add it here if needed
app.post('/api/news', requireAuth, express.json(), async (req, res) => {
    const { content } = req.body;
    const userId = req.session.email; // Identify who is posting

    if (!content) {
        return res.status(400).json({ success: false, message: "Missing 'content' in request body." });
    }

    try {
        const newNewsId = await addNewsItem(content);
        console.log(`[API Success] User ${userId} added news item ID: ${newNewsId}`);
        res.status(201).json({ success: true, message: "News item added successfully.", newsId: newNewsId });
    } catch (err) {
        console.error(`[API Error] /api/news POST by ${userId}:`, err);
        res.status(500).json({ success: false, message: err.message || "Failed to add news item." });
    }
});

// DELETE a news item by ID (protected)
app.delete('/api/news/:id', requireAuth, async (req, res) => {
    const newsId = parseInt(req.params.id, 10); // Ensure ID is an integer
    const userId = req.session.email; // Identify who is deleting

    if (isNaN(newsId)) {
        return res.status(400).json({ success: false, message: "Invalid news item ID." });
    }

    try {
        const deleted = await deleteNewsItem(newsId);
        if (deleted) {
            console.log(`[API Success] User ${userId} deleted news item ID: ${newsId}`);
            res.json({ success: true, message: `News item ${newsId} deleted successfully.` });
        } else {
            res.status(404).json({ success: false, message: `News item ${newsId} not found.` });
        }
    } catch (err) {
        console.error(`[API Error] /api/news DELETE by ${userId} for ID ${newsId}:`, err);
        res.status(500).json({ success: false, message: "Failed to delete news item." });
    }
});


app.get('/dashboard', requireEmail, async (req, res) => {
    const email = req.session.email;
    let errorMessage = req.session.errorMessage || null;
    req.session.errorMessage = null; // Clear error after displaying once
    let registrationStatus = null;

    try {
        // 1. Check registration status
        registrationStatus = await getUserRegistrationStatus(email);
        if (registrationStatus === null) {
             console.warn(`User ${email} reached dashboard without record in users DB. Forcing registration.`);
             registrationStatus = 0;
             await ensureUserExists(email);
        }

        if (registrationStatus === 0) {
            console.log(`User ${email} needs to register with the judge.`);
            return res.redirect('/register');
        }

        // 2. User is registered. Sync games and render dashboard.
        const syncResult = await syncDipMaster();
        if (syncResult.syncError && !errorMessage) {
            errorMessage = syncResult.syncError;
        }

        // Get all games for the game selector dropdown
        const allGameStates = await getAllGameStates();
        const gameList = Object.values(allGameStates).map(g => ({ name: g.name, status: g.status }));

        // Get initial target game from cookie, if available
        const initialTargetGameName = req.cookies.targetGame;
        let initialGameState = null;
        let initialRecommendedCommands = {};

        if (initialTargetGameName) {
            initialGameState = allGameStates[initialTargetGameName];
            if (initialGameState) {
                 initialRecommendedCommands = getRecommendedCommands(initialGameState, email);
            } else {
                 console.warn(`[Dashboard] Initial target game '${initialTargetGameName}' from cookie not found in DB.`);
                 res.clearCookie('targetGame'); // Clear invalid cookie
                 // Clear corresponding password/variant cookies
                 res.clearCookie(`targetPassword_${initialTargetGameName}`);
                 res.clearCookie(`targetVariant_${initialTargetGameName}`);
            }
        }

        // If no valid initial game, get default recommendations (no game context)
        if (!initialGameState) {
             initialRecommendedCommands = getRecommendedCommands(null, email);
        }

        res.render('dashboard', {
            email: email,
            allGames: gameList, // Pass list of all games for selector
            initialTargetGame: initialGameState, // Pass state of initially selected game (or null)
            initialRecommendedCommands: initialRecommendedCommands, // Pass recommendations for initial game (or default)
            error: errorMessage,
            layout: 'layout'
        });

    } catch (err) {
        console.error(`[Dashboard Error] Failed to load dashboard data for ${email}:`, err);
        errorMessage = `Error loading dashboard: ${err.message}`;
        // Attempt to render with default state on error
        res.render('dashboard', {
            email: email,
            allGames: [],
            initialTargetGame: null,
            initialRecommendedCommands: getRecommendedCommands(null, email),
            error: errorMessage,
            layout: 'layout'
        });
    }
});

app.post('/signoff', (req, res) => {
    const email = req.session.email; // Log who is signing off
    console.log(`[Auth] User ${email} signing off.`);
    req.session.destroy((err) => {
        // Clear cookies regardless of session destruction success
        res.clearCookie('connect.sid'); // Session cookie
        res.clearCookie('targetGame'); // General target game cookie
        // Clear all game-specific password/variant cookies
        Object.keys(req.cookies).forEach(cookieName => {
             if (cookieName.startsWith('targetPassword_') || cookieName.startsWith('targetVariant_')) {
                 res.clearCookie(cookieName);
             }
        });
        if (err) {
            console.error("Session destruction error:", err);
        }
        res.redirect('/');
    });
});


// API endpoint to execute the dip command
app.post('/execute-dip', requireEmail, async (req, res) => {
    const { command, targetGame, targetPassword, targetVariant } = req.body;
    const email = req.session.email;

    if (!command) {
        return res.status(400).json({ success: false, output: 'Error: Missing command.' });
    }

    const commandVerb = command.trim().split(/\s+/)[0].toUpperCase();
    let actualTargetGame = targetGame; // Game context for the command

    // Determine the actual target game if the command itself specifies one
     const commandParts = command.trim().split(/\s+/);
     const gameNameCommands = ['LIST', 'HISTORY', 'SUMMARY', 'WHOGAME', 'OBSERVE', 'WATCH', 'SIGN', 'CREATE', 'EJECT'];
     if (gameNameCommands.includes(commandVerb) && commandParts.length > 1) {
         let potentialGameName = commandParts[1];
         // Adjust for SIGN ON Pgame and CREATE/SIGN ON ?game syntax
         if (commandVerb === 'SIGN' && command.toUpperCase().includes(' ON ') && !potentialGameName.startsWith('?')) { if (potentialGameName.length > 1 && /^[A-Z]$/i.test(potentialGameName[0])) { potentialGameName = potentialGameName.substring(1); } }
         else if ((commandVerb === 'SIGN' || commandVerb === 'CREATE') && potentialGameName.startsWith('?')) { potentialGameName = potentialGameName.substring(1); }
         else if (commandVerb === 'EJECT' && potentialGameName.includes('@')) { potentialGameName = null; }

         const keywords = ['FULL', 'FROM', 'TO', 'LINES', 'EXCLSTART', 'EXCLEND', 'BROAD', 'ON', '?', 'MASTER'];
         if (potentialGameName && /^[a-zA-Z0-9]{1,8}$/.test(potentialGameName) && !keywords.includes(potentialGameName.toUpperCase())) {
             if (actualTargetGame && actualTargetGame !== potentialGameName) {
                 console.log(`[Execute Prep] Command ${commandVerb} specifies game '${potentialGameName}', overriding target context '${actualTargetGame}'.`);
             } else if (!actualTargetGame) {
                  console.log(`[Execute Prep] Command ${commandVerb} specifies game '${potentialGameName}', setting target context.`);
             }
             actualTargetGame = potentialGameName;
         }
     }

    try {
        const result = await executeDipCommand(email, command, actualTargetGame, targetPassword, targetVariant);
        const stdoutData = result.stdout;
        let requiresGameRefresh = false; // Flag to indicate if LIST should be run after

        // --- Post-Execution Processing ---

        // 1. Handle REGISTER Success (Update our DB)
        if (commandVerb === 'REGISTER') {
             const outputLower = stdoutData.toLowerCase();
             if (outputLower.includes("registration accepted") || outputLower.includes("updated registration") || outputLower.includes("already registered")) {
                 await setUserRegistered(email);
                 console.log(`[Execute] Marked ${email} as registered in local DB after REGISTER command.`);
             }
        }

        // 2. Handle SIGN ON / OBSERVE / CREATE Success (Update cookies, flag for refresh)
        let isSignOnOrObserveSuccess = false;
        let newGameCreated = false;
        let signedOnGame = null; // The game name confirmed by the judge

        const signOnSuccessPattern = /signed on as (?:\w+)\s*(?:in game)?\s*'(\w+)'/i;
        const observeSuccessPattern = /(?:Observing|Watching) game '(\w+)'/i;
        const createSuccessPattern = /Game '(\w+)' created/i;

        let match;
        if ((match = stdoutData.match(signOnSuccessPattern)) && (commandVerb === 'SIGN' && command.toUpperCase().includes(' ON '))) {
            signedOnGame = match[1];
            console.log(`[Execute] SIGN ON Success detected for ${email}: Game=${signedOnGame}`);
            isSignOnOrObserveSuccess = true;
        } else if ((match = stdoutData.match(observeSuccessPattern)) && (commandVerb === 'OBSERVE' || commandVerb === 'WATCH')) {
            signedOnGame = match[1];
            console.log(`[Execute] OBSERVE/WATCH Success detected for ${email}: Game=${signedOnGame}`);
            isSignOnOrObserveSuccess = true;
        } else if ((match = stdoutData.match(createSuccessPattern)) && commandVerb === 'CREATE') {
            signedOnGame = match[1];
            console.log(`[Execute] CREATE Success detected for ${email}: Game=${signedOnGame}`);
            isSignOnOrObserveSuccess = true;
            newGameCreated = true;
            console.log(`[Execute Sync] Triggering dip.master sync after CREATE ${signedOnGame}`);
            syncDipMaster().catch(syncErr => console.error("Error during post-create sync:", syncErr));
        }

        if (isSignOnOrObserveSuccess && signedOnGame) {
            actualTargetGame = signedOnGame;
            requiresGameRefresh = true;
            console.log(`[Execute] SignOn/Observe/Create success for ${signedOnGame}. Client should update context.`);
        }

        // 3. Identify other commands that likely modify game state and require refresh
        const stateChangingCommands = [
            'PROCESS', 'SET', 'RESIGN', 'WITHDRAW', 'EJECT', 'TERMINATE', 'ROLLBACK', 'FORCE BEGIN', 'UNSTART', 'PROMOTE',
            'PAUSE', 'RESUME', 'BECOME MASTER', 'SET MODERATE', 'SET UNMODERATE', 'CLEAR'
        ];
        if (stateChangingCommands.includes(commandVerb) && result.success && actualTargetGame) {
            const outputLower = stdoutData.toLowerCase();
            if (outputLower.includes('processed') || outputLower.includes('terminated') || outputLower.includes('resigned') ||
                outputLower.includes('ejected') || outputLower.includes('rolled back') || outputLower.includes('set') ||
                outputLower.includes('promoted') || outputLower.includes('paused') || outputLower.includes('resumed') ||
                outputLower.includes('cleared') || outputLower.includes('moderated') || outputLower.includes('unmoderated'))
            {
                 console.log(`[Execute] Command ${commandVerb} likely modified state for ${actualTargetGame}. Flagging for refresh.`);
                 requiresGameRefresh = true;
            }
        }
        if (commandVerb === 'LIST' && result.success && actualTargetGame) {
             requiresGameRefresh = true;
        }


        // 4. Refresh game state from Judge if needed
        let refreshedGameState = null;
        let updatedRecommendedCommands = null; // *** ADDED VARIABLE ***

        if (requiresGameRefresh && actualTargetGame) {
            console.log(`[Execute Refresh] Running LIST ${actualTargetGame} to refresh state after ${commandVerb}`);
            try {
                const listResult = await executeDipCommand(email, `LIST ${actualTargetGame}`, actualTargetGame, targetPassword, targetVariant);
                if (listResult.success) {
                    refreshedGameState = parseListOutput(actualTargetGame, listResult.stdout);
                    await saveGameState(actualTargetGame, refreshedGameState);
                    console.log(`[Execute Refresh] Successfully refreshed and saved state for ${actualTargetGame}`);

                    // *** ADDED: Calculate recommendations based on the *just parsed* state ***
                    updatedRecommendedCommands = getRecommendedCommands(refreshedGameState, email);
                    console.log(`[Execute Refresh] Generated recommendations for refreshed state.`);

                } else {
                    console.error(`[Execute Refresh] Failed to run LIST command for ${actualTargetGame}:`, listResult.output);
                }
            } catch (refreshError) {
                console.error(`[Execute Refresh] Error during state refresh for ${actualTargetGame}:`, refreshError);
            }
        }

        // 5. Send Response
        res.json({
            success: result.success,
            output: result.output,
            isSignOnOrObserveSuccess: isSignOnOrObserveSuccess,
            createdGameName: newGameCreated ? signedOnGame : null,
            refreshedGameState: refreshedGameState,
            updatedRecommendedCommands: updatedRecommendedCommands // *** ADDED: Send new recommendations ***
        });

    } catch (error) {
        console.error(`[Execute Error] Command "${commandVerb}" for ${email} failed:`, error);
        res.status(error.output?.includes('Spawn failed') ? 503 : 500).json({
             success: false,
             output: error.output || 'Unknown execution error',
             isSignOnOrObserveSuccess: false
        });

// Endpoint to add a new game
app.post('/api/games', requireAuth, async (req, res) => {
    // Basic implementation: requires gameName and variant in the body.
    // TODO: Extend to handle more complex ADDGAME parameters (press, deadlines, players etc.)
    const { gameName, variant, ...otherOptions } = req.body;
    const userEmail = req.session.email;

    if (!gameName || !variant) {
        return res.status(400).json({ error: 'Missing required parameters: gameName, variant' });
    }

    // Construct the ADDGAME command string - basic version
    // This might need refinement based on the exact njudge dip CLI syntax for options
    let commandParts = ['ADDGAME', gameName, variant];
    // Example: Add other options if they exist (needs specific CLI format knowledge)
    // Object.entries(otherOptions).forEach(([key, value]) => {
    //     commandParts.push(`${key.toUpperCase()}=${value}`); // Placeholder format
    // });
    const command = commandParts.join(' ');

    console.log(`[API /api/games POST] User ${userEmail} attempting command: ${command}`);

    try {
        // Using executeDipCommand to run the ADDGAME command
        const result = await executeDipCommand(userEmail, command, gameName, null, variant);
        console.log(`[API /api/games POST] Command successful for ${gameName}. Output:\n${result.stdout}`);
        // Optionally trigger a game list refresh here
        res.status(201).json({ message: `Game '${gameName}' creation initiated.`, output: result.stdout });
    } catch (error) {
        console.error(`[API /api/games POST] Error executing ADDGAME command for ${gameName}:`, error);
        // Try to provide more specific status codes based on common errors
        const statusCode = error.output?.includes('Spawn failed') ? 503 :
                           error.stderr?.includes('already exists') ? 409 : // Conflict
                           500; // Default internal server error
        res.status(statusCode).json({
            error: `Failed to add game '${gameName}'.`,
            details: error.stderr || error.message || 'Unknown error',
            stdout: error.stdout // Include stdout as it might contain partial info
        });
    }
});

// Endpoint to remove a game
app.delete('/api/games/:gameName', requireAuth, async (req, res) => {
    const { gameName } = req.params;
    // Password might be needed for REMOVEGAME, potentially passed in body
    const { password } = req.body;
    const userEmail = req.session.email;

    if (!gameName) {
        // Should not happen with route definition, but good practice
        return res.status(400).json({ error: 'Missing gameName in path parameter.' });
    }

    // Construct the REMOVEGAME command string
    const command = `REMOVEGAME ${gameName}`;

    console.log(`[API /api/games DELETE] User ${userEmail} attempting command: ${command} for game ${gameName}`);

    try {
        // Pass password to executeDipCommand if provided
        const result = await executeDipCommand(userEmail, command, gameName, password);
        console.log(`[API /api/games DELETE] Command successful for ${gameName}. Output:\n${result.stdout}`);
        // Optionally trigger game list refresh or remove from DB here
        res.status(200).json({ message: `Game '${gameName}' removal initiated.`, output: result.stdout });
    } catch (error) {
        console.error(`[API /api/games DELETE] Error executing REMOVEGAME command for ${gameName}:`, error);
         // Try to provide more specific status codes
        const statusCode = error.output?.includes('Spawn failed') ? 503 :
                           error.stderr?.includes('No such game') ? 404 : // Not Found
                           error.stderr?.includes('incorrect password') ? 401 : // Unauthorized (or 403 Forbidden)
                           500; // Default internal server error
        res.status(statusCode).json({
            error: `Failed to remove game '${gameName}'.`,
            details: error.stderr || error.message || 'Unknown error',
            stdout: error.stdout
        });
    }
});



// --- Map Data API Endpoint ---

// GET /api/map/:gameName/:phase?
// Provides combined map data (geometry, metadata, game state) for rendering.
console.log(`[Route Definition Check] Defining GET /api/map/:gameName/:phase?`); // Roo Debug Log
app.get('/api/map/:gameName/:phase?', requireAuth, async (req, res) => { // Roo: Added requireAuth
    const { gameName, phase } = req.params;
    console.log(`[Map API Request] Handler Reached. gameName: ${gameName}, phase: ${phase}, user: ${req.userId}`); // Roo Debug Log
    console.log(`[Map API Request] Handler Reached. gameName: ${gameName}, phase: ${phase}, user: ${req.userId}`); // Roo Debug Log

    if (!gameName) {
        return res.status(400).json({ error: 'Game name is required.' });
    }

    try {
        const mapData = await getMapData(gameName, phase, res); // Pass res

        // If getMapData encountered an unexpected error, it sent the response and returned undefined.
        // Check if the response was already sent by getMapData's catch block.
        if (res.headersSent) {
            return; // Stop processing in the handler
        }

        if (!mapData) {
            // getMapData returned null due to an *expected* issue (e.g., game not found internally, history fail)
            const gameExists = await getGameState(gameName); // Check if game actually exists
            if (!gameExists) {
                 // Game genuinely not found
                 return res.status(404).json({ error: `Game '${gameName}' not found.` });
            } else {
                 // Game exists, but getMapData couldn't assemble data (expected failure path)
                 return res.status(500).json({ error: `Could not retrieve complete map data for game '${gameName}' phase '${phase || 'latest'}'. Check server logs for expected failures.` });
            }
        } else {
             // Success: getMapData returned valid data
             res.json(mapData);
        }
    } catch (error) {
        // Catch errors occurring *within the route handler itself* (e.g., getGameState fails)
        console.error(`[Map API Route Error] Unexpected error in route handler for ${gameName}:`, error);
        if (!res.headersSent) { // Ensure response hasn't been sent already
             res.status(500).json({ error: 'An unexpected error occurred processing the map request.' });
        }
    }
});



// --- User Preference API Endpoints ---

// GET all preferences for the logged-in user
console.log(`[Route Definition Check] Defining GET /api/user/preferences`); // Roo Debug Log
app.get('/api/user/preferences', requireAuth, async (req, res) => {
    try {
        const preferences = await getUserPreferences(req.userId);
        res.json({ success: true, preferences });
    } catch (error) {
        console.error(`[API Error] GET /api/user/preferences failed for user ${req.userId}:`, error);
        res.status(500).json({ success: false, message: 'Failed to retrieve preferences.' });
    }
});

// POST (set/update) multiple preferences for the logged-in user
app.post('/api/user/preferences', requireAuth, express.json(), async (req, res) => {
    const preferencesToSet = req.body; // Expects an object like { key1: value1, key2: value2 }
    if (typeof preferencesToSet !== 'object' || preferencesToSet === null) {
        return res.status(400).json({ success: false, message: 'Invalid request body. Expected a JSON object of preferences.' });
    }

    const promises = [];
    for (const key in preferencesToSet) {
        if (Object.hasOwnProperty.call(preferencesToSet, key)) {
            promises.push(setUserPreference(req.userId, key, preferencesToSet[key]));
        }
    }

    try {
        await Promise.all(promises);
        res.json({ success: true, message: 'Preferences updated successfully.' });
    } catch (error) {
        console.error(`[API Error] POST /api/user/preferences failed for user ${req.userId}:`, error);
        res.status(500).json({ success: false, message: 'Failed to update preferences.' });

// --- Public Stats API Endpoints ---

// GET /api/stats/game-status - Get game counts by status
app.get('/api/stats/game-status', async (req, res) => {
    try {
        const gameCounts = await getGameCountsByStatus();
        res.json(gameCounts);
    } catch (error) {
        console.error("Error fetching game status stats:", error);
        res.status(500).json({ message: "Failed to retrieve game status statistics." });
    }
});

    }
});

// DELETE a specific preference key for the logged-in user
app.delete('/api/user/preferences/:key', requireAuth, async (req, res) => {
    const keyToDelete = req.params.key;
    if (!keyToDelete) {
        return res.status(400).json({ success: false, message: 'Preference key parameter is required.' });
    }

    try {
        const deleted = await deleteUserPreference(req.userId, keyToDelete);
        if (deleted) {
            res.json({ success: true, message: `Preference '${keyToDelete}' deleted.` });
        } else {
            res.status(404).json({ success: false, message: `Preference '${keyToDelete}' not found.` });
        }
    } catch (error) {
        console.error(`[API Error] DELETE /api/user/preferences/${keyToDelete} failed for user ${req.userId}:`, error);
        res.status(500).json({ success: false, message: 'Failed to delete preference.' });
    }
});

// POST reset all preferences for the logged-in user
app.post('/api/user/preferences/reset', requireAuth, async (req, res) => {
    try {
        const count = await deleteAllUserPreferences(req.userId);
        res.json({ success: true, message: `Reset ${count} preferences.` });
    } catch (error) {
        console.error(`[API Error] POST /api/user/preferences/reset failed for user ${req.userId}:`, error);
        res.status(500).json({ success: false, message: 'Failed to reset preferences.' });
    }
});
    }

// NEW ENDPOINT START
app.get('/api/game/:gameName/history', requireEmail, async (req, res) => {
    const gameName = req.params.gameName;
    const userEmail = req.session.email; // Assuming requireEmail middleware sets this

    if (!gameName) {
        return res.status(400).json({ error: 'Game name is required.' });
    }

    console.log(`[API HISTORY] Request received for game: ${gameName} from user: ${userEmail}`);

    try {
        // Execute the 'HISTORY <gameName>' command
        // Use the existing executeDipCommand function
        const historyOutput = await executeDipCommand(userEmail, `HISTORY ${gameName}`, gameName);

        // Check if the command returned an error message within the output
        if (typeof historyOutput === 'string' && (historyOutput.includes('No such game') || historyOutput.includes('Error:'))) {
             console.warn(`[API HISTORY Warning] Command for ${gameName} returned error message: ${historyOutput}`);
             // Determine appropriate status code based on error message
             const statusCode = historyOutput.includes('No such game') ? 404 : 500;
             return res.status(statusCode).json({ error: historyOutput.trim() });
        }

        const parsedHistory = parseHistoryOutput(gameName, historyOutput);
        res.json(parsedHistory);

    } catch (error) {
        console.error(`[API HISTORY Error] Failed to get or parse history for game ${gameName}:`, error);
        // Handle potential errors from executeDipCommand (e.g., spawn issues)
        const statusCode = error.output?.includes('Spawn failed') ? 503 : (error.message?.includes('No such game') ? 404 : 500);
        const errorMessage = error.message || 'Failed to retrieve game history.';
        res.status(statusCode).json({ error: errorMessage, details: error.output || null });
    }
});
// NEW ENDPOINT END

});

// --- Start Server ---
// ... (Keep server start and graceful shutdown as is) ...
app.use(express.static(path.join(__dirname, 'public'))); // Roo: Moved static middleware here
app.listen(port, () => {
    console.log(`Dip Web App listening at http://localhost:${port}`);
    console.log(`Using dip binary: ${dipBinaryPath}`);
    if (dipBinaryArgs.length > 0) console.log(`Using dip binary args: ${dipBinaryArgs.join(' ')}`);
    console.log(`Using dip binary root path: ${dipBinaryRootPath}`);
    console.log(`Expecting dip.master at: ${dipMasterPath}`);

    const resolvedDipCommand = path.resolve(dipBinaryRootPath, path.basename(dipBinaryPath));
    if (!fs.existsSync(resolvedDipCommand)) {
        console.warn(`\n!!! WARNING: Dip binary not found at '${resolvedDipCommand}'. Check DIP_BINARY_PATH in .env. !!!\n`);
    } else {
        try {
            fs.accessSync(resolvedDipCommand, fs.constants.X_OK);
            console.log(`Dip binary found at '${resolvedDipCommand}' and appears executable.`);
        } catch (err) {
            console.warn(`\n!!! WARNING: Dip binary found at '${resolvedDipCommand}' but might not be executable. Error: ${err.message}. Try: chmod +x ${resolvedDipCommand} !!!\n`);
        }
    }

    if (!fs.existsSync(dipMasterPath)) {
        console.warn(`\n!!! WARNING: dip.master file not found at '${dipMasterPath}'. Check DIP_MASTER_PATH in .env or ensure it's relative to binary path. Game list sync might fail. !!!\n`);
    } else {
        console.log(`Found dip.master at '${dipMasterPath}'. Performing initial sync...`);
        syncDipMaster().catch(err => console.error("[Startup Sync Error]", err));
    }
    function print (path, layer) {
        if (layer.route) {
          layer.route.stack.forEach(print.bind(null, path.concat(split(layer.route.path))))
        } else if (layer.name === 'router' && layer.handle.stack) {
          layer.handle.stack.forEach(print.bind(null, path.concat(split(layer.regexp))))
        } else if (layer.method) {
          console.log('%s /%s',
            layer.method.toUpperCase(),
            path.concat(split(layer.regexp)).filter(Boolean).join('/'))
        }
      }
      
      function split (thing) {
        if (typeof thing === 'string') {
          return thing.split('/')
        } else if (thing.fast_slash) {
          return ''
        } else {
          var match = thing.toString()
            .replace('\\/?', '')
            .replace('(?=\\/|$)', '$')
            .match(/^\/\^((?:\\[.*+?^${}()|[\]\\\/]|[^.*+?^${}()|[\]\\\/])*)\$\//)
          return match
            ? match[1].replace(/\\(.)/g, '$1').split('/')
            : '<complex:' + thing.toString() + '>'
        }
      }
      
      app._router.stack.forEach(print.bind(null, []))
});

process.on('SIGINT', () => {
    console.log('SIGINT signal received: closing databases...');
    let closedCount = 0;
    const totalDbs = 3;
    const tryExit = () => {
        closedCount++;
        if (closedCount === totalDbs) {
            console.log('All databases closed gracefully.');
            process.exit(0);
        }
    };
    db.close((err) => { if (err) console.error('Error closing game_states DB:', err.message); else console.log('Game states DB closed.'); tryExit(); });
    sessionDb.close((err) => { if (err) console.error('Error closing sessions DB:', err.message); else console.log('Sessions DB closed.'); tryExit(); });
    userDb.close((err) => { if (err) console.error('Error closing users DB:', err.message); else console.log('Users DB closed.'); tryExit(); });
    setTimeout(() => { console.error("Databases did not close gracefully within 5s, forcing exit."); process.exit(1); }, 5000);
});
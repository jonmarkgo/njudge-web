require('dotenv').config();
const express = require('express');
const path = require('path');
const { spawn } = require('child_process');
const session = require('express-session');
const fs = require('fs');
const sqlite3 = require('sqlite3').verbose();
const expressLayouts = require('express-ejs-layouts');
const SQLiteStore = require('connect-sqlite3')(session);
const cookieParser = require('cookie-parser'); // Added

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
        options TEXT DEFAULT '[]',
        currentPhase TEXT DEFAULT 'Unknown',
        nextDeadline TEXT,
        masters TEXT DEFAULT '[]',
        players TEXT DEFAULT '[]',
        observers TEXT DEFAULT '[]',
        settings TEXT DEFAULT '{}',
        lastUpdated INTEGER,
        rawListOutput TEXT
    )`, (err) => {
        if (err) console.error("Error creating game_states table:", err);
        else {
            // Add columns if they don't exist (for upgrades)
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
        const validPlayers = (gameState.players || []).filter(p => p && typeof p === 'object' && p.power); // Ensure player objects are valid
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
                    row.masters = JSON.parse(row.masters || '[]');
                    row.players = JSON.parse(row.players || '[]');
                    row.observers = JSON.parse(row.observers || '[]');
                    row.options = JSON.parse(row.options || '[]');
                    row.settings = JSON.parse(row.settings || '{}');
                    resolve(row);
                } catch (parseError) {
                    console.error(`[DB Error] Failed to parse JSON state for game ${gameName}:`, parseError, 'Raw data:', row);
                    // Return row with potentially unparsed fields or default empty arrays/objects
                    row.masters = row.masters ? JSON.parse(row.masters || '[]') : [];
                    row.players = row.players ? JSON.parse(row.players || '[]') : [];
                    row.observers = row.observers ? JSON.parse(row.observers || '[]') : [];
                    row.options = row.options ? JSON.parse(row.options || '[]') : [];
                    row.settings = row.settings ? JSON.parse(row.settings || '{}') : {};
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

// --- Parsing Helper Functions ---
const parseListOutput = (gameName, output) => {
    console.log(`[Parser LIST] Attempting to parse LIST output for ${gameName}`);
    const gameState = { name: gameName, status: 'Unknown', variant: 'Standard', options: [], currentPhase: 'Unknown', nextDeadline: null, players: [], masters: [], observers: [], settings: {}, rawListOutput: output, lastUpdated: Math.floor(Date.now() / 1000) };
    const lines = output.split('\n');
    let readingPlayers = false; let readingSettings = false;
    const deadlineRegex = /Deadline:\s*([SFUW]\d{4}[MRB][X]?)\s*(.*)/i;
    const variantRegex = /Variant:\s*(\S+)\s*(.*)/i;
    const playerLineRegex = /^\s+(Austria|England|France|Germany|Italy|Russia|Turkey)\s*:\s*(.*?)\s*$/i;
    const masterLineRegex = /^\s+(?:Master|Moderator)\s*:\s*(.*?)\s*$/i; // Added Moderator
    const observerLineRegex = /^\s+Observer\s*:\s*(.*?)\s*$/i;
    const statusRegex = /Game status:\s*(.*)/i;
    const settingsHeaderRegex = /Game settings:/i;
    const pressSettingRegex = /Press:\s*(.*?)(?:,|\s*$)/i;
    const diasSettingRegex = /\b(NoDIAS|DIAS)\b/i;
    const nmrSettingRegex = /\b(NMR|NoNMR)\b/i;
    const concessionSettingRegex = /\b(Concessions|No Concessions)\b/i;
    const emailRegex = /[\w.-]+@[\w.-]+\.\w+/; // Regex to extract email

    lines.forEach(line => {
        const trimmedLine = line.trim();
        let match = line.match(statusRegex);
        if (match) { gameState.status = match[1].trim(); }
        else {
            // Infer status if not explicitly stated
            if (line.includes("Game is forming")) gameState.status = 'Forming';
            else if (line.includes("Movement results for") || line.includes("Retreats for") || line.includes("Adjustments for")) gameState.status = 'Active';
            else if (line.includes("The game is over") || line.includes("is a draw") || line.includes("wins the game")) gameState.status = 'Finished';
            else if (line.includes("Game is paused")) gameState.status = 'Paused';
            else if (line.includes("Game is terminated")) gameState.status = 'Terminated';
        }

        match = line.match(deadlineRegex);
        if (match) {
            gameState.currentPhase = match[1].trim();
            const deadlineStr = match[2].trim();
            gameState.nextDeadline = deadlineStr;
            // Basic validation - don't try to parse if it doesn't look like a date
            if (deadlineStr && /\w{3}\s+\w{3}\s+\d{1,2}\s+\d{4}\s+\d{2}:\d{2}:\d{2}/.test(deadlineStr)) {
                try {
                    const parsedDate = new Date(deadlineStr);
                    if (isNaN(parsedDate)) {
                        console.warn(`[Parser LIST ${gameName}] Could not parse deadline date string: ${deadlineStr}`);
                    }
                    // Store as string, let client format
                } catch (e) {
                    console.warn(`[Parser LIST ${gameName}] Error parsing deadline date: ${e}`);
                }
            }
        }

        match = line.match(variantRegex);
        if (match) {
            gameState.variant = match[1].trim();
            const optionsStr = match[2].replace(/,/g, ' ').trim();
            gameState.options = optionsStr.split(/\s+/).filter(opt => opt && opt !== 'Variant:');
            // Infer some settings from options
            if (gameState.options.includes('Gunboat')) gameState.settings.gunboat = true;
            if (gameState.options.includes('NMR')) gameState.settings.nmr = true; else gameState.settings.nmr = false; // Explicitly set false if not present
            if (gameState.options.includes('Chaos')) gameState.settings.chaos = true;
        }

        // Start reading player/master/observer lines
        if (trimmedLine.match(/^(Austria|England|France|Germany|Italy|Russia|Turkey|Master|Moderator|Observer)\s*:/i)) {
            readingPlayers = true;
        }

        if (readingPlayers) {
            match = line.match(playerLineRegex);
            if (match) {
                const power = match[1];
                const details = match[2].trim();
                const emailMatch = details.match(emailRegex);
                const playerInfo = {
                    power: power,
                    email: emailMatch ? emailMatch[0] : null,
                    status: 'Playing' // Default status
                };
                // Parse status from details string
                const detailsLower = details.toLowerCase();
                if (detailsLower.includes("waiting for orders")) playerInfo.status = "Waiting";
                else if (detailsLower.includes("civil disorder") || detailsLower.includes("(cd)")) playerInfo.status = "CD";
                else if (detailsLower.includes("resigned")) playerInfo.status = "Resigned";
                else if (detailsLower.includes("abandoned")) playerInfo.status = "Abandoned";
                else if (detailsLower.includes("eliminated")) playerInfo.status = "Eliminated";
                gameState.players.push(playerInfo);
            } else {
                match = line.match(masterLineRegex);
                if (match) {
                    const email = match[1].trim().match(emailRegex)?.[0];
                    if (email && !gameState.masters.includes(email)) gameState.masters.push(email);
                } else {
                    match = line.match(observerLineRegex);
                    if (match) {
                        const email = match[1].trim().match(emailRegex)?.[0];
                        if (email && !gameState.observers.includes(email)) gameState.observers.push(email);
                    } else if (!trimmedLine || trimmedLine.startsWith('-') || settingsHeaderRegex.test(trimmedLine)) {
                        // Stop reading players if we hit settings or an empty/separator line
                        readingPlayers = false;
                    }
                }
            }
        }

        if (settingsHeaderRegex.test(trimmedLine)) {
            readingSettings = true;
        }

        if (readingSettings) {
            match = line.match(pressSettingRegex); if (match) gameState.settings.press = match[1].trim();
            match = line.match(diasSettingRegex); if (match) gameState.settings.dias = (match[1].toUpperCase() === 'DIAS');
            match = line.match(nmrSettingRegex); if (match) gameState.settings.nmr = (match[1].toUpperCase() === 'NMR');
            match = line.match(concessionSettingRegex); if (match) gameState.settings.concessions = (match[1].toLowerCase() === 'concessions');
            if (line.toLowerCase().includes('gunboat')) gameState.settings.gunboat = true;
            if (line.toLowerCase().includes('chaos')) gameState.settings.chaos = true;
            // Add more settings parsing here if needed
        }
    });

    // Set defaults for settings if not found and not inferred from options
    if (gameState.settings.nmr === undefined) gameState.settings.nmr = false;
    if (gameState.settings.dias === undefined) gameState.settings.dias = true;
    if (gameState.settings.concessions === undefined) gameState.settings.concessions = true;
    if (gameState.settings.gunboat === undefined) gameState.settings.gunboat = false;

    // If status is still Unknown, try inferring from phase
    if (gameState.status === 'Unknown' && gameState.currentPhase) {
        if (gameState.currentPhase.toUpperCase() === 'FORMING') gameState.status = 'Forming';
        else if (gameState.currentPhase !== 'Unknown') gameState.status = 'Active';
    }

    console.log(`[Parser LIST ${gameName}] Final Parsed State: Status=${gameState.status}, Phase=${gameState.currentPhase}, Variant=${gameState.variant}, Players=${gameState.players.length}, Settings=`, gameState.settings);
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
        const powerMatch = trimmedLine.match(/^(Austria|England|France|Germany|Italy|Russia|Turkey)\s*:\s*(.*)/i);
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

// --- Command Recommendation Logic ---
// Updated to take gameState and userEmail, doesn't rely on session game/power
const getRecommendedCommands = (gameState, userEmail) => {
    const recommendations = { recommended: [], gameInfo: [], playerActions: [], settings: [], general: [], master: [] };

    if (!gameState || !userEmail) { // No game context or user email
        recommendations.recommended = ['SIGN ON ?', 'SIGN ON ?game', 'SIGN ON power', 'OBSERVE', 'LIST'];
        recommendations.gameInfo = ['WHOGAME', 'HISTORY', 'SUMMARY', 'CREATE ?'];
        recommendations.playerActions = ['SET PASSWORD', 'SET ADDRESS']; // REGISTER handled separately
        recommendations.general = ['GET', 'WHOIS', 'HELP', 'VERSION', 'MANUAL'];
    } else {
        // Determine user's role in *this specific game*
        const userIsMaster = gameState.masters?.includes(userEmail);
        const myPlayerInfo = gameState.players?.find(p => p.email === userEmail);
        const userIsPlayer = !!myPlayerInfo;
        const userPower = userIsPlayer ? myPlayerInfo.power : null;
        const userIsObserver = gameState.observers?.includes(userEmail) && !userIsPlayer && !userIsMaster;

        const phase = gameState.currentPhase?.toUpperCase() || 'UNKNOWN';
        const status = gameState.status?.toUpperCase() || 'UNKNOWN';
        const playerStatus = myPlayerInfo?.status?.toUpperCase() || 'UNKNOWN';

        // Basic game info is always useful
        recommendations.gameInfo = ['LIST', 'HISTORY', 'SUMMARY', 'WHOGAME'];

        // General commands
        recommendations.general = ['GET', 'HELP', 'VERSION', 'MANUAL'];

        // Player-specific actions
        if (userIsPlayer) {
            recommendations.playerActions.push(...['SET PASSWORD', 'SET ADDRESS', 'RESIGN', 'DIARY']);
            recommendations.settings.push('PHASE', 'IF', 'CLEAR');

            // Press/Broadcast based on game settings
            if (gameState.settings?.press !== 'None') {
                 recommendations.playerActions.push('PRESS', 'BROADCAST');
            }

            // Deadline related
            recommendations.playerActions.push('SET ABSENCE', 'SET NOABSENCE');
            if (gameState.settings?.wait !== false) recommendations.playerActions.push('SET WAIT', 'SET NOWAIT');

            // Draw/Concede based on settings
            if (gameState.settings?.dias !== false || gameState.settings?.dias === undefined) {
                recommendations.playerActions.push('SET DRAW', 'SET NODRAW');
            } else { // NoDIAS
                recommendations.playerActions.push('SET DRAW', 'SET NODRAW'); // Syntax is different but command is same
            }
            if (gameState.settings?.concessions !== false) {
                recommendations.playerActions.push('SET CONCEDE', 'SET NOCONCEDE');
            }

            // Recommended based on phase/status
            if (status === 'ACTIVE' && !['CD', 'RESIGNED', 'ABANDONED', 'ELIMINATED'].includes(playerStatus)) {
                if (phase.endsWith('M') || phase.endsWith('R') || phase.endsWith('B')) {
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
            } else if (status === 'FORMING') {
                recommendations.recommended = ['SET PREFERENCE'];
                 if (gameState.settings?.press !== 'None') recommendations.recommended.push('PRESS');
            } else if (status === 'PAUSED') {
                 if (gameState.settings?.press !== 'None') recommendations.recommended.push('PRESS');
            } else if (status === 'FINISHED' || status === 'TERMINATED') {
                recommendations.recommended = ['HISTORY', 'SUMMARY'];
            } else { // Unknown status or player inactive
                recommendations.recommended = ['LIST', 'HISTORY', 'SUMMARY', 'WHOGAME'];
            }

        } else if (userIsObserver) {
            recommendations.playerActions.push(...['SET PASSWORD', 'SET ADDRESS', 'RESIGN']); // Observer can resign observation
            if (gameState.settings?.observerPress !== 'none' && gameState.settings?.press !== 'None') {
                recommendations.playerActions.push('PRESS', 'BROADCAST');
                recommendations.recommended.push('PRESS', 'BROADCAST');
            } else {
                 recommendations.recommended = ['LIST', 'HISTORY', 'SUMMARY', 'WHOGAME'];
            }
        } else if (!userIsMaster) { // User not in game at all
             recommendations.recommended = ['SIGN ON power', 'OBSERVE']; // Suggest joining
             recommendations.playerActions = ['SET PASSWORD', 'SET ADDRESS']; // Can still manage account
        }

        // Master commands
        if (userIsMaster) {
            recommendations.master.push(...['SET', 'PROCESS', 'ROLLBACK', 'PAUSE', 'RESUME', 'TERMINATE', 'EJECT', 'BECOME', 'PROMOTE', 'FORCE BEGIN', 'UNSTART']);
            // Add common SET options for masters
            recommendations.master.push(...['SET DEADLINE', 'SET GRACE', 'SET START', 'SET NMR', 'SET NO NMR', 'SET DIAS', 'SET NO DIAS', 'SET CONCESSIONS', 'SET NO CONCESSIONS', 'SET VARIANT', 'SET NOT VARIANT', 'SET PUBLIC', 'SET PRIVATE']);
            // Add press control settings
             recommendations.master.push(...['SET ALL PRESS', 'SET NORMAL PRESS', 'SET QUIET', 'SET NO QUIET', 'SET WATCH ALL PRESS', 'SET NO WATCH ALL PRESS']);

            if (status === 'UNKNOWN' || status === 'FORMING') recommendations.recommended.push('FORCE BEGIN', 'SET');
            if (status === 'PAUSED') recommendations.recommended.push('RESUME');
            if (status === 'FINISHED' || status === 'TERMINATED') recommendations.recommended.push('ROLLBACK', 'UNSTART');
        }
    }

    // Add global commands if not present
    if (!recommendations.general.includes('WHOIS')) recommendations.general.push('WHOIS');

    // Filter duplicates across all categories and sort
    const uniqueCommands = new Set();
    const filterUnique = (arr) => arr.filter(cmd => {
        if (uniqueCommands.has(cmd)) return false;
        uniqueCommands.add(cmd);
        return true;
    });

    const finalRecommendations = {};
    for (const key in recommendations) {
        finalRecommendations[key] = filterUnique(recommendations[key]).sort();
    }

    // Ensure MANUAL is always available
    if (!uniqueCommands.has('MANUAL')) {
        finalRecommendations.general.push('MANUAL');
        finalRecommendations.general.sort();
    }

    console.log(`[Recommendations for ${userEmail} in ${gameState?.name || 'No Game'}] Generated:`, finalRecommendations);
    return finalRecommendations;
};

// --- Dip Execution Function ---
// Takes email, command, and optional game context (name, password)
const executeDipCommand = (email, command, targetGame = null, targetPassword = null, targetVariant = null) => {
    return new Promise(async (resolve, reject) => { // Make async to await getGameState
        const now = new Date();
        let fullCommand = command.trim();
        const commandVerb = fullCommand.split(/\s+/)[0].toUpperCase();

        // Commands that require game context (SIGN ON prepended)
        // This list needs careful review based on njudgedocs.txt
        const gameContextCommands = [
            'ORDERS', 'PRESS', 'BROADCAST', 'DIARY', 'RESIGN', 'WITHDRAW', // Player actions in-game
            'SET WAIT', 'SET NOWAIT', 'SET ABSENCE', 'SET NOABSENCE', 'SET DRAW', 'SET NODRAW', 'SET CONCEDE', 'SET NOCONCEDE', // Player settings in-game
            'PHASE', 'IF', 'CLEAR', // Future orders
            'PROCESS', 'ROLLBACK', 'PAUSE', 'RESUME', 'TERMINATE', 'EJECT', 'BECOME', 'PROMOTE', // Master actions
            'SET DEADLINE', 'SET GRACE', 'SET START', 'SET NMR', 'SET NO NMR', // Master settings (most SET need context)
            // Add other SET commands that modify *this* game's state
            'SET VARIANT', 'SET NOT VARIANT', 'SET PUBLIC', 'SET PRIVATE', 'SET APPROVAL', 'SET NO APPROVAL', 'SET APPROVE', 'SET NOT APPROVE',
            // WHOGAME, HISTORY, SUMMARY *can* take a game name, but don't *require* sign-on if name is provided.
            // LIST can take a game name, but doesn't require sign-on.
            // SET PASSWORD/ADDRESS apply to the user account, not a specific game context directly.
        ];

        // Commands that *don't* need game context prepended
        const noContextCommands = [
            'REGISTER', 'WHOIS', 'INFO', 'GET', 'VERSION', 'HELP', 'LIST', // Global info
            'SIGN', 'OBSERVE', 'WATCH', 'CREATE', // Initiating game interaction
            'SET PASSWORD', 'SET ADDRESS', // User account settings
            'MANUAL' // User explicitly handles everything
        ];

        let requiresContext = false;
        if (!noContextCommands.includes(commandVerb) && !(commandVerb === 'SIGN' && command.toUpperCase().includes('ON'))) {
             // Assume context is needed if not explicitly excluded. Refine this list as needed.
             requiresContext = true;
             // Special case: Some SET commands might be global, others game-specific.
             // For now, assume most SET commands target the current game context.
             if (commandVerb === 'SET' && commandParts.length > 1) {
                 const setOption = commandParts[1].toUpperCase();
                 if (['PASSWORD', 'ADDRESS'].includes(setOption)) {
                     requiresContext = false; // These are user-level
                 }
             }
        }


        if (requiresContext) {
            if (!targetGame || !targetPassword) {
                return reject({ success: false, output: `Error: Command "${commandVerb}" requires a target game and password, but none were provided.` });
            }

            let signOnPrefix = null;
            const variant = targetVariant; // Use the passed-in variant

            if (variant && variant.trim() !== '') {
                // Variant logic: Use the specific format requested, overriding role-based prefix
                const cleanVariant = variant.trim();
                signOnPrefix = `SIGN ON ?${targetGame} ${targetPassword} ${cleanVariant}`;
                console.log(`[Execute Prep] Using variant sign-on for ${email} on game ${targetGame} with variant ${cleanVariant}`);
            } else {
                // No variant: Use existing role-based logic
                try {
                    const gameState = await getGameState(targetGame);
                    if (!gameState) {
                         // Game doesn't exist in DB yet, maybe it's being created or just not synced?
                         // We can't determine the role. Let the command fail at the judge if needed.
                         // Or, maybe assume observer/player sign on? Let's try player first.
                         console.warn(`[Execute Prep] Game ${targetGame} not in DB. Assuming player sign-on ('?') for command ${commandVerb}.`);
                         // Heuristic: Try signing on as power '?' (observer/joiner)
                         signOnPrefix = `SIGN ON ?${targetGame} ${targetPassword}`;

                    } else {
                        const userIsMaster = gameState.masters?.includes(email);
                        const myPlayerInfo = gameState.players?.find(p => p.email === email);
                        const userIsPlayer = !!myPlayerInfo;
                        const userPower = userIsPlayer ? myPlayerInfo.power.charAt(0).toUpperCase() : null; // Use initial
                        const userIsObserver = gameState.observers?.includes(email) && !userIsPlayer && !userIsMaster;

                        if (userIsPlayer && userPower) {
                            signOnPrefix = `SIGN ON ${userPower}${targetGame} ${targetPassword}`;
                        } else if (userIsMaster) {
                            // Masters sign on with 'M' initial
                            signOnPrefix = `SIGN ON M${targetGame} ${targetPassword}`;
                        } else if (userIsObserver) {
                             // Observers sign on with 'O' initial
                            signOnPrefix = `SIGN ON O${targetGame} ${targetPassword}`;
                        } else {
                            // User not found in this game. Maybe trying to join? Or error?
                            // Let the judge handle the error if they aren't allowed.
                            // We could try OBSERVE or SIGN ON ? but that complicates things.
                            // Let's assume they *should* have access and try signing on as a player initial '?'
                             console.warn(`[Execute Prep] User ${email} not found as player/master/observer in ${targetGame}. Assuming join/observe sign-on ('?') for command ${commandVerb}.`);
                             signOnPrefix = `SIGN ON ?${targetGame} ${targetPassword}`;
                        }
                    }
                } catch (dbErr) {
                    console.error(`[Execute Prep] DB Error checking user role for ${email} in ${targetGame}:`, dbErr);
                    return reject({ success: false, output: `Database error checking user role for game ${targetGame}.` });
                }
            }

            // Apply the determined prefix (either variant-based or role-based)
            if (signOnPrefix) {
                fullCommand = `${signOnPrefix}\n${fullCommand}`;
                console.log(`[Execute Prep] Prepended "${signOnPrefix.split(' ')[0]}..." for user ${email} on game ${targetGame} for command ${commandVerb}`);
            } else if (!variant || variant.trim() === '') { // Only log error if no prefix could be determined *and* no variant was supplied
                 console.error(`[Execute Prep] Could not determine SIGN ON prefix for user ${email} on game ${targetGame} for command ${commandVerb}. Proceeding without prefix.`);
                 // Proceed without prefix, judge might reject it.
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
                 // Provide more useful error message if possible
                 let errorMsg = `Execution failed: Exit code ${code}, Signal ${signal}`;
                 if (stderrData.includes('command not found') || stderrData.includes('No such file')) {
                     errorMsg += `\n\nPossible cause: dip binary path incorrect or binary not executable. Check DIP_BINARY_PATH in .env and permissions.`;
                 } else if (stderrData.includes('timeout')) {
                      errorMsg += `\n\nPossible cause: Command took too long to execute.`;
                 }
                 return reject({ success: false, output: `${errorMsg}\n\n${output}` });
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
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use(session({
    store: new SQLiteStore({ db: 'sessions.db', dir: __dirname, table: 'sessions', concurrentDB: true }),
    secret: sessionSecret || 'fallback-secret-change-me',
    resave: false,
    saveUninitialized: false,
    cookie: { secure: process.env.NODE_ENV === 'production', httpOnly: true, maxAge: 1000 * 60 * 60 * 24 * 7 }
}));

// Middleware to ensure email is in session
function requireEmail(req, res, next) {
    if (!req.session.email) {
        // Clear any potentially stale game cookies if session is lost
        res.clearCookie('targetGame');
        res.clearCookie('targetPassword');
        if (req.path === '/') return next(); // Allow access to root
        if (req.xhr || req.headers.accept.indexOf('json') > -1) {
             return res.status(401).json({ success: false, output: 'Session expired or invalid. Please reload.' });
        }
        return res.redirect('/');
    }
    res.locals.user = req.session.email; // Make email available in all views
    next();
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
    if (!email || !email.includes('@')) {
        return res.render('index', { layout: false, error: 'Please enter a valid email address.' });
    }
    try {
        await ensureUserExists(email); // Add/update user in our tracking DB
        req.session.email = email;
        // Clear any old game context on new login
        res.clearCookie('targetGame');
        res.clearCookie('targetPassword');
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

        const outputLower = result.stdout.toLowerCase();
        if (outputLower.includes("registration accepted") ||
            outputLower.includes("updated registration") ||
            outputLower.includes("already registered") ||
            outputLower.includes("this is an update to an existing registration")) {
            await setUserRegistered(email); // Mark as registered in our DB
            console.log(`[Register Success] User ${email} registered with judge.`);
            req.session.save(err => {
                 if (err) console.error("Session save error after registration:", err);
                 res.redirect('/dashboard');
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
                            gamesFromMaster[gameName].status = phaseOrStatus; // Use Forming, Paused etc. as status
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
                currentState = { name: gameName, status: masterInfo.status, variant: 'Standard', options: [], currentPhase: masterInfo.currentPhase, nextDeadline: null, masters: [], players: [], observers: [], settings: {} };
                needsSave = true;
            } else {
                // Update phase/status if different from dip.master
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

// API endpoint to get all game names and basic status
app.get('/api/games', requireEmail, async (req, res) => {
    try {
        const gameStates = await getAllGameStates();
        // Return only essential info for the dropdown
        const gameList = Object.values(gameStates).map(g => ({
            name: g.name,
            status: g.status,
            phase: g.currentPhase
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
            // Optionally trigger a LIST command if game not found in DB?
            // For now, just return not found. Client can trigger refresh.
            return res.status(404).json({ success: false, message: `Game '${gameName}' not found in database.` });
        }
        // Generate recommendations based on this specific game state
        const recommendedCommands = getRecommendedCommands(gameState, req.session.email);
        res.json({ success: true, gameState, recommendedCommands });
    } catch (err) {
        console.error(`[API Error] /api/game/${gameName}:`, err);
        res.status(500).json({ success: false, message: `Failed to retrieve game state for ${gameName}.` });
    }
});


// Main dashboard route - Now renders a single dashboard view
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
                 res.clearCookie('targetPassword');
            }
        }

        // If no valid initial game, get default recommendations (no game context)
        if (!initialGameState) {
             initialRecommendedCommands = getRecommendedCommands(null, email);
        }

        res.render('dashboard', { // Render the new unified dashboard view
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
        res.clearCookie('connect.sid');
        res.clearCookie('targetGame');
        res.clearCookie('targetPassword');
        if (err) {
            console.error("Session destruction error:", err);
        }
        res.redirect('/');
    });
});


// API endpoint to execute the dip command
app.post('/execute-dip', requireEmail, async (req, res) => {
    const { command, targetGame, targetPassword, targetVariant } = req.body; // Get context from client, including optional variant
    const email = req.session.email;

    if (!command) {
        return res.status(400).json({ success: false, output: 'Error: Missing command.' });
    }

    const commandVerb = command.trim().split(/\s+/)[0].toUpperCase();
    let actualTargetGame = targetGame; // Game context for the command

    // Determine the actual target game if the command itself specifies one
    // (e.g., LIST game, CREATE ?game, SIGN ON Pgame, OBSERVE game)
     const commandParts = command.trim().split(/\s+/);
     const gameNameCommands = ['LIST', 'HISTORY', 'SUMMARY', 'WHOGAME', 'OBSERVE', 'WATCH', 'SIGN', 'CREATE'];
     if (gameNameCommands.includes(commandVerb) && commandParts.length > 1) {
         let potentialGameName = commandParts[1];
         // Adjust for SIGN ON Pgame and CREATE/SIGN ON ?game syntax
         if (commandVerb === 'SIGN' && command.toUpperCase().includes(' ON ') && !potentialGameName.startsWith('?')) { if (potentialGameName.length > 1 && /^[A-Z]$/i.test(potentialGameName[0])) { potentialGameName = potentialGameName.substring(1); } }
         else if ((commandVerb === 'SIGN' || commandVerb === 'CREATE') && potentialGameName.startsWith('?')) { potentialGameName = potentialGameName.substring(1); }

         const keywords = ['FULL', 'FROM', 'TO', 'LINES', 'EXCLSTART', 'EXCLEND', 'BROAD', 'ON', '?'];
         // Basic check if it looks like a game name (1-8 alphanumeric) and not a keyword
         if (/^[a-zA-Z0-9]{1,8}$/.test(potentialGameName) && !keywords.includes(potentialGameName.toUpperCase())) {
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
        let stateModified = false;
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

        // 2. Handle SIGN ON / OBSERVE / CREATE Success (Update cookies, potentially refresh state)
        let isSignOnOrObserveSuccess = false;
        let newGameCreated = false;
        let signedOnGame = null;

        if (commandVerb === 'SIGN' && command.toUpperCase().includes(' ON ') && !command.includes('?')) {
            const successPattern = /signed on as (?:\w+)\s*(?:in game)?\s*'(\w+)'/i; // Simpler pattern, just capture game name
            const match = stdoutData.match(successPattern);
            if (match) {
                signedOnGame = match[1];
                console.log(`[Execute] SIGN ON Success detected for ${email}: Game=${signedOnGame}`);
                isSignOnOrObserveSuccess = true; actualTargetGame = signedOnGame; requiresGameRefresh = true; stateModified = true;
            } else { console.log(`[Execute] SIGN ON for ${email} completed, but success message not recognized.`); }
        }
        else if (commandVerb === 'OBSERVE' || commandVerb === 'WATCH') {
             const observePattern = /(?:Observing|Watching) game '(\w+)'/i;
             const match = stdoutData.match(observePattern);
             if (match) {
                 signedOnGame = match[1];
                 console.log(`[Execute] OBSERVE Success detected for ${email}: Game=${signedOnGame}`);
                 isSignOnOrObserveSuccess = true; actualTargetGame = signedOnGame; requiresGameRefresh = true; stateModified = true;
             } else { console.log(`[Execute] OBSERVE/WATCH for ${email} completed, but success message not recognized.`); }
        }
        else if (commandVerb === 'CREATE' && command.toUpperCase().includes('?')) {
             const createPattern = /Game '(\w+)' created/i;
             const match = stdoutData.match(createPattern);
             if (match) {
                 signedOnGame = match[1]; // Game created, treat as the new target
                 console.log(`[Execute] CREATE Success detected for ${email}: Game=${signedOnGame}`);
                 isSignOnOrObserveSuccess = true; // Treat create like a successful sign on for UI update
                 actualTargetGame = signedOnGame; newGameCreated = true; requiresGameRefresh = true; stateModified = true;
                 // Trigger dip.master sync after creation
                 console.log(`[Execute Sync] Triggering dip.master sync after CREATE ${actualTargetGame}`);
                 syncDipMaster().catch(syncErr => console.error("Error during post-create sync:", syncErr));
             } else { console.log(`[Execute] CREATE for ${email} completed, but success message not recognized.`); }
        }

        // Update cookies if sign on/observe/create was successful
        if (isSignOnOrObserveSuccess && signedOnGame && targetPassword) {
            res.cookie('targetGame', signedOnGame, { maxAge: 1000 * 60 * 60 * 24 * 30, httpOnly: true, secure: process.env.NODE_ENV === 'production' });
            // WARNING: Storing password in cookie is insecure. Only do this if you understand the risks.
            // Consider prompting user instead. For now, implementing as requested.
            res.cookie('targetPassword', targetPassword, { maxAge: 1000 * 60 * 60 * 24 * 30, httpOnly: true, secure: process.env.NODE_ENV === 'production' });
            console.log(`[Execute] Set cookies for targetGame=${signedOnGame}`);
        }

        // 3. Identify other commands that likely modify game state and require refresh
        const stateChangingCommands = ['PROCESS', 'SET', 'RESIGN', 'WITHDRAW', 'EJECT', 'TERMINATE', 'ROLLBACK', 'FORCE BEGIN', 'UNSTART', 'PROMOTE'];
        if (stateChangingCommands.includes(commandVerb) && result.success && actualTargetGame) {
            // Check output for confirmation if possible (e.g., "processed", "terminated", "resigned")
            const outputLower = stdoutData.toLowerCase();
            if (outputLower.includes('processed') || outputLower.includes('terminated') || outputLower.includes('resigned') || outputLower.includes('ejected') || outputLower.includes('rolled back') || outputLower.includes('set') || outputLower.includes('promoted')) {
                 console.log(`[Execute] Command ${commandVerb} likely modified state for ${actualTargetGame}. Flagging for refresh.`);
                 requiresGameRefresh = true;
                 stateModified = true; // Indicate state potentially changed
            }
        }

        // 4. Refresh game state from Judge if needed
        let refreshedGameState = null;
        if (requiresGameRefresh && actualTargetGame) {
            console.log(`[Execute Refresh] Running LIST ${actualTargetGame} to refresh state after ${commandVerb}`);
            try {
                // Use the *original* user email and the potentially updated target game/password
                const listResult = await executeDipCommand(email, `LIST ${actualTargetGame}`, actualTargetGame, targetPassword);
                if (listResult.success) {
                    refreshedGameState = parseListOutput(actualTargetGame, listResult.stdout);
                    await saveGameState(actualTargetGame, refreshedGameState);
                    console.log(`[Execute Refresh] Successfully refreshed and saved state for ${actualTargetGame}`);
                } else {
                    console.error(`[Execute Refresh] Failed to run LIST command for ${actualTargetGame}:`, listResult.output);
                }
            } catch (refreshError) {
                console.error(`[Execute Refresh] Error during state refresh for ${actualTargetGame}:`, refreshError);
            }
        }

        // 5. Send Response
        // Include the potentially refreshed game state in the response
        res.json({
            success: result.success,
            output: result.output,
            isSignOnOrObserveSuccess: isSignOnOrObserveSuccess, // Let client know to potentially reload UI context
            createdGameName: newGameCreated ? signedOnGame : null,
            refreshedGameState: refreshedGameState // Send back the latest state if refreshed
        });

    } catch (error) {
        // Handle errors from executeDipCommand (non-zero exit, spawn fail, stdin fail, context missing)
        console.error(`[Execute Error] Command "${commandVerb}" for ${email} failed:`, error);
        res.status(500).json({
             success: false,
             output: error.output || 'Unknown execution error',
             isSignOnOrObserveSuccess: false
        });
    }
});

// --- Start Server ---
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
});

// Graceful shutdown
process.on('SIGINT', () => {
    console.log('SIGINT signal received: closing databases...');
    db.close((err) => { if (err) console.error('Error closing game_states DB:', err.message); else console.log('Game states DB closed.'); });
    sessionDb.close((err) => { if (err) console.error('Error closing sessions DB:', err.message); else console.log('Sessions DB closed.'); });
    userDb.close((err) => { if (err) console.error('Error closing users DB:', err.message); else console.log('Users DB closed.'); process.exit(0); });
    // Force exit after a delay if DBs don't close quickly
    setTimeout(() => { console.error("Databases did not close gracefully, forcing exit."); process.exit(1); }, 5000);
});
